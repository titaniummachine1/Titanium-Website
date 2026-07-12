/**
 * Headless engine play smoke — WASM worker + AppController game start.
 *
 * Open manually:
 *   /smoke.html?auto=1&engines=titanium-v16,titanium-v17&deadlineMs=3000
 *
 * Driven from terminal:
 *   npm run test:engine-smoke
 */

import { PlayerType } from '../lib/engineConfig.js';
import { TitaniumWasmEngineClient } from '../lib/titaniumWasmClient.js';
import { UNLIMITED_VISITS } from '../lib/timeControl.js';
import { toAlgebraic } from '../lib/gameLogic.js';

const params = new URLSearchParams(location.search);
const AUTO = params.get('auto') === '1';
const DEADLINE_MS = Math.max(500, Number(params.get('deadlineMs') || 3000));
const ENGINES = (params.get('engines') || 'titanium-v16,titanium-v17')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function playerTypeForEngineMode(engineMode) {
  return engineMode === 'titanium-v17' ? PlayerType.TitaniumV17 : PlayerType.TitaniumV16;
}

function aiSettings() {
  return {
    titaniumNet: 'hard',
    wallClockSeconds: 2,
    visitsBudget: UNLIMITED_VISITS,
    cores: 1,
  };
}

async function waitForLegalityOracle(controller, timeoutMs) {
  const started = performance.now();
  while (!controller.legalityOracleState.ready && !controller.legalityOracleState.error) {
    if (performance.now() - started > timeoutMs) {
      throw new Error('legality oracle not ready before deadline');
    }
    await sleep(25);
  }
  if (controller.legalityOracleState.error) {
    throw controller.legalityOracleState.error;
  }
}

async function smokeWorker(engineMode) {
  const started = performance.now();
  const client = new TitaniumWasmEngineClient({
    kind: 'titanium',
    engineMode,
    cores: 1,
  });

  const move = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${engineMode} worker: no move within ${DEADLINE_MS}ms`));
    }, DEADLINE_MS);

    client.onError = (err) => {
      clearTimeout(timer);
      reject(err);
    };
    client.onBestMove = (action) => {
      clearTimeout(timer);
      resolve(toAlgebraic(action));
      return true;
    };

    client.startRequest({
      aiSettings: aiSettings(),
      moveHistory: [],
      isFreshGame: true,
      awaitReady: true,
      engineMode,
    }).catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  client.destroy();
  return {
    layer: 'worker',
    engineMode,
    move,
    elapsedMs: Math.round(performance.now() - started),
    ok: true,
  };
}

async function smokeSite(engineMode) {
  const { AppController } = await import('../game/appController.js');
  const started = performance.now();
  const controller = new AppController();
  controller.onChange = () => {};
  controller.onLiveUpdate = () => {};

  void controller.initializeLegalityOracle();
  await waitForLegalityOracle(controller, Math.min(DEADLINE_MS, 10_000));

  const playerType = playerTypeForEngineMode(engineMode);
  const settings = aiSettings();

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const seatErrors = controller.engineErrors ?? {};
      reject(
        new Error(
          `${engineMode} site: no move within ${DEADLINE_MS}ms` +
            (seatErrors[0] || seatErrors[1] ? ` | ${seatErrors[0] || seatErrors[1]}` : ''),
        ),
      );
    }, DEADLINE_MS);

    const poll = () => {
      if (controller.session.actions.length > 0) {
        clearTimeout(timer);
        resolve({
          layer: 'site',
          engineMode,
          move: toAlgebraic(controller.session.actions[0]),
          elapsedMs: Math.round(performance.now() - started),
          ok: true,
        });
      }
    };

    const origOnChange = controller.onChange;
    controller.onChange = () => {
      poll();
      origOnChange?.();
    };

    try {
      controller.newGameWithPlayers({
        players: [playerType, PlayerType.Human],
        playerAiSettings: [settings, null],
      });
      poll();
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });

  controller.destroyEngineForSeat(0);
  controller.destroyEngineForSeat(1);
  return result;
}

async function runEngineSmoke(engineMode) {
  const worker = await smokeWorker(engineMode);
  const site = await smokeSite(engineMode);
  return { engineMode, worker, site };
}

async function main() {
  const status = document.getElementById('status');
  const results = [];
  const errors = [];

  for (const engineMode of ENGINES) {
    status.textContent = `running ${engineMode}…`;
    try {
      results.push(await runEngineSmoke(engineMode));
    } catch (err) {
      errors.push({
        engineMode,
        message: err?.message ?? String(err),
      });
    }
  }

  const out = {
    deadlineMs: DEADLINE_MS,
    engines: ENGINES,
    results,
    errors,
    ok: errors.length === 0,
  };

  window.__SMOKE_RESULTS__ = out;
  window.__SMOKE_DONE__ = true;
  window.__SMOKE_ERROR__ = errors.length
    ? errors.map((entry) => `${entry.engineMode}: ${entry.message}`).join(' | ')
    : null;

  status.textContent = JSON.stringify(out, null, 2);
  if (errors.length > 0) {
    throw new Error(window.__SMOKE_ERROR__);
  }
}

if (AUTO) {
  main().catch((err) => {
    window.__SMOKE_ERROR__ = String(err?.message ?? err);
    window.__SMOKE_DONE__ = true;
    const status = document.getElementById('status');
    if (status) {
      status.textContent = window.__SMOKE_ERROR__;
    }
  });
}
