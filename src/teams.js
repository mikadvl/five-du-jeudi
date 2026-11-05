// Niveau, indice de forme (Elo) et répartition des équipes.

/** Niveau 1-10 saisi par l'admin -> note de base. 5 = 1000. */
export const levelRating = (level) => 1000 + (Number(level ?? 5) - 5) * 60;

/**
 * Force utilisée pour équilibrer les équipes.
 * Mélange le niveau déclaré et l'Elo issu des résultats : plus un joueur a de matchs,
 * plus son historique pèse (jusqu'à 70 % au bout de 10 matchs).
 */
export function blendedStrength({ level, elo, games }) {
  const w = (Math.min(games || 0, 10) / 10) * 0.7;
  return (1 - w) * levelRating(level) + w * (elo ?? levelRating(level));
}

export const expectedScore = (avgA, avgB) => 1 / (1 + 10 ** ((avgB - avgA) / 400));

/** Variation d'Elo pour chaque joueur de l'équipe A (l'équipe B prend l'opposé). */
export function eloDelta({ avgA, avgB, scoreA, scoreB, k = 20 }) {
  const expected = expectedScore(avgA, avgB);
  const actual = scoreA > scoreB ? 1 : scoreA < scoreB ? 0 : 0.5;
  const margin = Math.log(Math.abs(scoreA - scoreB) + 1) + 1;
  return k * margin * (actual - expected);
}

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
export { pairKey };

/**
 * Répartit les joueurs en 2 équipes.
 * players: [{ key, strength }]
 * pairCounts: Map(pairKey -> nb de fois coéquipiers récemment) pour varier les compos.
 * Retourne { A: [key], B: [key], sumA, sumB }
 */
export function balanceTeams(players, { pairCounts = new Map(), pairWeight = 6, profileWeight = 30, tolerance = 25, rng = Math.random } = {}) {
  const n = players.length;
  if (n === 0) return { A: [], B: [], sumA: 0, sumB: 0 };
  if (n === 1) return { A: [players[0].key], B: [], sumA: players[0].strength, sumB: 0 };

  const s = players.map((p) => p.strength);
  const total = s.reduce((a, b) => a + b, 0);
  const pen = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) pen[i][j] = (pairCounts.get(pairKey(players[i].key, players[j].key)) || 0) * pairWeight;

  // Profils (attaque, défense, technique… en points de niveau) : on répartit chaque qualité des deux côtés
  const prof = players.map((p) => p.profile || null);
  const dims = prof.find(Boolean)?.length || 0;
  const cost = (inA) => {
    let sumA = 0;
    for (let i = 0; i < n; i++) if (inA[i]) sumA += s[i];
    let p = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (inA[i] === inA[j]) p += pen[i][j];
    let q = 0;
    for (let d = 0; d < dims; d++) {
      let diff = 0;
      for (let i = 0; i < n; i++) if (prof[i]) diff += inA[i] ? prof[i][d] : -prof[i][d];
      q += Math.abs(diff);
    }
    return Math.abs(sumA - (total - sumA)) + p + q * profileWeight;
  };

  const sizeA = Math.floor(n / 2);
  let candidates = [];

  if (n <= 20) {
    // Énumération exhaustive (C(12,6)/2 = 462 compos pour 12 joueurs)
    const inA = new Array(n).fill(false);
    let best = Infinity;
    const all = [];
    const rec = (start, left) => {
      if (left === 0) {
        if (n % 2 === 0 && !inA[0]) return; // évite les doublons miroir
        const c = cost(inA);
        all.push([c, inA.slice()]);
        if (c < best) best = c;
        return;
      }
      for (let i = start; i <= n - left; i++) {
        inA[i] = true;
        rec(i + 1, left - 1);
        inA[i] = false;
      }
    };
    rec(0, sizeA);
    candidates = all.filter(([c]) => c <= best + tolerance).map(([, split]) => split);
  } else {
    // Grand groupe : draft en serpentin puis améliorations par échanges
    const order = [...s.keys()].sort((a, b) => s[b] - s[a]);
    const inA = new Array(n).fill(false);
    let countA = 0;
    order.forEach((idx, k) => {
      const toA = (k % 4 === 0 || k % 4 === 3) && countA < sizeA;
      if (toA || n - k <= sizeA - countA) {
        inA[idx] = true;
        countA++;
      }
    });
    let c = cost(inA);
    for (let it = 0; it < 5000; it++) {
      const i = Math.floor(rng() * n);
      const j = Math.floor(rng() * n);
      if (inA[i] === inA[j]) continue;
      inA[i] = !inA[i];
      inA[j] = !inA[j];
      const c2 = cost(inA);
      if (c2 <= c) c = c2;
      else {
        inA[i] = !inA[i];
        inA[j] = !inA[j];
      }
    }
    candidates = [inA];
  }

  let pick = candidates[Math.floor(rng() * candidates.length)];
  // Côté chasuble tiré au sort (sauf si les tailles diffèrent : l'équipe A reste la plus petite)
  if (n % 2 === 0 && rng() < 0.5) pick = pick.map((x) => !x);

  const A = [];
  const B = [];
  let sumA = 0;
  let sumB = 0;
  players.forEach((p, i) => {
    if (pick[i]) {
      A.push(p.key);
      sumA += p.strength;
    } else {
      B.push(p.key);
      sumB += p.strength;
    }
  });
  return { A, B, sumA, sumB };
}
