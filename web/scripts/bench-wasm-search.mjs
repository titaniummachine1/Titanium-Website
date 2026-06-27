/**
 * WASM search throughput (Node loads web-target glue; no browser worker overhead).
 * Usage: node scripts/bench-wasm-search.mjs [timeMs] [withProgress]
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wasmDir = path.join(webDir, 'src', 'wasm', 'titanium');
const timeMs = Number(process.argv[2] || 10_000);
const withProgress = process.argv[3] !== '0';

const wasmBytes = readFileSync(path.join(wasmDir, 'titanium_bg.wasm'));
const { default: init, WasmEngine } = await import(pathToFileURL(path.join(wasmDir, 'titanium.js')).href);
await init(wasmBytes);

let progressCalls = 0;
const onProgress = withProgress
  ? () => {
      progressCalls += 1;
    }
  : undefined;

const engine = new WasmEngine(2); // hard tier (embedded weights)
const t0 = performance.now();
const mv = engine.go_with_profile(timeMs, 0, 0, 0, 0, onProgress);
const wallMs = performance.now() - t0;
const depth = engine.last_search_depth();
const nodes = Number(engine.last_search_nodes());
const nps = nodes / (wallMs / 1000);

console.log(
  JSON.stringify(
    {
      timeMs,
      withProgress,
      progressCalls,
      move: mv,
      depth,
      nodes,
      wallMs: Math.round(wallMs),
      nps: Math.round(nps),
    },
    null,
    2,
  ),
);
