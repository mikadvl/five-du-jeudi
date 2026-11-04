import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getSettings } from '../src/db.js';
import { createService } from '../src/service.js';
import { createApp } from '../src/server.js';

async function boot() {
  const db = openDb(':memory:');
  const notifier = { publicKey: 'test', emailEnabled: false, send: async () => ({ push: 0, email: 0 }) };
  const service = createService(db, { notifier });
  const app = createApp({ db, service, notifier, trustProxy: false });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, url, body) => {
      const res = await fetch(base + url, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
  };
  return { db, server, client, code: getSettings(db).invite_code };
}

test('parcours API : inscription, droits, match, +1, désistement', async () => {
  const { server, client, code } = await boot();
  try {
    const orga = client();
    const pote = client();
    const intrus = client();

    assert.equal((await intrus('GET', '/api/home')).status, 401);
    assert.equal((await intrus('POST', '/api/auth/register', { name: 'Intrus', password: 'secret1', inviteCode: 'nope' })).status, 403);

    const r1 = await orga('POST', '/api/auth/register', { name: 'Mika', password: 'secret1', inviteCode: code });
    assert.equal(r1.status, 201);
    assert.equal(r1.body.user.role, 'admin'); // premier compte = organisateur

    const r2 = await pote('POST', '/api/auth/register', { name: 'Karim', password: 'secret2', inviteCode: code, email: 'k@ex.fr' });
    assert.equal(r2.body.user.role, 'player');
    assert.equal((await pote('POST', '/api/auth/register', { name: 'mika', password: 'secret3', inviteCode: code })).status, 409);

    // Un joueur ne peut pas créer de match
    assert.equal((await pote('POST', '/api/matches', { startsAt: '2030-01-10T20:00' })).status, 403);
    const created = await orga('POST', '/api/matches', { startsAt: '2030-01-10T20:00', location: 'Five', capacity: 2 });
    assert.equal(created.status, 201);
    const id = created.body.id;

    let m = (await pote('POST', `/api/matches/${id}/join`, { guests: [{ name: 'Sam', level: 7 }] })).body;
    assert.equal(m.confirmed.length, 2);
    assert.equal(m.me.spot, 'confirmed');
    // Les niveaux ne sont pas visibles par un joueur
    assert.equal(m.confirmed[0].strength, undefined);

    m = (await orga('POST', `/api/matches/${id}/join`, { guests: [] })).body;
    assert.equal(m.me.spot, 'waitlist');
    assert.equal(m.me.waitPosition, 1);
    assert.ok(m.confirmed[0].strength > 0); // visibles par l'orga

    // Karim retire son +1 -> Mika remonte
    const sam = m.confirmed.find((e) => e.isGuest);
    assert.equal((await orga('POST', `/api/entries/${sam.id}/cancel`)).status, 200); // l'orga peut retirer n'importe qui
    m = (await orga('GET', `/api/matches/${id}`)).body;
    assert.equal(m.me.spot, 'confirmed');

    // Karim ne peut pas désinscrire Mika
    assert.equal((await pote('POST', `/api/entries/${m.me.entryId}/cancel`)).status, 403);

    // Connexion par email, insensible à la casse
    const again = client();
    assert.equal((await again('POST', '/api/auth/login', { login: 'K@EX.FR', password: 'secret2' })).status, 200);
    assert.equal((await again('POST', '/api/auth/login', { login: 'karim', password: 'faux' })).status, 401);

    // Réglages admin validés
    assert.equal((await orga('PUT', '/api/admin/settings', { time: '25:00' })).status, 400);
    const s = await orga('PUT', '/api/admin/settings', { time: '19:30', capacity: 10 });
    assert.equal(s.body.time, '19:30');

    // Pages du front servies
    const html = await fetch(`http://127.0.0.1:${server.address().port}/`).then((r) => r.text());
    assert.match(html, /<main id="view"/);
  } finally {
    server.close();
  }
});

test('rôle capitaine : gère les matchs, pas les réglages ni les comptes', async () => {
  const { server, client, code } = await boot();
  try {
    const orga = client();
    const cap = client();
    await orga('POST', '/api/auth/register', { name: 'Orga', password: 'secret1', inviteCode: code });
    const r = await cap('POST', '/api/auth/register', { name: 'Capi', password: 'secret1', inviteCode: code });
    assert.equal((await cap('POST', '/api/matches', { startsAt: '2030-01-10T20:00' })).status, 403);

    assert.equal((await orga('PUT', `/api/admin/users/${r.body.user.id}`, { role: 'captain' })).status, 200);
    const m = await cap('POST', '/api/matches', { startsAt: '2030-01-10T20:00', location: 'Five', capacity: 10 });
    assert.equal(m.status, 201);
    assert.equal(m.body.canManage, true);
    assert.equal((await cap('PUT', `/api/matches/${m.body.id}`, { location: 'UrbanSoccer Montaudran' })).body.location, 'UrbanSoccer Montaudran');

    assert.equal((await cap('GET', '/api/admin/settings')).status, 403);
    assert.equal((await cap('PUT', `/api/admin/users/${r.body.user.id}`, { role: 'admin' })).status, 403);
  } finally {
    server.close();
  }
});

test('le niveau est choisi par le joueur à l’inscription', async () => {
  const { server, client, code, db } = await boot();
  try {
    const a = client();
    await a('POST', '/api/auth/register', { name: 'Orga', password: 'secret1', inviteCode: code });
    const b = client();
    const r = await b('POST', '/api/auth/register', { name: 'Crack', password: 'secret1', inviteCode: code, level: 9 });
    const u = db.prepare('SELECT level, elo FROM users WHERE id = ?').get(r.body.user.id);
    assert.equal(u.level, 9);
    assert.equal(u.elo, 1240);
    assert.equal((await client()('POST', '/api/auth/register', { name: 'Tricheur', password: 'secret1', inviteCode: code, level: 42 })).status, 400);
  } finally {
    server.close();
  }
});

test('répartition anonyme des notes : organisateurs uniquement', async () => {
  const { server, client, code } = await boot();
  try {
    const orga = client();
    const capi = client();
    const x = client();
    await orga('POST', '/api/auth/register', { name: 'Orga', password: 'secret1', inviteCode: code });
    const c = await capi('POST', '/api/auth/register', { name: 'Capi', password: 'secret1', inviteCode: code });
    const t = await x('POST', '/api/auth/register', { name: 'Cible', password: 'secret1', inviteCode: code });
    await orga('PUT', `/api/admin/users/${c.body.user.id}`, { role: 'captain' });
    await orga('PUT', `/api/ratings/${t.body.user.id}`, { rating: 7 });
    await capi('PUT', `/api/ratings/${t.body.user.id}`, { rating: 2 });
    const list = (await orga('GET', '/api/admin/users')).body;
    const row = list.find((u) => u.id === t.body.user.id);
    assert.deepEqual(row.peer_list, [2, 7]);
    assert.ok(!('rater_id' in row));
    assert.equal((await capi('GET', '/api/admin/users')).status, 403);
  } finally {
    server.close();
  }
});
