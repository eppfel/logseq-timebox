// Adapter for DB graphs (Logseq 2.x). Tasks are blocks tagged #Task with
// Status/Priority/Scheduled properties; Scheduled is a :datetime property
// storing epoch milliseconds. All writes go through the property APIs —
// block text is never parsed or rewritten except for the title itself.
//
// Convention: a Scheduled time of exactly 00:00 is treated as an all-day event.
// Duration is stored in a plugin-owned number property (minutes).

import { getOrCreateJournalPage } from "./journal";
import type { GraphAdapter, RescheduleOptions, TaskKind, TimeboxTask } from "./types";

const SCHEDULED_PROP = "logseq.property/scheduled";
const STATUS_PROP = "logseq.property/status";
const DURATION_PROP_NAME = "duration";

type StatusLabel = "Backlog" | "Todo" | "Doing" | "In Review" | "Done" | "Canceled";

/** Reads a value from a datascriptQuery result map, whose namespaced keys are
 * serialized as literal strings like ":logseq.property/scheduled". */
const prop = (obj: Record<string, unknown> | null | undefined, key: string): unknown => {
  if (!obj) return undefined;
  return obj[`:${key}`] ?? obj[key] ?? obj[key.split("/").pop() as string];
};

/** Unwraps values that may arrive as {":logseq.property/value": n} ref maps (e.g. :number properties). */
const coerceNumber = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object") {
    const inner = prop(v as Record<string, unknown>, "logseq.property/value");
    if (typeof inner === "number" && Number.isFinite(inner)) return inner;
  }
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

/** Extracts the trailing segment of a closed-value ident, e.g.
 * {ident: ":logseq.property/status.doing"} → "doing". */
const closedValueKey = (v: unknown): string | null => {
  const ident =
    typeof v === "string" ? v : v && typeof v === "object" ? (v as Record<string, unknown>)["ident"] : null;
  if (typeof ident !== "string") return null;
  const lastDot = ident.lastIndexOf(".");
  return lastDot === -1 ? null : ident.substring(lastDot + 1);
};

const statusToKind = (statusKey: string | null): TaskKind => {
  if (statusKey === "done") return "done";
  if (statusKey === "canceled") return "canceled";
  if (statusKey === "doing" || statusKey === "in-review") return "inProgress";
  return "open";
};

const statusKeyToLabel: Record<string, StatusLabel> = {
  backlog: "Backlog",
  todo: "Todo",
  doing: "Doing",
  "in-review": "In Review",
  done: "Done",
  canceled: "Canceled",
};

const nextStatus = (current: StatusLabel | null): StatusLabel => {
  if (current === "Todo") return "Doing";
  if (current === "Doing") return "Done";
  if (current === "Done") return "Todo";
  return "Doing";
};

const repeatUnitLetter: Record<string, string> = {
  minute: "min",
  hour: "h",
  day: "d",
  week: "w",
  month: "m",
  year: "y",
};

const repeatTypePrefix: Record<string, string> = {
  "dotted-plus": ".+",
  plus: "+",
  "double-plus": "++",
};

/** The plugin's duration property ident (without leading colon), resolved once per session. */
let durationIdentPromise: Promise<string> | null = null;

const resolveDurationIdent = async (): Promise<string> => {
  const pluginId = ((logseq as any)?.baseInfo?.id as string) || "logseq-timebox";
  const fallback = `plugin.property.${pluginId}/${DURATION_PROP_NAME}`;
  try {
    const created = await (logseq.Editor as any).upsertProperty(DURATION_PROP_NAME, {
      type: "number",
      public: true,
    });
    const ident = created?.ident ?? created?.["db/ident"];
    if (typeof ident === "string" && ident.includes("/")) {
      return ident.replace(/^:+/, "");
    }
  } catch (e) {
    console.warn("logseq-timebox: could not upsert duration property, using fallback ident", e);
  }
  return fallback;
};

const getDurationIdent = (): Promise<string> => {
  if (!durationIdentPromise) durationIdentPromise = resolveDurationIdent();
  return durationIdentPromise;
};

