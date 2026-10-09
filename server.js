'use strict';
// Unison IPL Auction server. Zero dependencies: static files + JSON actions + Server-Sent Events.
// All auction rules are enforced here; the browser is only a view.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PLAYERS = require('./data/players');

const PORT = Number(process.env.PORT) || 3000;
const CFG = {
  LOBBY_SECONDS: Number(process.env.UNISON_LOBBY_SECONDS) || 120, // team-setup countdown
  LOT_SECONDS: Number(process.env.UNISON_LOT_SECONDS) || 20, // clock for every player on the block
  EXTEND_TO_SECONDS: Math.min(10, Number(process.env.UNISON_LOT_SECONDS) || 10), // a bid in the last seconds tops the clock back up to this
  RESULT_MS: Number(process.env.UNISON_RESULT_MS) || 4500, // how long the SOLD / UNSOLD stamp stays on screen
  MAX_TEAMS: 5,
  MIN_TEAMS: 2,
  MAX_MEMBERS: 6, // 1 auctioneer + 5 teams
  MAX_SQUAD: 25,
  MAX_RETAIN: 3,
  RETAIN_PCT: [0.15, 0.11, 0.08], // retention cost as a share of the budget, per slot
  MIN_BASE: 20, // lakh
  MIN_BUDGET_CR: 50,
  MAX_BUDGET_CR: 200,
};
const PALETTE = [
  '#1d4ed8', '#facc15', '#7c3aed', '#f97316', '#ec4899',
  '#16a34a', '#14b8a6', '#be123c', '#0ea5e9', '#84cc16',
];
// All money is stored in lakh (1 Cr = 100 L) as integers.
const CR = 100;

const rooms = new Map();
const catalogById = new Map(PLAYERS.map((p) => [p.id, p]));

const uid = (n = 16) => crypto.randomBytes(n).toString('hex');
function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += alphabet[crypto.randomInt(alphabet.length)];
    if (!rooms.has(c)) return c;
  }
}

// IPL-style bid increments.
function increment(price) {
  if (price < 100) return 5;
  if (price < 200) return 10;
  if (price < 500) return 20;
  return 25;
}
const retentionPrice = (budget, idx) =>
  Math.max(25, Math.round((budget * CFG.RETAIN_PCT[idx]) / 25) * 25);

function createRoom() {
  const room = {
    code: newCode(),
    createdAt: Date.now(),
    touched: Date.now(),
    phase: 'lobby', // lobby -> retention -> auction -> ended
    budget: 120 * CR,
    members: new Map(), // token -> member
    teams: [],
    lobbyDeadline: null,
    taken: {}, // playerId -> {team, price, how}
    unsold: new Set(),
    custom: [],
    lot: null,
    trades: [],
    log: [],
    clients: new Set(), // {res, token}
  };
  rooms.set(room.code, room);
  return room;
}

const memberById = (room, id) => [...room.members.values()].find((m) => m.id === id);
const teamById = (room, id) => room.teams.find((t) => t.id === id);
const findPlayer = (room, id) => catalogById.get(id) || room.custom.find((p) => p.id === id);
const addLog = (room, text, kind = 'info') => {
  room.log.push({ t: Date.now(), text, kind });
  if (room.log.length > 300) room.log.shift();
};
const fmt = (l) => (l >= 100 ? `₹${parseFloat((l / 100).toFixed(2))} Cr` : `₹${l} L`);

function isConnected(room, member) {
  for (const c of room.clients) if (c.token === member.token) return true;
  return false;
}

