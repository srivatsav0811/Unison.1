'use strict';
// End-to-end smoke test: plays a whole auction against the real server over HTTP + SSE.
// Run with: npm test
process.env.UNISON_LOT_SECONDS = '2';
process.env.UNISON_RESULT_MS = '1500';
process.env.UNISON_LOBBY_SECONDS = '2';

const assert = require('assert');
const { server, CFG } = require('../server');
const PLAYERS = require('../data/players');

let base;
const post = async (path, body) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, ...(await r.json()) };
};
async function state(code, token) {
  const ctl = new AbortController();
  const r = await fetch(`${base}/api/events?code=${code}&token=${token}`, { signal: ctl.signal });
  const reader = r.body.getReader();
  let buf = '';
  for (;;) {
    const { value } = await reader.read();
    buf += Buffer.from(value).toString();
    const m = buf.match(/data: (.*)\n\n/);
    if (m) { ctl.abort(); return JSON.parse(m[1]); }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const id = (name) => PLAYERS.find((p) => p.name === name).id;

async function newRoom(n) {
  const { code } = await post('/api/room', {});
  const ms = [];
  for (let i = 0; i < n; i++) {
    const j = await post('/api/join', { code, name: 'P' + i });
    assert.ok(j.token, 'join ' + i + ' ' + JSON.stringify(j));
    ms.push({ code, token: j.token });
  }
  const act = (m, type, extra = {}) => post('/api/act', { code, token: m.token, type, ...extra });
  return { code, ms, act };
}

async function main() {
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  let n = 0;
  const ok = (msg) => console.log(`  ✓ ${msg}`, ++n && '');

  // ---- player database ----
  assert.ok(PLAYERS.length > 400, 'roster size');
  for (const r of ['BAT', 'BOWL', 'AR', 'WK']) assert.ok(PLAYERS.some((p) => p.role === r), 'role ' + r);
  assert.strictEqual(new Set(PLAYERS.map((p) => p.name.toLowerCase())).size, PLAYERS.length, 'duplicate names');
  ok(`roster has ${PLAYERS.length} unique players across all 4 roles`);

  // ---- lobby ----
  const { code, ms, act } = await newRoom(6);
  const [auc, ...teams] = ms;
  const seventh = await post('/api/join', { code, name: 'Extra' });
  assert.strictEqual(seventh.status, 403);
  ok('7th player is turned away (6 per lobby)');

  assert.strictEqual((await act(auc, 'setRole', { role: 'auctioneer' })).status, 200);
  assert.strictEqual((await act(teams[0], 'setRole', { role: 'auctioneer' })).status, 400);
  for (const t of teams) assert.strictEqual((await act(t, 'setRole', { role: 'team' })).status, 200);
  ok('exactly one auctioneer, five teams');

  assert.strictEqual((await act(auc, 'setBudget', { cr: 49 })).status, 400);
  assert.strictEqual((await act(auc, 'setBudget', { cr: 201 })).status, 400);
  assert.strictEqual((await act(teams[0], 'setBudget', { cr: 100 })).status, 400);
  assert.strictEqual((await act(auc, 'setBudget', { cr: 50 })).status, 200);
  ok('budget limited to 50-200 Cr and only the auctioneer can set it');

  const colors = CFG.PALETTE || (await state(code, auc.token)).cfg.PALETTE;
  assert.strictEqual((await act(teams[0], 'setTeam', { name: 'Royal Strikers', color: colors[5] })).status, 200);
  assert.strictEqual((await act(teams[1], 'setTeam', { name: 'Royal Strikers', color: colors[6] })).status, 400, 'duplicate name');
  assert.strictEqual((await act(teams[1], 'setTeam', { name: 'Blue Hawks', color: colors[5] })).status, 400, 'duplicate colour');
  const names = ['Royal Strikers', 'Blue Hawks', 'Green Lions', 'Night Owls', 'Fire Foxes'];
  for (let i = 0; i < 5; i++) assert.strictEqual((await act(teams[i], 'setTeam', { name: names[i], color: colors[i + 5] })).status, 200);
  ok('team names and colours must be unique');

  assert.strictEqual((await act(auc, 'skipCountdown')).status, 400);
  await act(auc, 'startCountdown');
  for (let i = 0; i < 4; i++) await act(teams[i], 'lock', { locked: true });
  assert.strictEqual((await act(auc, 'skipCountdown')).status, 400, 'skip before all locked');
  await act(teams[4], 'lock', { locked: true });
  assert.strictEqual((await act(auc, 'skipCountdown')).status, 200);
  let s = await state(code, auc.token);
  assert.strictEqual(s.phase, 'retention');
  assert.ok(s.teams.every((t) => t.purse === 5000));
  ok('countdown can be skipped only once every team is locked; all purses = ₹50 Cr');

  // ---- retention ----
  assert.strictEqual((await act(teams[0], 'retain', { pid: id('Virat Kohli') })).status, 200);
  assert.strictEqual((await act(teams[1], 'retain', { pid: id('Virat Kohli') })).status, 400);
  s = await state(code, auc.token);
  assert.strictEqual(s.teams[0].purse, 5000 - 750);
  await act(teams[0], 'retain', { pid: id('MS Dhoni') });
  await act(teams[0], 'retain', { pid: id('Rohit Sharma') });
  assert.strictEqual((await act(teams[0], 'retain', { pid: id('Jasprit Bumrah') })).status, 400, 'max 3');
  s = await state(code, auc.token);
  assert.strictEqual(s.teams[0].purse, 5000 - 750 - 550 - 400);
  await act(teams[0], 'unretain', { pid: id('MS Dhoni') });
  s = await state(code, auc.token);
  assert.strictEqual(s.teams[0].purse, 5000 - 750 - 550, 'slabs re-price after un-retain');
  ok('retention: max 3, slab prices, no double-retaining, refunds on undo');

  assert.strictEqual((await act(teams[0], 'startAuction')).status, 400);
  assert.strictEqual((await act(auc, 'startAuction')).status, 200);

  // ---- bidding ----
  const bumrah = id('Jasprit Bumrah');
  assert.strictEqual((await act(teams[1], 'startLot', { pid: bumrah, base: 200 })).status, 400);
  assert.strictEqual((await act(auc, 'startLot', { pid: id('Virat Kohli'), base: 200 })).status, 400, 'retained player');
  assert.strictEqual((await act(auc, 'startLot', { pid: bumrah, base: 10 })).status, 400);
  assert.strictEqual((await act(auc, 'startLot', { pid: bumrah, base: 200 })).status, 200);
  assert.strictEqual((await act(auc, 'startLot', { pid: id('Rashid Khan'), base: 200 })).status, 400, 'one at a time');
  assert.strictEqual((await act(teams[1], 'bid', { price: 200 })).status, 200);
  assert.strictEqual((await act(teams[1], 'bid')).status, 400, 'cannot outbid yourself');
  assert.strictEqual((await act(teams[2], 'bid', { price: 200 })).status, 400, 'stale price');
  assert.strictEqual((await act(teams[2], 'bid', { price: 220 })).status, 200);
  s = await state(code, auc.token);
  assert.strictEqual(s.lot.bid, 220);
  ok('bids follow increments, one lot at a time, stale/duplicate bids rejected');

  await sleep(2500); // clock runs out -> auto-sold to highest bidder
  s = await state(code, auc.token);
  assert.ok(s.lot && s.lot.status === 'sold' && s.lot.soldTo === s.teams[2].id && s.lot.soldPrice === 220);
  assert.strictEqual(s.teams[2].purse, 5000 - 220);
  ok('timer expiry sells the player to the top bidder (SOLD state)');
  await sleep(1700);

  // unsold on expiry, with no bids
  await act(auc, 'startLot', { pid: id('Rashid Khan'), base: 200 });
  await sleep(2600);
  s = await state(code, auc.token);
  assert.ok(s.lot && s.lot.status === 'unsold');
  assert.ok(s.unsold.includes(id('Rashid Khan')));
  ok('no bids -> UNSOLD state');
  await sleep(1700);

  // manual declare + unsold
  await act(auc, 'startLot', { pid: id('Kagiso Rabada'), base: 200 });
  assert.strictEqual((await act(auc, 'sell', { team: s.teams[3].id })).status, 200);
  s = await state(code, auc.token);
  assert.strictEqual(s.lot.soldTo, s.teams[3].id);
  await sleep(1700);
  await act(auc, 'startLot', { pid: id('Trent Boult'), base: 200 });
  assert.strictEqual((await act(auc, 'markUnsold')).status, 200);
  await sleep(1700);
  ok('auctioneer can declare the buyer or mark a player unsold');

  // ---- running out of money ----
  const broke = teams[4];
  s = await state(code, auc.token);
  const fox = s.teams[4];
  await act(auc, 'startLot', { pid: id('Ben Stokes'), base: 4900 });
  assert.strictEqual((await act(broke, 'bid', { price: 4900 })).status, 200);
  assert.strictEqual((await act(auc, 'sell', { team: fox.id })).status, 200);
  await sleep(1700);
  s = await state(code, auc.token);
  assert.strictEqual(s.teams[4].purse, 100);
  await act(auc, 'startLot', { pid: id('Jos Buttler'), base: 200 });
  const blocked = await act(broke, 'bid', { price: 200 });
  assert.strictEqual(blocked.status, 400);
  assert.match(blocked.error, /only have/i);
  assert.strictEqual((await act(auc, 'sell', { team: fox.id })).status, 400, 'auctioneer cannot sell above purse either');
  await act(auc, 'markUnsold');
  await sleep(1700);
  // spend the last ₹1 Cr -> purse 0 -> the team is locked out of bidding entirely
  await act(auc, 'startLot', { pid: id('Jofra Archer'), base: 100 });
  assert.strictEqual((await act(auc, 'sell', { team: fox.id })).status, 200);
  await sleep(1700);
  await act(auc, 'startLot', { pid: id('Sunil Narine'), base: 20 });
  const broke2 = await act(broke, 'bid', { price: 20 });
  assert.strictEqual(broke2.status, 400);
  assert.match(broke2.error, /out of money/i);
  ok('a team that cannot afford a bid, or has no money left, is blocked (server-enforced)');
  await act(auc, 'markUnsold');
  await sleep(1700);

  // ---- exchange ----
  s = await state(code, auc.token);
  const t1 = s.teams[1], t2 = s.teams[2];
  const t1p = t1.squad[0]?.pid;
  const t2p = t2.squad[0]?.pid; // bumrah
  assert.ok(t2p === bumrah);
  await act(auc, 'startLot', { pid: id('Pat Cummins'), base: 200 });
  assert.strictEqual((await act(teams[2], 'proposeTrade', { to: t1.id, give: [bumrah], get: [] })).status, 400, 'trades pause on a live lot');
  await act(auc, 'markUnsold');
  await sleep(1700);
  // give t1 a player to swap
  await act(auc, 'startLot', { pid: id('Shreyas Iyer'), base: 200 });
  await act(auc, 'sell', { team: t1.id });
  await sleep(1700);
  const iyer = id('Shreyas Iyer');
  const r1 = await act(teams[2], 'proposeTrade', { to: t1.id, give: [bumrah], get: [iyer], cash: 50 });
  assert.strictEqual(r1.status, 200, JSON.stringify(r1));
  s = await state(code, auc.token);
  const offer = s.trades[s.trades.length - 1];
  assert.strictEqual((await act(teams[2], 'respondTrade', { id: offer.id, action: 'accept' })).status, 400, 'sender cannot accept own offer');
  assert.strictEqual((await act(teams[1], 'respondTrade', { id: offer.id, action: 'accept' })).status, 200);
  const before = { a: t1.purse, b: t2.purse };
  s = await state(code, auc.token);
  assert.ok(s.teams[1].squad.some((x) => x.pid === bumrah) && s.teams[2].squad.some((x) => x.pid === iyer));
  assert.strictEqual(s.teams[2].purse, before.b - 50);
  ok('player-for-player exchange with cash moves players and money');

  // ---- end ----
  assert.strictEqual((await act(teams[0], 'endAuction')).status, 400);
  assert.strictEqual((await act(auc, 'endAuction')).status, 200);
  s = await state(code, auc.token);
  assert.strictEqual(s.phase, 'ended');
  ok('auction ends');

  // ---- lobby timer expiry auto-advances ----
  const r2 = await newRoom(3);
  await r2.act(r2.ms[0], 'setRole', { role: 'auctioneer' });
  await r2.act(r2.ms[1], 'setRole', { role: 'team' });
  await r2.act(r2.ms[2], 'setRole', { role: 'team' });
  await r2.act(r2.ms[0], 'startCountdown');
  await sleep(2600);
  s = await state(r2.code, r2.ms[0].token);
  assert.strictEqual(s.phase, 'retention');
  ok('when the 2-minute countdown expires the lobby closes automatically');

  console.log(`\nAll ${n} checks passed.`);
}

main().then(() => process.exit(0), (e) => { console.error('\nFAILED:', e); process.exit(1); });
