import { createMdAdapter } from "./mdAdapter";
import { createDbAdapter } from "./dbAdapter";
import type { GraphAdapter } from "./types";

export type { GraphAdapter, TimeboxTask, TaskKind, RescheduleOptions } from "./types";

let adapterPromise: Promise<GraphAdapter> | null = null;

const detectAdapter = async (): Promise<GraphAdapter> => {
  let explicitIsDbGraph: boolean | null = null;

  // Preferred: explicit host API (may not exist on older hosts)
  try {
    const check = (logseq.App as any)?.checkCurrentIsDbGraph;
    if (typeof check === "function") {
      const result = await check.call(logseq.App);
      if (typeof result === "boolean") {
        explicitIsDbGraph = result;
      }
    }
  } catch {
    // Expected on Logseq OG, whose plugin host predates this DB-only method.
    // Continue to the graph-prefix fallback without reporting a false warning.
  }

  if (explicitIsDbGraph === true) {
    console.info("logseq-timebox: using DB graph adapter (via checkCurrentIsDbGraph)");
    return createDbAdapter();
  }

  // Confirm false/unsupported host results against graph metadata. Web hosts
  // can expose the plugin before their current DB graph has finished loading.
  const graph = await logseq.App.getCurrentGraph();
  if (!graph) {
    throw new Error("logseq-timebox: current graph is not ready");
  }
  const url = (graph as any)?.url ?? "";
  const name = (graph as any)?.name ?? "";
  const isDbGraph = String(url).startsWith("logseq_db_") || String(name).startsWith("logseq_db_");
  const via = isDbGraph || explicitIsDbGraph === null
    ? "graph prefix"
    : "checkCurrentIsDbGraph";

  console.info(`logseq-timebox: using ${isDbGraph ? "DB" : "MD"} graph adapter (via ${via})`);
  return isDbGraph ? createDbAdapter() : createMdAdapter();
};

/** Returns the adapter for the currently open graph (cached until the graph changes). */
export const getGraphAdapter = (): Promise<GraphAdapter> => {
  if (!adapterPromise) {
    adapterPromise = detectAdapter().catch((error) => {
      // An unavailable startup graph is not a stable MD result. Allow the next
      // graph event or calendar refresh to retry detection.
      adapterPromise = null;
      throw error;
    });
  }
  return adapterPromise;
};

/** Drops the cached adapter so the next call re-detects (call on graph switch). */
export const resetGraphAdapter = (): void => {
  adapterPromise = null;
};