function viewFor(room, token) {
  const me = room.members.get(token);
  const teams = room.teams.map((t) => ({
    id: t.id, name: t.name, color: t.color, locked: t.locked, purse: t.purse,
    squad: t.squad, retDone: t.retDone,
  }));
  const allLocked = teams.length >= CFG.MIN_TEAMS && teams.every((t) => t.locked);
  return {
    serverNow: Date.now(),
    code: room.code,
    phase: room.phase,
    budget: room.budget,
    cfg: { ...CFG, PALETTE },
    me: me ? { id: me.id, role: me.role } : null,
    members: [...room.members.values()].map((m) => ({
      id: m.id, name: m.name, role: m.role, connected: isConnected(room, m),
    })),
    teams,
    lobby: { deadline: room.lobbyDeadline, allLocked },
    taken: room.taken,
    unsold: [...room.unsold],
    custom: room.custom,
    lot: room.lot,
    trades: room.trades.slice(-40),
    log: room.log.slice(-120),
  };
}

function broadcast(room) {
  room.touched = Date.now();
  for (const c of room.clients) {
    c.res.write(`event: state\ndata: ${JSON.stringify(viewFor(room, c.token))}\n\n`);
  }
}

// ---------- game logic ----------

function nextPrice(lot) {
  return lot.bid == null ? lot.base : lot.bid + increment(lot.bid);
}

function finishLobby(room) {
  room.phase = 'retention';
  room.lobbyDeadline = null;
  for (const t of room.teams) {
    t.locked = true;
    t.purse = room.budget;
    t.squad = [];
    t.retDone = false;
  }
  addLog(room, `Teams are set. Every team has ${fmt(room.budget)}. Retention window is open.`, 'phase');
}

function recomputeRetentions(room, team) {
  const retained = team.squad.filter((s) => s.how === 'retained');
  retained.forEach((s, i) => {
    s.price = retentionPrice(room.budget, i);
    room.taken[s.pid] = { team: team.id, price: s.price, how: 'retained' };
  });
  team.purse = room.budget - retained.reduce((a, s) => a + s.price, 0);
}

function resolveLot(room, teamId, price) {
  const lot = room.lot;
  const p = findPlayer(room, lot.pid);
  if (teamId) {
    const t = teamById(room, teamId);
    t.purse -= price;
    t.squad.push({ pid: lot.pid, price, how: 'auction' });
    room.taken[lot.pid] = { team: t.id, price, how: 'auction' };
    room.unsold.delete(lot.pid);
    lot.status = 'sold';
    lot.soldTo = t.id;
    lot.soldPrice = price;
    addLog(room, `SOLD! ${p.name} to ${t.name} for ${fmt(price)}`, 'sold');
  } else {
    room.unsold.add(lot.pid);
    lot.status = 'unsold';
    addLog(room, `UNSOLD: ${p.name} (base ${fmt(lot.base)})`, 'unsold');
  }
  lot.deadline = null;
  lot.resultUntil = Date.now() + CFG.RESULT_MS;
}

function validateTrade(room, tr) {
  const from = teamById(room, tr.from);
  const to = teamById(room, tr.to);
  if (!from || !to || from.id === to.id) return 'Pick another team to trade with.';
  if (!tr.give.length && !tr.get.length) return 'Add at least one player to the deal.';
  for (const pid of tr.give) if (!from.squad.some((s) => s.pid === pid)) return 'A player you are giving is no longer in your squad.';
  for (const pid of tr.get) if (!to.squad.some((s) => s.pid === pid)) return `A player you asked for is no longer in ${to.name}'s squad.`;
  if (from.squad.length - tr.give.length + tr.get.length > CFG.MAX_SQUAD) return `${from.name} would exceed ${CFG.MAX_SQUAD} players.`;
  if (to.squad.length - tr.get.length + tr.give.length > CFG.MAX_SQUAD) return `${to.name} would exceed ${CFG.MAX_SQUAD} players.`;
  if (tr.cash > 0 && from.purse < tr.cash) return `${from.name} cannot afford ${fmt(tr.cash)} cash.`;
  if (tr.cash < 0 && to.purse < -tr.cash) return `${to.name} cannot afford ${fmt(-tr.cash)} cash.`;
  return null;
}

