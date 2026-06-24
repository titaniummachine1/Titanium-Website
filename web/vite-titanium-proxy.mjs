/**
 * Dev-server proxy — browser calls /api/titanium/* → native Rust titanium binary.
 * GitHub Pages (ghpages mode) uses WASM workers instead; no proxy, no .exe.
 * Supports SSE progress stream + wall-clock / visit budget from UI sliders.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Monorepo workspace root (parent of `site/`). Canonical `engine/` lives here. */
const monorepoRoot = path.resolve(siteRoot, '..');
const binName = process.platform === 'win32' ? 'titanium.exe' : 'titanium';

function engineBinaryPaths(root) {
  return [
    path.join(root, 'engine', 'target', 'release', binName),
    path.join(root, 'engine', 'target-alt', 'release', binName),
    path.join(root, 'engine', 'target', 'debug', binName),
    path.join(root, 'engine', 'target-alt', 'debug', binName),
  ];
}

/** Prefer monorepo `engine/` — `site/engine/` submodule is often stale. */
function candidateBinaries() {
  const seen = new Set();
  const out = [];
  for (const root of [monorepoRoot, siteRoot]) {
    for (const bin of engineBinaryPaths(root)) {
      if (!seen.has(bin) && existsSync(bin)) {
        seen.add(bin);
        out.push(bin);
      }
    }
  }
  return out;
}

/** Cached after first successful smoke test — rejects stale binaries missing CAT corridor walls. */
let resolvedBin = null;

function titaniumBinaryQuickCheck(bin) {
  const result = spawnSync(bin, ['lmr', 'e2', '--time', '0.1', '--depth', '4'], {
    encoding: 'utf8',
    cwd: monorepoRoot,
    timeout: 15_000,
  });
  if (result.status !== 0) {
    return false;
  }
  try {
    const payload = JSON.parse(String(result.stdout ?? '').trim());
    return (
      payload.source === 'shallow' &&
      Array.isArray(payload.moves) &&
      payload.moves.length >= 4
    );
  } catch {
    return false;
  }
}

/** Strict CAT/LMR alignment check — corridor walls must appear in shallow plan. */
function titaniumSmokeStrict(bin) {
  const result = spawnSync(
    bin,
    ['lmr', 'e2', 'e8', 'e3', 'e7', 'e4', 'e6', '--time', '10', '--depth', '8'],
    {
      encoding: 'utf8',
      cwd: monorepoRoot,
      timeout: 25_000,
    },
  );
  if (result.status !== 0) {
    return false;
  }
  try {
    const payload = JSON.parse(String(result.stdout ?? '').trim());
    const moves = payload.moves ?? [];
    const d5 = moves.find((m) => m.move === 'd5h');
    return (
      payload.source === 'shallow' &&
      moves.length >= 15 &&
      d5 &&
      Number(d5.catCm) >= 200 &&
      d5.reduction === 0
    );
  } catch {
    return false;
  }
}

function titaniumSmokeOk(bin) {
  return titaniumSmokeStrict(bin) || titaniumBinaryQuickCheck(bin);
}

/** Reject stale binaries where --engine ace-v8 still routes to minimax. */
function titaniumAceV8SmokeOk(bin) {
  const result = spawnSync(bin, ['genmove', '--engine', 'ace-v8-ti', '--time', '0.1', '--log'], {
    encoding: 'utf8',
    cwd: monorepoRoot,
    timeout: 20_000,
  });
  if (result.status !== 0) {
    return false;
  }
  const jsonLine = String(result.stderr ?? '')
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith('info json '));
  if (!jsonLine) {
    return false;
  }
  try {
    const payload = JSON.parse(jsonLine.slice('info json '.length));
    return (
      (payload.engine === 'ace-v8' || payload.engine === 'ace-v8-ti') &&
      Array.isArray(payload.depthLog) &&
      payload.depthLog.length > 0
    );
  } catch {
    return false;
  }
}

/** Reject stale binaries where `--engine ace-v10-ti-pmc` still routes to Titanium minimax. */
function titaniumAceV10SmokeOk(bin) {
  const result = spawnSync(
    bin,
    ['genmove', '--engine', 'ace-v10-ti-pmc', '--time', '0.05', '--log'],
    {
      encoding: 'utf8',
      cwd: monorepoRoot,
      timeout: 20_000,
    },
  );
  if (result.status !== 0) {
    return false;
  }
  const jsonLine = String(result.stderr ?? '')
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith('info json '));
  if (!jsonLine) {
    return false;
  }
  try {
    const payload = JSON.parse(jsonLine.slice('info json '.length));
    return (
      payload.engine === 'ace-v10-ti-pmc' &&
      payload.stoppedBy === 'ace-v10-ti-pmc' &&
      Array.isArray(payload.depthLog) &&
      payload.depthLog.length > 0
    );
  } catch {
    return false;
  }
}

