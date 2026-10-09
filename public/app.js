'use strict';
// Unison IPL Auction - browser client. The server owns all rules; this file only renders state and sends actions.

const $app = document.getElementById('app');
let S = null; // latest server state
let catalog = [];
let byId = new Map();
let offset = 0; // serverNow - Date.now()
let es = null;
let session = load();
const ui = {
  tab: 'pool', search: '', role: 'ALL', status: 'avail', limit: 60, selPid: null, baseCr: '',
  teamName: undefined, teamColor: undefined, budgetDraft: null, addOpen: false,
  trade: { to: '', give: new Set(), get: new Set(), dir: 'pay', cash: '' }, ovKey: null, conn: 'ok',
  homeName: localStorage.getItem('unison.name') || '', homeCode: (new URLSearchParams(location.search).get('code') || '').toUpperCase(),
};

function load() { try { return JSON.parse(localStorage.getItem('unison.session')); } catch { return null; } }
function save(s) { session = s; if (s) localStorage.setItem('unison.session', JSON.stringify(s)); else localStorage.removeItem('unison.session'); }

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => Date.now() + offset;
const money = (l) => (l >= 100 ? `₹${+(l / 100).toFixed(2)} Cr` : `₹${l} L`);
const P = (pid) => byId.get(pid) || (S && S.custom.find((p) => p.id === pid));
const T = (id) => S.teams.find((t) => t.id === id);
const myTeam = () => (S.me && S.me.role === 'team' ? T(S.me.id) : null);
const isAuc = () => S.me && S.me.role === 'auctioneer';
const ROLE_NAME = { BAT: 'Batter', BOWL: 'Bowler', AR: 'All-rounder', WK: 'Wicketkeeper' };
const increment = (p) => (p < 100 ? 5 : p < 200 ? 10 : p < 500 ? 20 : 25);
const nextPrice = (lot) => (lot.bid == null ? lot.base : lot.bid + increment(lot.bid));
const slab = (i) => Math.max(25, Math.round((S.budget * S.cfg.RETAIN_PCT[i]) / 25) * 25);
const suggestBase = (r) => (r >= 90 ? 200 : r >= 85 ? 150 : r >= 80 ? 100 : r >= 72 ? 75 : r >= 65 ? 50 : r >= 55 ? 30 : 20);
const initials = (n) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const hue = (n) => [...n].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const stars = (r) => '★'.repeat(Math.max(1, Math.round((r - 40) / 12))) ;
const outOfMoney = (t) => t.purse < S.cfg.MIN_BASE;
const textOn = (hex) => { const n = parseInt(hex.slice(1), 16); const l = ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000; return l > 150 ? '#111' : '#fff'; };

function toast(msg, ok) {
  const el = document.createElement('div');
  el.className = 'toast' + (ok ? ' ok' : '');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong.');
  return j;
}
async function act(type, extra = {}) {
  try { await api('/api/act', { code: session.code, token: session.token, type, ...extra }); return true; }
  catch (e) { toast(e.message); return false; }
}

// ---------- connection ----------
function connect() {
  if (es) es.close();
  if (!session) return render();
  es = new EventSource(`/api/events?code=${encodeURIComponent(session.code)}&token=${encodeURIComponent(session.token)}`);
  es.addEventListener('state', (e) => {
    S = JSON.parse(e.data);
    offset = S.serverNow - Date.now();
    ui.conn = 'ok';
    if (!S.me && session) { leaveLocal(); return; }
    render();
  });
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) { toast('Session expired. Rejoin the room.'); leaveLocal(); }
    else { ui.conn = 'retry'; render(); }
  };
}
function leaveLocal() {
  if (es) es.close();
  save(null); S = null; history.replaceState(null, '', location.pathname); render();
}

// ---------- render shell (keeps focus + scroll) ----------
function render() {
  const a = document.activeElement;
  const focus = a && a.id ? { id: a.id, s: a.selectionStart, e: a.selectionEnd } : null;
  const scrolls = {};
  document.querySelectorAll('[data-scroll]').forEach((el) => { scrolls[el.dataset.scroll] = el.scrollTop; });
  const winY = window.scrollY;

  $app.innerHTML = !S ? homeView() : shell();

  document.querySelectorAll('[data-scroll]').forEach((el) => { if (scrolls[el.dataset.scroll] != null) el.scrollTop = scrolls[el.dataset.scroll]; });
  window.scrollTo(0, winY);
  if (focus) {
    const el = document.getElementById(focus.id);
    if (el) { el.focus(); try { el.setSelectionRange(focus.s, focus.e); } catch { /* not a text input */ } }
  }
  tick();
}

function shell() {
  const phase = { lobby: 'Lobby', retention: 'Retention', auction: 'LIVE AUCTION', ended: 'Auction complete' }[S.phase];
  let body;
  if (S.phase === 'lobby') body = lobbyView();
  else if (S.phase === 'retention') body = retentionView();
  else if (S.phase === 'auction') body = auctionView();
  else body = endedView();
  const role = !S.me.role ? 'Choosing role' : isAuc() ? 'Auctioneer' : `Team: ${esc(myTeam()?.name)}`;
  return `
    <header class="top">
      <div class="brand">🏏 UNISON <b>IPL AUCTION</b></div>
      <div class="row wrap gap-s">
        <span class="chip code" title="Room code">${esc(S.code)}</span>
        <span class="chip">${phase}</span>
        <span class="chip">${role}</span>
        ${S.phase === 'lobby' ? '<button class="btn sm" data-act="leave">Leave</button>' : ''}
      </div>
    </header>
    <main>
      ${ui.conn === 'retry' ? '<div class="banner">Connection lost. Reconnecting…</div>' : ''}
      ${body}
    </main>
    ${overlayView()}`;
}

