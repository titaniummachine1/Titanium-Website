/** Live LMR tuning strip when CAT/LMR vision is enabled (viz only). */

import { LMR_AGGRESSION_DEFAULT } from '../lib/catHeatmap.js';

const LMR_AGGRESSION_MIN = -500;
const LMR_AGGRESSION_MAX = 150;

function clampLmrAggression(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return LMR_AGGRESSION_DEFAULT;
  }
  return Math.min(LMR_AGGRESSION_MAX, Math.max(LMR_AGGRESSION_MIN, Math.trunc(n)));
}

function visionTuningStructureKey(state) {
  const s = state.settings ?? {};
  if (!s.showCatVision && !s.showLmrVision) {
    return '';
  }
  if (s.uiMode === 'replay') {
    return '';
  }
  return s.showCatVision ? 'cat' : 'lmr';
}

function syncVisionTuningValues(host, state) {
  const settings = state.settings ?? {};
  const lmrAgg = clampLmrAggression(settings.lmrAggressionPercent ?? LMR_AGGRESSION_DEFAULT);
  const lmrSlider = host.querySelector('[data-vision-tuning-slider="lmrAggressionPercent"]');
  if (lmrSlider && document.activeElement !== lmrSlider) {
    lmrSlider.value = String(lmrAgg);
  }
  const lmrLabel = host.querySelector('[data-vision-tuning-label="lmrAggressionPercent"]');
  if (lmrLabel) {
    lmrLabel.textContent = `${lmrAgg}%`;
  }
  const loading = state.catVizLoading || state.lmrVizLoading;
  host.classList.toggle('vision-tuning--refreshing', loading);
  const warn = host.querySelector('.vision-tuning__warn');
  const changed = state.lmrViz?.summary?.protectedMovesChanged ?? 0;
  if (changed > 0) {
    if (!warn) {
      const p = document.createElement('p');
      p.className = 'vision-tuning__warn';
      host.appendChild(p);
    }
    host.querySelector('.vision-tuning__warn').textContent =
      `Protected moves changed (${changed}) — tuning bug`;
  } else if (warn) {
    warn.remove();
  }
}

export function renderVisionTuningPanelHtml(state) {
  // Tuning slider below the board is dev-only; on production it lives in the settings dialog.
  if (!import.meta.env.DEV) {
    return '';
  }
  const settings = state.settings ?? {};
  if (!settings.showCatVision && !settings.showLmrVision) {
    return '';
  }
  if (settings.uiMode === 'replay') {
    return '';
  }
  const lmrAgg = clampLmrAggression(settings.lmrAggressionPercent ?? LMR_AGGRESSION_DEFAULT);

  return `
    <div class="vision-tuning" data-vision-tuning>
      <p class="vision-tuning__title">Vision tuning <span class="vision-tuning__badge">local only</span></p>
      <p class="vision-tuning__hint">Fixed 10-ply LMR tuning: -500% absolute max cut, 0% CAT-shaped max cut, 100% default, 150% full depth.</p>
      <div class="vision-tuning__row">
        <label class="vision-tuning__label">
          LMR tuning
          <span data-vision-tuning-label="lmrAggressionPercent">${lmrAgg}%</span>
        </label>
        <input type="range" class="vision-tuning__slider" data-vision-tuning-slider="lmrAggressionPercent"
          min="${LMR_AGGRESSION_MIN}" max="${LMR_AGGRESSION_MAX}" step="1" value="${lmrAgg}" />
      </div>
      ${state.lmrViz?.summary?.protectedMovesChanged
        ? `<p class="vision-tuning__warn">Protected moves changed (${state.lmrViz.summary.protectedMovesChanged}) — tuning bug</p>`
        : ''}
    </div>`;
}

function wireVisionTuningPanel(host, controller) {
  host.querySelectorAll('[data-vision-tuning-slider]').forEach((input) => {
    if (input.dataset.visionTuningWired) {
      return;
    }
    input.dataset.visionTuningWired = '1';
    input.addEventListener('input', () => {
      const key = input.dataset.visionTuningSlider;
      const value = Number(input.value);
      if (key === 'lmrAggressionPercent') {
        controller.setLmrAggressionPercent?.(value);
      }
      const label = host.querySelector(`[data-vision-tuning-label="${key}"]`);
      if (label) {
        label.textContent = `${clampLmrAggression(value)}%`;
      }
    });
  });
}

/** Mount or refresh the live tuning strip above the board controls. Dev builds only. */
export function updateVisionTuningPanel(container, state, controller) {
  const slot = container.querySelector('[data-vision-tuning-root]');
  if (!import.meta.env.DEV) {
    slot?.remove();
    return;
  }
  const structureKey = visionTuningStructureKey(state);
  if (!structureKey) {
    slot?.remove();
    return;
  }
  if (!slot) {
    slot = document.createElement('div');
    slot.dataset.visionTuningRoot = '';
    const boardSlot = container.querySelector('.board-slot') ?? container.querySelector('#board-slot');
    if (boardSlot?.parentElement) {
      boardSlot.insertAdjacentElement('afterend', slot);
    } else {
      container.prepend(slot);
    }
  }
  if (slot.dataset.visionTuningStructure !== structureKey) {
    slot.dataset.visionTuningStructure = structureKey;
    slot.innerHTML = renderVisionTuningPanelHtml(state);
    wireVisionTuningPanel(slot, controller);
  } else {
    syncVisionTuningValues(slot, state);
  }
}