function titaniumEngineSmokeOk(bin) {
  return titaniumAceV8SmokeOk(bin) && titaniumAceV10SmokeOk(bin);
}

function resolveBinary() {
  if (
    resolvedBin &&
    existsSync(resolvedBin) &&
    titaniumBinaryQuickCheck(resolvedBin) &&
    titaniumEngineSmokeOk(resolvedBin)
  ) {
    return resolvedBin;
  }
  resolvedBin = null;

  if (process.env.TITANIUM_BIN) {
    const bin = process.env.TITANIUM_BIN;
    if (
      existsSync(bin) &&
      titaniumBinaryQuickCheck(bin) &&
      titaniumEngineSmokeOk(bin)
    ) {
      resolvedBin = bin;
      return bin;
    }
    console.warn(
      `[titanium] proxy: ignoring TITANIUM_BIN=${bin} (missing, failed smoke, or stale ace routing)`,
    );
    delete process.env.TITANIUM_BIN;
  }

  const candidates = candidateBinaries();
  for (const bin of candidates) {
    if (titaniumSmokeOk(bin) && titaniumEngineSmokeOk(bin)) {
      resolvedBin = bin;
      return bin;
    }
  }
  if (candidates.length) {
    throw new Error(
      'Titanium binary failed smoke test (needs ace-v8 + ace-v10 routing) — rebuild: cd engine && cargo build --release',
    );
  }
  throw new Error(
    'Titanium binary missing — run: cd engine && cargo build --release',
  );
}

function prewarmTitaniumBinary() {
  resolvedBin = null;
  try {
    const bin = resolveBinary();
    console.log(`[titanium] proxy using ${bin}`);
    return bin;
  } catch (err) {
    console.error(`[titanium] proxy: ${err.message ?? err}`);
    return null;
  }
}