// ---------- home ----------
function homeView() {
  return `
  <main><div class="home">
    <div class="hero">
      <div class="brand" style="margin-bottom:14px">🏏 UNISON <b>IPL AUCTION</b></div>
      <h1>RUN YOUR OWN<br><span>IPL MEGA AUCTION</span></h1>
      <p>One auctioneer, five franchises, ${catalog.length} real IPL players from 2008 to today. Same purse for everyone. 20 seconds to sell. Zero mercy.</p>
      <div class="feats">
        <div>Room code lobby (6 players)</div><div>Auctioneer sets base price &amp; budget</div>
        <div>Retentions before the auction</div><div>Player-for-player exchanges</div>
        <div>SOLD / UNSOLD stamps</div><div>Empty purse = no more bidding</div>
      </div>
    </div>
    <div class="card">
      <label class="field" for="homeName">Your name</label>
      <input id="homeName" class="input" maxlength="20" placeholder="e.g. Ravi" value="${esc(ui.homeName)}" data-bind="homeName">
      <button class="btn primary big mt" style="width:100%" data-act="create">Create a room</button>
      <div class="row mt" style="color:var(--muted)"><hr class="grow" style="border:0;border-top:1px solid var(--line)">or join with a code<hr class="grow" style="border:0;border-top:1px solid var(--line)"></div>
      <div class="row mt-s">
        <input id="homeCode" class="input codeinput" maxlength="5" placeholder="CODE" value="${esc(ui.homeCode)}" data-bind="homeCode">
        <button class="btn big" data-act="join">Join</button>
      </div>
    </div>
  </div></main>`;
}

async function enter(code) {
  const name = ui.homeName.trim();
  if (!name) return toast('Enter your name first.');
  try {
    localStorage.setItem('unison.name', name);
    const j = await api('/api/join', { code, name });
    save({ code: j.code, token: j.token });
    history.replaceState(null, '', `?code=${j.code}`);
    connect();
  } catch (e) { toast(e.message); }
}

// ---------- lobby ----------
function lobbyView() {
  const aucTaken = S.members.some((m) => m.role === 'auctioneer');
  const full = S.teams.length >= S.cfg.MAX_TEAMS;
  const t = myTeam();
  const link = `${location.origin}/?code=${S.code}`;

  const seats = S.members.map((m) => {
    const team = S.teams.find((x) => x.id === m.id);
    return `<div class="seat"><span class="sw" style="background:${team ? team.color : '#55608c'}"></span>
      <div class="grow"><b>${esc(m.name)}</b>${m.id === S.me.id ? ' <span class="muted">(you)</span>' : ''}
      <div class="small muted">${m.role === 'auctioneer' ? '🔨 Auctioneer' : m.role === 'team' ? `${esc(team.name)} ${team.locked ? '· 🔒 locked in' : '· setting up…'}` : 'Choosing role…'}</div></div>
      <span class="chip"><span class="dot ${m.connected ? '' : 'off'}"></span>${m.connected ? 'online' : 'offline'}</span></div>`;
  }).join('');

  const slots = Array.from({ length: S.cfg.MAX_TEAMS }, (_, i) => {
    const x = S.teams[i];
    return x ? `<div class="slot filled" style="border-left-color:${x.color}"><b>${esc(x.name)}</b><span class="small muted">${x.locked ? '🔒 Locked in' : 'Not locked yet'}</span></div>`
      : `<div class="slot muted"><b>Team slot ${i + 1}</b><span class="small">Open</span></div>`;
  }).join('');

  let mine = '';
  if (!S.me.role) {
    mine = `<div class="card"><h3>Pick your role</h3>
      <div class="row wrap">
        <button class="btn primary big grow" data-act="role" data-role="auctioneer" ${aucTaken ? 'disabled' : ''}>🔨 Be the Auctioneer</button>
        <button class="btn big grow" data-act="role" data-role="team" ${full ? 'disabled' : ''}>🏏 Join as a Team</button>
      </div>
      <p class="small muted mt-s">${aucTaken ? 'The auctioneer seat is taken. ' : 'Only one person can be the auctioneer. '}${full ? 'All 5 team slots are full.' : ''}</p></div>`;
  } else if (t) {
    const name = ui.teamName ?? t.name;
    const color = ui.teamColor ?? t.color;
    const taken = new Set(S.teams.filter((x) => x.id !== t.id).map((x) => x.color));
    mine = `<div class="card"><h3>Your franchise</h3>
      <label class="field" for="teamName">Team name</label>
      <input id="teamName" class="input" maxlength="24" value="${esc(name)}" data-bind="teamName" ${t.locked ? 'disabled' : ''}>
      <label class="field mt-s">Team colour</label>
      <div class="swatches">${S.cfg.PALETTE.map((c) => `<button class="swatch ${c === color ? 'sel' : ''}" style="background:${c}" data-act="color" data-color="${c}" ${taken.has(c) || t.locked ? 'disabled' : ''} aria-label="colour ${c}"></button>`).join('')}</div>
      <div class="row mt">
        ${t.locked ? '<button class="btn grow" data-act="unlock">Unlock to edit</button>' : '<button class="btn primary grow" data-act="lockin">🔒 Lock in</button>'}
        ${t.locked ? '' : '<button class="btn" data-act="role" data-role="auctioneer"' + (aucTaken ? ' disabled' : '') + '>Switch to auctioneer</button>'}
      </div></div>`;
  } else {
    const budget = ui.budgetDraft ?? S.budget / 100;
    const started = !!S.lobby.deadline;
    mine = `<div class="card"><h3>Auctioneer controls</h3>
      <label class="field" for="budget">Budget for every team</label>
      <div class="budget" id="budgetShow">₹${budget} Cr</div>
      <input id="budget" class="range" type="range" min="${S.cfg.MIN_BUDGET_CR}" max="${S.cfg.MAX_BUDGET_CR}" step="5" value="${budget}" data-bind="budget">
      <div class="row spread small muted"><span>₹${S.cfg.MIN_BUDGET_CR} Cr</span><span>₹${S.cfg.MAX_BUDGET_CR} Cr</span></div>
      <div class="row wrap mt">
        ${started ? '' : `<button class="btn primary grow" data-act="startCountdown">▶ Start ${S.cfg.LOBBY_SECONDS / 60}:00 countdown</button>`}
        ${started ? `<button class="btn primary grow" data-act="skip" ${S.lobby.allLocked ? '' : 'disabled'}>⏭ Skip timer — all locked in</button>` : ''}
      </div>
      <p class="small muted mt-s">${started ? (S.lobby.allLocked ? 'Everyone is locked in. Skip the timer to move on.' : 'Skip unlocks once every team has locked in.') : 'Start the countdown when your teams have joined. You can still change the budget during it.'}</p></div>`;
  }

  return `
  <div class="grid2">
    <div class="grid" style="display:grid;gap:18px">
      <div class="card">
        <h3>Room code — share it with 5 players</h3>
        <div class="bigcode">${esc(S.code)}</div>
        <div class="row wrap mt-s">
          <button class="btn sm" data-act="copy" data-text="${esc(S.code)}">Copy code</button>
          <button class="btn sm" data-act="copy" data-text="${esc(link)}">Copy invite link</button>
        </div>
      </div>
      ${mine}
    </div>
    <div style="display:grid;gap:18px;align-content:start">
      <div class="card" style="text-align:center">
        <h3>Team setup countdown</h3>
        ${S.lobby.deadline ? `<div class="clock" data-deadline="${S.lobby.deadline}" data-kind="clock">2:00</div>
          <p class="small muted mt-s">Name your team, pick a colour and lock in before time runs out.</p>`
          : `<div class="clock" style="color:var(--muted)">${S.cfg.LOBBY_SECONDS / 60}:00</div><p class="small muted mt-s">Waiting for the auctioneer to start the countdown.</p>`}
        <div class="small mt-s">Purse per team: <b style="color:var(--gold2)">${money(S.budget)}</b></div>
      </div>
      <div class="card"><h3>Teams (${S.teams.length}/${S.cfg.MAX_TEAMS})</h3><div class="slots">${slots}</div></div>
      <div class="card"><h3>Lobby (${S.members.length}/${S.cfg.MAX_MEMBERS})</h3><div style="display:grid;gap:8px">${seats}</div></div>
    </div>
  </div>`;
}

