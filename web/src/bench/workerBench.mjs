/**
 * Browser benchmark using production TitaniumWasmEngineClient + worker.
 * Driven by scripts/run-browser-bench.mjs or open bench.html?auto=1
 */

import { TitaniumWasmEngineClient } from '../lib/titaniumWasmClient.js';
import { UNLIMITED_VISITS } from '../lib/timeControl.js';

const params = new URLSearchParams(location.search);
const TIME_SEC = Number(params.get('timeSec') || 10);
const RUNS = Number(params.get('runs') || 1);
const AUTO = params.get('auto') === '1';
const WASM_WORKERS = 1;
const NET = params.get('net') || 'easy';

const ENGINE_CONFIG = { engineMode: 'titanium-v15-frozen', kind: 'titanium' };

function engineModeForNet(net) {
  if (net === 'easy') return 'titanium-v15-frozen';
  if (net === 'medium') return 'titanium-v15-medium';
  return 'titanium-v15';
}

function aiSettings() {
  return {
    titaniumNet: NET,
    wallClockSeconds: TIME_SEC,
    visitsBudget: UNLIMITED_VISITS,
    cores: WASM_WORKERS,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runSearch(client, { isFreshGame = false, awaitReady = true } = {}) {
  const engineMode = engineModeForNet(NET);
  return new Promise((resolve, reject) => {
    let finalInfo = null;
    client.onInfo = (info) => {
      if (info.progress === 1) {
        finalInfo = info;
      }
    };
    client.onBestMove = () => {
      const pending = client.pendingRequest;
      const worker0 = pending?.results?.get(0);
      const wallMs = performance.now() - (pending?.started ?? performance.now());
      const selected = worker0?.nodes ?? finalInfo?.selectedWorkerNodes ?? 0;
      const aggregate = finalInfo?.totalNodesAcrossWorkers ?? finalInfo?.nodes ?? selected;
      resolve({
        algebraicMove: worker0?.algebraicMove,
        depth: worker0?.depth ?? finalInfo?.searchDepth,
        selectedWorkerNodes: selected,
        totalNodesAcrossWorkers: aggregate,
        workerNodes: finalInfo?.workerNodes,
        stopReason: worker0?.stopReason,
        searchWallMs: worker0?.searchWallMs,
        clientWallMs: wallMs,
        initMs: pending?.initMs ?? 0,
        nodeSource: finalInfo?.nodeSource ?? 'bestmove',
        wasmWorkers: WASM_WORKERS,
        npsSelected: Math.round(selected / (wallMs / 1000)),
        npsAggregate: Math.round(aggregate / (wallMs / 1000)),
      });
      return true;
    };
    client.onError = (err) => reject(err);
    void client.startRequest({
      aiSettings: aiSettings(),
      moveHistory: [],
      isFreshGame,
      awaitReady,
      engineMode,
    });
  });
}

async function benchThreads(runs, { warmOnly = false } = {}) {
  const cold = [];
  const warm = [];
  for (let i = 0; i < runs; i++) {
    const client = new TitaniumWasmEngineClient({ ...ENGINE_CONFIG, engineMode: engineModeForNet(NET) });
    if (!warmOnly) {
      const t0 = performance.now();
      const first = await runSearch(client, { isFreshGame: true, awaitReady: true });
      cold.push({ ...first, wallMs: Math.round(performance.now() - t0), includesInit: true });
      await sleep(200);
    }
    const t1 = performance.now();
    const second = await runSearch(client, {
      isFreshGame: warmOnly,
      awaitReady: true,
    });
    warm.push({
      ...second,
      wallMs: Math.round(performance.now() - t1),
      includesInit: warmOnly,
    });
    if (!warmOnly) {
      const t2 = performance.now();
      const third = await runSearch(client, { isFreshGame: false, awaitReady: true });
      warm.push({
        ...third,
        wallMs: Math.round(performance.now() - t2),
        includesInit: false,
        label: 'second_on_warm_worker',
      });
    }
    client.destroy();
    await sleep(300);
  }
  return { cold, warm };
}

async function main() {
  const status = document.getElementById('status');
  const out = {
    timeSec: TIME_SEC,
    runs: RUNS,
    net: NET,
    engineMode: engineModeForNet(NET),
    position: 'startpos',
    wasmWorkers: WASM_WORKERS,
    singleWorker: await benchThreads(RUNS),
  };
  window.__BENCH_RESULTS__ = out;
  window.__BENCH_DONE__ = true;
  status.textContent = JSON.stringify(out, null, 2);
}

if (AUTO) {
  main().catch((err) => {
    window.__BENCH_ERROR__ = String(err?.message ?? err);
    window.__BENCH_DONE__ = true;
    document.getElementById('status').textContent = window.__BENCH_ERROR__;
  });
}
