// Remplit une base de démo (joueurs fictifs, 6 matchs joués, prochain jeudi en cours d'inscription).
// Usage : DATA_DIR=./demo-data node --disable-warning=ExperimentalWarning scripts/seed-demo.js
import path from 'node:path';
import { openDb, getSettings } from '../src/db.js';
import { createService } from '../src/service.js';
import { hashPassword, nameKey } from '../src/auth.js';
import { levelRating } from '../src/teams.js';
import { upcomingSlots, toLocalInput, parseLocalDateTime } from '../src/time.js';

const dir = process.env.DATA_DIR || path.resolve('demo-data');
const db = openDb(path.join(dir, 'five.db'));
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
  console.error('La base contient déjà des comptes, abandon.');
  process.exit(1);
}

let now = new Date();
const svc = createService(db, { clock: () => now });
const s = getSettings(db);
const PASSWORD = 'demo1234';
const hash = hashPassword(PASSWORD);

const roster = [
  ['Mika', 7, 'admin'],
  ['Karim', 8],
  ['Thomas', 6],
  ['Julien', 5],
  ['Nico', 7],
  ['Seb', 4],
  ['Romain', 6],
  ['Alex', 5],
  ['Bruno', 3],
  ['Yann', 8],
  ['Lucas', 6],
  ['Max', 5],
  ['Hugo', 4],
  ['Théo', 7],
];
const users = roster.map(([name, level, role]) => {
  const r = db
    .prepare('INSERT INTO users (name, name_key, password_hash, role, level, elo) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, nameKey(name), hash, role || 'player', level, levelRating(level));
  return db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
});
db.prepare(`UPDATE settings SET value = '["UrbanSoccer Montaudran","Five Sesquières","Le Five Toulouse Sud"]' WHERE key = 'venues'`).run();

let seed = 42;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const shuffle = (xs) => xs.map((x) => [rnd(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);

// Jeudis passés
const tz = s.timezone;
const nextSlots = upcomingSlots(new Date(), 4, s.time, 1, tz);
const nextThursday = nextSlots[0].startsAt;
for (let w = 6; w >= 1; w--) {
  const day = toLocalInput(new Date(nextThursday.getTime() - w * 7 * 86400e3), tz).slice(0, 10);
  const startsAtLocal = `${day}T${s.time}`;
  const start = parseLocalDateTime(startsAtLocal, tz);
  now = new Date(start.getTime() - 3 * 86400e3);
  const m = svc.createMatch({ startsAt: startsAtLocal, location: w === 3 ? 'Five Sesquières' : 'UrbanSoccer Montaudran', capacity: 12 });
  const players = shuffle(users).slice(0, 12);
  for (const p of players) svc.join(m.id, p);
  now = new Date(start.getTime() - 2 * 3600e3);
  svc.generateTeams(m.id, { rng: rnd });
  now = new Date(start.getTime() + 75 * 60e3);
  const dto = svc.serializeMatch(svc.getMatch(m.id), users[0]);
  const A = dto.confirmed.filter((e) => e.team === 'A');
  const B = dto.confirmed.filter((e) => e.team === 'B');
  const goals = {};
  const score = (team) => {
    const n = Math.floor(rnd() * 9) + 2;
    for (let g = 0; g < n; g++) {
      const e = team[Math.floor(rnd() * team.length)];
      goals[e.id] = (goals[e.id] || 0) + 1;
    }
    return n;
  };
  const scoreA = score(A);
  const scoreB = score(B);
  svc.saveResult(m.id, { scoreA, scoreB, goals });
  const top = Object.entries(goals).sort((a, b) => b[1] - a[1])[0][0];
  for (const e of dto.confirmed) {
    if (e.id === Number(top)) continue;
    const voter = users.find((u) => u.id === e.userId);
    svc.vote(m.id, voter, rnd() < 0.7 ? Number(top) : dto.confirmed[Math.floor(rnd() * 12)].id === e.id ? Number(top) : dto.confirmed[Math.floor(rnd() * 12)].id);
  }
}

// Un désistement tardif pour l'exemple
now = new Date();
const m = svc.createMatch({ startsAt: toLocalInput(nextThursday, tz), location: 'UrbanSoccer Montaudran', capacity: 12 });
const order = ['Mika', 'Karim', 'Thomas', 'Nico', 'Yann', 'Romain', 'Lucas', 'Alex', 'Théo', 'Julien', 'Max', 'Bruno', 'Hugo'];
for (const name of order) {
  const u = users.find((x) => x.name === name);
  if (name === 'Julien') svc.join(m.id, u, [{ name: 'Sam', level: 6 }]);
  else svc.join(m.id, u);
}
svc.generateTeams(m.id, { rng: rnd });
db.prepare('DELETE FROM sent_notifications').run();
// Un jeudi planifié ailleurs, un autre sauté
const later = upcomingSlots(new Date(), 4, s.time, 3, tz);
svc.planSlot(later[1].slot, { location: 'Five Sesquières' });
svc.planSlot(later[2].slot, { skipped: true });

console.log(`Base de démo prête dans ${dir}`);
console.log(`Comptes : ${roster.map((r) => r[0]).join(', ')} — mot de passe : ${PASSWORD} (Mika est organisateur)`);
console.log(`Code d'invitation : ${getSettings(db).invite_code}`);
