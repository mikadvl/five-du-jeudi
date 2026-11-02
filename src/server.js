import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getSettings, setSettings, tx } from './db.js';
import { createService, HttpError } from './service.js';
import { createNotifier } from './notify.js';
import { levelRating } from './teams.js';
import {
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  userFromToken,
  parseCookies,
  nameKey,
  rateLimiter,
  purgeExpiredSessions,
} from './auth.js';
import { toLocalInput } from './time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const bad = (msg) => new HttpError(400, msg);
const str = (v, min, max, label) => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (s.length < min || s.length > max) throw bad(`${label} : entre ${min} et ${max} caractères`);
  return s;
};
const emailOrNull = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || s.length > 120) throw bad('Adresse email invalide');
  return s.toLowerCase();
};

const publicUser = (u) =>
  u && {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    notifyEmail: !!u.notify_email,
  };

const EDITABLE_SETTINGS = {
  group_name: (v) => str(v, 1, 40, 'Nom du groupe'),
  location: (v) => str(v, 0, 120, 'Lieu'),
  weekday: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 6) throw bad('Jour invalide');
    return n;
  },
  time: (v) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) throw bad('Heure invalide (HH:MM)');
    return v;
  },
  capacity: (v) => intRange(v, 2, 40, 'Nombre de places'),
  open_days_before: (v) => intRange(v, 1, 14, 'Ouverture des inscriptions'),
  remind_unregistered_hours: (v) => intRange(v, 0, 168, 'Relance des non-inscrits'),
  remind_confirmed_hours: (v) => intRange(v, 0, 72, 'Rappel aux joueurs'),
  remind_open: (v) => (v === true || v === '1' || v === 1 ? 1 : 0),
  team_a_name: (v) => str(v, 1, 20, 'Nom équipe A'),
  team_b_name: (v) => str(v, 1, 20, 'Nom équipe B'),
  mvp_vote_hours: (v) => intRange(v, 1, 168, 'Durée du vote'),
  invite_code: (v) => str(v, 4, 32, "Code d'invitation"),
  venues: (v) => {
    const list = (Array.isArray(v) ? v : String(v ?? '').split('\n'))
      .map((x) => String(x).trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    const unique = [...new Set(list)];
    if (unique.length > 12) throw bad('12 lieux maximum');
    if (unique.some((x) => x.length > 120)) throw bad('Nom de lieu trop long (120 caractères max)');
    return JSON.stringify(unique);
  },
  timezone: (v) => {
    try {
      new Intl.DateTimeFormat('fr-FR', { timeZone: String(v) });
    } catch {
      throw bad('Fuseau horaire invalide');
    }
    return String(v);
  },
};
export function parseVenues(s) {
  try {
    const a = JSON.parse(s.venues || '[]');
    const list = Array.isArray(a) ? a.map(String) : [];
    return s.location && !list.includes(s.location) ? [s.location, ...list] : list;
  } catch {
    return s.location ? [s.location] : [];
  }
}
const settingsDto = (s) =>
  Object.fromEntries(Object.keys(EDITABLE_SETTINGS).map((k) => [k, k === 'venues' ? parseVenues(s) : s[k]]));

