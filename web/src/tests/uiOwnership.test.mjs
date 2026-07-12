/**
 * UI ownership tests — engine settings only in unified dialog.
 * Run: node src/tests/uiOwnership.test.mjs
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { compactPlayerConfigSummary } from '../ui/playerCard.js';
import { PlayerType, StrengthLevel, TimeToMove } from '../lib/engineConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_SRC = path.resolve(__dirname, '..');

function readSrc(relativePath) {
  return readFileSync(path.join(WEB_SRC, relativePath), 'utf8');
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) passed++;
  else {
    failed++;
    console.error('  FAIL:', message);
  }
}

console.log('\n[ui] player card source has no interactive settings');
const playerCardSrc = readSrc('ui/playerCard.js');
assert(!playerCardSrc.includes('renderLiveSettings'), 'no renderLiveSettings');
assert(!playerCardSrc.includes('wireLiveSettings'), 'no wireLiveSettings');
assert(!playerCardSrc.includes('player-card__settings'), 'no settings panel markup');
assert(!playerCardSrc.includes('type="range"'), 'no range sliders in player card');
assert(!playerCardSrc.includes('<select'), 'no select in player card');
assert(playerCardSrc.includes('player-card__config'), 'has read-only config summary');
assert(playerCardSrc.includes('data-player-card-status'), 'status scoped to card');

console.log('\n[ui] controls bar has no engine settings');
const controlsSrc = readSrc('ui/gameControls.js');
assert(!controlsSrc.includes('type="range"'), 'no sliders in controls');
assert(!controlsSrc.includes('Engine settings'), 'no engine settings label');
assert(!controlsSrc.includes('data-cat-setting'), 'CAT display settings not in controls');
assert(!controlsSrc.includes('data-lmr-step'), 'LMR aggressiveness not in controls');
assert(controlsSrc.includes('Settings'), 'Settings button present');

console.log('\n[ui] unified dialog owns engine-specific controls');
const dialogSrc = readSrc('ui/playerDialog.js');
assert(dialogSrc.includes('renderTimeModeControls'), 'remote thinking mode in dialog');
assert(dialogSrc.includes('renderTimeSlider'), 'time slider in dialog');
assert(dialogSrc.includes('renderAceTierControls'), 'ACE tier in dialog');
assert(dialogSrc.includes('renderRemoteStrengthControls'), 'remote strength in dialog');
assert(dialogSrc.includes('renderTitaniumNetControls'), 'titanium net in dialog');
assert(dialogSrc.includes('changePlayers'), 'settings apply via changePlayers');
assert(dialogSrc.includes('Vision overlay'), 'vision mode in dialog');
assert(dialogSrc.includes('data-vision-mode'), 'Off/CAT/LMR mode switch in dialog');
assert(dialogSrc.includes('lmrAggressionPercent'), 'LMR tuning slider in dialog');
assert(!dialogSrc.includes('CAT path tilt'), 'CAT path tilt slider removed from dialog');

console.log('\n[ui] live setting restart preserved in controller');
const controllerSrc = readSrc('game/appController.js');
assert(controllerSrc.includes('_afterLivePlayerSettingChange'), 'live restart helper');
assert(controllerSrc.includes('maybeRequestAiMove'), 'search restart after change');

console.log('\n[ui] compact config summary examples');
const kaSummary = compactPlayerConfigSummary({
  isHuman: false,
  isRemote: true,
  playerType: PlayerType.KaAI,
  strengthLevel: StrengthLevel.Alpha,
  timeToMove: TimeToMove.Long,
});
assert(kaSummary.includes('Ka') && kaSummary.includes('Alpha') && kaSummary.includes('Long'), kaSummary);

const tiSummary = compactPlayerConfigSummary({
  isHuman: false,
  isTitanium: true,
  isLocalMcts: true,
  playerType: PlayerType.TitaniumV16,
  titaniumNet: 'hard',
  wallClockSeconds: 3,
});
assert(
  tiSummary === 'Titanium v16',
  tiSummary,
);

const ti16Summary = compactPlayerConfigSummary({
  isHuman: false,
  isTitanium: true,
  isLocalMcts: true,
  playerType: PlayerType.TitaniumV16,
  titaniumNet: 'hard',
  wallClockSeconds: 5,
});
assert(
  ti16Summary === 'Titanium v16',
  ti16Summary,
);
const tiFallbackSummary = compactPlayerConfigSummary(
  {
    isHuman: false,
    isTitanium: true,
    isLocalMcts: true,
    playerType: PlayerType.TitaniumV16,
    titaniumNet: 'hard',
    wallClockSeconds: 5,
    cores: 8,
  },
  { requestedThreads: 8, effectiveThreads: 1 },
);
assert(tiFallbackSummary.includes('1 thread fallback'), tiFallbackSummary);

assert(compactPlayerConfigSummary({ isHuman: true }) === 'Human', 'human summary');

console.log('\n[ui] live node estimates are marked');
assert(playerCardSrc.includes("'n~'"), 'estimated live node totals use n~ prefix');
assert(playerCardSrc.includes('estimatedTotalNodes'), 'card consumes estimatedTotalNodes flag');
assert(controllerSrc.includes('estimatedTotalNodes: false'), 'completed searches clear estimate flag');

console.log('\n[ui] thinking status markup stays inside player card template');
assert(
  playerCardSrc.indexOf('player-card__status') < playerCardSrc.indexOf('player-card__main')
    || playerCardSrc.includes('player-card__info'),
  'status nested under card info',
);
assert(
  !playerCardSrc.includes('player-ai-settings'),
  'no shared settings panel class in card',
);

console.log('\n════════════════════════════════');
console.log(`TOTAL: ${passed + failed} — passed ${passed}, failed ${failed}`);
if (failed > 0) process.exit(1);