function parseProgressLine(line) {
  const progress = /^info progress sims (\d+) elapsed_ms (\d+) winrate ([\d.]+)/.exec(line);
  if (progress) {
    return {
      type: 'progress',
      simulations: Number(progress[1]),
      elapsedMs: Number(progress[2]),
      winRate: Number(progress[3]),
      stoppedBy: 'mcts',
    };
  }
  if (line.startsWith('info json ')) {
    try {
      return { type: 'info', ...JSON.parse(line.slice('info json '.length)) };
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeGenmoveEngine(engine) {
  if (
    engine === 'minimax' ||
    engine === 'titanium-v15' ||
    engine === 'titanium-v15-frozen' ||
    engine === 'ace' ||
    engine === 'ace-v8' ||
    engine === 'ace-v10' ||
    engine === 'ace-v13' ||
    engine === 'ace-ti' ||
    engine === 'ace-v8-ti' ||
    engine === 'ace-v10-ti' ||
    engine === 'ace-v13-ti' ||
    engine === 'ace-v8-ti-pmc' ||
    engine === 'ace-v10-ti-pmc' ||
    engine === 'ace-cat'
  ) {
    return engine;
  }
  return 'mcts';
}

function buildGenmoveArgs(moves, options) {
  const timeSec = Math.max(0.1, Number(options.timeSec) || 10);
  const maxSims = Math.max(1, Number(options.maxSimulations) || 2_000_000_000);
  const maxNodes = Math.max(1, Number(options.maxNodes) || maxSims);
  const uct = Number(options.uct) || 0.2;
  const engine = normalizeGenmoveEngine(options.engine);

  const args = ['genmove', ...moves, '--engine', engine, '--time', String(timeSec), '--log'];
  if (engine === 'minimax') {
    args.push('--nodes', String(maxNodes));
  } else if (
    engine === 'titanium-v15' ||
    engine === 'titanium-v15-frozen' ||
    engine === 'ace' ||
    engine === 'ace-v8' ||
    engine === 'ace-v10' ||
    engine === 'ace-v13' ||
    engine === 'ace-ti' ||
    engine === 'ace-v8-ti' ||
    engine === 'ace-v10-ti' ||
    engine === 'ace-v13-ti' ||
    engine === 'ace-v8-ti-pmc' ||
    engine === 'ace-v10-ti-pmc' ||
    engine === 'ace-cat'
  ) {
    if (options.maxDepth != null) {
      args.push('--depth', String(Math.max(1, Math.round(Number(options.maxDepth)))));
    }
  } else {
    args.push('--sims', String(maxSims), '--uct', String(uct));
  }
  return { args, engine, timeSec };
}

function runGenmoveStreaming(moves, options, res) {
  const bin = resolveBinary();
  const { args, engine } = buildGenmoveArgs(moves, options);

  const childEnv = { ...process.env };
  delete childEnv.TITANIUM_DISABLE_BOOK;
  delete childEnv.TITANIUM_BRIDGE;

  const child = spawn(bin, args, { cwd: monorepoRoot, env: childEnv });
  let stdout = '';
  let stderrBuf = '';

  const writeEvent = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split(/\r?\n/);
    stderrBuf = lines.pop() ?? '';
    for (const line of lines) {
      const parsed = parseProgressLine(line.trim());
      if (parsed) {
        writeEvent(parsed);
      }
    }
  });

  child.on('error', (err) => {
    writeEvent({ type: 'error', error: err.message });
    res.end();
  });

  child.on('close', (code) => {
    if (stderrBuf.trim()) {
      const parsed = parseProgressLine(stderrBuf.trim());
      if (parsed) {
        writeEvent(parsed);
      }
    }

    if (code !== 0) {
      writeEvent({ type: 'error', error: `titanium exited ${code}` });
      res.end();
      return;
    }

    const line = stdout.trim().split(/\r?\n/).pop() || '';
    const match = /^bestmove\s+(\S+)/.exec(line);
    if (!match || match[1] === '(none)') {
      writeEvent({ type: 'error', error: `no legal move: ${line}` });
      res.end();
      return;
    }

    writeEvent({
      type: 'bestmove',
      algebraic: match[1],
      stoppedBy: engine,
    });
    res.end();
  });
}

function runGenmoveSync(moves, options) {
  const bin = resolveBinary();
  const { args, engine } = buildGenmoveArgs(moves, options);

  const childEnv = { ...process.env };
  delete childEnv.TITANIUM_DISABLE_BOOK;
  delete childEnv.TITANIUM_BRIDGE;

  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    cwd: monorepoRoot,
    maxBuffer: 4 * 1024 * 1024,
    env: childEnv,
  });

  if (result.error) {
    throw new Error(`Titanium binary not found at ${bin}`);
  }
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `titanium genmove exited ${result.status}`);
  }

  const line = (result.stdout || '').trim().split(/\r?\n/).pop() || '';
  const match = /^bestmove\s+(\S+)/.exec(line);
  if (!match || match[1] === '(none)') {
    throw new Error(`no legal move: ${line}`);
  }

  let meta = { stoppedBy: engine, simulations: 0, nodes: 0 };
  const jsonLine = (result.stderr || '')
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.startsWith('info json '));
  if (jsonLine) {
    try {
      meta = { ...meta, ...JSON.parse(jsonLine.slice('info json '.length)) };
    } catch {
      /* ignore */
    }
  }

  return { algebraic: match[1], ...meta };
}

function runLmrSync(moves, timeSec = 10, idDepth = 8) {
  const bin = resolveBinary();
  const args = ['lmr', ...moves, '--time', String(timeSec), '--depth', String(idDepth)];
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    cwd: monorepoRoot,
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`Titanium binary not found at ${bin}`);
  }
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `titanium lmr exited ${result.status}`);
  }

  const line = (result.stdout || '').trim();
  return JSON.parse(line);
}

/** One long-lived `titanium session` per UI engine seat — TT / killers / history persist. */
const seatSessions = new Map();

class TitaniumSeatSession {
  constructor(seatId, engine = null) {
    this.seatId = seatId;
    this.engine = engine;
    this.stdoutBuf = '';
    this.stderrBuf = '';
    this.chain = Promise.resolve();
    this.pending = null;
    this.child = null;
    this.spawn();
  }

