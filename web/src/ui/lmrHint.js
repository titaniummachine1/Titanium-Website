export function renderLmrHint(container, state, controller) {
  const existing = container.querySelector('.lmr-hint');
  if (!state.showLmrHint) {
    existing?.remove();
    return;
  }
  if (existing) {
    return;
  }

  const shallow = state.settings.lmrVisionShallow;
  const hint = document.createElement('div');
  hint.className = 'lmr-hint';
  hint.innerHTML = `
    <div class="lmr-hint__card">
      <p class="lmr-hint__title">LMR vision</p>
      <div class="lmr-hint__bar" aria-hidden="true">
        <span class="lmr-hint__swatch lmr-hint__swatch--corridor"></span>
        <span class="lmr-hint__swatch lmr-hint__swatch--cut"></span>
        <span class="lmr-hint__swatch lmr-hint__swatch--share"></span>
      </div>
      <p class="lmr-hint__labels"><span>corridor cm</span><span>ply cut</span><span>node %</span></p>
      <p class="lmr-hint__text">
        ${shallow
    ? '<strong>Shallow</strong> — static LMR plan for this position before any search runs (pierce profile, move window, planned cuts). This is what speeds the tree up.'
    : '<strong>Search</strong> — live root effort after search. Sidebar lists <code>%</code> node share (linear), bar width log-scaled. Board shows node share + child depth + cut.'}
        Colors scale to visible values only (1-ply plan noise hidden). Yellow–red = corridor cm, teal–crimson = ply cut (e.g. <code>−3</code> = search 3 plies shallower), blue–violet = node %. Board numbers are child depth. <code>↺</code> = re-search.
      </p>
      <button type="button" class="btn btn--primary btn--small" data-action="dismiss-lmr-hint">Got it</button>
    </div>
  `;
  hint.querySelector('[data-action="dismiss-lmr-hint"]')?.addEventListener('click', () => {
    controller.dismissLmrHint();
  });
  container.appendChild(hint);
}
