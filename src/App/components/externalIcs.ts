import * as ICALRaw from "ical.js";
const ICAL: any = (ICALRaw as any)?.default ?? ICALRaw;
import type { EventInput } from "@fullcalendar/core";

/** Normalize host HTTP payloads (shape varies by Logseq SDK version). */
function icsBodyFromHostResult(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const k of ["body", "text", "data", "content"] as const) {
      const v = o[k];
      if (typeof v === "string" && v.length) return v;
    }
  }
  return null;
}

/**
 * Load remote ICS text through Logseq's host proxy so marketplace iframes do
 * not depend on the feed's CORS policy. Keep the legacy Request API and browser
 * fetch as fallbacks for older hosts and unpacked development builds.
 */
async function fetchIcsText(url: string): Promise<string> {
  const net = typeof logseq !== "undefined" ? logseq.Net : undefined;

  if (typeof net?.get === "function") {
    try {
      const raw = await net.get<string>(url, { responseType: "text" });
      const fromNet = icsBodyFromHostResult(raw);
      if (fromNet != null && fromNet.trim()) return fromNet;
    } catch (e) {
      console.warn("[logseq-timebox] ICS via logseq.Net failed, trying fallbacks", url, e);
    }
  }

  const reqFn =
    typeof logseq !== "undefined" && typeof (logseq as any).Request?._request === "function"
      ? ((logseq as any).Request._request as (opts: {
          url: string;
          method: "GET";
          returnType: "text";
        }) => Promise<unknown>)
      : undefined;

  if (reqFn) {
    try {
      const raw = await reqFn({ url, method: "GET", returnType: "text" });
      const fromReq = icsBodyFromHostResult(raw);
      if (fromReq != null && fromReq.trim()) return fromReq;
    } catch (e) {
      console.warn("[logseq-timebox] ICS via logseq.Request failed, using fetch()", url, e);
    }
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const EXTERNAL_BG = "#fce7ff";
const EXTERNAL_BORDER = "#f3c4ff";
const EXTERNAL_TEXT = "#5b1b73";
const WINDOW_PAST_DAYS = 30;
const WINDOW_FUTURE_DAYS = 120;

const buildEventInput = (summary: string, start: Date, end: Date | null, allDay: boolean, sourceLabel: string, now: Date): EventInput => {
  const isPast = (end ?? start) < now;
  const classes = ["fc-external-event"];
  if (isPast) classes.push("fc-external-event-past");
  
  const evt: EventInput = {
    title: summary || "Untitled",
    start: start.toISOString(),
    allDay,
    extendedProps: {
      source: "external",
      sourceLabel,
    },
    backgroundColor: EXTERNAL_BG,
    borderColor: EXTERNAL_BORDER,
    textColor: EXTERNAL_TEXT,
    editable: false,
    classNames: classes,
  };
  if (end) evt.end = end.toISOString();
  return evt;
};

const inWindow = (start: Date, windowStart: Date, windowEnd: Date) => start >= windowStart && start <= windowEnd;

export const fetchExternalIcs = async (urls: string[]): Promise<EventInput[]> => {
  const results: EventInput[] = [];
  const uniqueUrls = Array.from(new Set(urls.map((u) => u.trim()).filter(Boolean)));
  if (uniqueUrls.length === 0) return results;

  const now = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_PAST_DAYS * 24 * 3600 * 1000);
  const windowEnd = new Date(now.getTime() + WINDOW_FUTURE_DAYS * 24 * 3600 * 1000);

  const fetches = uniqueUrls.map(async (url) => {
    try {
      const text = await fetchIcsText(url);
      if (!text || !text.trim()) return;

      const jcalData = ICAL.parse(text);
      const comp = new ICAL.Component(jcalData);
      const vevents = comp.getAllSubcomponents("vevent");

      for (const vevent of vevents) {
        try {
          const event = new ICAL.Event(vevent);
          if (event.status === "CANCELLED") continue;

          // Skip events without a valid startDate
          if (!event.startDate || typeof event.startDate.toJSDate !== "function") {
            continue;
          }

          if (event.isRecurring()) {
            try {
              const expand = new ICAL.RecurExpansion({
                component: vevent,
                dtstart: event.startDate,
              });
              let count = 0;
              const maxOccurrences = 500; // Safety limit
              while (expand.next() && count < maxOccurrences) {
                count++;
                const next = expand.last;
                if (!next || typeof next.toJSDate !== "function") {
                  continue;
                }
                const startDate = next.toJSDate();
                if (!inWindow(startDate, windowStart, windowEnd)) {
                  if (startDate > windowEnd) break;
                  continue;
                }
                const duration = event.duration;
                let endDate: Date | null = null;
                if (duration && typeof next.clone === "function") {
                  try {
                    endDate = next.clone().addDuration(duration).toJSDate();
                  } catch {
                    // ignore duration calculation errors
                  }
                }
                const allDay = next.isDate ?? false;
                results.push(buildEventInput(event.summary, startDate, endDate, allDay, url, now));
              }
            } catch {
              // If recurrence expansion fails, fall back to single event
              const startDate = event.startDate.toJSDate();
              if (inWindow(startDate, windowStart, windowEnd)) {
                const endDate = event.endDate?.toJSDate?.() ?? null;
                const allDay = event.startDate.isDate ?? false;
                results.push(buildEventInput(event.summary, startDate, endDate, allDay, url, now));
              }
            }
          } else {
            const startDate = event.startDate.toJSDate();
            if (!inWindow(startDate, windowStart, windowEnd)) continue;
            const endDate = event.endDate?.toJSDate?.() ?? null;
            const allDay = event.startDate.isDate ?? false;
            results.push(buildEventInput(event.summary, startDate, endDate, allDay, url, now));
          }
        } catch {
          // Skip malformed events
        }
      }
    } catch (e) {
      console.warn("[logseq-timebox] external ICS fetch/parse error", url, e);
    }
  });

  await Promise.all(fetches);
  return results;
};