// ---------- pool list shared by retention + auction ----------
function filteredPool({ forRetention }) {
  const all = [...catalog, ...S.custom];
  const q = ui.search.trim().toLowerCase();
  const unsold = new Set(S.unsold);
  let list = all.filter((p) => {
    if (ui.role !== 'ALL' && p.role !== ui.role) return false;
    if (q && !(p.name.toLowerCase().includes(q) || p.country.toLowerCase().includes(q))) return false;
    const tk = S.taken[p.id];
    if (forRetention) return true;
    if (ui.status === 'avail') return !tk && !unsold.has(p.id);
    if (ui.status === 'unsold') return !tk && unsold.has(p.id);
    if (ui.status === 'sold') return !!tk;
    return true;
  });
  list.sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));
  return list;
}

function filterBar({ forRetention }) {
  return `
    <input id="search" class="input" placeholder="Search name or country (IND, AUS…)" value="${esc(ui.search)}" data-bind="search">
    <div class="seg mt-s">${['ALL', 'BAT', 'BOWL', 'AR', 'WK'].map((r) => `<button class="${ui.role === r ? 'on' : ''}" data-act="frole" data-role="${r}">${r === 'ALL' ? 'All' : ROLE_NAME[r]}</button>`).join('')}</div>
    ${forRetention ? '' : `<div class="seg mt-s">${[['avail', 'Available'], ['unsold', 'Unsold'], ['sold', 'Sold'], ['all', 'Everyone']].map(([k, l]) => `<button class="${ui.status === k ? 'on' : ''}" data-act="fstatus" data-status="${k}">${l}</button>`).join('')}</div>`}`;
}

function playerPills(p) {
  return `<span class="pill ${p.role}">${p.role}</span> <span class="pill cty">${esc(p.country)}</span>`;
}

