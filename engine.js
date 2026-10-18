// Rules engine for three-player chess. No DOM access, so it also runs under Node.
//
// The board is a hexagon split into three 4x8 segments, one per player (96 cells).
// A cell is (seg, rank, file): rank 0 is that player's back rank, rank 3 touches the
// middle. Files 0-3 of segment p border files 7-4 of segment p-1, and files 4-7
// border files 3-0 of segment p+1. Crossing that seam flips the direction of travel.
// Six cells meet at the centre; a diagonal through the centre continues to the
// cell directly opposite.
(function (root) {
  const FILES = 'abcdefgh';
  const idx = (p, r, f) => p * 32 + r * 8 + f;
  const segOf = (i) => i >> 5;
  const rankOf = (i) => (i >> 3) & 3;
  const fileOf = (i) => i & 7;

  const VALUES = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };
  const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const ALL = ORTH.concat(DIAG);

  // One step from cell i in direction (dr, df), expressed in i's segment frame.
  // Returns the new cell and the direction re-expressed in the new cell's frame.
  function step(i, dr, df) {
    const p = segOf(i), r = rankOf(i), f = fileOf(i);
    const nr = r + dr, nf = f + df;
    if (nf < 0 || nf > 7 || nr < 0) return null;
    if (nr <= 3) return { i: idx(p, nr, nf), dr, df };
    if (f === 3 && df === 1) return { i: idx((p + 1) % 3, 3, 4), dr: -1, df: 1 };
    if (f === 4 && df === -1) return { i: idx((p + 2) % 3, 3, 3), dr: -1, df: -1 };
    const q = nf < 4 ? (p + 2) % 3 : (p + 1) % 3;
    return { i: idx(q, 3, 7 - nf), dr: -dr, df: -df };
  }

  function initialBoard() {
    const b = new Array(96).fill(null);
    const back = 'RNBQKBNR';
    for (let p = 0; p < 3; p++) {
      for (let f = 0; f < 8; f++) {
        b[idx(p, 0, f)] = { type: back[f], owner: p, moved: false };
        b[idx(p, 1, f)] = { type: 'P', owner: p, moved: false };
      }
    }
    return b;
  }

  // Pawns move toward the middle in their own segment, then toward the enemy's back rank.
  const pawnDir = (i, owner) => (segOf(i) === owner ? 1 : -1);

  function knightTargets(i) {
    const out = new Set();
    const perp = (dr) => (dr !== 0 ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]]);
    for (const [dr, df] of ORTH) {
      const a = step(i, dr, df);
      if (!a) continue;
      for (const [pr, pf] of perp(a.dr)) {
        const b1 = step(a.i, pr, pf);
        const b2 = b1 && step(b1.i, b1.dr, b1.df);
        if (b2) out.add(b2.i);
      }
      const b = step(a.i, a.dr, a.df);
      if (!b) continue;
      for (const [pr, pf] of perp(b.dr)) {
        const c = step(b.i, pr, pf);
        if (c) out.add(c.i);
      }
    }
    out.delete(i);
    return [...out];
  }

  function slide(board, i, dirs) {
    const out = [];
    for (const [dr, df] of dirs) {
      let cur = { i, dr, df };
      for (let n = 0; n < 16; n++) {
        const s = step(cur.i, cur.dr, cur.df);
        if (!s || s.i === i) break;
        out.push(s.i);
        if (board[s.i]) break;
        cur = s;
      }
    }
    return out;
  }

  // Cells the piece on i attacks (for pawns, only the diagonal captures).
  function attacks(board, i) {
    const pc = board[i];
    switch (pc.type) {
      case 'P': {
        const d = pawnDir(i, pc.owner);
        return [1, -1].map((df) => step(i, d, df)).filter(Boolean).map((s) => s.i);
      }
      case 'N': return knightTargets(i);
      case 'K': return ALL.map(([dr, df]) => step(i, dr, df)).filter(Boolean).map((s) => s.i);
      case 'R': return slide(board, i, ORTH);
      case 'B': return slide(board, i, DIAG);
      default: return slide(board, i, ALL);
    }
  }

  function attackedBy(board, cell, player, alive) {
    for (let i = 0; i < 96; i++) {
      const pc = board[i];
      if (pc && pc.owner !== player && alive[pc.owner] && attacks(board, i).includes(cell)) return true;
    }
    return false;
  }

  function kingCell(board, player) {
    return board.findIndex((pc) => pc && pc.owner === player && pc.type === 'K');
  }

  function inCheck(board, player, alive) {
    const k = kingCell(board, player);
    return k >= 0 && attackedBy(board, k, player, alive);
  }

  function pseudoMoves(board, i) {
    const pc = board[i];
    const moves = [];
    const add = (to) => {
      const t = board[to];
      if (t && t.owner === pc.owner) return;
      const m = { from: i, to, capture: !!t };
      if (pc.type === 'P' && rankOf(to) === 0 && segOf(to) !== pc.owner) {
        for (const promo of ['Q', 'R', 'B', 'N']) moves.push({ ...m, promo });
      } else {
        moves.push(m);
      }
    };
    if (pc.type === 'P') {
      const d = pawnDir(i, pc.owner);
      const s = step(i, d, 0);
      if (s && !board[s.i]) {
        add(s.i);
        if (segOf(i) === pc.owner && rankOf(i) === 1) {
          const s2 = step(s.i, s.dr, s.df);
          if (s2 && !board[s2.i]) add(s2.i);
        }
      }
      for (const df of [1, -1]) {
        const c = step(i, d, df);
        if (c && board[c.i] && board[c.i].owner !== pc.owner) add(c.i);
      }
    } else {
      for (const to of attacks(board, i)) add(to);
    }
    return moves;
  }

  function applyMove(board, m) {
    const nb = board.slice();
    const pc = nb[m.from];
    nb[m.to] = m.promo ? { type: m.promo, owner: pc.owner, moved: true } : { ...pc, moved: true };
    nb[m.from] = null;
    if (m.castle) {
      nb[m.castle.to] = { ...nb[m.castle.from], moved: true };
      nb[m.castle.from] = null;
    }
    return nb;
  }

  function legalMoves(board, player, alive) {
    const res = [];
    for (let i = 0; i < 96; i++) {
      const pc = board[i];
      if (!pc || pc.owner !== player) continue;
      for (const m of pseudoMoves(board, i)) {
        if (!inCheck(applyMove(board, m), player, alive)) res.push(m);
      }
    }
    const k = idx(player, 0, 4);
    const K = board[k];
    if (K && K.type === 'K' && K.owner === player && !K.moved && !inCheck(board, player, alive)) {
      // [rook file, cells that must be empty, cell the king passes, king dest, rook dest]
      for (const [rf, between, pass, kTo, rTo] of [[7, [5, 6], 5, 6, 5], [0, [1, 2, 3], 3, 2, 3]]) {
        const rk = board[idx(player, 0, rf)];
        if (!rk || rk.type !== 'R' || rk.owner !== player || rk.moved) continue;
        if (between.some((f) => board[idx(player, 0, f)])) continue;
        if (attackedBy(board, idx(player, 0, pass), player, alive)) continue;
        const m = { from: k, to: idx(player, 0, kTo), capture: false, castle: { from: idx(player, 0, rf), to: idx(player, 0, rTo) } };
        if (!inCheck(applyMove(board, m), player, alive)) res.push(m);
      }
    }
    return res;
  }

  const api = {
    FILES, VALUES, idx, segOf, rankOf, fileOf, step,
    initialBoard, attacks, attackedBy, inCheck, kingCell, pseudoMoves, applyMove, legalMoves,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ThreeChess = api;
})(this);
