/**
 * Node-only probe of native Titanium `fields` output for state parity tests.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteWebRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(siteWebRoot, '../..');
const binName = process.platform === 'win32' ? 'titanium.exe' : 'titanium';

function resolveBinary() {
  if (process.env.TITANIUM_BIN && existsSync(process.env.TITANIUM_BIN)) {
    return process.env.TITANIUM_BIN;
  }
  for (const root of [repoRoot, siteWebRoot, path.resolve(siteWebRoot, '..')]) {
    const bin = path.join(root, 'engine', 'target', 'release', binName);
    if (existsSync(bin)) {
      return bin;
    }
  }
  return null;
}

/** Parse titanium `fields` scalars — turn 0 = White, walls P0/P1 = White/Black. */
export function probeTitaniumFields(moves) {
  const bin = resolveBinary();
  if (!bin) {
    return { ok: false, error: 'titanium binary not found' };
  }

  const args = ['fields', ...(Array.isArray(moves) ? moves : [])];
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    cwd: repoRoot,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.status !== 0) {
    return { ok: false, error: result.stderr?.trim() || `exit ${result.status}` };
  }

  const scalars = /turn=(\d+)\s+walls P0\/P1=(\d+)\/(\d+)/.exec(result.stdout ?? '');
  if (!scalars) {
    return { ok: false, error: 'could not parse Scalars line' };
  }

  const turn = Number(scalars[1]);
  const wallsWhite = Number(scalars[2]);
  const wallsBlack = Number(scalars[3]);

  const plyMatch = /^ready (\d+)/m.exec(result.stderr ?? '');
  const plies = plyMatch ? Number(plyMatch[1]) : moves.length;

  return {
    ok: true,
    sideToMove: turn + 1,
    wallsRemaining: { white: wallsWhite, black: wallsBlack },
    plies,
    rawScalars: scalars[0],
  };
}

export function titaniumBinaryAvailable() {
  return resolveBinary() != null;
}
