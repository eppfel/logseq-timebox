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
  const externalCacheRef = useRef<{ urls: string; events: EventInput[] } | null>(null);

  // Track pending updates to prevent stale DB data from overwriting optimistic UI
  const pendingUpdatesRef = useRef<Map<string, PendingUpdate>>(new Map());
  // Track dragging state to pause refreshes
  const isDraggingRef = useRef(false);

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

    try {
      const adapter = await getGraphAdapter();
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

      // Fetch external ICS if enabled
      let externalEvents: EventInput[] = [];
      if (externalVisible) {
        const urls = (((logseq as any)?.settings?.externalIcsUrls || "") as string)
          .split(/\r?\n/)
          .map((u) => u.trim())
          .filter(Boolean);
        const urlsKey = urls.join("|");

        // Use cache if available and not forcing refresh
        if (!forceExternalRefresh && externalCacheRef.current?.urls === urlsKey) {
          externalEvents = externalCacheRef.current.events;
        } else if (urls.length) {
          externalEvents = await fetchExternalIcs(urls);
          externalCacheRef.current = { urls: urlsKey, events: externalEvents };
        }
      }

      setEvents([...calendarEvents, ...externalEvents]);
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
