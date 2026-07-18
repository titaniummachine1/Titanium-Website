/**
 * Titanium abort / request-scoped signal tests.
 * Run: node src/tests/titaniumAbort.test.mjs
 */

import { parseAlgebraic } from '../lib/gameLogic.js';
import {
  cancelActiveSearchRequest,
  createAbortError,
  isAbortError,
} from '../lib/engineAbort.js';
import { TitaniumEngineClient } from '../lib/titaniumRustClient.js';

const REPORTED_MOVES = 'e2 e8 e3 e7 e4 e6 a3h'.split(/\s+/).map((token) => parseAlgebraic(token));

let passed = 0;
let failed = 0;
let fetchDelayMs = 0;
let sessionCallCount = 0;
let stopCallCount = 0;
let goStreamBody = null;
const originalFetch = globalThis.fetch;

function assert(condition, message) {
  if (condition) passed++;
  else {
    failed++;
    console.error('  FAIL:', message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockFetch() {
  globalThis.fetch = async (url, opts = {}) => {
    const signal = opts.signal;
    if (signal?.aborted) {
      throw createAbortError();
    }
    await sleep(fetchDelayMs);
    if (signal?.aborted) {
      throw createAbortError();
    }

    if (String(url).includes('/api/titanium/session')) {
      sessionCallCount += 1;
      const body = JSON.parse(opts.body ?? '{}');
      if (body.op === 'stop') {
        stopCallCount += 1;
        return { ok: true, json: async () => ({ ok: true, stopped: true }) };
      }
      if (body.op === 'go') {
        goStreamBody = body;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              'data: {"type":"info","searchDepth":1,"rootScore":0.1,"nodes":10,"depthLog":[{"depth":1,"score":0.1,"nodes":10,"pv":"e5"}]}\n\n',
            ));
            controller.enqueue(new TextEncoder().encode(
              'data: {"type":"bestmove","algebraic":"e5"}\n\n',
            ));
            controller.close();
          },
        });
        return { ok: true, body: stream };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    }

    throw new Error(`unexpected fetch url ${url}`);
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function makeClient() {
  return new TitaniumEngineClient(
    { engineMode: 'titanium-v16', key: 'titanium-v16' },
    { seatId: 'seat-1' },
  );
}

async function runTests() {
  console.log('\n[abort] isAbortError helpers');
  assert(isAbortError(createAbortError()), 'createAbortError');
  assert(isAbortError({ name: 'AbortError' }), 'name AbortError');
  assert(!isAbortError(new Error('boom')), 'regular error');

  console.log('\n[abort] double cancellation is idempotent');
  {
    const client = makeClient();
    const controller = new AbortController();
    client._activeSearch = { requestId: 1, abortController: controller };
    await client.cancelSearch();
    await client.cancelSearch();
    assert(controller.signal.aborted, 'controller aborted');
    assert(client._activeSearch === null, 'active search cleared');
  }

  console.log('\n[abort] cancel during session sync — no null signal read');
  {
    mockFetch();
    fetchDelayMs = 80;
    sessionCallCount = 0;
    stopCallCount = 0;
    goStreamBody = null;

    const client = makeClient();
    let errorMessage = null;
    let bestMove = null;
    client.onError = (err) => { errorMessage = err?.message ?? String(err); };
    client.onBestMove = (action) => { bestMove = action; return 'stale'; };

    client.requestMove({
      aiSettings: { wallClockSeconds: 3, visitsBudget: 0, strengthLevel: 4, cores: 1 },
      moveHistory: REPORTED_MOVES,
      isFreshGame: false,
    });

    await sleep(10);
    await client.cancelSearch();
    await sleep(200);

    assert(errorMessage == null, `no engine error banner (${errorMessage})`);
    assert(bestMove == null, 'cancelled request did not commit');
    assert(stopCallCount >= 1, 'cancelSearch posts session stop');
    restoreFetch();
  }

  console.log('\n[abort] live setting restart uses new AbortSignal');
  {
    fetchDelayMs = 0;
    sessionCallCount = 0;

    const client = makeClient();

    globalThis.fetch = async (url, opts = {}) => {
      if (String(url).includes('/api/titanium/session')) {
        const body = JSON.parse(opts.body ?? '{}');
        if (body.op === 'stop') {
          return { ok: true, json: async () => ({ ok: true, stopped: true }) };
        }
        if (body.op === 'go') {
          return {
            ok: true,
            body: new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode('data: {"type":"bestmove","algebraic":"e5"}\n\n'));
                c.close();
              },
            }),
          };
        }
        await sleep(body.op === 'position' ? 60 : 0);
        if (opts.signal?.aborted) throw createAbortError();
        return { ok: true, json: async () => ({ ok: true }) };
      }
      throw new Error('unexpected');
    };

    client.requestMove({
      aiSettings: { wallClockSeconds: 3, visitsBudget: 0, strengthLevel: 4, cores: 1 },
      moveHistory: REPORTED_MOVES,
      isFreshGame: false,
    });
    const firstSignal = client._activeSearch?.abortController?.signal;
    await client.cancelSearch();

    client.requestMove({
      aiSettings: { wallClockSeconds: 8, visitsBudget: 0, strengthLevel: 2, cores: 1 },
      moveHistory: REPORTED_MOVES,
      isFreshGame: false,
    });
    const secondSignal = client._activeSearch?.abortController?.signal;

    await sleep(150);

    assert(firstSignal && secondSignal, 'both searches had signals');
    assert(firstSignal !== secondSignal, 'new search got a fresh AbortSignal');
    assert(firstSignal.aborted, 'old signal aborted');
    assert(!secondSignal.aborted, 'new signal active');
    restoreFetch();
  }

  console.log('\n[abort] stale bestmove after cancel is ignored');
  {
    const client = makeClient();
    let commits = 0;
    client.onBestMove = () => {
      commits += 1;
      return 'stale';
    };

    globalThis.fetch = async (url, opts = {}) => {
      if (String(url).includes('/api/titanium/session')) {
        const body = JSON.parse(opts.body ?? '{}');
        if (body.op === 'stop') {
          return { ok: true, json: async () => ({ ok: true, stopped: true }) };
        }
        if (body.op === 'go') {
          return {
            ok: true,
            body: new ReadableStream({
              async start(c) {
                await sleep(40);
                if (opts.signal?.aborted) return;
                c.enqueue(new TextEncoder().encode('data: {"type":"bestmove","algebraic":"e5"}\n\n'));
                c.close();
              },
            }),
          };
        }
        return { ok: true, json: async () => ({ ok: true }) };
      }
      throw new Error('unexpected');
    };

    client.requestMove({
      aiSettings: { wallClockSeconds: 3, visitsBudget: 0, strengthLevel: 4, cores: 1 },
      moveHistory: REPORTED_MOVES,
      isFreshGame: false,
    });
    await sleep(5);
    await client.cancelSearch();
    await sleep(120);

    assert(commits === 0, 'stale stream did not commit after cancel');
    restoreFetch();
  }

  console.log('\n[abort] cancelActiveSearchRequest safe when already aborted');
  {
    const controller = new AbortController();
    controller.abort();
    cancelActiveSearchRequest({ abortController: controller });
    cancelActiveSearchRequest(null);
    assert(true, 'no throw');
  }

  console.log('\n[abort] reported position uses session path without crash');
  {
    mockFetch();
    fetchDelayMs = 0;
    sessionCallCount = 0;
    goStreamBody = null;

    const client = makeClient();
    client.onBestMove = () => 'stale';

    client.requestMove({
      aiSettings: { wallClockSeconds: 5, visitsBudget: 0, strengthLevel: 4, cores: 4 },
      moveHistory: REPORTED_MOVES,
      isFreshGame: false,
    });
    // Incremental makemove sync is one fetch per ply before go — wait for go.
    for (let i = 0; i < 50 && !goStreamBody; i += 1) {
      await sleep(20);
    }

    assert(sessionCallCount >= 2, 'position sync + go');
    assert(goStreamBody?.timeSec === 5, 'go received configured time');
    assert(goStreamBody?.cores === 4, 'go received configured cores');
    assert(goStreamBody?.goMode !== 'rem', 'per-move wallClock does not force go rem');
    restoreFetch();
  }

  console.log('\n════════════════════════════════');
  console.log(`TOTAL: ${passed + failed} — passed ${passed}, failed ${failed}`);
  if (failed > 0) process.exit(1);
}

runTests().finally(restoreFetch);
