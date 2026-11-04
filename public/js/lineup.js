// Image de la compo : terrain de five vu de dessus, une équipe par moitié, prête à partager.

const W = 1080;
const H = 1630;
const PITCH = { x: 60, y: 320, w: 960, h: 1200 };

const COLORS = {
  bg: '#101814',
  grass: '#17803f',
  grassAlt: '#1a8a45',
  line: 'rgba(255,255,255,0.85)',
  text: '#ffffff',
  muted: '#b9c4be',
  bib: '#ff6b1a',
  bibInk: '#3a1600',
  dark: '#101814',
};

// Positions (x, rangée) : rangée 0 = près du but, 1 = près du milieu de terrain. 3 rangées max pour rester lisible.
const FORMATIONS = {
  1: [[0.5, 0.5]],
  2: [[0.5, 0], [0.5, 1]],
  3: [[0.5, 0], [0.28, 1], [0.72, 1]],
  4: [[0.5, 0], [0.25, 0.5], [0.75, 0.5], [0.5, 1]],
  5: [[0.5, 0], [0.25, 0.5], [0.75, 0.5], [0.3, 1], [0.7, 1]],
  6: [[0.5, 0], [0.16, 0.5], [0.5, 0.5], [0.84, 0.5], [0.3, 1], [0.7, 1]],
  7: [[0.5, 0], [0.16, 0.5], [0.5, 0.5], [0.84, 0.5], [0.16, 1], [0.5, 1], [0.84, 1]],
};

function positions(n) {
  if (FORMATIONS[n]) return FORMATIONS[n];
  // Au-delà de 7 : grille régulière
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return Array.from({ length: n }, (_, i) => [((i % cols) + 0.5) / cols, (Math.floor(i / cols) + 0.5) / rows]);
}

const initials = (name) => {
  const w = String(name || '?').trim().split(/\s+/);
  return (w.length > 1 ? w[0][0] + w[1][0] : w[0].slice(0, 2)).toUpperCase();
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitText(ctx, text, maxW) {
  let t = text;
  while (ctx.measureText(t).width > maxW && t.length > 3) t = t.slice(0, -2) + '…';
  return t;
}

function drawPitch(ctx) {
  const { x, y, w, h } = PITCH;
  ctx.save();
  roundRect(ctx, x, y, w, h, 36);
  ctx.clip();
  const bands = 10;
  for (let i = 0; i < bands; i++) {
    ctx.fillStyle = i % 2 ? COLORS.grassAlt : COLORS.grass;
    ctx.fillRect(x, y + (h / bands) * i, w, h / bands + 1);
  }
  ctx.restore();

  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 5;
  const m = 24;
  roundRect(ctx, x + m, y + m, w - 2 * m, h - 2 * m, 18);
  ctx.stroke();
  // Ligne médiane et rond central
  ctx.beginPath();
  ctx.moveTo(x + m, y + h / 2);
  ctx.lineTo(x + w - m, y + h / 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + w / 2, y + h / 2, 90, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + w / 2, y + h / 2, 7, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.line;
  ctx.fill();
  // Surfaces (arcs, comme un terrain de five)
  for (const top of [true, false]) {
    const gy = top ? y + m : y + h - m;
    ctx.beginPath();
    ctx.arc(x + w / 2, gy, 170, top ? 0 : Math.PI, top ? Math.PI : Math.PI * 2);
    ctx.stroke();
    // Buts
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(x + w / 2 - 80, top ? gy - 12 : gy, 160, 12);
  }
}

function drawPlayer(ctx, cx, cy, p, team) {
  const r = 52;
  const isA = team === 'A';
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = isA ? COLORS.bib : COLORS.dark;
  ctx.fill();
  ctx.restore();
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = isA ? COLORS.bibInk : '#ffffff';
  ctx.font = "800 34px Bricolage, 'Helvetica Neue', Arial, sans-serif";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initials(p.name), cx, cy + 2);

  if (p.isGuest) {
    roundRect(ctx, cx + 22, cy - r - 6, 56, 32, 16);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.fillStyle = COLORS.dark;
    ctx.font = "700 20px Geist, 'Helvetica Neue', Arial, sans-serif";
    ctx.fillText('+1', cx + 50, cy - r + 10);
  }

  // Nom dans une pastille lisible sur l'herbe
  ctx.font = "600 30px Geist, 'Helvetica Neue', Arial, sans-serif";
  const label = fitText(ctx, p.name.split(' ')[0], 230);
  const tw = ctx.measureText(label).width + 32;
  roundRect(ctx, cx - tw / 2, cy + r + 12, tw, 46, 23);
  ctx.fillStyle = 'rgba(16,24,20,0.82)';
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, cx, cy + r + 36);
}