// ---------- retention ----------
function retentionView() {
  const t = myTeam();
  const list = filteredPool({ forRetention: true });
  const shown = list.slice(0, ui.limit);
  const mineRet = t ? t.squad.filter((s) => s.how === 'retained') : [];

  const slabs = Array.from({ length: S.cfg.MAX_RETAIN }, (_, i) => `<span class="chip">#${i + 1}: ${money(slab(i))}</span>`).join(' ');

  const pool = `
    <div class="card"><h3>Player pool</h3>${filterBar({ forRetention: true })}
      <div class="plist mt-s" data-scroll="pool">${shown.map((p) => {
        const tk = S.taken[p.id];
        const owner = tk && T(tk.team);
        let btn = '';
        if (owner) btn = `<span class="pill tag" style="background:${owner.color}33;color:${owner.color}">${esc(owner.name)}</span>`;
        else if (t && !t.retDone) btn = `<button class="btn sm primary" data-act="retain" data-pid="${p.id}" ${mineRet.length >= S.cfg.MAX_RETAIN ? 'disabled' : ''}>Retain ${money(slab(mineRet.length))}</button>`;
        return `<div class="prow ${owner ? 'dim' : ''}"><div><span class="nm">${esc(p.name)}</span> ${playerPills(p)}</div><div class="row gap-s"><span class="rate">${p.rating}</span>${btn}</div></div>`;
      }).join('') || '<p class="muted">No players match.</p>'}
      ${list.length > shown.length ? `<button class="btn sm" data-act="more">Show more (${list.length - shown.length})</button>` : ''}</div></div>`;

  const teamsBoard = S.teams.map((x) => {
    const ret = x.squad.filter((s) => s.how === 'retained');
    return `<div class="squad" style="--tc:${x.color}"><h4><span>${esc(x.name)} ${x.retDone ? '✅' : ''}</span><span>${money(x.purse)}</span></h4>
      ${ret.map((s) => `<div class="sq-item"><span>${esc(P(s.pid).name)} <span class="pill ${P(s.pid).role}">${P(s.pid).role}</span></span><span>${money(s.price)}${x.id === S.me.id && !x.retDone ? ` <button class="btn sm" data-act="unretain" data-pid="${s.pid}">✕</button>` : ''}</span></div>`).join('') || '<div class="sq-item muted">No retentions</div>'}</div>`;
  }).join('');

  const doneCount = S.teams.filter((x) => x.retDone).length;
  return `
  <div class="grid2" style="grid-template-columns:1.3fr 1fr">
    <div>${pool}</div>
    <div style="display:grid;gap:18px;align-content:start">
      <div class="card"><h3>Retention window</h3>
        <p class="muted" style="margin-top:0">Keep up to <b>${S.cfg.MAX_RETAIN}</b> players before the auction. They cost slab prices out of your purse (scaled to the ${money(S.budget)} budget):</p>
        <div class="row wrap gap-s">${slabs}</div>
        <p class="small muted">A retained player is removed from the auction pool. First team to retain a player gets them.</p>
        ${t ? `<button class="btn ${t.retDone ? '' : 'primary'} big mt" style="width:100%" data-act="retdone" data-done="${t.retDone ? 0 : 1}">${t.retDone ? 'Undo — keep editing' : `✔ Confirm retentions (${mineRet.length}/${S.cfg.MAX_RETAIN})`}</button>` : ''}
        ${isAuc() ? `<button class="btn primary big mt" style="width:100%" data-act="startAuction">🔨 Start the auction</button>
          <p class="small muted mt-s">${doneCount}/${S.teams.length} teams have confirmed.</p>` : `<p class="small muted mt-s">${doneCount}/${S.teams.length} teams confirmed. Waiting for the auctioneer to start.</p>`}
      </div>
      <div class="card"><h3>Retentions</h3>${teamsBoard}</div>
    </div>
  </div>`;
}

// ---------- auction ----------
function purseStrip() {
  const lead = S.lot && S.lot.bidder;
  return `<div class="purses">${S.teams.map((t) => `
    <div class="pcard ${lead === t.id ? 'lead' : ''} ${S.me.id === t.id ? 'me' : ''}" style="--tc:${t.color}">
      <div class="nm">${esc(t.name)}${S.me.id === t.id ? ' (you)' : ''}</div>
      <div class="pu ${outOfMoney(t) ? 'low' : ''}">${money(t.purse)}</div>
      <div class="small muted">${t.squad.length} player${t.squad.length === 1 ? '' : 's'} ${outOfMoney(t) ? '<span class="broke">OUT OF MONEY</span>' : ''}</div>
    </div>`).join('')}</div>`;
}

function stageView() {
  const lot = S.lot;
  if (!lot) {
    return `<div class="card stage"><div class="empty-stage"><div><div class="emoji">🔨</div>
      <h2>${isAuc() ? 'Pick the next player' : 'Waiting for the next player'}</h2>
      <p>${isAuc() ? 'Choose someone from the pool, set a base price and put them on the block.' : 'The auctioneer is choosing who goes under the hammer.'}</p></div></div></div>`;
  }
  const p = P(lot.pid);
  const bidder = lot.bidder && T(lot.bidder);
  const h = hue(p.name);
  return `<div class="card stage">
    <div class="avatar" style="background:linear-gradient(135deg,hsl(${h} 70% 45%),hsl(${(h + 60) % 360} 70% 30%))">${esc(initials(p.name))}</div>
    <h2>${esc(p.name)}</h2>
    <div class="row wrap gap-s" style="justify-content:center;margin-top:6px">${playerPills(p)} <span class="stars" title="Rating ${p.rating}">${stars(p.rating)}</span></div>
    <div class="small muted mt-s">${ROLE_NAME[p.role]} · Base ${money(lot.base)}</div>
    <div class="bidbox" style="${bidder ? `border-color:${bidder.color}` : ''}">
      <div class="lbl">${lot.bid == null ? 'Base price' : 'Current bid'}</div>
      <div class="amt">${money(lot.bid ?? lot.base)}</div>
      <div class="who" style="${bidder ? `color:${bidder.color}` : 'color:var(--muted)'}">${bidder ? esc(bidder.name) : 'No bids yet'}</div>
    </div>
    ${lot.status === 'live' ? `<div class="timer" data-deadline="${lot.deadline}" data-total="${S.cfg.LOT_SECONDS}"><div class="tnum">${S.cfg.LOT_SECONDS}</div><div class="tbar"><i></i></div></div>` : ''}
    <div class="history">${lot.history.slice(-6).map((h2) => { const t = T(h2.team); return `<span class="hchip" style="color:${t.color};border-color:${t.color}">${esc(t.name)} ${money(h2.price)}</span>`; }).join('')}</div>
    ${bidControls(lot)}
  </div>`;
}

