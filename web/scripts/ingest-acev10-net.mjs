/**
 * Regenerate engine/src/ace/net_weights.bin from acev10_engine.js NET_DATA.
 * Run from repo: node site/web/scripts/ingest-acev10-net.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const siteDir = path.resolve(webDir, '..');
const engineJs = fs.readFileSync(path.join(siteDir, '_vendor/acev10_engine.js'), 'utf8');
const match = engineJs.match(/var NET_DATA = (\{[\s\S]*?\});/);
if (!match) {
  throw new Error('NET_DATA not found in acev10_engine.js');
}
const NET_DATA = Function(`"use strict"; return (${match[1]});`)();

const H = NET_DATA.H;
const chunks = [NET_DATA.Wskip, NET_DATA.B1, NET_DATA.W2, NET_DATA.W1C, NET_DATA.PO, NET_DATA.PX];
const floats = chunks.flat();
const buf = Buffer.alloc(floats.length * 8);
for (let i = 0; i < floats.length; i++) {
  buf.writeDoubleLE(Number(floats[i]), i * 8);
}

const out = path.resolve(siteDir, '..', 'engine', 'src', 'ace', 'net_weights.bin');
fs.writeFileSync(out, buf);
console.log(`Wrote ${buf.length} bytes (H=${H}, ${floats.length} f64) → ${out}`);