/** Reads current status + duration via the readable block-properties API. */
const readBlockProps = async (
  uuid: string
): Promise<{ statusLabel: StatusLabel | null; durationMins: number | null }> => {
  let statusLabel: StatusLabel | null = null;
  let durationMins: number | null = null;
  try {
    const props = (await (logseq.Editor as any).getBlockProperties(uuid)) as Record<string, unknown> | null;
    if (props) {
      const rawStatus = prop(props, STATUS_PROP);
      if (typeof rawStatus === "string" && Object.values(statusKeyToLabel).includes(rawStatus as StatusLabel)) {
        statusLabel = rawStatus as StatusLabel;
      } else {
        const key = closedValueKey(rawStatus);
        statusLabel = key ? statusKeyToLabel[key] ?? null : null;
      }
      const durationIdent = await getDurationIdent();
      durationMins = coerceNumber(prop(props, durationIdent));
    }
  } catch {
    /* block without properties */
  }
  return { statusLabel, durationMins };
};

const setDuration = async (uuid: string, durationMins: number | null): Promise<void> => {
  if (durationMins && durationMins > 0) {
    await (logseq.Editor as any).upsertBlockProperty(uuid, DURATION_PROP_NAME, Math.round(durationMins));
  } else {
    await (logseq.Editor as any).removeBlockProperty(uuid, DURATION_PROP_NAME);
  }
};

const tagAsTask = async (uuid: string): Promise<void> => {
  try {
    await (logseq.Editor as any).addBlockTag(uuid, "logseq.class/Task");
  } catch (e) {
    // Non-fatal: the block still shows in the calendar via its Scheduled property.
    console.warn("logseq-timebox: could not tag block as Task", e);
  }
};

// 2.x removed scrollToBlockInPage; its page route accepts a block UUID and
// opens that node directly. Keep the sidebar as a best-effort fallback.
const navigateToBlockDb = async (uuid: string): Promise<void> => {
  try {
    await (logseq.App as any).pushState("page", { name: uuid });
    return;
  } catch {
    /* fall through to sidebar */
  }
  try {
    await logseq.Editor.openInRightSidebar(uuid);
  } catch {
    /* navigation is best-effort */
  }
};

