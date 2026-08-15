// Adapter for Markdown (file-based) graphs. Tasks are parsed from and written
// back as block text: `SCHEDULED: <...>` lines, TODO/DOING markers, [#A]
// priority tokens, [d:...] duration tokens and ++1w-style repeaters.

import {
  formatScheduledDate,
  parseDurationToken,
  parseRepeater,
  updateDurationTokenInContent,
  nextTriCycleMarker,
  applyTriCycleMarkerToContent,
} from "../components/calendarUtils";
import { getOrCreateJournalPage } from "./journal";
import type { GraphAdapter, RescheduleOptions, TaskKind, TimeboxTask } from "./types";

/** Logseq priority token on a block (e.g. `[#A]`). */
const hasPriorityA = (text: string) => /\[#A\]/i.test(text);

/** Markers where [#A] should use the high-priority red palette (NOW uses same color as DOING, not this branch). */
const priorityARedMarkers = new Set<string>(["TODO", "LATER"]);

interface ScheduledInfo {
  date: Date;
  allDay: boolean;
  durationMins?: number;
}

const parseScheduledTime = (content: string): ScheduledInfo | null => {
  // Parse SCHEDULED: <YYYY-MM-DD ddd HH:mm> or SCHEDULED: <YYYY-MM-DD ddd>
  const scheduledMatch = content.match(/SCHEDULED:\s*<([^>]+)>/);
  if (!scheduledMatch) return null;

  const scheduledStr = scheduledMatch[1];
  // Extract date and optional time
  const dateTimeMatch = scheduledStr.match(/(\d{4}-\d{2}-\d{2})\s+\w+\s*(\d{2}:\d{2})?/);
  if (!dateTimeMatch) return null;

  const dateStr = dateTimeMatch[1];
  const timeStr = dateTimeMatch[2];
  const allDay = !timeStr;

  if (allDay) {
    const date = new Date(dateStr + "T00:00:00");
    return { date, allDay: true };
  } else {
    const date = new Date(dateStr + "T" + timeStr + ":00");
    // Try to parse duration token [d:...]
    const durationMins = parseDurationToken(content) ?? undefined;
    return { date, allDay: false, durationMins };
  }
};

const markerToKind = (marker: string | undefined): TaskKind => {
  if (marker === "DONE") return "done";
  if (marker === "CANCELED") return "canceled";
  if (marker === "DOING" || marker === "NOW") return "inProgress";
  return "open";
};

const extractTitleLine = (content: string): string =>
  content
    .split("\n")
    .find((line: string) => !line.startsWith("SCHEDULED:") && !line.startsWith("DEADLINE:")) || "";

export const createMdAdapter = (): GraphAdapter => ({
  graphKind: "md",

  async fetchTasks(): Promise<TimeboxTask[]> {
    const scheduledBlocks = await logseq.DB.datascriptQuery(`
      [:find (pull
        ?block
        [:block/uuid
          :block/content
          :block/marker
          :block/scheduled
          :block/deadline
          {:block/page
            [:db/id :block/name :block/original-name :block/journal-day :block/journal?]}])
        :where
        [?block :block/scheduled]
        (or-join [?block]
          (and
            [?block :block/marker ?marker]
            [(contains? #{"TODO" "DOING" "NOW" "LATER" "WAITING" "DONE" "CANCELED"} ?marker)])
          [(missing? $ ?block :block/marker)])]
    `);

    const tasks: TimeboxTask[] = [];
    if (!scheduledBlocks?.length) return tasks;

    for (const result of scheduledBlocks) {
      const block = result[0];
      if (!block || !block.scheduled) continue;

      // Parse scheduled date
      let scheduledInfo = parseScheduledTime(block.content || "");
      if (!scheduledInfo) {
        // Fallback to block.scheduled property (YYYYMMDD format)
        const scheduledStr = String(block.scheduled);
        const year = parseInt(scheduledStr.substring(0, 4));
        const month = parseInt(scheduledStr.substring(4, 6)) - 1;
        const day = parseInt(scheduledStr.substring(6, 8));
        scheduledInfo = { date: new Date(year, month, day), allDay: true };
      }

      const title = extractTitleLine(block.content || "") || "Untitled";
      const cleanTitle = title.replace(/^\[(TODO|DOING|NOW|LATER|WAITING|DONE|CANCELED)\]\s*/, "").trim();

      tasks.push({
        uuid: block.uuid,
        title: cleanTitle,
        start: scheduledInfo.date,
        allDay: scheduledInfo.allDay,
        durationMins: !scheduledInfo.allDay && scheduledInfo.durationMins ? scheduledInfo.durationMins : null,
        kind: markerToKind(block.marker),
        highPriority:
          !!block.marker &&
          priorityARedMarkers.has(block.marker) &&
          (hasPriorityA(cleanTitle) || hasPriorityA(block.content || "")),
        recurringPattern: parseRepeater(block.content || ""),
        rawStatus: block.marker,
      });
    }
    return tasks;
  },

  async reschedule(uuid: string, start: Date, allDay: boolean, opts: RescheduleOptions): Promise<void> {
    const block = await logseq.Editor.getBlock(uuid);
    if (!block) throw new Error("Block not found");

    const existingDur = opts.preferExistingDuration ? parseDurationToken(block.content || "") : null;
    const durMins = existingDur ?? opts.durationMins;

    // Preserve repeater pattern (e.g., ++1w, .+1d)
    const repeater = parseRepeater(block.content || "");
    const repeaterSuffix = repeater ? ` ${repeater}` : "";

    // Build new SCHEDULED with repeater preserved
    const newScheduledText = `SCHEDULED: <${formatScheduledDate(start, allDay)}${repeaterSuffix}>`;
    let updatedContent = (block.content || "").replace(/SCHEDULED:\s*<[^>]+>(?:\s*\[d:[^\]]+\])?/, newScheduledText);

    // Ensure duration token is on the title line
    updatedContent = updateDurationTokenInContent(updatedContent, !allDay && durMins ? durMins : null);

    await logseq.Editor.updateBlock(uuid, updatedContent);
  },

  async clearSchedule(uuid: string): Promise<void> {
    const block = await logseq.Editor.getBlock(uuid);
    if (!block) throw new Error("Block not found");

    // Remove SCHEDULED line and duration token
    let updatedContent = (block.content || "")
      .split("\n")
      .filter((line: string) => !line.trim().startsWith("SCHEDULED:"))
      .join("\n");
    updatedContent = updatedContent.replace(/\s*\[d:[^\]]+\]/g, "");
    updatedContent = updatedContent.trimEnd();

    await logseq.Editor.updateBlock(uuid, updatedContent);
  },

  async createTask(date: Date, allDay: boolean, durationMins: number | null): Promise<boolean> {
    const page = await getOrCreateJournalPage(date);
    if (!page) return false;

    let todoText = "TODO new todo from calendar ui";
    todoText = updateDurationTokenInContent(todoText, !allDay && durationMins ? durationMins : null);

    // Format: title with [d:...] on first line, SCHEDULED on second line
    const scheduledText = `SCHEDULED: <${formatScheduledDate(date, allDay)}>`;
    const blockContent = `${todoText}\n${scheduledText}`;

    const block = await logseq.Editor.appendBlockInPage(page.uuid, blockContent);
    if (!block) return false;

    if (page.name) {
      await logseq.Editor.scrollToBlockInPage(page.name, block.uuid);
    }
    return true;
  },

  async cycleStatus(uuid: string): Promise<string | null> {
    const block = await logseq.Editor.getBlock(uuid);
    if (!block) return null;
    const next = nextTriCycleMarker(block.marker as string | undefined);
    const newContent = applyTriCycleMarkerToContent(block.content || "", next);
    await logseq.Editor.updateBlock(uuid, newContent);
    return next;
  },

  async navigateToTask(uuid: string): Promise<void> {
    const block = await logseq.Editor.getBlock(uuid);
    if (!block?.page) return;
    const { id: pageId, originalName } = block.page;
    let pageName = originalName;
    if (!pageName) {
      const page = await logseq.Editor.getPage(pageId);
      pageName = page?.originalName || page?.name;
    }
    if (pageName) {
      await logseq.Editor.scrollToBlockInPage(pageName, uuid);
    }
  },

  async getEditableTitle(uuid: string): Promise<string | null> {
    const block = await logseq.Editor.getBlock(uuid);
    if (!block) return null;
    return extractTitleLine(block.content || "");
  },

  async saveTitle(uuid: string, title: string): Promise<void> {
    const block = await logseq.Editor.getBlock(uuid);
    if (!block) return;

    // Replace the title line while preserving SCHEDULED/DEADLINE lines
    const lines = (block.content || "").split("\n");
    const titleIndex = lines.findIndex(
      (line: string) => !line.startsWith("SCHEDULED:") && !line.startsWith("DEADLINE:")
    );
    if (titleIndex !== -1) {
      lines[titleIndex] = title;
    } else {
      lines.unshift(title);
    }

    await logseq.Editor.updateBlock(uuid, lines.join("\n"));
  },
});