function bidControls(lot) {
  if (lot.status !== 'live') return '';
  const t = myTeam();
  if (t) {
    const price = nextPrice(lot);
    let why = '';
    if (lot.bidder === t.id) why = '✔ You are the highest bidder';
    else if (t.squad.length >= S.cfg.MAX_SQUAD) why = 'Squad full';
    else if (outOfMoney(t)) why = '🚫 Out of money — bidding disabled';
    else if (price > t.purse) why = `🚫 Can't afford ${money(price)} (you have ${money(t.purse)})`;
    return `<div class="mt"><button class="bidbtn" data-act="bid" data-price="${price}" ${why ? 'disabled' : ''}>${why || `BID ${money(price)}`}</button>
      ${why ? '' : '<div class="small muted mt-s">Tip: press <b>Space</b> to bid</div>'}</div>`;
  }
  if (isAuc()) {
    const price = lot.bid ?? lot.base;
    return `<div class="mt"><div class="small muted">Declare the sale (at ${money(price)}):</div>
      <div class="row wrap mt-s" style="justify-content:center">
        ${S.teams.map((x) => `<button class="btn" style="border-color:${x.color};${lot.bidder === x.id ? `background:${x.color};color:${textOn(x.color)}` : ''}" data-act="sell" data-team="${x.id}">Sold to ${esc(x.name)}</button>`).join('')}
        <button class="btn danger" data-act="unsold">Mark unsold</button>
      </div></div>`;
  }
  return '';
}

function auctionView() {
  return `${purseStrip()}
  <div class="grid3">
    <div class="card"><h3>Your seat</h3>${seatPanel()}</div>
    <div>${stageView()}</div>
    <div class="card">${sidePanel()}</div>
  </div>`;
}

function seatPanel() {
  const t = myTeam();
  if (t) {
    const spent = S.budget - t.purse;
    return `<div class="squad" style="--tc:${t.color}"><h4><span>${esc(t.name)}</span><span>${money(t.purse)} left</span></h4>
      <div class="small muted" style="padding:0 12px 6px">${t.squad.length}/${S.cfg.MAX_SQUAD} players · spent ${money(spent)}</div>
      ${t.squad.map((s) => `<div class="sq-item"><span>${esc(P(s.pid).name)} <span class="pill ${P(s.pid).role}">${P(s.pid).role}</span></span><span>${money(s.price)}</span></div>`).join('') || '<div class="sq-item muted">No players yet</div>'}</div>`;
  }
  const sold = Object.values(S.taken).filter((x) => x.how === 'auction').length;
  return `<p style="margin-top:0">You are running the auction.</p>
    <div class="small muted">Sold: <b>${sold}</b> · Unsold: <b>${S.unsold.length}</b> · Budget each: <b>${money(S.budget)}</b></div>
    <button class="btn danger mt" style="width:100%" data-act="endAuction" ${S.lot ? 'disabled' : ''}>🏁 End the auction</button>
    <p class="small muted mt-s">Ends for everyone and shows the final standings.</p>`;
}

