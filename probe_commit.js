// Resolve Ishtar's go/makemove commit semantics on ONE connection.
// Sequence: go (Ishtar P1 plays m1) -> makemove <opp reply> -> go (m3?).
// If m3 is a sane P1 2nd move, go() auto-commits its own move. If m3 replays
// m1, it does not (we must makemove the engine's own move too).
const { QuoridorEngineClient, ENGINES } = require('./extracted/engine_client');
const c = new QuoridorEngineClient(ENGINES.ishtar);
const moves = [];
let step = 0;
c.onRawMessage = (m) => { if (/bestmove|^info time/.test(m)) console.log('<<', m); };
c.onError = (e) => { console.error('error', e.message); process.exit(1); };
c.onBestMove = (action, raw) => {
  const mv = raw.trim().split(' ')[0];
  console.log(`step ${step}: bestmove = ${mv}`);
  moves.push(mv);
  step++;
  if (step === 1) {
    // opponent (P2) reply — a plain pawn step, no flip needed for pawns
    console.log('>> makemove e2 (opponent reply)');
    c.makeMoves([{ coordinate: { column: 'e', row: 2 } }]);
    c.go('intuition');
  } else {
    console.log(`RESULT: m1=${moves[0]} m3=${moves[1]} -> ` +
      (moves[0] === moves[1] ? 'go does NOT commit (replay)' : 'go COMMITS (advanced)'));
    c.destroy();
    process.exit(0);
  }
};
c.connect();
c.go('intuition');
setTimeout(() => { console.log('timeout'); process.exit(1); }, 20000);