  spawn() {
    const bin = resolveBinary();
    const childEnv = { ...process.env };
    delete childEnv.TITANIUM_DISABLE_BOOK;
    delete childEnv.TITANIUM_BRIDGE;

    const args =
      this.engine &&
      (this.engine.startsWith('ace') ||
        this.engine === 'titanium-v15' ||
        this.engine === 'titanium-v15-frozen')
        ? ['session', '--engine', this.engine]
        : ['session'];
    const child = spawn(bin, args, { cwd: monorepoRoot, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.stdoutBuf = '';
    this.stderrBuf = '';

    child.stdout.on('data', (chunk) => {
      this.stdoutBuf += chunk.toString();
      const lines = this.stdoutBuf.split(/\r?\n/);
      this.stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        this.onStdoutLine(line.trim());
      }
    });

    child.stderr.on('data', (chunk) => {
      this.stderrBuf += chunk.toString();
      const lines = this.stderrBuf.split(/\r?\n/);
      this.stderrBuf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (this.onStderrLine) {
          this.onStderrLine(trimmed);
        }
      }
    });

    child.on('close', () => {
      if (this.child !== child) {
        return;
      }
      if (this.pending) {
        this.pending.reject(new Error(`titanium session ${this.seatId} exited`));
        this.pending = null;
      }
      this.child = null;
      if (seatSessions.get(this.seatId) === this) {
        seatSessions.delete(this.seatId);
      }
    });
  }

  onStdoutLine(line) {
    if (!line || !this.pending) {
      return;
    }
    if (line === 'ready' || line.startsWith('ready ') || line.startsWith('bestmove ') || line.startsWith('error ')) {
      const { resolve, reject } = this.pending;
      this.pending = null;
      if (line.startsWith('error ')) {
        reject(new Error(line.slice(6)));
      } else {
        resolve(line);
      }
    }
  }

  enqueue(line) {
    this.chain = this.chain
      .catch(() => {
        /* recover after interrupted go — next op must not stay wedged */
      })
      .then(() => {
        if (!this.child) {
          this.spawn();
        }
        return new Promise((resolve, reject) => {
          this.pending = { resolve, reject };
          try {
            this.child.stdin.write(`${line}\n`);
          } catch (err) {
            this.pending = null;
            reject(err);
          }
        });
      });
    return this.chain;
  }

  /** Interrupt in-flight `go` — kill only this seat's child; next op respawns via enqueue. */
  stopSearch(reason = 'stopped') {
    const pending = this.pending;
    if (!pending) {
      return Promise.resolve(false);
    }
    this.pending = null;
    this.onStderrLine = null;
    pending.reject(new Error(reason));
    const dying = this.child;
    if (dying) {
      this.child = null;
      try {
        dying.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    return Promise.resolve(true);
  }

  reset() {
    return this.enqueue('reset');
  }

  position(moves) {
    const tail = moves.length ? ` ${moves.join(' ')}` : '';
    return this.enqueue(`position${tail}`);
  }

  makemove(move) {
    return this.enqueue(`makemove ${move}`);
  }

  go(timeSec, maxNodes, onStderrLine) {
    this.onStderrLine = onStderrLine ?? null;
    // Native session REPL accepts `go TIME_SEC` only (see site/engine session.rs).
    return this.enqueue(`go ${timeSec}`);
  }

  destroy() {
    seatSessions.delete(this.seatId);
    if (this.child) {
      try {
        this.child.stdin.write('quit\n');
      } catch {
        /* ignore */
      }
      this.child.kill();
      this.child = null;
    }
  }
}

function getSeatSession(seatId, engine = null) {
  if (!seatId) {
    throw new Error('session seatId required');
  }
  const existing = seatSessions.get(seatId);
  if (existing && (engine ?? null) !== existing.engine) {
    existing.destroy();
  }
  if (!seatSessions.has(seatId)) {
    seatSessions.set(seatId, new TitaniumSeatSession(seatId, engine ?? null));
  }
  return seatSessions.get(seatId);
}

function destroySeatSession(seatId) {
  const session = seatSessions.get(seatId);
  if (session) {
    session.destroy();
  }
}

async function handleSessionOp(payload, res, wantsStream, req) {
  const seatId = String(payload.seatId ?? '');
  const op = String(payload.op ?? '');
  const engine = payload.engine ? normalizeGenmoveEngine(String(payload.engine)) : null;
  const session = getSeatSession(seatId, engine === 'mcts' ? null : engine);

  if (op === 'reset') {
    await session.reset();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (op === 'position') {
    const moves = Array.isArray(payload.moves) ? payload.moves.map(String) : [];
    await session.position(moves);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, plies: moves.length }));
    return;
  }

