// Graph adapter abstraction: one implementation for Markdown (file) graphs,
// one for DB graphs. Everything version-specific lives behind this interface.

/** Normalized task state used for calendar colors. */
export type TaskKind = "done" | "canceled" | "inProgress" | "open";

export interface TimeboxTask {
  uuid: string;
  /** Display title (markers/tokens stripped). */
  title: string;
  start: Date;
  allDay: boolean;
  durationMins: number | null;
  kind: TaskKind;
  /** High priority ([#A] in MD graphs, High/Urgent in DB graphs). Only used for coloring open tasks. */
  highPriority: boolean;
  /** Short human-readable repeat pattern (e.g. "++1w") or null. */
  recurringPattern: string | null;
  /** Raw marker (MD) or status name (DB), for extendedProps. */
  rawStatus?: string;
}

export interface RescheduleOptions {
  /** Duration computed from the calendar event's end, if any. */
  durationMins: number | null;
  /** When true (drag/move), an existing stored duration wins over durationMins (resize passes false). */
  preferExistingDuration: boolean;
}

export interface GraphAdapter {
  readonly graphKind: "md" | "db";
  fetchTasks(): Promise<TimeboxTask[]>;
  reschedule(uuid: string, start: Date, allDay: boolean, opts: RescheduleOptions): Promise<void>;
  clearSchedule(uuid: string): Promise<void>;
  /** Creates a task in the journal page of `date` and navigates to it. Returns false on failure. */
  createTask(date: Date, allDay: boolean, durationMins: number | null): Promise<boolean>;
  /** Cycles Todo → Doing → Done (others jump to Doing). Returns the new status label for the toast. */
  cycleStatus(uuid: string): Promise<string | null>;
  /** Opens the block in Logseq (page navigation / scroll — host-version specific). */
  navigateToTask(uuid: string): Promise<void>;
  getEditableTitle(uuid: string): Promise<string | null>;
  saveTitle(uuid: string, title: string): Promise<void>;
}
