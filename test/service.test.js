import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setSettings } from '../src/db.js';
import { createService } from '../src/service.js';
import { hashPassword, nameKey } from '../src/auth.js';
import { upcomingSlots } from '../src/time.js';
import { balanceTeams, levelRating } from '../src/teams.js';

// Hachage une seule fois pour accélérer les tests
const HASH = hashPassword('secret');

function setup(startIso = '2026-11-02T09:00:00Z') {
  const db = openDb(':memory:');
  const sent = [];
  const clock = { now: new Date(startIso) };
  const notifier = { send: async (ids, payload) => sent.push({ ids, ...payload }) };
  const svc = createService(db, { notifier, clock: () => clock.now });
  const users = [];
  const addUser = (name, level = 5, role = 'player') => {
    const r = db
      .prepare('INSERT INTO users (name, name_key, password_hash, role, level, elo) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, nameKey(name), HASH, role, level, levelRating(level));
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    users.push(u);
    return u;
  };
  const flush = () => new Promise((r) => setTimeout(r, 5));
  return { db, svc, sent, clock, addUser, users, flush };
}

function matchIn(svc, iso = '2026-11-05T20:00') {
  return svc.createMatch({ startsAt: iso, location: 'Five Toulouse', capacity: 12 });
}

test('créneau hebdo : jeudi 20h heure de Paris, changement d’heure géré', () => {
  const slots = upcomingSlots(new Date('2026-10-20T10:00:00Z'), 4, '20:00', 2, 'Europe/Paris');
  assert.equal(slots[0].slot, '2026-10-22');
  assert.equal(slots[0].startsAt.toISOString(), '2026-10-22T18:00:00.000Z'); // heure d'été
  assert.equal(slots[1].slot, '2026-10-29');
  assert.equal(slots[1].startsAt.toISOString(), '2026-10-29T19:00:00.000Z'); // heure d'hiver
});

test('liste d’attente : 12 titulaires, le 13e attend puis remonte au désistement', async () => {
  const { svc, addUser, sent, flush } = setup();
  const m = matchIn(svc);
  const players = Array.from({ length: 13 }, (_, i) => addUser(`Joueur ${i + 1}`));
  for (const p of players) svc.join(m.id, p);
  let dto = svc.serializeMatch(svc.getMatch(m.id), players[12]);
  assert.equal(dto.confirmed.length, 12);
  assert.equal(dto.waitlist.length, 1);
  assert.deepEqual(dto.me, { entryId: dto.waitlist[0].id, spot: 'waitlist', team: null, waitPosition: 1 });

  await flush();
  sent.length = 0;
  const e3 = svc.serializeMatch(svc.getMatch(m.id), players[2]).me.entryId;
  svc.cancelEntry(e3, players[2]);
  await flush();
  dto = svc.serializeMatch(svc.getMatch(m.id), players[12]);
  assert.equal(dto.confirmed.length, 12);
  assert.equal(dto.waitlist.length, 0);
  assert.equal(dto.me.spot, 'confirmed');
  assert.ok(sent.some((n) => n.ids.includes(players[12].id) && n.title === 'Tu passes titulaire !'));
});

test('+1 : l’invité prend une place, passe en attente si complet, et part avec son hôte', () => {
  const { svc, addUser } = setup();
  const m = matchIn(svc);
  const ps = Array.from({ length: 11 }, (_, i) => addUser(`P${i}`));
  for (const p of ps.slice(0, 10)) svc.join(m.id, p);
  // 11e joueur vient avec 2 potes : lui + 1 invité titulaires, le 2e invité en attente
  svc.join(m.id, ps[10], [{ name: 'Karim', level: 7 }, { name: 'Léo' }]);
  let dto = svc.serializeMatch(svc.getMatch(m.id), ps[10]);
  assert.equal(dto.confirmed.length, 12);
  assert.equal(dto.waitlist.length, 1);
  assert.equal(dto.waitlist[0].name, 'Léo');
  assert.equal(dto.waitlist[0].hostName, 'P10');
  const karim = dto.confirmed.find((e) => e.name === 'Karim');
  assert.ok(karim.isGuest);

  // L'hôte se retire : ses deux invités aussi
  svc.cancelEntry(dto.me.entryId, ps[10]);
  dto = svc.serializeMatch(svc.getMatch(m.id), ps[0]);
  assert.equal(dto.confirmed.length, 10);
  assert.equal(dto.waitlist.length, 0);

  // On ne peut pas ajouter de +1 sans être inscrit
  assert.throws(() => svc.addGuest(m.id, ps[10], { name: 'Bob' }), /Inscris-toi/);
});

test('double inscription refusée, match commencé verrouillé', () => {
  const { svc, addUser, clock } = setup();
  const m = matchIn(svc);
  const p = addUser('Alex');
  svc.join(m.id, p);
  assert.throws(() => svc.join(m.id, p), /déjà inscrit/);
  clock.now = new Date('2026-11-05T19:30:00Z');
  const q = addUser('Bruno');
  assert.throws(() => svc.join(m.id, q), /commencé/);
});

test('équipes équilibrées : 6 contre 6, écart minimal', () => {
  const { svc, addUser } = setup();
  const m = matchIn(svc);
  const levels = [9, 8, 8, 7, 6, 6, 5, 5, 4, 3, 3, 2];
  levels.forEach((l, i) => svc.join(m.id, addUser(`N${i}`, l)));
  svc.generateTeams(m.id);
  const admin = addUser('Orga', 5, 'admin');
  const dto = svc.serializeMatch(svc.getMatch(m.id), admin);
  const A = dto.confirmed.filter((e) => e.team === 'A');
  const B = dto.confirmed.filter((e) => e.team === 'B');
  assert.equal(A.length, 6);
  assert.equal(B.length, 6);
  const sum = (xs) => xs.reduce((a, e) => a + e.strength, 0);
  assert.ok(Math.abs(sum(A) - sum(B)) <= 60, `écart trop grand: ${sum(A)} vs ${sum(B)}`);
  assert.ok(dto.teams.prediction >= 45 && dto.teams.prediction <= 55);
});

test('algo : nombre impair et grand groupe', () => {
  const players = Array.from({ length: 11 }, (_, i) => ({ key: `u${i}`, strength: 900 + i * 25 }));
  const r = balanceTeams(players);
  assert.equal(r.A.length + r.B.length, 11);
  assert.equal(Math.abs(r.A.length - r.B.length), 1);
  const big = Array.from({ length: 24 }, (_, i) => ({ key: `u${i}`, strength: 800 + ((i * 37) % 400) }));
  const r2 = balanceTeams(big);
  assert.equal(r2.A.length, 12);
  assert.ok(Math.abs(r2.sumA - r2.sumB) < 100);
});

test('remontée après équipes faites : le remplaçant prend l’équipe libérée', () => {
  const { svc, addUser } = setup();
  const m = matchIn(svc);
  const ps = Array.from({ length: 13 }, (_, i) => addUser(`R${i}`, 5));
  ps.forEach((p) => svc.join(m.id, p));
  svc.generateTeams(m.id);
  const leaver = svc.serializeMatch(svc.getMatch(m.id), ps[0]).me;
  svc.cancelEntry(leaver.entryId, ps[0]);
  const sub = svc.serializeMatch(svc.getMatch(m.id), ps[12]).me;
  assert.equal(sub.spot, 'confirmed');
  assert.equal(sub.team, leaver.team);
});

test('désistement tardif (< 24h) comptabilisé', () => {
  const { svc, addUser, clock } = setup();
  const m = matchIn(svc);
  const p = addUser('Tardif');
  svc.join(m.id, p);
  clock.now = new Date('2026-11-05T10:00:00Z');
  svc.cancelEntry(svc.serializeMatch(svc.getMatch(m.id), p).me.entryId, p);
  const st = svc.stats('all');
  assert.equal(st.players.find((x) => x.userId === p.id).lateCancels, 1);
});

test('résultat, Elo, vote MVP et stats', async () => {
  const { svc, addUser, clock, db } = setup();
  const m = matchIn(svc);
  const ps = Array.from({ length: 12 }, (_, i) => addUser(`S${i}`, 5));
  ps.forEach((p) => svc.join(m.id, p));
  svc.generateTeams(m.id);
  clock.now = new Date('2026-11-05T21:30:00Z');
  const admin = addUser('Admin', 5, 'admin');
  let dto = svc.serializeMatch(svc.getMatch(m.id), admin);
  const scorer = dto.confirmed.find((e) => e.team === 'A');
  svc.saveResult(m.id, { scoreA: 8, scoreB: 5, goals: { [scorer.id]: 4 } });

  const elo = (u) => db.prepare('SELECT elo, games FROM users WHERE id = ?').get(u.id);
  const aPlayer = ps.find((p) => p.id === scorer.userId);
  const bEntry = dto.confirmed.find((e) => e.team === 'B');
  const bPlayer = ps.find((p) => p.id === bEntry.userId);
  assert.ok(elo(aPlayer).elo > 1000);
  assert.ok(elo(bPlayer).elo < 1000);
  assert.equal(elo(aPlayer).games, 1);

  // MVP : pas de vote pour soi, vote ouvert aux joueurs du match
  assert.throws(() => svc.vote(m.id, aPlayer, scorer.id), /soi-même/);
  assert.throws(() => svc.vote(m.id, admin, scorer.id), /Seuls les joueurs/);
  for (const p of ps.filter((p) => p.id !== aPlayer.id)) svc.vote(m.id, p, scorer.id);
  svc.vote(m.id, aPlayer, bEntry.id);
  dto = svc.serializeMatch(svc.getMatch(m.id), aPlayer);
  assert.equal(dto.mvp.open, true);
  assert.deepEqual(dto.mvp.winners, []); // gagnant révélé à la clôture

  clock.now = new Date('2026-11-09T21:00:00Z'); // > 72 h
  dto = svc.serializeMatch(svc.getMatch(m.id), aPlayer);
  assert.deepEqual(dto.mvp.winners, [scorer.id]);

  const st = svc.stats('2026');
  const row = st.players.find((x) => x.userId === aPlayer.id);
  assert.equal(row.wins, 1);
  assert.equal(row.goals, 4);
  assert.equal(row.mvps, 1);
  assert.deepEqual(row.form, ['V']);

  const prof = svc.playerProfile(aPlayer.id, aPlayer);
  assert.equal(prof.totals.played, 1);
  assert.ok(prof.strength > 1000);
  const hidden = svc.playerProfile(aPlayer.id, bPlayer);
  assert.equal(hidden.strength, undefined);

  // Correction du score : l'Elo est recalculé
  svc.saveResult(m.id, { scoreA: 2, scoreB: 6, goals: {} });
  assert.ok(elo(aPlayer).elo < 1000);
});

test('rappels automatiques : création du match, relance, rappel jour J, une seule fois', async () => {
  const { svc, addUser, sent, clock, flush, db } = setup('2026-10-30T10:00:00Z'); // vendredi
  const ps = Array.from({ length: 5 }, (_, i) => addUser(`T${i}`));
  setSettings(db, { open_days_before: '6' });

  // Vendredi : jeudi suivant est à > 6 jours -> rien
  svc.runReminders();
  assert.equal(svc.listMatches(ps[0]).upcoming.length, 0);

  // Vendredi 20h passé -> le match du jeudi 5/11 est créé
  clock.now = new Date('2026-10-30T19:30:00Z');
  svc.runReminders();
  await flush();
  const up = svc.listMatches(ps[0]).upcoming;
  assert.equal(up.length, 1);
  assert.ok(sent.some((n) => n.title === 'Inscriptions ouvertes' && n.ids.length === 5));
  const id = up[0].id;
  svc.join(id, ps[0]);
  svc.join(id, ps[1]);

  // Mercredi 18h (26h avant) : relance des non-inscrits
  sent.length = 0;
  clock.now = new Date('2026-11-04T18:00:00Z');
  svc.runReminders();
  svc.runReminders();
  await flush();
  const unreg = sent.filter((n) => n.title.startsWith('Il reste'));
  assert.equal(unreg.length, 1);
  assert.equal(unreg[0].title, 'Il reste 10 places');
  assert.deepEqual(unreg[0].ids.sort(), [ps[2].id, ps[3].id, ps[4].id].sort());

  // Jeudi 12h (8h avant) : rappel aux inscrits
  sent.length = 0;
  clock.now = new Date('2026-11-05T11:30:00Z');
  svc.runReminders();
  await flush();
  const conf = sent.filter((n) => n.title === "C'est ce soir !");
  assert.equal(conf.length, 2);
});

test('lieu planifié à l’avance et jeudi sans five', () => {
  const { svc, db, clock } = setup('2026-11-02T09:00:00Z'); // lundi
  setSettings(db, { open_days_before: '6' });
  const planned = svc.plannedSlots(4);
  assert.equal(planned[0].slot, '2026-11-05');
  assert.equal(planned[0].location, 'UrbanSoccer Montaudran');
  svc.planSlot('2026-11-12', { location: 'Five Sesquières' });
  svc.planSlot('2026-11-19', { skipped: true });
  assert.throws(() => svc.planSlot('2026-11-13', { location: 'X' }), /hors calendrier/);

  clock.now = new Date('2026-11-06T20:00:00Z'); // ouverture du 12/11
  svc.runReminders();
  const up = svc.listMatches(null).upcoming;
  assert.equal(up.find((m) => m.startsAt.startsWith('2026-11-12')).location, 'Five Sesquières');

  clock.now = new Date('2026-11-13T20:00:00Z'); // le 19/11 est sauté
  svc.runReminders();
  assert.ok(!svc.listMatches(null).upcoming.some((m) => m.startsAt.startsWith('2026-11-19')));
  assert.equal(svc.plannedSlots(2)[0].skipped, true);
});

test('suppression d’un compte : tout part, la liste d’attente remonte, Elo recalculé', async () => {
  const { svc, addUser, db, clock, flush, sent } = setup();
  const admin = addUser('Orga', 5, 'admin');
  const m = matchIn(svc);
  const ps = Array.from({ length: 13 }, (_, i) => addUser(`D${i}`));
  ps.forEach((p, i) => svc.join(m.id, p, i === 0 ? [{ name: 'Invité' }] : []));
  const old = matchIn(svc, '2026-11-12T20:00');
  ps.slice(0, 12).forEach((p) => svc.join(old.id, p));
  svc.generateTeams(old.id);
  clock.now = new Date('2026-11-12T21:30:00Z');
  svc.saveResult(old.id, { scoreA: 5, scoreB: 3 });
  clock.now = new Date('2026-11-02T09:00:00Z');
  assert.throws(() => svc.deleteUser(admin.id, admin), /propre compte/);

  await flush();
  sent.length = 0;
  svc.deleteUser(ps[0].id, admin);
  await flush();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(ps[0].id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries WHERE user_id = ?').get(ps[0].id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rating_history WHERE user_id = ?').get(ps[0].id).n, 0);
  const dto = svc.serializeMatch(svc.getMatch(m.id), admin);
  assert.equal(dto.confirmed.length, 12); // lui + son invité partis, 2 remontés
  assert.equal(dto.waitlist.length, 0);
  assert.ok(sent.some((n) => n.title === 'Tu passes titulaire !'));
  assert.ok(!svc.stats('all').players.some((p) => p.userId === ps[0].id));
});