/**
 * Dessine l'image de la compo et renvoie un Blob PNG.
 * data = { groupName, dateLabel, timeLabel, location, teamNames: {A, B}, teamA: [{name, isGuest}], teamB: [...], url }
 */
export async function renderLineup(data) {
  if (document.fonts?.ready) {
    await Promise.all([
      document.fonts.load("800 34px Bricolage"),
      document.fonts.load("600 30px Geist"),
      document.fonts.load("400 30px Geist"),
    ]).catch(() => {});
  }
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  // En-tête
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = COLORS.muted;
  ctx.font = "600 32px Geist, 'Helvetica Neue', Arial, sans-serif";
  ctx.fillText(data.groupName, 64, 92);
  ctx.fillStyle = COLORS.text;
  ctx.font = "800 72px Bricolage, 'Helvetica Neue', Arial, sans-serif";
  ctx.fillText(fitText(ctx, data.dateLabel, 950), 60, 160);
  ctx.fillStyle = COLORS.muted;
  ctx.font = "400 34px Geist, 'Helvetica Neue', Arial, sans-serif";
  ctx.fillText(fitText(ctx, [data.timeLabel, data.location].filter(Boolean).join(', '), 950), 64, 212);

  drawPitch(ctx);

  // Équipe B en haut (vers le but du haut), équipe A en bas
  const half = PITCH.h / 2;
  const padX = 110;
  const usableW = PITCH.w - 2 * padX;
  const first = 110; // centre de la rangée la plus proche du but
  const last = half - 150; // rangée la plus proche du milieu (laisse la place au nom)
  const place = (players, team) => {
    const pos = positions(players.length);
    players.forEach((p, i) => {
      const [fx, fy] = pos[i];
      const cx = PITCH.x + padX + fx * usableW;
      const depth = first + fy * (last - first);
      const cy = team === 'B' ? PITCH.y + depth : PITCH.y + PITCH.h - depth - 50;
      drawPlayer(ctx, cx, cy, p, team);
    });
  };
  place(data.teamB, 'B');
  place(data.teamA, 'A');

  // Étiquettes d'équipe
  const tag = (label, y, isA) => {
    ctx.font = "700 30px Geist, 'Helvetica Neue', Arial, sans-serif";
    const tw = ctx.measureText(label).width + 56;
    roundRect(ctx, PITCH.x, y, tw, 50, 25);
    ctx.fillStyle = isA ? COLORS.bib : '#ffffff';
    ctx.fill();
    ctx.fillStyle = isA ? COLORS.bibInk : COLORS.dark;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, PITCH.x + 28, y + 26);
  };
  tag(data.teamNames.B, PITCH.y - 66, false);
  tag(data.teamNames.A, PITCH.y + PITCH.h + 16, true);

  // Pied
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = COLORS.muted;
  ctx.font = "400 28px Geist, 'Helvetica Neue', Arial, sans-serif";
  ctx.textAlign = 'right';
  ctx.fillText(data.url ? data.url.replace(/^https?:\/\//, '').replace(/\/#.*$/, '') : '', PITCH.x + PITCH.w, PITCH.y + PITCH.h + 52);

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
