/** Live LMR tuning strip when CAT/LMR vision is enabled (viz only). */

function visionTuningStructureKey(state) {
  const s = state.settings ?? {};
  if (!s.showCatVision && !s.showLmrVision) {
    return '';
  }
  if (s.uiMode === 'replay') {
    return '';
  }
  return s.showCatVision
    ? `cat-${s.catVisionSource === 'current' ? 'current' : 'v7'}`
    : 'lmr';
}

function syncVisionTuningValues(host, state) {
  const loading = state.catVizLoading || state.lmrVizLoading;
  host.classList.toggle('vision-tuning--refreshing', loading);
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
  const source = settings.catVisionSource === 'current' ? 'current' : 'v7';
  const hint = settings.showLmrVision
    ? 'Fixed 10-ply LMR plan: v15 baseline plus depth-1 dead-tail/backward overrides.'
    : source === 'current'
      ? 'Current CAT: production corridor CAT used by search/LMR; wall overlays come from the production payload.'
      : 'CAT v7 · Plane 4: research-only normalized 0..1 via u8. Non-path 0.25 is pressure-only Lee bonus (max 0.25), not path attention. Lee pressure is min-max normalized over nonzero squares then scaled to 0.25, so max-pressure or all-equal pressure becomes exactly 0.25; sealed late-game boards can paint many such squares by design, not a UI bug. Walls disabled.';
  const sourceToggle =
    settings.showLmrVision
      ? ''
      : `<div class="vision-tuning__sources" role="group" aria-label="CAT source">
          <button type="button" class="btn btn--small ${source === 'current' ? 'btn--primary' : 'btn--ghost'}" data-cat-vision-source="current">Current CAT</button>
          <button type="button" class="btn btn--small ${source === 'v7' ? 'btn--primary' : 'btn--ghost'}" data-cat-vision-source="v7">CAT v7</button>
        </div>`;

  return `
    <div class="vision-tuning" data-vision-tuning>
      <p class="vision-tuning__title">Vision tuning <span class="vision-tuning__badge">local only</span></p>
      <p class="vision-tuning__hint">${hint}</p>
      ${sourceToggle}
    </div>`;
}

function wireVisionTuningPanel(host, controller) {
  host.querySelectorAll('[data-cat-vision-source]').forEach((button) => {
    button.addEventListener('click', () => {
      controller.setCatVisionSource?.(button.dataset.catVisionSource);
    });
  });
}

/** Mount or refresh the live tuning strip above the board controls. Dev builds only. */
export function updateVisionTuningPanel(container, state, controller) {
  let slot = container.querySelector('[data-vision-tuning-root]');
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
    const boardPlayRow =
      container.querySelector('.board-play-row') ?? container.querySelector('#board-play-row');
    if (boardPlayRow?.parentElement === container) {
      boardPlayRow.insertAdjacentElement('afterend', slot);
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
