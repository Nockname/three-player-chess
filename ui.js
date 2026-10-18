const E = ThreeChess;

const PLAYERS = [
  { name: 'White', fill: '#fafafa', stroke: '#2a2a2a' },
  { name: 'Red', fill: '#d8413a', stroke: '#3a0c0a' },
  { name: 'Black', fill: '#1e1e1e', stroke: '#d9d9d9' },
];
const GLYPHS = { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' };
const glyph = (t) => GLYPHS[t] + '︎';
const AI_VALUE = { P: 1, N: 3, B: 3.2, R: 5, Q: 9, K: 100 };

const svg = document.getElementById('board');
const NS = 'http://www.w3.org/2000/svg';

let state;
let history;
let selected = null;
let view = 'auto';
let aiTimer = null;

// mode is 'local' (everyone on this screen), 'host' (this tab runs an online game)
// or 'client' (joined someone else's game). Seat kinds: 'human' (this screen),
// 'cpu', 'remote' (a joined player) and 'open' (waiting for someone to join).
let mode = 'local';
let seats = [{ kind: 'human' }, { kind: 'cpu' }, { kind: 'cpu' }];
let mySeat = null; // client only; null while connecting or when spectating
let peer = null;
let hostConn = null; // client only
let conns = []; // host only: [{ conn, seat, lastSeen }]
let lastFromHost = 0; // client only
let hostGone = false; // client only

// WebRTC often doesn't report a peer that closed its tab, so both sides ping and
// treat a peer that's been silent this long as gone.
const PING_MS = 2000;
const TIMEOUT_MS = 8000;
let shareLink = null;
let netStatus = '';

// ---------- game flow ----------

function newGame() {
  clearTimeout(aiTimer);
  state = { board: E.initialBoard(), turn: 0, alive: [true, true, true], log: [], lastMove: null, winner: null, legal: [] };
  history = [];
  selected = null;
  startTurn();
}

const nextAlive = (p) => [1, 2, 3].map((k) => (p + k) % 3).find((q) => state.alive[q]);

function isMyTurn() {
  if (state.winner != null) return false;
  if (mode === 'client') return state.turn === mySeat;
  return seats[state.turn].kind === 'human';
}

function eliminate(p, text) {
  state.alive[p] = false;
  state.board = state.board.map((pc) => (pc && pc.owner === p ? null : pc));
  state.log.push({ sys: true, text });
}

function startTurn() {
  selected = null;
  for (;;) {
    const left = [0, 1, 2].filter((p) => state.alive[p]);
    if (left.length === 1) {
      state.winner = left[0];
      state.legal = [];
      state.log.push({ sys: true, text: `${PLAYERS[left[0]].name} wins!` });
      break;
    }
    const legal = E.legalMoves(state.board, state.turn, state.alive);
    if (legal.length) {
      state.legal = legal;
      break;
    }
    const mated = E.inCheck(state.board, state.turn, state.alive);
    const name = PLAYERS[state.turn].name;
    const p = state.turn;
    state.turn = nextAlive(p);
    eliminate(p, mated ? `${name} is checkmated` : `${name} has no legal moves`);
  }
  changed();
}

// Redraw, tell joined players, and let the computer move if it's its turn.
function changed() {
  render();
  broadcast();
  clearTimeout(aiTimer);
  if (mode !== 'client' && state.winner == null && seats[state.turn].kind === 'cpu') aiTimer = setTimeout(aiMove, 500);
}

function makeMove(m) {
  if (mode === 'client') {
    hostConn.send({ type: 'move', from: m.from, to: m.to, promo: m.promo || null });
    selected = null;
    state.legal = [];
    render();
    return;
  }
  history.push({ board: state.board, turn: state.turn, alive: [...state.alive], logLen: state.log.length, lastMove: state.lastMove });
  const mover = state.turn;
  const victim = state.board[m.to];
  state.log.push({ player: mover, text: describe(m) });
  state.board = E.applyMove(state.board, m);
  state.lastMove = m;
  state.turn = nextAlive(mover);
  if (victim && victim.type === 'K') {
    eliminate(victim.owner, `${PLAYERS[mover].name} captures ${PLAYERS[victim.owner].name}'s king`);
    if (state.turn === victim.owner) state.turn = nextAlive(victim.owner);
  }
  startTurn();
}

function undo() {
  if (!history.length) return;
  clearTimeout(aiTimer);
  let snap = history.pop();
  // Step back to the last position where a human was to move.
  while (history.length && seats[snap.turn].kind === 'cpu') snap = history.pop();
  state.board = snap.board;
  state.turn = snap.turn;
  state.alive = snap.alive;
  state.log.length = snap.logLen;
  state.lastMove = snap.lastMove;
  state.winner = null;
  startTurn();
}

// ---------- online play (PeerJS, host-authoritative) ----------

function randomId() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = 'tpc-';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function snapshot() {
  const { board, turn, alive, log, lastMove, winner } = state;
  return { board, turn, alive, log, lastMove, winner };
}

function broadcast() {
  if (mode !== 'host') return;
  const msg = { type: 'state', state: snapshot(), seats: seats.map((s) => ({ kind: s.kind })) };
  for (const c of conns) if (c.conn.open) c.conn.send({ ...msg, you: c.seat });
}

function goOnline() {
  if (typeof Peer === 'undefined') {
    netStatus = 'Couldn\'t load the online-play library. Check your connection and reload.';
    render();
    return;
  }
  mode = 'host';
  seats = [{ kind: 'human' }, { kind: 'open' }, { kind: 'open' }];
  view = 'auto';
  document.getElementById('view').value = 'auto';
  netStatus = 'Setting up the game…';
  peer = new Peer(randomId(), { debug: 1 });
  peer.on('open', (id) => {
    shareLink = `${location.origin}${location.pathname}?join=${id}`;
    netStatus = 'Send this link to two friends:';
    render();
  });
  peer.on('connection', (conn) => {
    conn.on('open', () => onJoin(conn));
    conn.on('data', (d) => onHostData(conn, d));
    conn.on('close', () => onLeave(conn));
  });
  peer.on('disconnected', () => peer.reconnect());
  setInterval(() => {
    for (const c of conns) {
      if (Date.now() - c.lastSeen > TIMEOUT_MS) onLeave(c.conn);
      else if (c.conn.open) c.conn.send({ type: 'ping' });
    }
  }, PING_MS);
  peer.on('error', (e) => {
    netStatus = `Connection problem (${e.type}). Players who already joined can keep playing.`;
    render();
  });
  newGame();
}

function onJoin(conn) {
  const seat = seats.findIndex((s) => s.kind === 'open');
  conns.push({ conn, seat: seat >= 0 ? seat : null, lastSeen: Date.now() });
  if (seat >= 0) seats[seat] = { kind: 'remote' };
  changed();
}

function onLeave(conn) {
  const entry = conns.find((c) => c.conn === conn);
  if (!entry) return;
  conns = conns.filter((c) => c !== entry);
  conn.close();
  if (entry.seat != null) seats[entry.seat] = { kind: 'open' };
  changed();
}

function onHostData(conn, d) {
  const entry = conns.find((c) => c.conn === conn);
  if (entry) entry.lastSeen = Date.now();
  if (!d || d.type !== 'move' || !entry || entry.seat !== state.turn || state.winner != null) return;
  const m = state.legal.find((x) => x.from === d.from && x.to === d.to && (x.promo || null) === d.promo);
  if (m) makeMove(m);
  else broadcast();
}

function joinGame(id) {
  mode = 'client';
  seats = [{ kind: 'human' }, { kind: 'open' }, { kind: 'open' }];
  state = { board: E.initialBoard(), turn: 0, alive: [true, true, true], log: [], lastMove: null, winner: null, legal: [] };
  history = [];
  if (typeof Peer === 'undefined') {
    netStatus = 'Couldn\'t load the online-play library. Check your connection and reload.';
    render();
    return;
  }
  netStatus = 'Connecting to the game…';
  peer = new Peer({ debug: 1 });
  peer.on('open', () => {
    hostConn = peer.connect(id, { reliable: true });
    hostConn.on('open', () => {
      netStatus = 'Connected.';
      lastFromHost = Date.now();
      const timer = setInterval(() => {
        if (Date.now() - lastFromHost > TIMEOUT_MS) {
          clearInterval(timer);
          hostLost();
        } else {
          hostConn.send({ type: 'ping' });
        }
      }, PING_MS);
      render();
    });
    hostConn.on('data', onClientData);
    hostConn.on('close', hostLost);
  });
  peer.on('error', (e) => {
    netStatus = e.type === 'peer-unavailable'
      ? 'Game not found. The host may have closed their tab.'
      : `Connection problem (${e.type}).`;
    render();
  });
  render();
}

function hostLost() {
  hostGone = true;
  netStatus = 'Lost the connection to the host. The game has ended.';
  mySeat = null;
  state.legal = [];
  selected = null;
  render();
}

function onClientData(d) {
  lastFromHost = Date.now();
  if (!d || d.type !== 'state' || hostGone) return;
  state = { ...d.state, legal: [] };
  seats = d.seats;
  mySeat = d.you;
  if (isMyTurn()) state.legal = E.legalMoves(state.board, state.turn, state.alive);
  if (!(isMyTurn() && state.board[selected]?.owner === mySeat)) selected = null;
  render();
}

function leaveOnline() {
  location.href = location.pathname;
}

function cellName(i) {
  return `${E.FILES[E.fileOf(i)]}${E.rankOf(i) + 1}${PLAYERS[E.segOf(i)].name[0].toLowerCase()}`;
}

function describe(m) {
  if (m.castle) return E.fileOf(m.to) === 6 ? 'O-O' : 'O-O-O';
  const pc = state.board[m.from];
  const piece = pc.type === 'P' ? '' : glyph(pc.type);
  return `${piece}${cellName(m.from)}${m.capture ? '×' : '–'}${cellName(m.to)}${m.promo ? '=' + glyph(m.promo) : ''}`;
}

// ---------- computer player ----------

// One-ply greedy: grab material, avoid hanging the moved piece, like checks and promotions.
function aiMove() {
  const me = state.turn;
  let best = null;
  let bestScore = -Infinity;
  for (const m of state.legal) {
    const pc = state.board[m.from];
    const victim = state.board[m.to];
    const nb = E.applyMove(state.board, m);
    let score = Math.random() * 0.6;
    if (victim) score += AI_VALUE[victim.type] * 10;
    if (m.promo) score += m.promo === 'Q' ? 80 : 10;
    if (m.castle) score += 2;
    const moved = nb[m.to];
    if (E.attackedBy(nb, m.to, me, state.alive)) score -= AI_VALUE[moved.type] * 9;
    else if (E.attackedBy(state.board, m.from, me, state.alive)) score += AI_VALUE[pc.type] * 4;
    for (const p of [0, 1, 2]) if (p !== me && state.alive[p] && E.inCheck(nb, p, state.alive)) score += 3;
    if (pc.type === 'P') score += 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  makeMove(best);
}

// ---------- input ----------

function onCellClick(i) {
  if (!isMyTurn()) return;
  if (selected != null) {
    const ms = state.legal.filter((m) => m.from === selected && m.to === i);
    if (ms.length > 1) return askPromotion(ms);
    if (ms.length === 1) return makeMove(ms[0]);
  }
  const pc = state.board[i];
  selected = pc && pc.owner === state.turn && selected !== i ? i : null;
  render();
}

function askPromotion(ms) {
  const box = document.getElementById('promo');
  box.innerHTML = '';
  for (const m of ms) {
    const b = document.createElement('button');
    b.textContent = glyph(m.promo);
    b.style.color = PLAYERS[state.turn].fill;
    b.style.webkitTextStroke = `1px ${PLAYERS[state.turn].stroke}`;
    b.onclick = () => {
      box.classList.add('hidden');
      makeMove(m);
    };
    box.appendChild(b);
  }
  box.classList.remove('hidden');
}

// ---------- geometry ----------

const RADIUS = 100;

function geometry(rot) {
  const H = (k) => {
    const a = ((240 + 60 * (k % 6)) * Math.PI) / 180 + rot;
    return [RADIUS * Math.cos(a), -RADIUS * Math.sin(a)];
  };
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const M = (k) => mid(H(k), H(k + 1));
  const O = [0, 0];
  // Each segment is two quads (files 0-3 and 4-7). Corners in order:
  // (rank 0, low file), (rank 0, high file), (rank 4, high file), (rank 4, low file).
  const quads = [0, 1, 2].map((p) => [
    [H(2 * p), M(2 * p), O, M(2 * p + 5)],
    [M(2 * p), H(2 * p + 1), M(2 * p + 1), O],
  ]);
  const bil = (q, u, v) => [0, 1].map((d) =>
    q[0][d] * (1 - u) * (1 - v) + q[1][d] * u * (1 - v) + q[2][d] * u * v + q[3][d] * (1 - u) * v);
  // Map a (file, rank) position in a segment, in cell units (may be fractional or outside), to a point.
  const at = (p, file, rank) => {
    const right = file >= 4;
    return bil(quads[p][right ? 1 : 0], (file - (right ? 4 : 0)) / 4, rank / 4);
  };
  const cells = [];
  for (let i = 0; i < 96; i++) {
    const p = E.segOf(i), r = E.rankOf(i), f = E.fileOf(i);
    const q = quads[p][f >= 4 ? 1 : 0];
    const u0 = (f % 4) / 4, u1 = (f % 4 + 1) / 4, v0 = r / 4, v1 = (r + 1) / 4;
    const pts = [bil(q, u0, v0), bil(q, u1, v0), bil(q, u1, v1), bil(q, u0, v1)];
    let area = 0;
    for (let k = 0; k < 4; k++) {
      const [x1, y1] = pts[k], [x2, y2] = pts[(k + 1) % 4];
      area += x1 * y2 - x2 * y1;
    }
    cells.push({ pts, center: bil(q, (u0 + u1) / 2, (v0 + v1) / 2), size: Math.sqrt(Math.abs(area) / 2) });
  }
  return { cells, at, H };
}

// ---------- rendering ----------

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

function render() {
  const auto = mode === 'client' ? (mySeat ?? 0) : mode === 'host' ? 0 : (state.winner ?? state.turn);
  const bottom = view === 'auto' ? auto : Number(view);
  const { cells, at, H } = geometry((-120 * bottom * Math.PI) / 180);
  svg.innerHTML = '';

  const checked = new Set();
  for (const p of [0, 1, 2]) {
    if (state.alive[p] && E.inCheck(state.board, p, state.alive)) checked.add(E.kingCell(state.board, p));
  }
  const lm = state.lastMove;
  const targets = selected == null ? [] : state.legal.filter((m) => m.from === selected);

  for (let i = 0; i < 96; i++) {
    const c = cells[i];
    const cls = ['cell', (E.rankOf(i) + E.fileOf(i)) % 2 === 0 ? 'dark' : 'light'];
    if (lm && (lm.from === i || lm.to === i)) cls.push('last');
    if (i === selected) cls.push('selected');
    if (checked.has(i)) cls.push('check');
    const poly = el('polygon', { points: c.pts.map((pt) => pt.join(',')).join(' '), class: cls.join(' ') }, svg);
    poly.addEventListener('click', () => onCellClick(i));
  }

  // Back-rank edges in each player's colour, plus file and rank labels.
  for (const p of [0, 1, 2]) {
    const pl = PLAYERS[p];
    const [a, b] = [H(2 * p), H(2 * p + 1)];
    el('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: 'edge', stroke: !state.alive[p] ? '#555' : p === 2 ? '#8a8a8a' : pl.fill }, svg);
    const color = p === 2 ? '#9aa4ae' : pl.fill;
    for (let f = 0; f < 8; f++) {
      const [x, y] = at(p, f + 0.5, -0.55);
      el('text', { x, y, class: 'label', fill: color }, svg).textContent = E.FILES[f];
    }
    for (let r = 0; r < 4; r++) {
      for (const f of [-0.45, 8.45]) {
        const [x, y] = at(p, f, r + 0.5);
        el('text', { x, y, class: 'label', fill: color }, svg).textContent = r + 1;
      }
    }
  }

  for (let i = 0; i < 96; i++) {
    const pc = state.board[i];
    if (!pc) continue;
    const c = cells[i];
    const pl = PLAYERS[pc.owner];
    el('text', {
      x: c.center[0], y: c.center[1] + c.size * 0.04, class: 'piece',
      'font-size': c.size * 0.82, fill: pl.fill, stroke: pl.stroke, 'stroke-width': c.size * 0.05,
    }, svg).textContent = glyph(pc.type);
  }

  const seen = new Set();
  for (const m of targets) {
    if (seen.has(m.to)) continue;
    seen.add(m.to);
    const c = cells[m.to];
    if (state.board[m.to]) {
      el('circle', { cx: c.center[0], cy: c.center[1], r: c.size * 0.44, class: 'hint-capture', 'stroke-width': c.size * 0.09 }, svg);
    } else {
      el('circle', { cx: c.center[0], cy: c.center[1], r: c.size * 0.16, class: 'hint' }, svg);
    }
  }

  renderPanel();
}


const SEAT_LABEL = { cpu: 'Computer', remote: 'Online player', open: 'Waiting to join…' };

function renderPanel() {
  const status = document.getElementById('status');
  if (state.winner != null) {
    status.textContent = `${PLAYERS[state.winner].name} wins!`;
    status.style.setProperty('--player', PLAYERS[state.winner].fill);
  } else {
    const pl = PLAYERS[state.turn];
    const kind = seats[state.turn].kind;
    const check = E.inCheck(state.board, state.turn, state.alive) ? ' (in check)' : '';
    let text = `${pl.name} to move${check}`;
    if (mode !== 'local' && isMyTurn()) text = `Your move${check}`;
    else if (kind === 'open') text = `Waiting for someone to join as ${pl.name}`;
    else if (kind === 'cpu') text += ' (computer thinking…)';
    status.textContent = text;
    status.style.setProperty('--player', pl.fill);
  }

  renderOnline();

  const players = document.getElementById('players');
  players.innerHTML = '';
  for (const p of [0, 1, 2]) {
    const pl = PLAYERS[p];
    const kind = seats[p].kind;
    const row = document.createElement('div');
    row.className = 'player-row';
    if (!state.alive[p]) row.classList.add('out');
    else if (state.winner == null && state.turn === p) row.classList.add('to-move');
    row.innerHTML = `<span class="swatch" style="background:${pl.fill}"></span><span class="name">${pl.name}</span>`;
    if (!state.alive[p]) row.insertAdjacentHTML('beforeend', '<span class="tag">out</span>');
    // Local games can switch any seat; a host can hand seats nobody has joined to the computer.
    const options = mode === 'local' ? [['human', 'Human'], ['cpu', 'Computer']]
      : mode === 'host' && (kind === 'open' || kind === 'cpu') ? [['open', 'Open'], ['cpu', 'Computer']]
      : null;
    if (options) {
      const sel = document.createElement('select');
      sel.innerHTML = options.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
      sel.value = kind;
      sel.onchange = () => {
        seats[p] = { kind: sel.value };
        changed();
      };
      row.appendChild(sel);
    } else {
      let who = SEAT_LABEL[kind];
      if (mode === 'host' && kind === 'human') who = 'You';
      if (mode === 'client') who = p === mySeat ? 'You' : kind === 'human' ? 'Host' : who;
      row.insertAdjacentHTML('beforeend', `<span class="who">${who}</span>`);
    }
    players.appendChild(row);
  }

  const log = document.getElementById('log');
  log.innerHTML = '';
  for (const entry of state.log) {
    const li = document.createElement('li');
    if (entry.sys) {
      li.className = 'sys';
      li.textContent = entry.text;
    } else {
      li.innerHTML = `<span class="swatch" style="display:inline-block;width:9px;height:9px;margin-right:6px;background:${PLAYERS[entry.player].fill}"></span>`;
      li.append(entry.text);
    }
    log.appendChild(li);
  }
  log.scrollTop = log.scrollHeight;

  document.getElementById('new-game').hidden = mode === 'client';
  document.getElementById('undo').hidden = mode !== 'local';
  document.getElementById('undo').disabled = history.length === 0;
}

function renderOnline() {
  const box = document.getElementById('online');
  box.innerHTML = '';
  const add = (html) => box.insertAdjacentHTML('beforeend', html);
  if (mode === 'local') {
    add('<div><button id="go-online">Play online</button></div>');
    add('<div class="muted">Get a link to send to friends so you can play from different computers.</div>');
    if (netStatus) add(`<div>${netStatus}</div>`);
    document.getElementById('go-online').onclick = goOnline;
    return;
  }
  add(`<div>${netStatus}</div>`);
  if (mode === 'host' && shareLink) {
    add('<div class="share"><input id="share-link" readonly><button id="copy-link">Copy</button></div>');
    const input = document.getElementById('share-link');
    input.value = shareLink;
    input.onclick = () => input.select();
    document.getElementById('copy-link').onclick = async (e) => {
      await navigator.clipboard.writeText(shareLink);
      e.target.textContent = 'Copied';
    };
    add('<div class="muted">Keep this tab open: it runs the game.</div>');
  }
  if (mode === 'client' && hostConn?.open && mySeat == null) add('<div class="muted">The game is full, so you\'re watching.</div>');
  add('<div><button id="leave-online">Leave online game</button></div>');
  document.getElementById('leave-online').onclick = leaveOnline;
}

document.getElementById('new-game').onclick = newGame;
document.getElementById('undo').onclick = undo;
document.getElementById('view').onchange = (e) => {
  view = e.target.value;
  render();
};

const joinId = new URLSearchParams(location.search).get('join');
if (joinId) joinGame(joinId);
else newGame();