function sidePanel() {
  const tabs = [['pool', isAuc() ? 'Pick player' : 'Pool'], ['squads', 'Squads'], ['trades', 'Exchange'], ['log', 'Log']];
  const pendingForMe = S.me.role === 'team' ? S.trades.filter((x) => x.status === 'pending' && x.to === S.me.id).length : 0;
  let inner = '';
  if (ui.tab === 'pool') inner = poolPanel();
  else if (ui.tab === 'squads') inner = squadsPanel();
  else if (ui.tab === 'trades') inner = tradesPanel();
  else inner = `<div class="log" data-scroll="log">${[...S.log].reverse().map((l) => `<div class="${l.kind}">${esc(l.text)}</div>`).join('')}</div>`;
  return `<div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${ui.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}">${l}${k === 'trades' && pendingForMe ? ` (${pendingForMe})` : ''}</button>`).join('')}</div>${inner}`;
}

function poolPanel() {
  const list = filteredPool({ forRetention: false });
  const shown = list.slice(0, ui.limit);
  const unsold = new Set(S.unsold);
  const auc = isAuc();
  const sel = auc && ui.selPid && P(ui.selPid);
  let selBox = '';
  if (auc) {
    if (sel && !S.taken[sel.id]) {
      const base = ui.baseCr !== '' ? ui.baseCr : suggestBase(sel.rating) / 100;
      selBox = `<div class="selbox"><div class="row spread"><b>${esc(sel.name)}</b><span>${playerPills(sel)}</span></div>
        <label class="field mt-s" for="baseCr">Base price (₹ Cr)</label>
        <div class="row"><input id="baseCr" class="input" type="number" min="0.2" step="0.05" value="${base}" data-bind="baseCr">
        <button class="btn primary" data-act="startLot" ${S.lot ? 'disabled' : ''}>Put on block</button></div>
        <div class="seg mt-s">${[0.2, 0.5, 1, 1.5, 2, 3].map((v) => `<button data-act="basechip" data-v="${v}">${v} Cr</button>`).join('')}</div></div>`;
    } else {
      selBox = `<div class="selbox muted">Select a player below, or <button class="btn sm" data-act="random">🎲 pick random</button></div>`;
    }
  }
  const add = auc ? `<details ${ui.addOpen ? 'open' : ''} class="mt-s"><summary class="small muted" style="cursor:pointer" data-act="toggleAdd">+ Add a missing player</summary>
    <div class="row wrap mt-s"><input id="addName" class="input grow" placeholder="Player name" maxlength="40">
    <select id="addRole" class="input" style="width:auto"><option value="BAT">Batter</option><option value="BOWL">Bowler</option><option value="AR">All-rounder</option><option value="WK">Wicketkeeper</option></select>
    <input id="addCountry" class="input" style="width:70px" placeholder="IND" maxlength="3">
    <input id="addRating" class="input" style="width:80px" type="number" min="40" max="99" placeholder="Rating">
    <button class="btn sm" data-act="addPlayer">Add</button></div></details>` : '';
  return `${selBox}${filterBar({ forRetention: false })}
    <div class="small muted mt-s">${list.length} players</div>
    <div class="plist mt-s" data-scroll="pool">${shown.map((p) => {
      const tk = S.taken[p.id];
      const owner = tk && T(tk.team);
      const tag = owner ? `<span class="pill tag" style="background:${owner.color}33;color:${owner.color}">${esc(owner.name)} ${money(tk.price)}</span>` : unsold.has(p.id) ? '<span class="pill unsold">UNSOLD</span>' : '';
      const inner = `<div><span class="nm">${esc(p.name)}</span> ${playerPills(p)}</div><div class="row gap-s">${tag}<span class="rate">${p.rating}</span></div>`;
      return auc && !tk ? `<button class="prow ${ui.selPid === p.id ? 'sel' : ''}" data-act="select" data-pid="${p.id}">${inner}</button>` : `<div class="prow ${tk ? 'dim' : ''}">${inner}</div>`;
    }).join('') || '<p class="muted">No players match.</p>'}
    ${list.length > shown.length ? `<button class="btn sm" data-act="more">Show more (${list.length - shown.length})</button>` : ''}</div>${add}`;
}

function squadsPanel() {
  return `<div class="plist" style="max-height:560px" data-scroll="squads">${S.teams.map((t) => `<div class="squad" style="--tc:${t.color}"><h4><span>${esc(t.name)}</span><span>${money(t.purse)} · ${t.squad.length}</span></h4>
    ${t.squad.map((s) => `<div class="sq-item"><span>${esc(P(s.pid).name)} <span class="pill ${P(s.pid).role}">${P(s.pid).role}</span> <span class="small muted">${s.how}</span></span><span>${money(s.price)}</span></div>`).join('') || '<div class="sq-item muted">Empty</div>'}</div>`).join('')}</div>`;
}

function tradeLine(tr) {
  const names = (ids) => ids.map((id) => P(id)?.name || id).join(', ') || 'nothing';
  const a = T(tr.from), b = T(tr.to);
  const cash = tr.cash ? ` ${tr.cash > 0 ? '+' : '−'} ${money(Math.abs(tr.cash))} cash` : '';
  return `<b style="color:${a.color}">${esc(a.name)}</b> gives ${esc(names(tr.give))}${cash} ⇄ <b style="color:${b.color}">${esc(b.name)}</b> gives ${esc(names(tr.get))}`;
}

function tradesPanel() {
  const t = myTeam();
  const tr = ui.trade;
  let form = '<p class="muted small">Only teams can propose exchanges. Everyone can watch them here.</p>';
  if (t) {
    const others = S.teams.filter((x) => x.id !== t.id);
    if (!tr.to || !others.some((x) => x.id === tr.to)) tr.to = others[0]?.id || '';
    const them = tr.to && T(tr.to);
    const checks = (team, set, kind) => `<div class="checks">${team.squad.map((s) => `<label><input type="checkbox" data-act="tcheck" data-kind="${kind}" data-pid="${s.pid}" ${set.has(s.pid) ? 'checked' : ''}> ${esc(P(s.pid).name)} <span class="muted small">${money(s.price)}</span></label>`).join('') || '<span class="muted small">No players</span>'}</div>`;
    form = S.lot ? '<div class="banner">Exchanges pause while a player is on the block.</div>' : '';
    form += `<label class="field" for="tradeTo">Trade with</label>
      <select id="tradeTo" class="input" data-bind="tradeTo">${others.map((x) => `<option value="${x.id}" ${x.id === tr.to ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      <label class="field mt-s">You give</label>${checks(t, tr.give, 'give')}
      <label class="field mt-s">You get</label>${them ? checks(them, tr.get, 'get') : ''}
      <div class="row mt-s"><select id="tradeDir" class="input" style="width:auto" data-bind="tradeDir"><option value="pay" ${tr.dir === 'pay' ? 'selected' : ''}>I add cash</option><option value="recv" ${tr.dir === 'recv' ? 'selected' : ''}>I ask for cash</option></select>
      <input id="tradeCash" class="input" type="number" min="0" step="0.05" placeholder="₹ Cr (optional)" value="${esc(tr.cash)}" data-bind="tradeCash"></div>
      <button class="btn primary mt-s" style="width:100%" data-act="propose" ${S.lot ? 'disabled' : ''}>Send offer</button>`;
  }
  const list = [...S.trades].reverse();
  return `${form}<h3 class="mt">Offers</h3><div class="plist" data-scroll="trades">${list.map((x) => {
    let btns = '';
    if (x.status === 'pending' && t) {
      if (x.to === t.id) btns = `<div class="row mt-s"><button class="btn sm primary" data-act="tresp" data-id="${x.id}" data-a="accept" ${S.lot ? 'disabled' : ''}>Accept</button><button class="btn sm danger" data-act="tresp" data-id="${x.id}" data-a="reject">Reject</button></div>`;
      else if (x.from === t.id) btns = `<div class="row mt-s"><button class="btn sm" data-act="tresp" data-id="${x.id}" data-a="cancel">Cancel offer</button></div>`;
    }
    return `<div class="offer ${x.status}">${tradeLine(x)}<div class="small muted mt-s">${x.status.toUpperCase()}</div>${btns}</div>`;
  }).join('') || '<p class="muted small">No offers yet.</p>'}</div>`;
}

