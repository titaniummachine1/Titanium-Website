import { aceStrengthPresetsForPlayerType } from '../lib/aceTier.js';
import {
  STRENGTH_LEVEL_PRESETS,
  TIME_TO_MOVE_PRESETS,
  formatMaxDepth,
  formatVisitsCap,
  formatWallClock,
  maxDepthFromVisitsBudget,
  coresSliderMax,
  defaultCoreCount,
  visitsFromSliderPosition,
} from '../lib/timeControl.js';
import { playerColorLabel, playerColorName } from '../lib/playerColors.js';
import { renderDiscreteSlider } from './discreteSlider.js';
import { wireRangeSlider } from './sliderWire.js';
import './scrapedSlider.css';

export function renderPlayersPanel(container, state, controller) {
  const { settings, playerAiSettingsUi, playerOptionGroups, uiMode } = state;
  const isPlay = uiMode === 'play';
  const [p1Ui, p2Ui] = playerAiSettingsUi ?? [];

  container.innerHTML = `
    <section class="players-card ${isPlay ? '' : 'players-card--dim'}">
      <div class="player-slot player-slot--white">
        <label class="control-label">${playerColorLabel(1)}</label>
        ${renderPlayerSelect('player1', settings.players[0], playerOptionGroups)}
        ${renderPlayerAiSettings(p1Ui, 1)}
      </div>
      <div class="player-slot player-slot--black">
        <label class="control-label">${playerColorName(2)}</label>
        ${renderPlayerSelect('player2', settings.players[1], playerOptionGroups)}
        ${renderPlayerAiSettings(p2Ui, 2)}
      </div>
    </section>
  `;

  container.querySelector('[data-setting="player1"]')?.addEventListener('change', (event) => {
    controller.setPlayer(1, event.target.value);
  });
  container.querySelector('[data-setting="player2"]')?.addEventListener('change', (event) => {
    controller.setPlayer(2, event.target.value);
  });

  wirePlayerAiSettings(container, controller, 1);
  wirePlayerAiSettings(container, controller, 2);
}

function wirePlayerAiSettings(container, controller, playerNum) {
  const refresh = () => controller.onChange?.();

  wireRangeSlider(
    container,
    `[data-setting="strength-level-${playerNum}"]`,
    (value) => controller.setPlayerStrengthLevel(playerNum, value, { silent: true }),
    refresh,
  );

  wireRangeSlider(
    container,
    `[data-setting="time-to-move-${playerNum}"]`,
    (value) => controller.setPlayerTimeToMove(playerNum, value, { silent: true }),
    refresh,
  );

  wireRangeSlider(
    container,
    `[data-setting="wallclock-${playerNum}"]`,
    (value) => {
      controller.setPlayerWallClock(playerNum, value, { silent: true });
      const label = container.querySelector(`[data-wallclock-label="${playerNum}"]`);
      if (label) {
        label.textContent = formatWallClock(Number(value));
      }
    },
    refresh,
  );

  wireRangeSlider(
    container,
    `[data-setting="visits-${playerNum}"]`,
    (value) => {
      const visits = visitsFromSliderPosition(value);
      controller.setPlayerVisitsBudget(playerNum, visits, { silent: true });
      const label = container.querySelector(`[data-visits-label="${playerNum}"]`);
      if (label) {
        const isV3 = controller.getPlayerAiSettingsUiForSlot(playerNum).isQuoridorV3;
        label.textContent = isV3
          ? formatMaxDepth(maxDepthFromVisitsBudget(visits))
          : formatVisitsCap(visits);
      }
    },
    refresh,
  );

  if (controller.getPlayerAiSettingsUiForSlot(playerNum).hasNativeTitaniumLazySmp) {
    wireRangeSlider(
      container,
      `[data-setting="cores-${playerNum}"]`,
      (value) => {
        controller.setPlayerCores(playerNum, value, { silent: true });
        const label = container.querySelector(`[data-cores-label="${playerNum}"]`);
        if (label) {
          label.textContent = String(value);
        }
      },
      refresh,
    );
  }

}

