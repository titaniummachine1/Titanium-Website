/**
 * Compare WASM builds: default vs simd128. Runs 3 timed searches each.
 * Usage: node scripts/bench-wasm-compare.mjs [timeMs]
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const timeMs = Number(process.argv[2] || 10_000);
const runs = 3;

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function benchPkg(name) {
  const wasmDir = path.join(webDir, 'src', 'wasm', name);
  const wasmBytes = readFileSync(path.join(wasmDir, 'titanium_bg.wasm'));
  const { default: init, WasmEngine } = await import(
    pathToFileURL(path.join(wasmDir, 'titanium.js')).href
  );
  await init(wasmBytes);
  const rows = [];
  for (let i = 0; i < runs; i++) {
    const engine = new WasmEngine(2);
    const t0 = performance.now();
    const mv = engine.go_with_profile(timeMs, 0, 0, 0, 0, undefined);
    const wallMs = performance.now() - t0;
    const nodes = Number(engine.last_search_nodes());
    rows.push({
      run: i + 1,
      move: mv,
      depth: engine.last_search_depth(),
      nodes,
      wallMs: Math.round(wallMs),
      nps: Math.round(nodes / (wallMs / 1000)),
    });
  }
  return {
    pkg: name,
    medianNodes: median(rows.map((r) => r.nodes)),
    medianNps: median(rows.map((r) => r.nps)),
    medianWallMs: median(rows.map((r) => r.wallMs)),
    runs: rows,
  };
}

const results = [];
for (const pkg of ['titanium', 'titanium-simd128']) {
  results.push(await benchPkg(pkg));
}
console.log(JSON.stringify({ timeMs, results }, null, 2));