function executeTrade(room, tr) {
  const from = teamById(room, tr.from);
  const to = teamById(room, tr.to);
  const move = (src, dst, pids) => {
    for (const pid of pids) {
      const i = src.squad.findIndex((s) => s.pid === pid);
      const [entry] = src.squad.splice(i, 1);
      entry.how = 'trade';
      dst.squad.push(entry);
      room.taken[pid] = { team: dst.id, price: entry.price, how: 'trade' };
    }
  };
  move(from, to, tr.give);
  move(to, from, tr.get);
  from.purse -= tr.cash;
  to.purse += tr.cash;
}

const tradeText = (room, tr) => {
  const names = (ids) => ids.map((id) => findPlayer(room, id)?.name || id).join(', ') || 'nothing';
  const cash = tr.cash ? ` ${tr.cash > 0 ? '+' : '-'} ${fmt(Math.abs(tr.cash))} cash` : '';
  return `${teamById(room, tr.from).name} gives ${names(tr.give)}${cash} for ${names(tr.get)} from ${teamById(room, tr.to).name}`;
};

const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : NaN);

// Returns an error string, or null on success.
function act(room, member, b) {
  const team = member.role === 'team' ? teamById(room, member.id) : null;
  const isAuctioneer = member.role === 'auctioneer';
  const lotLive = room.lot && room.lot.status === 'live';

  switch (b.type) {
    // ----- lobby -----
    case 'setRole': {
      if (room.phase !== 'lobby') return 'Roles are fixed once the lobby closes.';
      if (team && team.locked) return 'Unlock your team before switching roles.';
      if (b.role === member.role) return null;
      if (b.role === 'auctioneer') {
        if ([...room.members.values()].some((m) => m.role === 'auctioneer')) return 'There is already an auctioneer.';
      } else if (b.role === 'team') {
        if (room.teams.length >= CFG.MAX_TEAMS) return `All ${CFG.MAX_TEAMS} team slots are taken.`;
      } else return 'Unknown role.';
      if (team) room.teams = room.teams.filter((t) => t.id !== member.id);
      member.role = b.role;
      if (b.role === 'team') {
        const used = new Set(room.teams.map((t) => t.color));
        room.teams.push({
          id: member.id, name: `Team ${member.name}`.slice(0, 24),
          color: PALETTE.find((c) => !used.has(c)), locked: false, purse: 0, squad: [], retDone: false,
        });
      }
      return null;
    }
    case 'leave': {
      if (room.phase !== 'lobby') return 'You can only leave during the lobby.';
      room.teams = room.teams.filter((t) => t.id !== member.id);
      room.members.delete(member.token);
      return null;
    }
    case 'setTeam': {
      if (!team) return 'Only teams can do this.';
      if (room.phase !== 'lobby' || team.locked) return 'Unlock your team to edit it.';
      const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
      if (name.length < 2) return 'Team name needs at least 2 characters.';
      if (room.teams.some((t) => t.id !== team.id && t.name.toLowerCase() === name.toLowerCase())) return 'Another team already has that name.';
      if (!PALETTE.includes(b.color)) return 'Pick a colour from the palette.';
      if (room.teams.some((t) => t.id !== team.id && t.color === b.color)) return 'That colour is taken.';
      team.name = name;
      team.color = b.color;
      return null;
    }
    case 'lock': {
      if (!team) return 'Only teams can lock in.';
      if (room.phase !== 'lobby') return 'Too late to change.';
      team.locked = !!b.locked;
      return null;
    }
    case 'setBudget': {
      if (!isAuctioneer || room.phase !== 'lobby') return 'Only the auctioneer can set the budget, before the auction.';
      const cr = int(b.cr);
      if (!(cr >= CFG.MIN_BUDGET_CR && cr <= CFG.MAX_BUDGET_CR)) return `Budget must be ${CFG.MIN_BUDGET_CR}-${CFG.MAX_BUDGET_CR} Cr.`;
      room.budget = cr * CR;
      return null;
    }
    case 'startCountdown': {
      if (!isAuctioneer || room.phase !== 'lobby') return 'Only the auctioneer can start the countdown.';
      if (room.lobbyDeadline) return null;
      room.lobbyDeadline = Date.now() + CFG.LOBBY_SECONDS * 1000;
      addLog(room, `Countdown started: ${CFG.LOBBY_SECONDS / 60} minutes to name and lock in your teams.`, 'phase');
      return null;
    }
    case 'skipCountdown': {
      if (!isAuctioneer || room.phase !== 'lobby' || !room.lobbyDeadline) return 'Nothing to skip.';
      if (room.teams.length < CFG.MIN_TEAMS) return `Need at least ${CFG.MIN_TEAMS} teams.`;
      if (!room.teams.every((t) => t.locked)) return 'Every team must lock in before you can skip the timer.';
      finishLobby(room);
      return null;
    }

    // ----- retention -----
    case 'retain': {
      if (room.phase !== 'retention' || !team) return 'Retention is not open.';
      if (team.retDone) return 'You already confirmed your retentions.';
      const retained = team.squad.filter((s) => s.how === 'retained');
      if (retained.length >= CFG.MAX_RETAIN) return `You can retain at most ${CFG.MAX_RETAIN} players.`;
      const p = findPlayer(room, b.pid);
      if (!p) return 'Unknown player.';
      if (room.taken[p.id]) return `${p.name} has already been retained by another team.`;
      const price = retentionPrice(room.budget, retained.length);
      if (team.purse < price) return 'Not enough money to retain.';
      team.squad.push({ pid: p.id, price, how: 'retained' });
      recomputeRetentions(room, team);
      addLog(room, `${team.name} retained ${p.name} for ${fmt(price)}`, 'retain');
      return null;
    }
    case 'unretain': {
      if (room.phase !== 'retention' || !team || team.retDone) return 'Cannot change retentions now.';
      const i = team.squad.findIndex((s) => s.pid === b.pid && s.how === 'retained');
      if (i < 0) return 'Not retained.';
      team.squad.splice(i, 1);
      delete room.taken[b.pid];
      recomputeRetentions(room, team);
      return null;
    }
    case 'retentionDone': {
      if (room.phase !== 'retention' || !team) return 'Retention is not open.';
      team.retDone = !!b.done;
      return null;
    }
    case 'startAuction': {
      if (!isAuctioneer || room.phase !== 'retention') return 'Only the auctioneer can start the auction.';
      room.phase = 'auction';
      for (const t of room.teams) t.retDone = true;
      addLog(room, 'The auction is LIVE. Good luck!', 'phase');
      return null;
    }

    // ----- auction -----
    case 'addPlayer': {
      if (!isAuctioneer || room.phase === 'lobby' || room.phase === 'ended') return 'Not allowed.';
      const name = String(b.name || '').trim().slice(0, 40);
      if (name.length < 2) return 'Give the player a name.';
      if (![...PLAYERS, ...room.custom].every((p) => p.name.toLowerCase() !== name.toLowerCase())) return 'That player already exists.';
      if (!['BAT', 'BOWL', 'AR', 'WK'].includes(b.role)) return 'Pick a role.';
      const rating = Math.min(99, Math.max(40, int(b.rating) || 60));
      room.custom.push({ id: `c${room.custom.length + 1}`, name, role: b.role, country: String(b.country || 'IND').toUpperCase().slice(0, 3), rating, custom: true });
      return null;
    }
    case 'startLot': {
      if (!isAuctioneer || room.phase !== 'auction') return 'Only the auctioneer can put players on the block.';
      if (room.lot) return 'Finish the current player first.';
      const p = findPlayer(room, b.pid);
      if (!p) return 'Unknown player.';
      if (room.taken[p.id]) return `${p.name} already belongs to a team.`;
      const base = int(b.base);
      if (!(base >= CFG.MIN_BASE) || base % 5 !== 0) return `Base price must be a multiple of 5 L, at least ${CFG.MIN_BASE} L.`;
      const maxPurse = Math.max(...room.teams.map((t) => t.purse));
      if (base > maxPurse) return 'No team can afford that base price.';
      room.lot = { pid: p.id, base, bid: null, bidder: null, history: [], status: 'live', deadline: Date.now() + CFG.LOT_SECONDS * 1000 };
      addLog(room, `On the block: ${p.name} (${p.role}) - base ${fmt(base)}`, 'lot');
      return null;
    }
    case 'bid': {
      if (!team) return 'Only teams can bid.';
      if (!lotLive) return 'There is no player on the block.';
      const lot = room.lot;
      if (lot.bidder === team.id) return 'You already have the highest bid.';
      const price = nextPrice(lot);
      if (b.price != null && int(b.price) !== price) return 'The price just moved. Look again and re-bid.';
      if (team.squad.length >= CFG.MAX_SQUAD) return `Your squad is full (${CFG.MAX_SQUAD}).`;
      if (price > team.purse) return team.purse < CFG.MIN_BASE ? 'You are out of money and cannot bid.' : `You only have ${fmt(team.purse)} left.`;
      lot.bid = price;
      lot.bidder = team.id;
      lot.history.push({ team: team.id, price });
      const left = lot.deadline - Date.now();
      if (left < CFG.EXTEND_TO_SECONDS * 1000) lot.deadline = Date.now() + CFG.EXTEND_TO_SECONDS * 1000;
      return null;
    }
    case 'sell': {
      if (!isAuctioneer || !lotLive) return 'Nothing to sell right now.';
      const t = teamById(room, b.team);
      if (!t) return 'Pick a team.';
      const price = room.lot.bid ?? room.lot.base;
      if (t.squad.length >= CFG.MAX_SQUAD) return `${t.name}'s squad is full.`;
      if (price > t.purse) return `${t.name} cannot afford ${fmt(price)} (has ${fmt(t.purse)}).`;
      resolveLot(room, t.id, price);
      return null;
    }
    case 'markUnsold': {
      if (!isAuctioneer || !lotLive) return 'Nothing to mark.';
      resolveLot(room, null, 0);
      return null;
    }
    case 'endAuction': {
      if (!isAuctioneer || room.phase !== 'auction') return 'Not allowed.';
      if (room.lot) return 'Finish the current player first.';
      room.phase = 'ended';
      addLog(room, 'The auction has ended.', 'phase');
      return null;
    }

    // ----- exchanges -----
    case 'proposeTrade': {
      if (!team || room.phase !== 'auction') return 'Trades open once the auction starts.';
      if (room.lot) return 'Trades pause while a player is on the block.';
      const tr = {
        id: uid(4), from: team.id, to: String(b.to), status: 'pending', at: Date.now(),
        give: [...new Set((b.give || []).map(String))], get: [...new Set((b.get || []).map(String))],
        cash: int(b.cash) || 0,
      };
      if (Math.abs(tr.cash) % 5 !== 0) return 'Cash must be in multiples of 5 L.';
      const err = validateTrade(room, tr);
      if (err) return err;
      room.trades.push(tr);
      addLog(room, `Trade offer: ${tradeText(room, tr)}`, 'trade');
      return null;
    }
    case 'respondTrade': {
      if (!team) return 'Only teams can respond.';
      const tr = room.trades.find((x) => x.id === b.id);
      if (!tr || tr.status !== 'pending') return 'That offer is no longer open.';
      if (b.action === 'cancel') {
        if (tr.from !== team.id) return 'Only the sender can cancel.';
        tr.status = 'cancelled';
        return null;
      }
      if (tr.to !== team.id) return 'This offer is not for you.';
      if (b.action === 'reject') { tr.status = 'rejected'; return null; }
      if (b.action !== 'accept') return 'Unknown action.';
      if (room.lot) return 'Trades pause while a player is on the block.';
      const err = validateTrade(room, tr);
      if (err) { tr.status = 'failed'; return `Deal failed: ${err}`; }
      executeTrade(room, tr);
      tr.status = 'accepted';
      addLog(room, `TRADE DONE: ${tradeText(room, tr)}`, 'trade');
      return null;
    }
    default:
      return 'Unknown action.';
  }
}