function renderPlayerAiSettings(ui, playerNum) {
  if (!ui || ui.isHuman) {
    return '';
  }

  const engineName = ui.engineName ?? 'AI';

  if (ui.isLocalMcts) {
    const { min: tMin, max: tMax, step: tStep } = ui.wallclockRange;
    const { min: vMin, max: vMax, step: vStep } = ui.visitsRange;
    const budgetLabel = ui.isTitanium ? 'Nodes' : ui.isQuoridorV3 ? 'Depth' : 'Rollouts';
    const visitsSlider = ui.isAceEngine
      ? ''
      : `
        <label class="control-label control-label--sub">${budgetLabel} · ${escapeHtml(engineName)}</label>
        <div class="time-slider-row">
          <input
            type="range"
            class="time-slider scraped-slider"
            data-setting="visits-${playerNum}"
            min="${vMin}"
            max="${vMax}"
            step="${vStep}"
            value="${ui.visitsSliderPosition}"
          />
          <output class="time-slider-value" data-visits-label="${playerNum}">${
            ui.isQuoridorV3
              ? formatMaxDepth(maxDepthFromVisitsBudget(ui.visitsBudget))
              : formatVisitsCap(ui.visitsBudget)
          }</output>
        </div>`;
    return `
      <div class="player-ai-settings" data-engine="${escapeHtml(engineName)}">
        <p class="player-ai-settings__engine">${escapeHtml(engineName)}</p>
        ${ui.isTitanium
        ? renderDiscreteSlider({
          label: `Strength · ${engineName}`,
          settingName: 'strength-level',
          playerNum,
          value: ui.strengthLevel,
          presets: STRENGTH_LEVEL_PRESETS,
        })
        : ''
      }
        ${ui.isAceFamily
        ? renderDiscreteSlider({
          label: `Version · ${engineName}`,
          settingName: 'strength-level',
          playerNum,
          value: ui.strengthLevel,
          presets: aceStrengthPresetsForPlayerType(ui.playerType),
        })
        : ''
      }
        <label class="control-label control-label--sub">Time · ${escapeHtml(engineName)}</label>
        <div class="time-slider-row">
          <input
            type="range"
            class="time-slider scraped-slider"
            data-setting="wallclock-${playerNum}"
            min="${tMin}"
            max="${tMax}"
            step="${tStep}"
            value="${ui.wallClockSeconds}"
          />
          <output class="time-slider-value" data-wallclock-label="${playerNum}">${formatWallClock(ui.wallClockSeconds)}</output>
        </div>
        ${ui.isTitanium
        ? `
        <label class="control-label control-label--sub">Search threads · ${escapeHtml(engineName)}</label>
        <div class="time-slider-row">
          <input
            type="range"
            class="time-slider scraped-slider"
            data-setting="cores-${playerNum}"
            min="1"
            max="${coresSliderMax()}"
            step="1"
            value="${ui.cores ?? defaultCoreCount()}"
          />
          <output class="time-slider-value" data-cores-label="${playerNum}">${ui.cores ?? defaultCoreCount()}</output>
        </div>`
        : ''
      }
        ${visitsSlider}
      </div>`;
  }

  if (ui.isZeroInk) {
    return `
      <div class="player-ai-settings" data-engine="${escapeHtml(engineName)}">
        <p class="player-ai-settings__engine">${escapeHtml(engineName)}</p>
        ${renderDiscreteSlider({
      label: `Time · ${engineName}`,
      settingName: 'time-to-move',
      playerNum,
      value: ui.timeToMove,
      presets: TIME_TO_MOVE_PRESETS,
    })}
      </div>`;
  }

  return `
    <div class="player-ai-settings" data-engine="${escapeHtml(engineName)}">
      <p class="player-ai-settings__engine">${escapeHtml(engineName)}</p>
      ${renderDiscreteSlider({
    label: `Strength · ${engineName}`,
    settingName: 'strength-level',
    playerNum,
    value: ui.strengthLevel,
    presets: STRENGTH_LEVEL_PRESETS,
  })}
      ${renderDiscreteSlider({
    label: `Time · ${engineName}`,
    settingName: 'time-to-move',
    playerNum,
    value: ui.timeToMove,
    presets: TIME_TO_MOVE_PRESETS,
  })}
    </div>`;
}

function renderPlayerSelect(name, value, groups) {
  const options = groups
    .map(
      (group) => `
      <optgroup label="${escapeHtml(group.label)}">
        ${group.options
          .map(
            (opt) =>
              `<option value="${opt.value}" ${opt.value === value ? 'selected' : ''} ${opt.disabled ? 'disabled' : ''}>${escapeHtml(opt.label)}</option>`,
          )
          .join('')}
      </optgroup>`,
    )
    .join('');

  return `<select class="control-select" data-setting="${name}">${options}</select>`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
