#!/usr/bin/env node
'use strict';
/** Benchmark Ka API labeling speed — N position prefixes, one search each.
 *  Usage: node site/ka_teacher_bench.js [intuition|short|medium] [count]
 */
const { spawn } = require('child_process');
const path = require('path');

const mode = process.argv[2] || 'intuition';
const count = Math.max(1, parseInt(process.argv[3], 10) || 10);
const script = path.join(__dirname, 'ka_value_label.js');

// Realistic mid-game prefixes (growing length)
const BASE = ['e2', 'e8', 'e3', 'e7', 'd6h', 'e4v', 'e4', 'f7', 'e5', 'f6', 'f5h', 'f6h'];
const prefixes = [];
for (let i = 0; i < count; i++) {
  const ply = 4 + (i % Math.max(1, BASE.length - 3));
  prefixes.push(BASE.slice(0, Math.min(ply, BASE.length)).join(' '));
}

async function main() {
  console.log(`Ka teacher bench: mode=${mode} positions=${count}`);
  const t0 = Date.now();
  let ok = 0;
  let fail = 0;
  const times = [];

  for (let i = 0; i < prefixes.length; i++) {
    const line = prefixes[i];
    const start = Date.now();
    await new Promise((resolve) => {
      const proc = spawn(process.execPath, [script, '--mode', mode], {
        cwd: path.join(__dirname, '..'),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      proc.stdout.on('data', (d) => { out += d; });
      proc.stderr.on('data', () => {});
      proc.stdin.write(line + '\n');
      proc.stdin.end();
      proc.on('close', (code) => {
        const sec = (Date.now() - start) / 1000;
        times.push(sec);
        if (code === 0 && out.includes('"cp"')) {
          try {
            const j = JSON.parse(out.trim().split('\n').pop());
            if (j.cp != null) {
              ok++;
              console.log(`  ${i + 1}/${count}  ${sec.toFixed(1)}s  cp=${j.cp}  ply=${line.split(' ').length}`);
              resolve();
              return;
            }
          } catch {}
        }
        fail++;
        console.log(`  ${i + 1}/${count}  ${sec.toFixed(1)}s  FAIL`);
        resolve();
      });
    });
  }

  const total = (Date.now() - t0) / 1000;
  const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
  const mx = times.length ? Math.max(...times) : 0;
  console.log('');
  console.log(`Total: ${total.toFixed(1)}s  avg ${avg.toFixed(1)}s/pos  max ${mx.toFixed(1)}s  ok=${ok} fail=${fail}`);
  console.log(`Extrapolate 50 plies/game: ~${(avg * 50 / 60).toFixed(1)} min label time (serial API)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