// ---------- clock ----------

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    let changed = false;
    if (room.phase === 'lobby' && room.lobbyDeadline && now >= room.lobbyDeadline) {
      if (room.teams.length >= CFG.MIN_TEAMS) finishLobby(room);
      else {
        room.lobbyDeadline = now + CFG.LOBBY_SECONDS * 1000;
        addLog(room, `Need at least ${CFG.MIN_TEAMS} teams. Countdown restarted.`, 'phase');
      }
      changed = true;
    }
    const lot = room.lot;
    if (lot) {
      if (lot.status === 'live' && now >= lot.deadline) {
        const t = lot.bidder && teamById(room, lot.bidder);
        resolveLot(room, t ? t.id : null, lot.bid);
        changed = true;
      } else if (lot.status !== 'live' && now >= lot.resultUntil) {
        room.lot = null;
        changed = true;
      }
    }
    if (changed) broadcast(room);
    if (now - room.touched > 6 * 3600 * 1000 && room.clients.size === 0) rooms.delete(room.code);
  }
}, 200);

setInterval(() => {
  for (const room of rooms.values()) for (const c of room.clients) c.res.write(': ping\n\n');
}, 15000);

// ---------- http ----------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const PUBLIC = path.join(__dirname, 'public');
const json = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 20000) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}
const cleanName = (n) => String(n || '').trim().replace(/\s+/g, ' ').slice(0, 20);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (url.pathname === '/api/players' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
      return res.end(JSON.stringify(PLAYERS));
    }
    if (url.pathname === '/api/room' && req.method === 'POST') {
      const room = createRoom();
      return json(res, 200, { code: room.code });
    }
    if (url.pathname === '/api/join' && req.method === 'POST') {
      const b = await readBody(req);
      const room = rooms.get(String(b.code || '').toUpperCase().trim());
      if (!room) return json(res, 404, { error: 'No room with that code.' });
      let m = b.token && room.members.get(b.token);
      if (!m) {
        if (room.phase !== 'lobby') return json(res, 403, { error: 'That auction has already started.' });
        if (room.members.size >= CFG.MAX_MEMBERS) return json(res, 403, { error: 'This room is full (6 players).' });
        const name = cleanName(b.name);
        if (!name) return json(res, 400, { error: 'Enter your name first.' });
        const token = uid();
        m = { token, id: 'm' + uid(3), name, role: null };
        room.members.set(token, m);
        addLog(room, `${name} joined the lobby`);
        broadcast(room);
      }
      return json(res, 200, { token: m.token, code: room.code });
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      const room = rooms.get(String(url.searchParams.get('code') || '').toUpperCase());
      const token = url.searchParams.get('token');
      if (!room || !room.members.has(token)) return json(res, 404, { error: 'Session expired.' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const client = { res, token };
      room.clients.add(client);
      req.on('close', () => { room.clients.delete(client); broadcast(room); });
      return broadcast(room);
    }
    if (url.pathname === '/api/act' && req.method === 'POST') {
      const b = await readBody(req);
      const room = rooms.get(String(b.code || '').toUpperCase());
      const member = room && room.members.get(b.token);
      if (!member) return json(res, 404, { error: 'Session expired. Rejoin the room.' });
      const error = act(room, member, b);
      broadcast(room);
      return json(res, error ? 400 : 200, error ? { error } : { ok: true });
    }

    // static files
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    json(res, 400, { error: 'Bad request.' });
  }
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => console.log(`Unison IPL Auction running on http://localhost:${PORT}`));
}
module.exports = { server, rooms, CFG };