// ---------- SOLD / UNSOLD ----------
function overlayView() {
  const lot = S && S.lot;
  if (!lot || lot.status === 'live') { ui.ovKey = null; return ''; }
  const key = lot.pid + lot.status;
  const anim = ui.ovKey !== key;
  ui.ovKey = key;
  const p = P(lot.pid);
  if (lot.status === 'sold') {
    const t = T(lot.soldTo);
    return `<div class="overlay ${anim ? 'anim' : ''}" role="alert"><div>
      <div class="stamp sold">SOLD!</div>
      <div class="sub">${esc(p.name)}</div>
      <div class="sub2" style="color:${t.color}">to ${esc(t.name)} for ${money(lot.soldPrice)}</div></div></div>`;
  }
  return `<div class="overlay ${anim ? 'anim' : ''}" role="alert"><div>
    <div class="stamp unsold">UNSOLD</div>
    <div class="sub">${esc(p.name)}</div>
    <div class="sub2 muted">Base ${money(lot.base)} — no takers</div></div></div>`;
}

// ---------- ended ----------
function endedView() {
  const rows = S.teams.map((t) => {
    const ps = t.squad.map((s) => ({ ...s, p: P(s.pid) })).sort((a, b) => b.p.rating - a.p.rating);
    const xi = ps.slice(0, 11);
    const score = xi.reduce((a, s) => a + s.p.rating, 0);
    const cnt = (r) => ps.filter((s) => s.p.role === r).length;
    return { t, ps, score, cnt, spent: S.budget - t.purse };
  }).sort((a, b) => b.score - a.score);
  return `<div class="card" style="text-align:center;margin-bottom:18px"><h3>Auction complete</h3>
    <div class="crown">👑</div><h2 style="font-family:var(--display);font-size:42px;color:${rows[0].t.color}">${esc(rows[0].t.name)}</h2>
    <p class="muted">Best squad: top-11 rating score of ${rows[0].score}</p></div>
    <div class="rank">${rows.map((r, i) => `<div class="card" style="--tc:${r.t.color}">
      <div class="row spread"><h2 style="color:${r.t.color}">#${i + 1} ${esc(r.t.name)}</h2><div class="score">${r.score}</div></div>
      <div class="small muted">${r.ps.length} players · spent ${money(r.spent)} · ${money(r.t.purse)} left<br>${r.cnt('BAT')} BAT · ${r.cnt('WK')} WK · ${r.cnt('AR')} AR · ${r.cnt('BOWL')} BOWL</div>
      <div class="mt-s">${r.ps.map((s, k) => `<div class="sq-item" style="${k < 11 ? '' : 'opacity:.6'}"><span>${esc(s.p.name)} <span class="pill ${s.p.role}">${s.p.role}</span></span><span>${money(s.price)}</span></div>`).join('') || '<span class="muted">No players</span>'}</div></div>`).join('')}</div>
    <div class="row mt" style="justify-content:center"><button class="btn primary big" data-act="newroom">Start a new auction</button></div>`;
}