function intRange(v, min, max, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label} : entre ${min} et ${max}`);
  return n;
}

export function createApp({ db, service, notifier, trustProxy = true }) {
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);
  app.use(express.json({ limit: '64kb' }));

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'",
    });
    req.user = userFromToken(db, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    next();
  });

  const requireUser = (req, res, next) => (req.user ? next() : next(new HttpError(401, 'Connecte-toi')));
  const requireAdmin = (req, res, next) =>
    req.user?.role === 'admin' ? next() : next(new HttpError(req.user ? 403 : 401, 'Réservé aux organisateurs'));

  const setSessionCookie = (req, res, userId) => {
    const { token, maxAge } = createSession(db, userId);
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge, path: '/' });
  };
  const authLimiter = rateLimiter({ max: 10, windowMs: 15 * 60e3 });
  const matchDto = (req, id) => service.serializeMatch(service.requireMatch(id), req.user);

  // ---------- Santé ----------
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // ---------- Session ----------
  app.get('/api/me', (req, res) => {
    const s = getSettings(db);
    res.json({
      user: publicUser(req.user),
      group: {
        name: s.group_name,
        teamA: s.team_a_name,
        teamB: s.team_b_name,
        timezone: s.timezone,
        capacity: Number(s.capacity),
        location: s.location,
        venues: parseVenues(s),
      },
      vapidPublicKey: notifier.publicKey,
      emailEnabled: notifier.emailEnabled,
      hasUsers: db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0,
    });
  });

  app.post('/api/auth/register', (req, res) => {
    if (!authLimiter(`reg:${req.ip}`)) throw new HttpError(429, 'Trop de tentatives, réessaie dans 15 minutes');
    const name = str(req.body?.name, 2, 30, 'Prénom / pseudo');
    const password = String(req.body?.password || '');
    if (password.length < 6) throw bad('Mot de passe : 6 caractères minimum');
    const email = emailOrNull(req.body?.email);
    const s = getSettings(db);
    if (String(req.body?.inviteCode || '').trim() !== s.invite_code) throw new HttpError(403, "Code d'invitation incorrect");
    const user = tx(db, () => {
      const first = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
      if (db.prepare('SELECT 1 FROM users WHERE name_key = ?').get(nameKey(name))) throw new HttpError(409, 'Ce nom est déjà pris');
      if (email && db.prepare('SELECT 1 FROM users WHERE lower(email) = ?').get(email))
        throw new HttpError(409, 'Cet email est déjà utilisé');
      const r = db
        .prepare('INSERT INTO users (name, name_key, email, password_hash, role, level, elo) VALUES (?, ?, ?, ?, ?, 5, ?)')
        .run(name, nameKey(name), email, hashPassword(password), first ? 'admin' : 'player', levelRating(5));
      return db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    });
    setSessionCookie(req, res, user.id);
    res.status(201).json({ user: publicUser(user) });
  });

  app.post('/api/auth/login', (req, res) => {
    if (!authLimiter(`login:${req.ip}`)) throw new HttpError(429, 'Trop de tentatives, réessaie dans 15 minutes');
    const login = String(req.body?.login || '').trim();
    const user = db
      .prepare('SELECT * FROM users WHERE (name_key = ? OR lower(email) = ?) AND active = 1')
      .get(nameKey(login), login.toLowerCase());
    if (!user || !verifyPassword(String(req.body?.password || ''), user.password_hash))
      throw new HttpError(401, 'Identifiant ou mot de passe incorrect');
    setSessionCookie(req, res, user.id);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    destroySession(db, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // ---------- Profil ----------
  app.put('/api/me', requireUser, (req, res) => {
    const b = req.body || {};
    const u = req.user;
    const name = b.name !== undefined ? str(b.name, 2, 30, 'Prénom / pseudo') : u.name;
    const email = b.email !== undefined ? emailOrNull(b.email) : u.email;
    const notify = b.notifyEmail !== undefined ? (b.notifyEmail ? 1 : 0) : u.notify_email;
    const clash = db.prepare('SELECT 1 FROM users WHERE name_key = ? AND id <> ?').get(nameKey(name), u.id);
    if (clash) throw new HttpError(409, 'Ce nom est déjà pris');
    if (email && db.prepare('SELECT 1 FROM users WHERE lower(email) = ? AND id <> ?').get(email, u.id))
      throw new HttpError(409, 'Cet email est déjà utilisé');
    db.prepare('UPDATE users SET name = ?, name_key = ?, email = ?, notify_email = ? WHERE id = ?').run(name, nameKey(name), email, notify, u.id);
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
  });

  app.put('/api/me/password', requireUser, (req, res) => {
    if (!verifyPassword(String(req.body?.current || ''), req.user.password_hash)) throw new HttpError(403, 'Mot de passe actuel incorrect');
    const next = String(req.body?.next || '');
    if (next.length < 6) throw bad('Mot de passe : 6 caractères minimum');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    res.json({ ok: true });
  });

  app.post('/api/push/subscribe', requireUser, (req, res) => {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) throw bad('Abonnement invalide');
    db.prepare(
      `INSERT INTO push_subs (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    ).run(req.user.id, String(endpoint), String(keys.p256dh), String(keys.auth));
    res.json({ ok: true });
  });

  app.delete('/api/push/subscribe', requireUser, (req, res) => {
    db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').run(String(req.body?.endpoint || ''), req.user.id);
    res.json({ ok: true });
  });

  app.post('/api/me/test-notification', requireUser, async (req, res) => {
    const r = await notifier.send([req.user.id], {
      title: 'Notifications activées',
      body: 'Tu recevras les rappels du five ici.',
      url: '/#/',
      tag: 'test',
    });
    res.json(r);
  });

  // ---------- Matchs ----------
  app.get('/api/home', requireUser, (req, res) => {
    const m = service.nextMatch();
    res.json({
      next: m ? service.serializeMatch(m, req.user) : null,
      pendingVote: service.pendingVote(req.user),
      last: service.lastResult(),
      teamNames: { A: getSettings(db).team_a_name, B: getSettings(db).team_b_name },
    });
  });
  app.put('/api/planned/:slot', requireAdmin, (req, res) => {
    res.json(service.planSlot(String(req.params.slot), { location: req.body?.location, skipped: !!req.body?.skipped }));
  });
  app.get('/api/matches', requireUser, (req, res) => res.json(service.listMatches(req.user)));
  app.get('/api/matches/:id', requireUser, (req, res) => res.json(matchDto(req, req.params.id)));

  app.post('/api/matches/:id/join', requireUser, (req, res) => {
    service.join(req.params.id, req.user, req.body?.guests || []);
    res.json(matchDto(req, req.params.id));
  });
  app.post('/api/matches/:id/guests', requireUser, (req, res) => {
    service.addGuest(req.params.id, req.user, req.body || {});
    res.json(matchDto(req, req.params.id));
  });
  app.post('/api/entries/:id/cancel', requireUser, (req, res) => {
    const e = db.prepare('SELECT match_id FROM entries WHERE id = ?').get(Number(req.params.id));
    if (!e) throw new HttpError(404, 'Inscription introuvable');
    service.cancelEntry(req.params.id, req.user);
    res.json(matchDto(req, e.match_id));
  });
  app.post('/api/matches/:id/mvp', requireUser, (req, res) => {
    service.vote(req.params.id, req.user, req.body?.entryId);
    res.json(matchDto(req, req.params.id));
  });

  // Admin – matchs
  app.post('/api/matches', requireAdmin, (req, res) => {
    const m = service.createMatch(req.body || {});
    res.status(201).json(service.serializeMatch(m, req.user));
  });
  app.get('/api/matches/:id/edit', requireAdmin, (req, res) => {
    const m = service.requireMatch(req.params.id);
    res.json({ startsAt: toLocalInput(new Date(m.starts_at), getSettings(db).timezone), location: m.location, capacity: m.capacity, notes: m.notes });
  });
  app.put('/api/matches/:id', requireAdmin, (req, res) => {
    service.updateMatch(req.params.id, req.body || {});
    res.json(matchDto(req, req.params.id));
  });
  app.post('/api/matches/:id/cancel', requireAdmin, (req, res) => {
    service.cancelMatch(req.params.id, req.body?.reason);
    res.json(matchDto(req, req.params.id));
  });
  app.post('/api/matches/:id/restore', requireAdmin, (req, res) => {
    service.restoreMatch(req.params.id);
    res.json(matchDto(req, req.params.id));
  });
  app.post('/api/matches/:id/players', requireAdmin, (req, res) => {
    service.addPlayer(req.params.id, req.user, req.body?.userId);
    res.json(matchDto(req, req.params.id));
  });
  app.post('/api/matches/:id/teams', requireAdmin, (req, res) => {
    service.generateTeams(req.params.id);
    res.json(matchDto(req, req.params.id));
  });
  app.put('/api/matches/:id/teams', requireAdmin, (req, res) => {
    service.setTeams(req.params.id, req.body?.assignments || {});
    res.json(matchDto(req, req.params.id));
  });
  app.delete('/api/matches/:id/teams', requireAdmin, (req, res) => {
    service.clearTeams(req.params.id);
    res.json(matchDto(req, req.params.id));
  });
  app.put('/api/matches/:id/result', requireAdmin, (req, res) => {
    service.saveResult(req.params.id, req.body || {});
    res.json(matchDto(req, req.params.id));
  });
  app.delete('/api/matches/:id/result', requireAdmin, (req, res) => {
    service.clearResult(req.params.id);
    res.json(matchDto(req, req.params.id));
  });

  // ---------- Stats & joueurs ----------
  app.get('/api/stats', requireUser, (req, res) => res.json(service.stats(req.query.season || '')));
  app.get('/api/players', requireUser, (req, res) =>
    res.json(db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY name_key').all()),
  );
  app.get('/api/players/:id', requireUser, (req, res) => res.json(service.playerProfile(req.params.id, req.user)));

  // ---------- Admin ----------
  app.get('/api/admin/settings', requireAdmin, (req, res) => {
    res.json(settingsDto(getSettings(db)));
  });
  app.put('/api/admin/settings', requireAdmin, (req, res) => {
    const out = {};
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!EDITABLE_SETTINGS[k]) continue;
      out[k] = EDITABLE_SETTINGS[k](v);
    }
    setSettings(db, out);
    service.runReminders();
    res.json(settingsDto(getSettings(db)));
  });

  app.get('/api/admin/users', requireAdmin, (req, res) => {
    const rows = db
      .prepare(
        `SELECT u.id, u.name, u.email, u.role, u.level, u.elo, u.games, u.active,
                (SELECT COUNT(*) FROM push_subs p WHERE p.user_id = u.id) AS devices
         FROM users u ORDER BY u.active DESC, u.name_key`,
      )
      .all();
    res.json(rows.map((r) => ({ ...r, elo: Math.round(r.elo), active: !!r.active })));
  });

  app.put('/api/admin/users/:id', requireAdmin, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
    if (!u) throw new HttpError(404, 'Joueur introuvable');
    const b = req.body || {};
    const level = b.level !== undefined ? intRange(b.level, 1, 10, 'Niveau') : u.level;
    const role = b.role !== undefined ? (b.role === 'admin' ? 'admin' : 'player') : u.role;
    const active = b.active !== undefined ? (b.active ? 1 : 0) : u.active;
    if ((role !== 'admin' || !active) && u.role === 'admin') {
      const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?").get(u.id).n;
      if (admins === 0) throw bad('Il faut garder au moins un organisateur');
    }
    db.prepare('UPDATE users SET level = ?, role = ?, active = ? WHERE id = ?').run(level, role, active, u.id);
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    if (level !== u.level) service.recomputeRatings();
    res.json({ ok: true });
  });

  app.post('/api/admin/users/:id/reset-password', requireAdmin, (req, res) => {
    const u = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(req.params.id));
    if (!u) throw new HttpError(404, 'Joueur introuvable');
    const temp = crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(temp), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    res.json({ password: temp });
  });

  app.use('/api', (req, res, next) => next(new HttpError(404, 'Route inconnue')));

  // ---------- Front (PWA) ----------
  app.use(
    express.static(PUBLIC_DIR, {
      setHeaders(res, file) {
        if (file.endsWith('sw.js') || file.endsWith('.html') || file.endsWith('.webmanifest')) res.set('Cache-Control', 'no-cache');
      },
    }),
  );
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  // ---------- Erreurs ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalide' });
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  });

  return app;
}

// ---------- Démarrage ----------
async function main() {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const db = openDb(path.join(dataDir, 'five.db'));
  const notifier = await createNotifier(db, {
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    appUrl: process.env.APP_URL || '',
  });
  const service = createService(db, { notifier });

  if (process.env.INVITE_CODE && db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    setSettings(db, { invite_code: process.env.INVITE_CODE });
  }

  const app = createApp({ db, service, notifier, trustProxy: process.env.TRUST_PROXY !== '0' });
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    const s = getSettings(db);
    console.log(`[five] ${s.group_name} prêt sur le port ${port}`);
    if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
      console.log(`[five] Aucun compte : le premier inscrit devient organisateur. Code d'invitation : ${s.invite_code}`);
    }
  });

  const tick = () => {
    try {
      service.runReminders();
      purgeExpiredSessions(db);
    } catch (err) {
      console.error('[scheduler]', err);
    }
  };
  tick();
  setInterval(tick, 60e3).unref?.();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