export const createDbAdapter = (): GraphAdapter => ({
  graphKind: "db",

  async fetchTasks(): Promise<TimeboxTask[]> {
    const durationIdent = await getDurationIdent();
    const buildQuery = (durationAttr: string | null) => `
      [:find (pull
        ?block
        [:block/uuid
          :block/title
          :logseq.property/scheduled
          {:logseq.property/status [:db/ident]}
          {:logseq.property/priority [:db/ident]}
          :logseq.property.repeat/repeated?
          :logseq.property.repeat/recur-frequency
          {:logseq.property.repeat/recur-unit [:db/ident]}
          {:logseq.property.repeat/repeat-type [:db/ident]}
          ${durationAttr ? `{:${durationAttr} [:logseq.property/value]}` : ""}
          {:block/page [:block/uuid :block/name :block/title :block/journal-day]}])
        :where
        [?block :logseq.property/scheduled]]
    `;

    let results: any;
    try {
      results = await logseq.DB.datascriptQuery(buildQuery(durationIdent));
    } catch (e) {
      // The duration property may not exist yet (e.g. its creation failed) — retry without it
      console.warn("logseq-timebox: scheduled query with duration failed, retrying without", e);
      results = await logseq.DB.datascriptQuery(buildQuery(null));
    }

    const tasks: TimeboxTask[] = [];
    if (!results?.length) return tasks;

    for (const result of results) {
      const block = Array.isArray(result) ? result[0] : result;
      if (!block) continue;

      const scheduledMs = coerceNumber(prop(block, SCHEDULED_PROP));
      const uuid = block["uuid"];
      if (!scheduledMs || !uuid) continue;

      const start = new Date(scheduledMs);
      // Convention: exactly midnight (local) = all-day event
      const allDay = start.getHours() === 0 && start.getMinutes() === 0;

      const title = (block["full-title"] || block["fullTitle"] || block["title"] || block["content"] || "Untitled") as string;

      const statusKey = closedValueKey(prop(block, STATUS_PROP));
      const kind = statusToKind(statusKey);

      const priorityKey = closedValueKey(prop(block, "logseq.property/priority"));
      const highPriority = priorityKey === "high" || priorityKey === "urgent";

      // Recurrence: structured repeat properties → compact "++1w"-style display
      let recurringPattern: string | null = null;
      if (prop(block, "logseq.property.repeat/repeated?")) {
        const freq = coerceNumber(prop(block, "logseq.property.repeat/recur-frequency")) ?? 1;
        const unitKey = closedValueKey(prop(block, "logseq.property.repeat/recur-unit"));
        const typeKey = closedValueKey(prop(block, "logseq.property.repeat/repeat-type"));
        const unit = unitKey ? repeatUnitLetter[unitKey] ?? unitKey : "";
        const prefix = typeKey ? repeatTypePrefix[typeKey] ?? "++" : "++";
        recurringPattern = `${prefix}${freq}${unit}`;
      }

      tasks.push({
        uuid,
        title: String(title).trim() || "Untitled",
        start,
        allDay,
        durationMins: allDay ? null : coerceNumber(prop(block, durationIdent)),
        kind,
        highPriority,
        recurringPattern,
        rawStatus: statusKey ? statusKeyToLabel[statusKey] : undefined,
      });
    }
    return tasks;
  },

  async reschedule(uuid: string, start: Date, allDay: boolean, opts: RescheduleOptions): Promise<void> {
    let scheduled = start;
    if (allDay) {
      scheduled = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    } else if (start.getHours() === 0 && start.getMinutes() === 0) {
      // Midnight means all-day by convention; nudge a timed event off midnight to keep it timed
      scheduled = new Date(start.getTime() + 60000);
    }
    await (logseq.Editor as any).upsertBlockProperty(uuid, SCHEDULED_PROP, scheduled.getTime());

    let durMins = opts.durationMins;
    if (opts.preferExistingDuration) {
      const { durationMins: existing } = await readBlockProps(uuid);
      durMins = existing ?? opts.durationMins;
    }
    await setDuration(uuid, !allDay ? durMins : null);
  },

  async clearSchedule(uuid: string): Promise<void> {
    await (logseq.Editor as any).removeBlockProperty(uuid, SCHEDULED_PROP);
    await (logseq.Editor as any).removeBlockProperty(uuid, DURATION_PROP_NAME);
  },

  async createTask(date: Date, allDay: boolean, durationMins: number | null): Promise<boolean> {
    const page = await getOrCreateJournalPage(date);
    if (!page) return false;

    const block = await logseq.Editor.appendBlockInPage(page.uuid, "new todo from calendar ui");
    if (!block) return false;

    await tagAsTask(block.uuid);
    try {
      await (logseq.Editor as any).upsertBlockProperty(block.uuid, STATUS_PROP, "Todo");
    } catch (e) {
      console.warn("logseq-timebox: could not set Todo status", e);
    }

    let scheduled = date;
    if (allDay) {
      scheduled = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    } else if (date.getHours() === 0 && date.getMinutes() === 0) {
      scheduled = new Date(date.getTime() + 60000);
    }
    await (logseq.Editor as any).upsertBlockProperty(block.uuid, SCHEDULED_PROP, scheduled.getTime());
    if (!allDay && durationMins) {
      await setDuration(block.uuid, durationMins);
    }

    await navigateToBlockDb(block.uuid);
    return true;
  },

  async navigateToTask(uuid: string): Promise<void> {
    await navigateToBlockDb(uuid);
  },

  async cycleStatus(uuid: string): Promise<string | null> {
    const { statusLabel } = await readBlockProps(uuid);
    const next = nextStatus(statusLabel);
    if (!statusLabel) {
      // Untracked block: make it a real task so the status renders in Logseq
      await tagAsTask(uuid);
    }
    await (logseq.Editor as any).upsertBlockProperty(uuid, STATUS_PROP, next);
    return next;
  },

  async getEditableTitle(uuid: string): Promise<string | null> {
    const block = await logseq.Editor.getBlock(uuid);
    if (!block) return null;
    return ((block as any).title as string) ?? block.content ?? "";
  },

  async saveTitle(uuid: string, title: string): Promise<void> {
    await logseq.Editor.updateBlock(uuid, title);
  },
});