// ---------- timers ----------
function tick() {
  document.querySelectorAll('[data-deadline]').forEach((el) => {
    const ms = Math.max(0, Number(el.dataset.deadline) - now());
    if (el.dataset.kind === 'clock') {
      const s = Math.ceil(ms / 1000);
      el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      el.classList.toggle('urgent', s <= 15);
    } else {
      const total = Number(el.dataset.total) * 1000;
      el.querySelector('.tnum').textContent = Math.ceil(ms / 1000);
      el.querySelector('i').style.width = `${Math.min(100, (ms / total) * 100)}%`;
      el.classList.toggle('urgent', ms <= 5000);
    }
  });
}
setInterval(tick, 100);

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const d = el.dataset;
  switch (d.act) {
    case 'create': {
      if (!ui.homeName.trim()) return toast('Enter your name first.');
      try { const j = await api('/api/room'); await enter(j.code); } catch (err) { toast(err.message); }
      break;
    }
    case 'join': if (ui.homeCode.trim().length < 5) toast('Enter the 5-letter room code.'); else enter(ui.homeCode.trim()); break;
    case 'leave': await act('leave'); leaveLocal(); break;
    case 'newroom': leaveLocal(); break;
    case 'copy': navigator.clipboard?.writeText(d.text).then(() => toast('Copied!', true), () => toast('Copy failed — select it manually.')); break;
    case 'role': ui.teamName = ui.teamColor = undefined; act('setRole', { role: d.role }); break;
    case 'color': ui.teamColor = d.color; render(); break;
    case 'lockin': {
      const t = myTeam();
      if (await act('setTeam', { name: ui.teamName ?? t.name, color: ui.teamColor ?? t.color })) { ui.teamName = ui.teamColor = undefined; act('lock', { locked: true }); }
      break;
    }
    case 'unlock': act('lock', { locked: false }); break;
    case 'startCountdown': act('startCountdown'); break;
    case 'skip': act('skipCountdown'); break;
    case 'frole': ui.role = d.role; ui.limit = 60; render(); break;
    case 'fstatus': ui.status = d.status; ui.limit = 60; render(); break;
    case 'more': ui.limit += 80; render(); break;
    case 'tab': ui.tab = d.tab; ui.limit = 60; render(); break;
    case 'retain': act('retain', { pid: d.pid }); break;
    case 'unretain': act('unretain', { pid: d.pid }); break;
    case 'retdone': act('retentionDone', { done: d.done === '1' }); break;
    case 'startAuction': act('startAuction'); break;
    case 'select': { ui.selPid = d.pid; ui.baseCr = ''; render(); break; }
    case 'basechip': ui.baseCr = d.v; render(); break;
    case 'random': {
      const pool = filteredPool({ forRetention: false }).filter((p) => !S.taken[p.id] && !S.unsold.includes(p.id));
      const src = pool.length ? pool : [...catalog, ...S.custom].filter((p) => !S.taken[p.id]);
      if (!src.length) return toast('No players left!');
      ui.selPid = src[Math.floor(Math.random() * src.length)].id; ui.baseCr = ''; render(); break;
    }
    case 'startLot': {
      const cr = Number(document.getElementById('baseCr')?.value);
      const base = Math.round((cr * 100) / 5) * 5;
      if (await act('startLot', { pid: ui.selPid, base })) { ui.selPid = null; ui.baseCr = ''; }
      break;
    }
    case 'toggleAdd': ui.addOpen = !ui.addOpen; break;
    case 'addPlayer': {
      const g = (id) => document.getElementById(id).value;
      if (await act('addPlayer', { name: g('addName'), role: g('addRole'), country: g('addCountry') || 'IND', rating: g('addRating') })) toast('Player added to the pool.', true);
      break;
    }
    case 'bid': act('bid', { price: Number(d.price) }); break;
    case 'sell': act('sell', { team: d.team }); break;
    case 'unsold': act('markUnsold'); break;
    case 'endAuction': if (confirm('End the auction for everyone?')) act('endAuction'); break;
    case 'tcheck': {
      const set = d.kind === 'give' ? ui.trade.give : ui.trade.get;
      if (el.checked) set.add(d.pid); else set.delete(d.pid);
      break;
    }
    case 'propose': {
      const tr = ui.trade;
      const cr = Number(tr.cash) || 0;
      const lakh = Math.round((cr * 100) / 5) * 5;
      const ok = await act('proposeTrade', { to: tr.to, give: [...tr.give], get: [...tr.get], cash: tr.dir === 'pay' ? lakh : -lakh });
      if (ok) { toast('Offer sent.', true); ui.trade = { to: tr.to, give: new Set(), get: new Set(), dir: 'pay', cash: '' }; render(); }
      break;
    }
    case 'tresp': {
      const ok = await act('respondTrade', { id: d.id, action: d.a });
      if (ok && d.a === 'accept') toast('Deal done!', true);
      break;
    }
  }
});

document.addEventListener('input', (e) => {
  const k = e.target.dataset.bind;
  if (!k) return;
  const v = e.target.value;
  if (k === 'homeName') ui.homeName = v;
  else if (k === 'homeCode') { ui.homeCode = v.toUpperCase(); e.target.value = ui.homeCode; }
  else if (k === 'teamName') ui.teamName = v;
  else if (k === 'budget') { ui.budgetDraft = Number(v); document.getElementById('budgetShow').textContent = `₹${v} Cr`; }
  else if (k === 'search') { ui.search = v; ui.limit = 60; render(); }
  else if (k === 'baseCr') ui.baseCr = v;
  else if (k === 'tradeCash') ui.trade.cash = v;
});
document.addEventListener('change', async (e) => {
  const k = e.target.dataset.bind;
  if (k === 'budget') { const ok = await act('setBudget', { cr: Number(e.target.value) }); ui.budgetDraft = null; if (!ok) render(); }
  else if (k === 'tradeTo') { ui.trade.to = e.target.value; ui.trade.get = new Set(); render(); }
  else if (k === 'tradeDir') ui.trade.dir = e.target.value;
  else if (e.target.dataset.act === 'tcheck') { /* handled on click */ }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'homeName' && !ui.homeCode) document.querySelector('[data-act="create"]')?.click();
  else if (e.key === 'Enter' && e.target.id === 'homeCode') document.querySelector('[data-act="join"]')?.click();
  if (e.code === 'Space' && S && S.phase === 'auction' && myTeam() && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) {
    const b = document.querySelector('.bidbtn:not(:disabled)');
    if (b) { e.preventDefault(); b.click(); }
  }
});

// ---------- boot ----------
(async function boot() {
  try { catalog = await (await fetch('/api/players')).json(); byId = new Map(catalog.map((p) => [p.id, p])); } catch { toast('Could not load the player database.'); }
  const urlCode = new URLSearchParams(location.search).get('code');
  if (session && urlCode && urlCode.toUpperCase() !== session.code) save(null);
  if (session) connect(); else render();
})();
