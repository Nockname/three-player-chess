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
let controllers = ['human', 'cpu', 'cpu'];
let view = 'auto';
let aiTimer = null;

// ---------- game flow ----------

function newGame() {
  clearTimeout(aiTimer);
  state = { board: E.initialBoard(), turn: 0, alive: [true, true, true], log: [], lastMove: null, winner: null, legal: [] };
  history = [];
  selected = null;
  startTurn();
}

const nextAlive = (p) => [1, 2, 3].map((k) => (p + k) % 3).find((q) => state.alive[q]);

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
      render();
      return;
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
  render();
  if (controllers[state.turn] === 'cpu') aiTimer = setTimeout(aiMove, 500);
}

function makeMove(m) {
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
  while (history.length && controllers[snap.turn] === 'cpu') snap = history.pop();
  state.board = snap.board;
  state.turn = snap.turn;
  state.alive = snap.alive;
  state.log.length = snap.logLen;
  state.lastMove = snap.lastMove;
  state.winner = null;
  startTurn();
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
  if (state.winner != null || controllers[state.turn] !== 'human') return;
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
  const bottom = view === 'auto' ? (state.winner ?? state.turn) : Number(view);
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

function renderPanel() {
  const status = document.getElementById('status');
  if (state.winner != null) {
    status.textContent = `${PLAYERS[state.winner].name} wins!`;
    status.style.setProperty('--player', PLAYERS[state.winner].fill);
  } else {
    const pl = PLAYERS[state.turn];
    const check = E.inCheck(state.board, state.turn, state.alive) ? ' (in check)' : '';
    const thinking = controllers[state.turn] === 'cpu' ? ' (computer thinking…)' : '';
    status.textContent = `${pl.name} to move${check}${thinking}`;
    status.style.setProperty('--player', pl.fill);
  }

  const players = document.getElementById('players');
  players.innerHTML = '';
  for (const p of [0, 1, 2]) {
    const pl = PLAYERS[p];
    const row = document.createElement('div');
    row.className = 'player-row';
    if (!state.alive[p]) row.classList.add('out');
    else if (state.winner == null && state.turn === p) row.classList.add('to-move');
    row.innerHTML = `<span class="swatch" style="background:${pl.fill}"></span><span class="name">${pl.name}</span>`;
    if (!state.alive[p]) row.insertAdjacentHTML('beforeend', '<span class="tag">out</span>');
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="human">Human</option><option value="cpu">Computer</option>';
    sel.value = controllers[p];
    sel.onchange = () => {
      controllers[p] = sel.value;
      clearTimeout(aiTimer);
      if (state.winner == null && state.turn === p && sel.value === 'cpu') aiTimer = setTimeout(aiMove, 300);
      render();
    };
    row.appendChild(sel);
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
  document.getElementById('undo').disabled = history.length === 0;
}

document.getElementById('new-game').onclick = newGame;
document.getElementById('undo').onclick = undo;
document.getElementById('view').onchange = (e) => {
  view = e.target.value;
  render();
};

newGame();
