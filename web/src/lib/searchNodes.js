/**
 * Resolve node counts for UI — prefer Lazy SMP aggregate totals when present.
 */

function sumHelperNodes(helpers) {
  if (!Array.isArray(helpers) || helpers.length === 0) {
    return 0;
  }
  return helpers.reduce((sum, n) => sum + (Number(n) || 0), 0);
}

/**
 * @param {Record<string, unknown> | null | undefined} info
 * @returns {number}
 */
export function resolveDisplayNodes(info) {
  if (!info) {
    return 0;
  }

  const explicitTotal =
    Number(info.totalNodesAcrossWorkers) ||
    Number(info.totalNodes) ||
    Number(info.total_nodes) ||
    0;
  if (explicitTotal > 0) {
    return explicitTotal;
  }

  const main = Number(info.mainThreadNodes ?? info.main_thread_nodes) || 0;
  const helpers = info.helperNodes ?? info.helper_nodes;
  const helperSum = sumHelperNodes(helpers);
  if (main > 0 && helperSum > 0) {
    return main + helperSum;
  }

  const depthLog = /** @type {Array<{ depth?: number; nodes?: number }>} */ (info.depthLog ?? []);
  const deep = depthLog.reduce(
    (best, entry) => ((entry.depth ?? 0) > (best?.depth ?? 0) ? entry : best),
    null,
  );

  return Math.max(
    main,
    Number(info.selectedWorkerNodes) || 0,
    Number(info.nodes) || 0,
    Number(info.simulations) || 0,
    Number(deep?.nodes) || 0,
  );
}

/**
 * Normalize engine / client info payloads onto consistent UI fields.
 * @param {Record<string, unknown>} data
 */
export function enrichNodeFields(data) {
  const mainThread =
    Number(data.mainThreadNodes ?? data.main_thread_nodes) || Number(data.nodes) || 0;
  const helperNodes = data.helperNodes ?? data.helper_nodes;
  const helperSum = sumHelperNodes(helperNodes);
  const totalFromEngine = Number(data.totalNodes ?? data.total_nodes) || 0;
  const totalAcrossWorkers = Number(data.totalNodesAcrossWorkers) || 0;
  const aggregate =
    totalAcrossWorkers ||
    totalFromEngine ||
    (mainThread > 0 && helperSum > 0 ? mainThread + helperSum : 0);
  const displayNodes = aggregate > 0 ? aggregate : mainThread;
  const multiThread =
    aggregate > mainThread ||
    helperSum > 0 ||
    (Array.isArray(helperNodes) && helperNodes.length > 0);

  return {
    nodes: displayNodes,
    totalNodes: aggregate > 0 ? aggregate : undefined,
    totalNodesAcrossWorkers: aggregate > 0 ? aggregate : displayNodes,
    mainThreadNodes: mainThread > 0 ? mainThread : undefined,
    helperNodes: Array.isArray(helperNodes) ? helperNodes : undefined,
    selectedWorkerNodes: mainThread,
    nodeSource: multiThread ? 'bestmove_aggregate' : data.nodeSource,
  };
}
