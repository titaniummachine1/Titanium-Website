/**
 * Compact player card — read-only during play.
 *
 * Shows: pawn + color label, engine name, clock, live telemetry, Play now.
 *
 * Interactive engine settings live only in the unified player dialog.
 */

import {
  STRENGTH_LEVEL_PRESETS,
  TIME_TO_MOVE_PRESETS,
  formatWallClock,
  titaniumNetLabel,
  catLmrCeilingLabel,
} from "../lib/timeControl.js";
import { PlayerType, StrengthLevel, TimeToMove } from "../lib/engineConfig.js";
import { playerColorName } from "../lib/playerColors.js";
import {
  formatScoreForCard,
  isMateScore,
  mateInfo,
} from "../lib/engineScore.js";
import { resolveDisplayNodes } from "../lib/searchNodes.js";
import { mergeThinkSnapshots } from "../lib/searchTelemetry.js";
import { aceStrengthPresetsForPlayerType } from "../lib/aceTier.js";
import { openLogsDialog } from "./gameControls.js";

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(s) {
  return escHtml(s).replace(/"/g, "&quot;");
}

function formatMs(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return "";
  const n = Number(ms);
  return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`;
}

function formatNodes(n) {
  if (!n || n <= 0) return "";
  return Number(n).toLocaleString();
}

function resolvePayloadScore(snap) {
  if (!snap) return null;
  const deep = deepestEntry(snap.depthLog);
  return deep?.score ?? snap.score ?? snap.rootScore ?? null;
}

function deepestEntry(depthLog) {
  if (!depthLog?.length) return null;
  return depthLog.reduce((best, e) =>
    e.depth > (best?.depth ?? 0) ? e : best,
  );
}

/** Merge controller search telemetry for the thinking seat (live + finalized partial info). */
function thinkingTelemetry(state, seatIndex) {
  if (!state.aiThinking || state.thinkingSeatIndex !== seatIndex) {
    return null;
  }
  const completed = state.lastCompletedThinkBySeat?.[seatIndex];
  const active = state.activeSearchInfo ?? state.searchInfoBySeat?.[seatIndex];
  const live = state.liveSearch;
  if (!active && !live && !completed) {
    return null;
  }
  const depthLog = active?.depthLog?.length
    ? active.depthLog
    : (live?.depthLog ?? []);
  const incoming = {
    ...(live ?? {}),
    ...(active ?? {}),
    depthLog,
    seatIndex: live?.seatIndex ?? seatIndex,
    playerType: live?.playerType ?? state.settings.players[seatIndex],
    requestSeq: live?.requestSeq ?? state.searchGeneration,
    positionKey: live?.positionKey ?? state.positionKey,
  };
  return mergeThinkSnapshots(completed, incoming);
}

function resolveNodes(snap) {
  return resolveDisplayNodes(snap);
}

function formatNodesLine(snap) {
  const n = resolveNodes(snap);
  if (n <= 0) return "";
  return `${snap?.estimatedTotalNodes ? "n~" : "n"}${formatNodes(n)}`;
}

function formatTelemetryNodes(view) {
  if (view.nodesLine) {
    return view.nodesLine;
  }
  if (view.nodes > 0) {
    return `n${formatNodes(view.nodes)}`;
  }
  return "";
}

function buildEvalHtml(view) {
  if (!view.scoreDisplay) return "";
  return `<div class="player-card__eval${view.isMate ? " player-card__eval--mate" : ""}">${escHtml(view.scoreDisplay)}</div>`;
}

function buildDepthHtml(view) {
  if (view.depth == null) return "";
  return `<div class="player-card__depth" title="Search depth">d${view.depth}</div>`;
}

/** Eval + depth on one centered row under the clock. */
function buildScorelineHtml(view) {
  const evalHtml = buildEvalHtml(view);
  const depthHtml = buildDepthHtml(view);
  if (!evalHtml && !depthHtml) return "";
  return `<div class="player-card__scoreline">${evalHtml}${depthHtml}</div>`;
}

function buildTelemetryHtml(view) {
  const nodes = formatTelemetryNodes(view);
  if (!nodes && view.thinkMs == null) {
    return "";
  }
  const nodesHtml = nodes
    ? `<span class="player-card__telemetry-nodes">${escHtml(nodes)}</span>`
    : "";
  const timeHtml =
    view.thinkMs != null
      ? `<span class="player-card__telemetry-time">${escHtml(formatMs(view.thinkMs))}</span>`
      : "";
  return `${nodesHtml}${timeHtml}`;
}

function resolveDepth(snap) {
  if (!snap) return null;
  const deep = deepestEntry(snap.depthLog);
  return deep?.depth ?? snap.depth ?? snap.searchDepth ?? null;
}

function expandStrengthLabel(label) {
  switch (label) {
    case "Beg.":
      return "Beginner";
    case "Inter.":
      return "Intermediate";
    case "Adv.":
      return "Advanced";
    default:
      return label;
  }
}

function formatTimeSummary(seconds) {
  const formatted = formatWallClock(seconds ?? 10);
  if (formatted.endsWith("ms")) return formatted;
  if (formatted.endsWith("s") && !formatted.includes(" ")) {
    return formatted.replace(/s$/, " s");
  }
  return formatted;
}

export function compactPlayerConfigSummary(ui, snap = null) {
  if (!ui || ui.isHuman) return "Human";

  const engine = shortEngineName(ui.playerType);

  if (ui.isRemote && !ui.isZeroInk) {
    const strength = expandStrengthLabel(
      STRENGTH_LEVEL_PRESETS.find(
        (p) => p.id === (ui.strengthLevel ?? StrengthLevel.Alpha),
      )?.label ?? "Alpha",
    );
    const time =
      TIME_TO_MOVE_PRESETS.find(
        (p) => p.id === (ui.timeToMove ?? TimeToMove.Short),
      )?.label ?? "Short";
    return `${engine} · ${strength} · ${time}`;
  }

  if (ui.isZeroInk) {
    const time =
      TIME_TO_MOVE_PRESETS.find(
        (p) => p.id === (ui.timeToMove ?? TimeToMove.Short),
      )?.label ?? "Short";
    return `${engine} · ${time}`;
  }

  if (ui.isAceFamily) {
    const tiers = aceStrengthPresetsForPlayerType(ui.playerType);
    const tier =
      tiers.find((t) => t.id === (ui.strengthLevel ?? 0))?.label ?? "JS";
    return `${engine} · ${tier} · ${formatTimeSummary(ui.wallClockSeconds)}`;
  }

  if (ui.isTitanium) {
    return engine;
  }

  return `${engine} · ${formatTimeSummary(ui.wallClockSeconds)}`;
}

function shortEngineName(playerType) {
  if (playerType === PlayerType.TitaniumV18) {
    return "Titanium v18";
  }
  if (playerType === PlayerType.TitaniumV17) {
    return "Titanium v17";
  }
  if (playerType === PlayerType.TitaniumV16) {
    return "Titanium v16";
  }
  if (playerType === PlayerType.GorisansonMCTS) return "Gorisanson";
  if (playerType === PlayerType.KaAI) return "Ka";
  if (playerType === PlayerType.ZeroInk) return "zero.ink";
  if (
    playerType === PlayerType.IshtarV3 ||
    playerType === PlayerType.IshtarPonder
  )
    return "Ishtar";
  if (playerType === PlayerType.AceV10) return "ACE v10";
  if (playerType === PlayerType.AceV13) return "ACE v13";
  return String(playerType);
}

/**
 * Spinner ring around the player's colour token while it thinks.
 * Reuses one DOM node across card re-renders (smooth animation) and stays
 * anchored to the pawn so it scrolls with the layout.
 */
/** @param {'thinking' | 'loading' | null} mode */
function updatePawnSpinner(container, mode, seatIndex) {
  const pawnEl = container.querySelector(".player-card__pawn");
  let spinner = container._pawnSpinner;

  if (!mode || !pawnEl) {
    spinner?.remove();
    container._pawnSpinner = null;
    return;
  }

  if (!spinner) {
    spinner = document.createElement("div");
    spinner.className = "pawn-spinner";
    container._pawnSpinner = spinner;
  }

  spinner.dataset.seat = String(seatIndex);
  spinner.classList.toggle("pawn-spinner--loading", mode === "loading");
  if (spinner.parentNode !== pawnEl) {
    pawnEl.appendChild(spinner);
  }
}

function seatLostOnTime(state, seatIndex) {
  return (
    state.endReason === "time" &&
    state.winner != null &&
    state.winner !== seatIndex + 1
  );
}

function seatNeedsClockReset(state, seatIndex) {
  return (
    state.engineStatus?.[seatIndex] === "flagged" ||
    seatLostOnTime(state, seatIndex)
  );
}

/** Stable card layout key — excludes live depth/nodes/pv so we can patch in place. */
export function playerCardStructureKey(state, seatIndex) {
  const playerType = state.settings.players[seatIndex];
  const isHuman = playerType === PlayerType.Human;
  const isThinking = state.aiThinking && state.thinkingSeatIndex === seatIndex;
  const isMyTurn =
    !state.winner && !state.isDraw && state.playerToMove === seatIndex + 1;
  const ui = state.playerAiSettingsUi?.[seatIndex];
  const engineStatus = state.engineStatus?.[seatIndex];
  const engineError = state.engineErrors?.[seatIndex];
  const hasError =
    !isHuman && typeof engineError === "string" && engineError.length > 0;
  const completedSnap = state.lastCompletedThinkBySeat?.[seatIndex];
  const activeSnap = thinkingTelemetry(state, seatIndex);
  const snap = activeSnap ?? completedSnap;
  const isLoading = isMyTurn && !isHuman && engineStatus === "connecting";
  const flagged = engineStatus === "flagged";
  const showResetTime = seatNeedsClockReset(state, seatIndex);

  return JSON.stringify({
    seatIndex,
    playerType,
    isHuman,
    isThinking,
    isLoading,
    isMyTurn,
    winner: state.winner,
    isDraw: state.isDraw,
    endReason: state.endReason ?? null,
    flagged,
    showResetTime,
    configSummary: compactPlayerConfigSummary(ui, snap),
    hasError,
    engineError: hasError ? engineError : "",
  });
}

function derivePlayerCardView(state, seatIndex) {
  const playerType = state.settings.players[seatIndex];
  const isHuman = playerType === PlayerType.Human;
  const isThinking = state.aiThinking && state.thinkingSeatIndex === seatIndex;
  const isMyTurn =
    !state.winner && !state.isDraw && state.playerToMove === seatIndex + 1;
  const colorName = playerColorName(seatIndex + 1);
  const ui = state.playerAiSettingsUi?.[seatIndex];

  const engineStatus = state.engineStatus?.[seatIndex];
  const engineError = state.engineErrors?.[seatIndex];
  const hasError =
    !isHuman && typeof engineError === "string" && engineError.length > 0;

  const isThinkingThisSeat =
    state.aiThinking && state.thinkingSeatIndex === seatIndex;
  const liveSnap = thinkingTelemetry(state, seatIndex);
  const completedSnap = state.lastCompletedThinkBySeat?.[seatIndex];
  // While this seat thinks, keep the last snapshot on screen until live search
  // reports something new (Gorisanson progress arrives in bursts).
  const snap = isThinkingThisSeat
    ? (liveSnap ?? completedSnap)
    : completedSnap;

  const depth = resolveDepth(snap);
  const nodes = resolveNodes(snap);
  const nodesLine = formatNodesLine(snap);
  const score = resolvePayloadScore(snap);
  const thinkMs = liveSnap?.elapsedMs ?? snap?.thinkMs ?? null;
  const rootWinRate = snap?.rootWinRate ?? null;
  const scoreMeta = {
    rootScoreText: snap?.rootScoreText ?? state.eval?.rootScoreText,
    scoreKind: snap?.scoreKind ?? state.eval?.scoreKind,
    scoreProven: snap?.scoreProven ?? state.eval?.scoreProven,
    unavailable:
      snap?.evalUnavailable === true || state.eval?.evalUnavailable === true,
  };

  const isLoading = isMyTurn && !isHuman && engineStatus === "connecting";
  const spinnerMode = hasError
    ? null
    : isThinking
      ? "thinking"
      : isLoading
        ? "loading"
        : null;

  let scoreDisplay = "";
  const isMate = isMateScore(score);
  if (score != null && Number.isFinite(Number(score))) {
    scoreDisplay = formatScoreForCard(score, scoreMeta);
    const mate = mateInfo(score);
    if (mate && mate.dist === 0 && !state.winner && !state.isDraw) {
      const winningSeat = mate.sign > 0 ? seatIndex : 1 - seatIndex;
      const dist =
        winningSeat === 0 ? state.eval?.whiteDist : state.eval?.blackDist;
      if (Number.isFinite(dist) && dist > 0) {
        scoreDisplay = mate.sign > 0 ? `Win in ${dist}` : `Lose in ${dist}`;
      } else {
        scoreDisplay = mate.sign > 0 ? "Winning" : "Losing";
      }
    }
  } else if (scoreMeta.unavailable || (isThinking && rootWinRate == null)) {
    scoreDisplay = "…";
  } else if (rootWinRate != null) {
    scoreDisplay = `${(rootWinRate * 100).toFixed(0)}%`;
  }

  const showPlayNow = isThinking;

  return {
    playerType,
    isHuman,
    isThinking,
    isMyTurn,
    colorName,
    hasError,
    engineError,
    configSummary: compactPlayerConfigSummary(ui, snap),
    spinnerMode,
    scoreDisplay,
    isMate,
    depth,
    nodes,
    nodesLine,
    thinkMs,
    showPlayNow,
    showResetTime: seatNeedsClockReset(state, seatIndex),
    clockText: state.gameClocks?.[seatIndex]?.label ?? "",
    selectedWorkerNodes: snap?.selectedWorkerNodes,
    totalNodesAcrossWorkers: snap?.totalNodesAcrossWorkers,
    nodeSource: snap?.nodeSource,
    progress: snap?.progress,
  };
}

/** Patch live telemetry without tearing down the card DOM (keeps spinner animation). */
export function patchPlayerCardLive(container, state, seatIndex, controller) {
  const view = derivePlayerCardView(state, seatIndex);
  const card = container.querySelector(
    `[data-player-card-seat="${seatIndex}"]`,
  );
  if (!card) {
    return false;
  }

  card.classList.toggle("player-card--active", view.isMyTurn);
  card.classList.toggle("player-card--winner", state.winner === seatIndex + 1);

  const statsEl = card.querySelector(".player-card__telemetry");
  const scorelineEl = card.querySelector(".player-card__scoreline");
  const evalEl = card.querySelector(".player-card__eval");
  const depthEl = card.querySelector(".player-card__depth");
  const scorelineHtml = buildScorelineHtml(view);
  const telemetryHtml = buildTelemetryHtml(view);
  const center = card.querySelector(".player-card__center");

  if (scorelineEl) {
    if (scorelineHtml) {
      if (evalEl) {
        if (view.scoreDisplay) {
          evalEl.className = `player-card__eval${view.isMate ? " player-card__eval--mate" : ""}`;
          evalEl.textContent = view.scoreDisplay;
        } else {
          evalEl.remove();
        }
      } else if (view.scoreDisplay) {
        const evalNode = document.createElement("div");
        evalNode.className = `player-card__eval${view.isMate ? " player-card__eval--mate" : ""}`;
        evalNode.textContent = view.scoreDisplay;
        scorelineEl.insertBefore(evalNode, scorelineEl.firstChild);
      }
      if (depthEl) {
        if (view.depth != null) {
          depthEl.textContent = `d${view.depth}`;
        } else {
          depthEl.remove();
        }
      } else if (view.depth != null) {
        const depthNode = document.createElement("div");
        depthNode.className = "player-card__depth";
        depthNode.title = "Search depth";
        depthNode.textContent = `d${view.depth}`;
        scorelineEl.appendChild(depthNode);
      }
    } else {
      scorelineEl.remove();
    }
  } else if (scorelineHtml && center) {
    const wrap = document.createElement("div");
    wrap.className = "player-card__scoreline";
    wrap.innerHTML = buildEvalHtml(view) + buildDepthHtml(view);
    const clockEl = center.querySelector("[data-player-card-clock]");
    if (clockEl?.nextSibling) {
      center.insertBefore(wrap, clockEl.nextSibling);
    } else if (clockEl) {
      center.appendChild(wrap);
    } else {
      center.insertBefore(wrap, center.firstChild);
    }
  }

  if (statsEl) {
    if (telemetryHtml) {
      statsEl.innerHTML = telemetryHtml;
    } else {
      statsEl.remove();
    }
  } else if (telemetryHtml && center) {
    const telemetry = document.createElement("div");
    telemetry.className = "player-card__telemetry";
    telemetry.innerHTML = telemetryHtml;
    center.appendChild(telemetry);
  }
  const clockEl = card.querySelector("[data-player-card-clock]");
  if (clockEl) clockEl.textContent = view.clockText;

  const playBtn = card.querySelector('[data-action="play-now"]');
  if (view.showPlayNow && !playBtn) {
    const right = card.querySelector(".player-card__right");
    const btn = document.createElement("button");
    btn.className = "btn btn--playnow";
    btn.dataset.action = "play-now";
    btn.title = "Stop search and play current best move";
    btn.textContent = "Play now";
    btn.addEventListener("click", () => controller.playNow?.());
    right?.appendChild(btn);
  } else if (!view.showPlayNow && playBtn) {
    playBtn.remove();
  }

  const resetBtn = card.querySelector('[data-action="reset-time"]');
  if (view.showResetTime && !resetBtn) {
    const right = card.querySelector(".player-card__right");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn--reset-time";
    btn.dataset.action = "reset-time";
    btn.title = "Reset this seat's clock";
    btn.textContent = "Reset time";
    btn.addEventListener("click", () => controller.resetSeatClock?.(seatIndex));
    right?.appendChild(btn);
  } else if (!view.showResetTime && resetBtn) {
    resetBtn.remove();
  }

  updatePawnSpinner(container, view.spinnerMode, seatIndex);
  return true;
}

function bindPlayerCardActions(container, state, seatIndex, controller) {
  container
    .querySelector('[data-action="play-now"]')
    ?.addEventListener("click", () => {
      controller.playNow?.();
    });

  container
    .querySelector('[data-action="reset-time"]')
    ?.addEventListener("click", () => {
      controller.resetSeatClock?.(seatIndex);
    });

  // Click the pawn icon to see full engine logs (chain-of-thought), same
  // content as the old standalone Logs button -- works even when the engine
  // hasn't errored, not just as an error-recovery affordance.
  const pawnEl = container.querySelector(".player-card__pawn");
  if (pawnEl) {
    pawnEl.classList.add("player-card__pawn--clickable");
    pawnEl.title = "Click for full engine logs";
    pawnEl.addEventListener("click", () => {
      openLogsDialog(controller.getState());
    });
  }

  container
    .querySelector('[data-action="copy-engine-error"]')
    ?.addEventListener("click", (event) => {
      event.stopPropagation();
      openLogsDialog(controller.getState());
    });
}

export function renderPlayerCard(container, state, seatIndex, controller) {
  const structureKey = playerCardStructureKey(state, seatIndex);
  if (
    container._playerCardStructureKey === structureKey &&
    container.querySelector(`[data-player-card-seat="${seatIndex}"]`)
  ) {
    patchPlayerCardLive(container, state, seatIndex, controller);
    return;
  }

  container._playerCardStructureKey = structureKey;
  const view = derivePlayerCardView(state, seatIndex);

  const spinner = container._pawnSpinner;
  if (spinner) {
    spinner.remove();
  }

  const scorelineHtml = buildScorelineHtml(view);
  const telemetryHtml = buildTelemetryHtml(view);

  container.innerHTML = `
    <div class="player-card player-card--seat${seatIndex}${view.isMyTurn ? " player-card--active" : ""}${state.winner === seatIndex + 1 ? " player-card--winner" : ""}" data-player-card-seat="${seatIndex}">
      <div class="player-card__main">
        <div class="player-card__left">
          <div class="player-card__token">
            <div class="player-card__color player-card__color--seat${seatIndex}">${escHtml(view.colorName)}</div>
            <div class="player-card__pawn pawn-icon pawn-icon--seat${seatIndex}">${
              view.hasError
                ? `<button type="button" class="pawn-icon__error" data-action="copy-engine-error" data-seat="${seatIndex}" title="Engine error — click for full game logs:&#10;${escAttr(view.engineError)}" aria-label="Engine error, click for full game logs">!</button>`
                : ""
            }</div>
          </div>
          <div class="player-card__info">
            <div class="player-card__config">${escHtml(view.configSummary)}</div>
          </div>
        </div>
        <div class="player-card__center">
          ${view.clockText ? `<div class="player-card__clock" data-player-card-clock>${escHtml(view.clockText)}</div>` : ""}
          ${scorelineHtml}
          ${telemetryHtml ? `<div class="player-card__telemetry">${telemetryHtml}</div>` : ""}
        </div>
        <div class="player-card__right">
          ${view.showPlayNow ? `<button class="btn btn--playnow" data-action="play-now" title="Stop search and play current best move">Play now</button>` : ""}
          ${view.showResetTime ? `<button type="button" class="btn btn--reset-time" data-action="reset-time" title="Reset this seat's clock">Reset time</button>` : ""}
        </div>
      </div>
    </div>
  `;

  updatePawnSpinner(container, view.spinnerMode, seatIndex);
  bindPlayerCardActions(container, state, seatIndex, controller);
}