  if (op === 'makemove') {
    const move = String(payload.move ?? '');
    await session.makemove(move);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, move }));
    return;
  }

  if (op === 'destroy') {
    destroySeatSession(seatId);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (op === 'stop') {
    const stopped = await session.stopSearch('stop');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, stopped }));
    return;
  }

  if (op === 'go') {
    const timeSec = Math.max(0.1, Number(payload.timeSec ?? payload.timeMs / 1000) || 10);
    const maxNodes = Math.max(1, Number(payload.maxNodes ?? payload.maxSimulations) || 2_000_000_000);

    const writeEvent = wantsStream
      ? (event) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      : null;

    if (wantsStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
    }

    const onStderr = (line) => {
      const parsed = parseProgressLine(line);
      if (parsed && writeEvent) {
        writeEvent(parsed);
      }
    };

    const abortGo = () => {
      void session.stopSearch('client disconnected');
    };
    if (req) {
      req.on('close', abortGo);
    }

    try {
      const line = await session.go(timeSec, maxNodes, onStderr);
      const match = /^bestmove\s+(\S+)/.exec(line);
      if (!match || match[1] === '(none)') {
        if (wantsStream) {
          writeEvent({ type: 'error', error: `no legal move: ${line}` });
          res.end();
        } else {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: `no legal move: ${line}` }));
        }
        return;
      }

      const stoppedBy = session.engine ?? 'minimax';
      const payloadOut = {
        type: 'bestmove',
        algebraic: match[1],
        stoppedBy,
      };

      if (wantsStream) {
        writeEvent(payloadOut);
        res.end();
        return;
      }

      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ algebraic: match[1], stoppedBy }));
    } catch (err) {
      if (wantsStream && !res.writableEnded) {
        res.end();
        return;
      }
      if (!res.headersSent) {
        res.statusCode = 499;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err.message ?? String(err) }));
      }
    } finally {
      if (req) {
        req.off('close', abortGo);
      }
    }
    return;
  }

  res.statusCode = 400;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: `unknown session op: ${op}` }));
}

function runCatSync(moves) {
  const bin = resolveBinary();
  const args = ['cat', ...moves];
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    cwd: monorepoRoot,
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`Titanium binary not found at ${bin}`);
  }
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `titanium cat exited ${result.status}`);
  }

  const line = (result.stdout || '').trim();
  return JSON.parse(line);
}

export function titaniumProxyPlugin() {
  return {
    name: 'titanium-rust-proxy',
    configureServer(server) {
      prewarmTitaniumBinary();

      server.middlewares.use('/api/titanium/lmr', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }

        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          try {
            const payload = JSON.parse(body || '{}');
            const moves = Array.isArray(payload.moves) ? payload.moves.map(String) : [];
            const timeSec = Number(payload.timeSec) || 10;
            const idDepth = Number(payload.idDepth ?? payload.searchDepth) || 8;
            const result = runLmrSync(moves, timeSec, idDepth);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(result));
          } catch (err) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message ?? String(err) }));
          }
        });
      });

      server.middlewares.use('/api/titanium/cat', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }

        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          try {
            const payload = JSON.parse(body || '{}');
            const moves = Array.isArray(payload.moves) ? payload.moves.map(String) : [];
            const result = runCatSync(moves);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(result));
          } catch (err) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message ?? String(err) }));
          }
        });
      });

      server.middlewares.use('/api/titanium/session', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }

        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', async () => {
          try {
            const payload = JSON.parse(body || '{}');
            const wantsStream =
              req.headers.accept?.includes('text/event-stream') || payload.stream === true;
            await handleSessionOp(payload, res, wantsStream, req);
          } catch (err) {
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: err.message ?? String(err) }));
            }
          }
        });
      });

      server.middlewares.use('/api/titanium/genmove', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }

        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          try {
            const payload = JSON.parse(body || '{}');
            const moves = Array.isArray(payload.moves) ? payload.moves.map(String) : [];
            const options = {
              timeSec: payload.timeSec ?? payload.timeMs / 1000,
              maxSimulations: payload.maxSimulations ?? payload.visitsBudget,
              maxNodes: payload.maxNodes,
              uct: payload.uct,
              engine: payload.engine ?? 'mcts',
            };

            const wantsStream =
              req.headers.accept?.includes('text/event-stream') || payload.stream === true;

            if (wantsStream) {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
              });
              runGenmoveStreaming(moves, options, res);
              return;
            }

            const result = runGenmoveSync(moves, options);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(result));
          } catch (err) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message ?? String(err) }));
          }
        });
      });
    },
  };
}
