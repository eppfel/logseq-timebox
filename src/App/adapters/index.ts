import { createMdAdapter } from "./mdAdapter";
import { createDbAdapter } from "./dbAdapter";
import type { GraphAdapter } from "./types";

export type { GraphAdapter, TimeboxTask, TaskKind, RescheduleOptions } from "./types";

let adapterPromise: Promise<GraphAdapter> | null = null;

const detectAdapter = async (): Promise<GraphAdapter> => {
  let isDbGraph = false;
  let via = "default";

  // Preferred: explicit host API (may not exist on older hosts)
  try {
    const check = (logseq.App as any)?.checkCurrentIsDbGraph;
    if (typeof check === "function") {
      const result = await check.call(logseq.App);
      if (typeof result === "boolean") {
        isDbGraph = result;
        via = "checkCurrentIsDbGraph";
      }
    }
  } catch (e) {
    console.warn("logseq-timebox: checkCurrentIsDbGraph failed", e);
  }

  // Fallback: DB graph repo urls/names carry the "logseq_db_" prefix
  if (via === "default") {
    try {
      const graph = await logseq.App.getCurrentGraph();
      const url = (graph as any)?.url ?? "";
      const name = (graph as any)?.name ?? "";
      isDbGraph = String(url).startsWith("logseq_db_") || String(name).startsWith("logseq_db_");
      via = `graph prefix (url=${url})`;
    } catch (e) {
      console.warn("logseq-timebox: getCurrentGraph failed, assuming MD graph", e);
    }
  }

  console.info(`logseq-timebox: using ${isDbGraph ? "DB" : "MD"} graph adapter (via ${via})`);
  return isDbGraph ? createDbAdapter() : createMdAdapter();
};

/** Returns the adapter for the currently open graph (cached until the graph changes). */
export const getGraphAdapter = (): Promise<GraphAdapter> => {
  if (!adapterPromise) adapterPromise = detectAdapter();
  return adapterPromise;
};

/** Drops the cached adapter so the next call re-detects (call on graph switch). */
export const resetGraphAdapter = (): void => {
  adapterPromise = null;
};
