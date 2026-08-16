import { useState, useEffect, useRef, useCallback } from "react";
import type { EventInput } from "@fullcalendar/core";
import { DB_CHANGED_EVENT } from "../../../main";
import { fetchExternalIcs } from "../externalIcs";
import { getGraphAdapter } from "../../adapters";
import type { TimeboxTask } from "../../adapters";

interface PendingUpdate {
  start: string;
  end?: string;
  allDay: boolean;
  timestamp: number;
}

interface ExternalEventsCache {
  fingerprint: string;
  fetchedAt: number;
  events: EventInput[];
}

const EXTERNAL_CACHE_STORAGE_KEY = "logseq-timebox-external-events-v1";
const LEGACY_EXTERNAL_CACHE_STORAGE_KEY = EXTERNAL_CACHE_STORAGE_KEY;
const EXTERNAL_CACHE_REFRESH_MS = 5 * 60 * 1000;
const EXTERNAL_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Compact fingerprint so private feed URLs are never copied into the cache. */
const fingerprintExternalUrls = (value: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}:${(hash >>> 0).toString(16)}`;
};

const removeExternalEventsCache = async (): Promise<void> => {
  try {
    await logseq.FileStorage.removeItem(EXTERNAL_CACHE_STORAGE_KEY);
  } catch {
    // Missing cache files are expected.
  }
};

const removeExternalEventsCacheForDbGraph = async (): Promise<void> => {
  try {
    const adapter = await getGraphAdapter();
    if (adapter.graphKind === "db") {
      await removeExternalEventsCache();
    }
  } catch {
    // Cache cleanup is best-effort.
  }
};

const readExternalEventsCache = async (fingerprint: string): Promise<ExternalEventsCache | null> => {
  try {
    const raw = await logseq.FileStorage.getItem(EXTERNAL_CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ExternalEventsCache>;
    if (
      parsed.fingerprint !== fingerprint ||
      typeof parsed.fetchedAt !== "number" ||
      !Array.isArray(parsed.events) ||
      Date.now() - parsed.fetchedAt > EXTERNAL_CACHE_MAX_AGE_MS
    ) {
      if (Date.now() - (parsed.fetchedAt ?? 0) > EXTERNAL_CACHE_MAX_AGE_MS) {
        void removeExternalEventsCache();
      }
      return null;
    }
    return parsed as ExternalEventsCache;
  } catch {
    return null;
  }
};

const writeExternalEventsCache = async (cache: ExternalEventsCache): Promise<void> => {
  try {
    await logseq.FileStorage.setItem(EXTERNAL_CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Cache failures must not prevent live calendar loading.
  }
};

const waitForPaint = (): Promise<void> =>
  new Promise((resolve) => window.requestAnimationFrame(() => resolve()));

const removeLegacyBrowserCache = (): void => {
  try {
    // Earlier development builds briefly used the shared iframe origin. Keep
    // external calendar data only in Logseq's plugin-scoped file storage.
    window.localStorage.removeItem(LEGACY_EXTERNAL_CACHE_STORAGE_KEY);
  } catch {
    // Browser storage may be unavailable in some plugin host configurations.
  }
};

const taskToEvent = (task: TimeboxTask): EventInput => {
  const event: EventInput = {
    id: task.uuid,
    title: task.title,
    start: task.start.toISOString(),
    allDay: task.allDay,
    extendedProps: {
      blockUuid: task.uuid,
      marker: task.rawStatus,
      ...(task.recurringPattern ? { recurringPattern: task.recurringPattern } : {}),
    },
  };

  // Set soft green background for DONE tasks
  if (task.kind === "done") {
    event.backgroundColor = "#d1f4d1";
    event.borderColor = "#a3e4a3";
    event.textColor = "#2d5f2d";
  } else if (task.kind === "canceled") {
    event.backgroundColor = "#e5e7eb";
    event.borderColor = "#9ca3af";
    event.textColor = "#374151";
  } else if (task.kind === "inProgress") {
    event.backgroundColor = "#ffe4cc";
    event.borderColor = "#ffb366";
    event.textColor = "#994d00";
  } else if (task.highPriority) {
    // High priority — [#A] (MD) or High/Urgent (DB)
    event.backgroundColor = "#fecaca";
    event.borderColor = "#f87171";
    event.textColor = "#7f1d1d";
  } else {
    // Sweet blue for all other open tasks
    event.backgroundColor = "#cce7ff";
    event.borderColor = "#66b3ff";
    event.textColor = "#004d99";
  }

  if (!task.allDay && task.durationMins && task.durationMins > 0) {
    const end = new Date(task.start.getTime() + task.durationMins * 60000);
    event.end = end.toISOString();
  }

  return event;
};

interface UseScheduledEventsReturn {
  events: EventInput[];
  externalVisible: boolean;
  setExternalVisible: (visible: boolean | ((prev: boolean) => boolean)) => void;
  refreshEvents: (forceExternalRefresh?: boolean) => void;
  setIsDragging: (dragging: boolean) => void;
  updateEventOptimistically: (event: EventInput) => void;
}

export function useScheduledEvents(): UseScheduledEventsReturn {
  const [events, setEvents] = useState<EventInput[]>([]);
  const [externalVisible, setExternalVisible] = useState<boolean>(
    () => (logseq as any)?.settings?.showExternalCalendars ?? true
  );

  // Debounce timer ref
  const debounceTimerRef = useRef<number | null>(null);
  // Cache for external ICS events (to avoid refetching on local changes)
  const externalCacheRef = useRef<ExternalEventsCache | null>(null);
  // Reuse an active request when initialization triggers a follow-up DB refresh.
  const externalRequestRef = useRef<{ fingerprint: string; promise: Promise<EventInput[]> } | null>(null);
  // Ignore results from an older overlapping refresh.
  const loadGenerationRef = useRef(0);
  // The immediate initial load already includes external calendars.
  const hasCompletedInitialExternalEffectRef = useRef(false);

  // Track pending updates to prevent stale DB data from overwriting optimistic UI
  const pendingUpdatesRef = useRef<Map<string, PendingUpdate>>(new Map());
  // Track dragging state to pause refreshes
  const isDraggingRef = useRef(false);

  useEffect(() => {
    removeLegacyBrowserCache();
  }, []);

  const setIsDragging = useCallback((dragging: boolean) => {
    if (dragging) {
      isDraggingRef.current = true;
    } else {
      // Delay setting false to allow handleEventDrop to fire and set pending update
      // This prevents a race condition where a refresh happens between drag stop and drop handler
      setTimeout(() => {
        isDraggingRef.current = false;
      }, 200);
    }
  }, []);

  const updateEventOptimistically = useCallback((event: EventInput) => {
    if (!event.id) return;

    // Update pending updates
    pendingUpdatesRef.current.set(event.id, {
      start: event.start as string,
      end: event.end as string,
      allDay: event.allDay as boolean,
      timestamp: Date.now()
    });

    // Update local state immediately
    setEvents(prev => {
      return prev.map(e => {
        if (e.id === event.id) {
          return { ...e, ...event };
        }
        return e;
      });
    });
  }, []);

  const loadScheduledEvents = useCallback(async (forceExternalRefresh = false) => {
    // Skip loading if dragging
    if (isDraggingRef.current) return;

    const generation = ++loadGenerationRef.current;
    try {
      const adapter = await getGraphAdapter();
      const persistExternalCache = adapter.graphKind === "db";
      let cachedExternalEvents: EventInput[] | null = null;
      let externalFingerprint = "";
      let shouldRefreshExternal = false;
      let externalUrls: string[] = [];

      if (externalVisible) {
        externalUrls = (((logseq as any)?.settings?.externalIcsUrls || "") as string)
          .split(/\r?\n/)
          .map((u) => u.trim())
          .filter(Boolean);
        const urlsKey = externalUrls.join("|");
        externalFingerprint = fingerprintExternalUrls(urlsKey);

        let cache = externalCacheRef.current;
        if (cache?.fingerprint !== externalFingerprint) {
          cache = persistExternalCache
            ? await readExternalEventsCache(externalFingerprint)
            : null;
          externalCacheRef.current = cache;
        }
        if (cache) {
          cachedExternalEvents = cache.events;
        }
        shouldRefreshExternal =
          externalUrls.length > 0 &&
          (forceExternalRefresh || !cache || Date.now() - cache.fetchedAt >= EXTERNAL_CACHE_REFRESH_MS);
      }

      const tasks = await adapter.fetchTasks();

      const calendarEvents: EventInput[] = [];
      for (const task of tasks) {
        const event = taskToEvent(task);

        // Check for pending updates
        const pending = pendingUpdatesRef.current.get(task.uuid);
        if (pending) {
          // Check if DB matches pending (DB caught up)
          // We compare start time and allDay status
          const isSynced = event.start === pending.start && event.allDay === pending.allDay;

          if (isSynced) {
            pendingUpdatesRef.current.delete(task.uuid);
          } else {
            // Not synced yet. Check if pending update is stale (e.g. > 15s)
            if (Date.now() - pending.timestamp < 15000) {
              // Keep optimistic state
              event.start = pending.start;
              event.end = pending.end;
              event.allDay = pending.allDay;
            } else {
              // Pending update timed out
              pendingUpdatesRef.current.delete(task.uuid);
            }
          }
        }

        calendarEvents.push(event);
      }

      if (generation !== loadGenerationRef.current) return;

      // Paint local tasks and any persisted external snapshot before starting a
      // potentially slow DB-host network request.
      setEvents([...calendarEvents, ...(cachedExternalEvents ?? [])]);

      if (shouldRefreshExternal) {
        await waitForPaint();
        let request = externalRequestRef.current;
        if (request?.fingerprint !== externalFingerprint) {
          const promise = fetchExternalIcs(externalUrls).finally(() => {
            if (externalRequestRef.current?.promise === promise) {
              externalRequestRef.current = null;
            }
          });
          request = { fingerprint: externalFingerprint, promise };
          externalRequestRef.current = request;
        }
        const externalEvents = await request.promise;
        if (generation !== loadGenerationRef.current) return;
        const cache: ExternalEventsCache = {
          fingerprint: externalFingerprint,
          fetchedAt: Date.now(),
          events: externalEvents,
        };
        externalCacheRef.current = cache;
        if (persistExternalCache) {
          void writeExternalEventsCache(cache);
        }
        setEvents([...calendarEvents, ...externalEvents]);
      }
    } catch {
    }
  }, [externalVisible]);

  // Debounced refresh function
  const refreshEvents = useCallback((forceExternalRefresh = false) => {
    if (debounceTimerRef.current) {
      window.clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      loadScheduledEvents(forceExternalRefresh);
    }, 100);
  }, [loadScheduledEvents]);

  // Initial load and DB change listener
  useEffect(() => {
    loadScheduledEvents();

    const handleDbChange = () => {
      refreshEvents(false); // Don't refetch external on DB changes
    };

    window.addEventListener(DB_CHANGED_EVENT, handleDbChange);

    return () => {
      window.removeEventListener(DB_CHANGED_EVENT, handleDbChange);
      if (debounceTimerRef.current) {
        window.clearTimeout(debounceTimerRef.current);
      }
    };
  }, [loadScheduledEvents, refreshEvents]);

  // Reload when externalVisible changes
  useEffect(() => {
    if (!hasCompletedInitialExternalEffectRef.current) {
      hasCompletedInitialExternalEffectRef.current = true;
      return;
    }
    refreshEvents(true); // Force refresh external when visibility toggles
  }, [externalVisible, refreshEvents]);

  // Listen for settings changes related to external calendars
  useEffect(() => {
    const unsubscribe = logseq?.onSettingsChanged?.((newSettings: any) => {
      if (newSettings && Object.prototype.hasOwnProperty.call(newSettings, "showExternalCalendars")) {
        setExternalVisible(!!newSettings.showExternalCalendars);
      }
      if (newSettings && Object.prototype.hasOwnProperty.call(newSettings, "externalIcsUrls")) {
        // Clear cache and refresh when URLs change
        externalCacheRef.current = null;
        void removeExternalEventsCacheForDbGraph();
        refreshEvents(true);
      }
    });

    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [refreshEvents]);

  return {
    events,
    externalVisible,
    setExternalVisible,
    refreshEvents: () => refreshEvents(false),
    setIsDragging,
    updateEventOptimistically
  };
}
