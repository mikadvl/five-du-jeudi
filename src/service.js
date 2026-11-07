// Logique métier : matchs, inscriptions / liste d'attente / +1, équipes, résultats, Elo, stats, rappels.
import { tx, getSettings } from './db.js';
import { balanceTeams, blendedStrength, levelRating, expectedScore, eloDelta, pairKey } from './teams.js';
import { upcomingSlots, parseLocalDateTime, seasonOf, seasonRange, localParts } from './time.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);
/** Organisateur ou capitaine : peut gérer les matchs. */
export const canManage = (user) => user?.role === 'admin' || user?.role === 'captain';
const conflict = (msg) => new HttpError(409, msg);
const H = 3600e3;
/** Nombre de notes reçues à partir duquel la moyenne des potes remplace le niveau de départ. */
export const PEER_MIN = 3;
export const ATTRS = [
  { key: 'att', short: 'ATT', label: 'Attaque' },
  { key: 'def', short: 'DEF', label: 'Défense' },
  { key: 'tec', short: 'TEC', label: 'Technique' },
  { key: 'vit', short: 'VIT', label: 'Vitesse' },
  { key: 'end', short: 'END', label: 'Endurance' },
  { key: 'phy', short: 'PHY', label: 'Physique' },
];
// Critères répartis des deux côtés lors de la création des équipes
const PROFILE_ATTRS = ['att', 'def', 'tec'];
const PROFILE_LABELS = { att: 'Buteur', def: 'Défenseur', tec: 'Technicien', vit: 'Rapide', end: 'Box to box', phy: 'Puissant' };

/** Profil du joueur d'après ses critères les plus forts. */
export function profileLabel(attrs) {
  const vals = ATTRS.map((a) => [a.key, attrs[a.key].value]);
  const max = Math.max(...vals.map((v) => v[1]));
  const min = Math.min(...vals.map((v) => v[1]));
  if (max - min < 1) return 'Polyvalent';
  return PROFILE_LABELS[vals.find((v) => v[1] === max)[0]];
}

const intIn = (v, min, max, fallback) => {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

export function createService(db, { notifier = { send: async () => ({}) }, clock = () => new Date() } = {}) {
  const settings = () => getSettings(db);
  const nowIso = () => clock().toISOString();

  // ---------- Notifications ----------
  const fire = (userIds, payload) => {
    const ids = [...new Set(userIds)];
    if (!ids.length) return;
    Promise.resolve()
      .then(() => notifier.send(ids, payload))
      .catch((err) => console.error('[notify]', err));
  };
  /** Exécute fn une seule fois pour une clé donnée (évite les doublons de rappels). */
  const once = (key, fn) => {
    const r = db.prepare('INSERT OR IGNORE INTO sent_notifications (key) VALUES (?)').run(key);
    if (r.changes === 1) fn();
    return r.changes === 1;
  };
  const fmt = (iso, opts) => new Intl.DateTimeFormat('fr-FR', { timeZone: settings().timezone, ...opts }).format(new Date(iso));
  const dayLabel = (iso) => fmt(iso, { weekday: 'long', day: 'numeric', month: 'long' });
  const timeLabel = (iso) => fmt(iso, { hour: '2-digit', minute: '2-digit' });
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const isSameLocalDay = (iso) => {
    const tz = settings().timezone;
    const a = localParts(new Date(iso), tz);
    const b = localParts(clock(), tz);
    return a.y === b.y && a.m === b.m && a.d === b.d;
  };
  const activeUserIds = () => db.prepare('SELECT id FROM users WHERE active = 1').all().map((u) => u.id);
  const teamName = (t) => {
    const s = settings();
    return t === 'A' ? s.team_a_name : t === 'B' ? s.team_b_name : null;
  };

  // ---------- Accès aux données ----------
  const getMatch = (id) => db.prepare('SELECT * FROM matches WHERE id = ?').get(Number(id)) || null;
  const requireMatch = (id) => {
    const m = getMatch(id);
    if (!m) throw new HttpError(404, 'Match introuvable');
    return m;
  };
  const activeEntries = (matchId) =>
    db
      .prepare(
        `SELECT e.*, u.name AS user_name, u.level AS user_level, u.elo AS user_elo, u.games AS user_games
         FROM entries e JOIN users u ON u.id = e.user_id
         WHERE e.match_id = ? AND e.state = 'active' ORDER BY e.id`,
      )
      .all(matchId);
  const entryStrength = (e) =>
    e.guest_name ? levelRating(e.guest_level) : blendedStrength({ level: e.user_level, elo: e.user_elo, games: e.user_games });
  const isStarted = (m) => new Date(m.starts_at) <= clock();
  const isPlayed = (m) => m.score_a !== null && m.score_a !== undefined;
  const confirmedCount = (matchId) =>
    db.prepare("SELECT COUNT(*) AS n FROM entries WHERE match_id = ? AND state = 'active' AND spot = 'confirmed'").get(matchId).n;

  function assertJoinable(m, user) {
    if (m.cancelled) throw conflict('Ce match est annulé');
    if (isPlayed(m)) throw conflict('Ce match est déjà joué');
    if (isStarted(m) && !canManage(user)) throw conflict('Le match a déjà commencé');
  }

  function cleanGuest(g) {
    const name = String(g?.name || '').trim().replace(/\s+/g, ' ');
    if (name.length < 1 || name.length > 40) throw bad('Donne un prénom à ton +1 (40 caractères max)');
    return { name, level: intIn(g?.level, 1, 10, 5) };
  }

  function insertEntry(m, userId, guest) {
    const spot = confirmedCount(m.id) < m.capacity ? 'confirmed' : 'waitlist';
    const r = db
      .prepare('INSERT INTO entries (match_id, user_id, guest_name, guest_level, spot) VALUES (?, ?, ?, ?, ?)')
      .run(m.id, userId, guest ? guest.name : null, guest ? guest.level : null, spot);
    return { id: Number(r.lastInsertRowid), spot };
  }

  /**
   * Recalcule titulaires / liste d'attente : les `capacity` premiers inscrits (ordre d'arrivée) jouent.
   * Si les équipes sont déjà faites, un joueur repêché prend l'équipe laissée vacante.
   */
  function normalize(m, vacated = []) {
    const list = db
      .prepare("SELECT id, user_id, guest_name, spot, team FROM entries WHERE match_id = ? AND state = 'active' ORDER BY id")
      .all(m.id);
    const up = db.prepare('UPDATE entries SET spot = ?, team = ? WHERE id = ?');
    const promoted = [];
    list.forEach((e, i) => {
      const want = i < m.capacity ? 'confirmed' : 'waitlist';
      if (want === e.spot) return;
      if (want === 'confirmed') {
        const team = m.teams_at && vacated.length ? vacated.shift() : null;
        up.run('confirmed', team, e.id);
        promoted.push({ ...e, team });
      } else {
        up.run('waitlist', null, e.id);
      }
    });
    return promoted;
  }

  function notifyPromoted(m, promoted) {
    for (const e of promoted) {
      const when = `${dayLabel(m.starts_at)} à ${timeLabel(m.starts_at)}`;
      fire(
        [e.user_id],
        e.guest_name
          ? { title: 'Ton +1 passe titulaire', body: `Une place s'est libérée : ${e.guest_name} joue ${when}.`, url: `/#/match/${m.id}`, tag: `match-${m.id}` }
          : { title: 'Tu passes titulaire !', body: `Une place s'est libérée : tu joues ${when}.`, url: `/#/match/${m.id}`, tag: `match-${m.id}` },
      );
    }
  }

  /** Match au complet : une seule notif par match, aux titulaires et aux organisateurs/capitaines. */
  function checkFull(matchId) {
    const m = getMatch(matchId);
    if (!m || m.cancelled || isPlayed(m) || isStarted(m)) return;
    if (confirmedCount(m.id) < m.capacity) return;
    once(`full:${m.id}`, () => {
      const when = `${dayLabel(m.starts_at)} à ${timeLabel(m.starts_at)}`;
      const players = new Set(
        db.prepare("SELECT DISTINCT user_id FROM entries WHERE match_id = ? AND state = 'active' AND spot = 'confirmed'").all(m.id).map((r) => r.user_id),
      );
      const staff = db
        .prepare("SELECT id FROM users WHERE active = 1 AND role IN ('admin', 'captain')")
        .all()
        .map((u) => u.id)
        .filter((id) => !players.has(id));
      const base = { title: `C'est complet ! ${m.capacity}/${m.capacity}`, url: `/#/match/${m.id}`, tag: `match-${m.id}` };
      fire([...players], { ...base, body: `Le five du ${when} est au complet, tu joues. Si tu ne peux plus venir, désiste-toi vite pour laisser ta place.` });
      fire(staff, { ...base, body: `Le five du ${when} est au complet. Les prochains inscrits passent en liste d'attente.` });
    });
  }

  /**
   * Journal des capitaines : chaque action d'un capitaine est signalée aux organisateurs (notif push).
   * `when` = date du match concerné (ISO ou Date), `text` commence par un verbe (« a fait les équipes »).
   */
  function notifyCaptainAction(actor, { when, matchId, text }) {
    if (!actor || actor.role !== 'captain') return;
    if (settings().notify_captain_actions !== '1') return;
    const admins = db.prepare("SELECT id FROM users WHERE active = 1 AND role = 'admin' AND id <> ?").all(actor.id).map((u) => u.id);
    if (!admins.length) return;
    const iso = when instanceof Date ? when.toISOString() : when;
    fire(admins, {
      title: `${actor.name} (capitaine)`,
      body: `${cap(text)}${iso ? `, match du ${dayLabel(iso)}` : ''}.`,
      url: matchId ? `/#/match/${matchId}` : '/#/calendrier',
      tag: `captain-${actor.id}-${matchId || 'cal'}`,
      pushOnly: true,
    });
  }

  // ---------- Inscriptions ----------
  function join(matchId, user, guests = []) {
    const m = requireMatch(matchId);
    assertJoinable(m, user);
    if (!Array.isArray(guests) || guests.length > 4) throw bad('4 invités maximum');
    const cleaned = guests.map(cleanGuest);
    const res = tx(db, () => {
      const exists = db
        .prepare("SELECT id FROM entries WHERE match_id = ? AND user_id = ? AND guest_name IS NULL AND state = 'active'")
        .get(m.id, user.id);
      if (exists) throw conflict('Tu es déjà inscrit à ce match');
      const me = insertEntry(m, user.id, null);
      const g = cleaned.map((x) => insertEntry(m, user.id, x));
      return { entry: me, guests: g };
    });
    checkFull(m.id);
    return res;
  }

  function addGuest(matchId, user, guest) {
    const m = requireMatch(matchId);
    assertJoinable(m, user);
    const g = cleanGuest(guest);
    const res = tx(db, () => {
      const host = db
        .prepare("SELECT id FROM entries WHERE match_id = ? AND user_id = ? AND guest_name IS NULL AND state = 'active'")
        .get(m.id, user.id);
      if (!host && !canManage(user)) throw conflict("Inscris-toi d'abord pour ajouter un +1");
      const n = db
        .prepare("SELECT COUNT(*) AS n FROM entries WHERE match_id = ? AND user_id = ? AND guest_name IS NOT NULL AND state = 'active'")
        .get(m.id, user.id).n;
      if (n >= 4) throw bad('4 invités maximum');
      return insertEntry(m, user.id, g);
    });
    checkFull(m.id);
    return res;
  }

  function addPlayer(matchId, admin, userId) {
    const m = requireMatch(matchId);
    assertJoinable(m, admin);
    const u = db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(Number(userId));
    if (!u) throw new HttpError(404, 'Joueur introuvable');
    const res = tx(db, () => {
      const exists = db
        .prepare("SELECT id FROM entries WHERE match_id = ? AND user_id = ? AND guest_name IS NULL AND state = 'active'")
        .get(m.id, u.id);
      if (exists) throw conflict('Ce joueur est déjà inscrit');
      return insertEntry(m, u.id, null);
    });
    checkFull(m.id);
    if (u.id !== admin.id) {
      const when = `${dayLabel(m.starts_at)} à ${timeLabel(m.starts_at)}`;
      fire([u.id], {
        title: res.spot === 'confirmed' ? 'Tu es inscrit au five' : "Tu es en liste d'attente",
        body: `${admin.name} t'a inscrit au match du ${when}${res.spot === 'confirmed' ? '' : ", en liste d'attente"}. Tu peux te désister depuis l'app.`,
        url: `/#/match/${m.id}`,
        tag: `match-${m.id}`,
      });
    }
    return res;
  }

  function cancelEntry(entryId, actor) {
    const e = db.prepare('SELECT * FROM entries WHERE id = ?').get(Number(entryId));
    if (!e || e.state !== 'active') throw new HttpError(404, 'Inscription introuvable');
    if (!canManage(actor) && e.user_id !== actor.id) throw new HttpError(403, "Tu ne peux pas désinscrire quelqu'un d'autre");
    const m = requireMatch(e.match_id);
    if (isPlayed(m)) throw conflict('Le match est déjà joué');
    if (isStarted(m) && !canManage(actor)) throw conflict('Le match a déjà commencé');

    const late = new Date(m.starts_at) - clock() < 24 * H;
    const { promoted, count } = tx(db, () => {
      const targets = [e];
      if (!e.guest_name) {
        // Le joueur se retire : ses +1 partent avec lui
        targets.push(
          ...db
            .prepare("SELECT * FROM entries WHERE match_id = ? AND user_id = ? AND guest_name IS NOT NULL AND state = 'active' ORDER BY id")
            .all(m.id, e.user_id),
        );
      }
      const vacated = [];
      const upd = db.prepare("UPDATE entries SET state = 'cancelled', cancelled_at = ?, late_cancel = ?, team = NULL WHERE id = ?");
      for (const t of targets) {
        upd.run(nowIso(), late && t.spot === 'confirmed' && !t.guest_name ? 1 : 0, t.id);
        if (t.spot === 'confirmed' && t.team) vacated.push(t.team);
      }
      return { promoted: normalize(getMatch(m.id), vacated), count: targets.length };
    });
    notifyPromoted(m, promoted);
    if (e.user_id !== actor.id) {
      const day = dayLabel(m.starts_at);
      fire([e.user_id], {
        title: e.guest_name ? `${e.guest_name} retiré du match` : 'Tu as été retiré du match',
        body: e.guest_name
          ? `${actor.name} a retiré ton +1 ${e.guest_name} du match du ${day}.`
          : `${actor.name} t'a retiré du match du ${day}.`,
        url: `/#/match/${m.id}`,
        tag: `match-${m.id}`,
      });
    }
    return { cancelled: count, promoted: promoted.length };
  }

  /** Supprime un compte et tout ce qui s'y rattache (inscriptions, +1, votes, historique). */
  function deleteUser(userId, actor) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
    if (!u) throw new HttpError(404, 'Joueur introuvable');
    if (u.id === actor.id) throw bad('Tu ne peux pas supprimer ton propre compte');
    if (u.role === 'admin') {
      const others = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?").get(u.id).n;
      if (others === 0) throw bad('Il faut garder au moins un organisateur');
    }
    const promoted = tx(db, () => {
      const matchIds = db.prepare('SELECT DISTINCT match_id FROM entries WHERE user_id = ?').all(u.id).map((r) => r.match_id);
      db.prepare('DELETE FROM mvp_votes WHERE voter_id = ?').run(u.id);
      db.prepare('DELETE FROM entries WHERE user_id = ?').run(u.id); // votes reçus supprimés en cascade
      db.prepare('DELETE FROM users WHERE id = ?').run(u.id); // sessions, appareils, historique Elo en cascade
      const out = [];
      for (const id of matchIds) {
        const m = getMatch(id);
        if (m && !m.cancelled && !isPlayed(m)) out.push([m, normalize(m)]); // la liste d'attente remonte
      }
      recomputeRatings();
      return out;
    });
    refreshAllLevels(); // ses notes données ne comptent plus
    for (const [m, list] of promoted) notifyPromoted(m, list);
  }

  // ---------- Carte joueur : critères notés par les potes ----------
  /** Carte d'un joueur : chaque critère = moyenne des notes reçues dès PEER_MIN notes, sinon niveau de départ. */
  function playerCard(userId) {
    const u = db.prepare('SELECT id, level, base_level FROM users WHERE id = ?').get(userId);
    if (!u) return null;
    const base = u.base_level ?? u.level;
    const rows = db.prepare('SELECT attr, COUNT(*) AS n, AVG(rating) AS avg FROM attr_ratings WHERE target_id = ? GROUP BY attr').all(u.id);
    const by = new Map(rows.map((r) => [r.attr, r]));
    const attrs = {};
    for (const a of ATTRS) {
      const r = by.get(a.key);
      const rated = r && r.n >= PEER_MIN;
      attrs[a.key] = { value: rated ? Math.round(r.avg * 10) / 10 : base, count: r ? r.n : 0, rated: !!rated };
    }
    const mean = ATTRS.reduce((t, a) => t + attrs[a.key].value, 0) / ATTRS.length;
    const raters = db.prepare('SELECT COUNT(DISTINCT rater_id) AS n FROM attr_ratings WHERE target_id = ?').get(u.id).n;
    return { attrs, overall: Math.round(mean * 10), level: Math.min(10, Math.max(1, Math.round(mean))), raters, profile: profileLabel(attrs) };
  }

  function peerSummary(userId) {
    const c = playerCard(userId);
    return { count: c?.raters || 0, avg: c ? c.overall / 10 : null };
  }

  /** Niveau effectif = moyenne arrondie des 6 critères (chacun noté par les potes dès PEER_MIN notes). */
  function refreshLevel(userId) {
    const u = db.prepare('SELECT id, level FROM users WHERE id = ?').get(userId);
    const c = u && playerCard(u.id);
    if (!c || c.level === u.level) return false;
    db.prepare('UPDATE users SET level = ? WHERE id = ?').run(c.level, u.id);
    return true;
  }

  function refreshAllLevels() {
    let changed = false;
    for (const { id } of db.prepare('SELECT id FROM users').all()) changed = refreshLevel(id) || changed;
    if (changed) recomputeRatings();
  }

  /** ratings = { att: 7, def: 5, ... } (les 6 critères), ou null pour retirer ses notes. */
  function ratePlayer(rater, targetId, ratings) {
    const t = db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(Number(targetId));
    if (!t) throw new HttpError(404, 'Joueur introuvable');
    if (t.id === rater.id) throw bad('Tu ne peux pas te noter toi-même');
    let clean = null;
    if (ratings !== null && ratings !== undefined) {
      if (typeof ratings !== 'object') throw bad('Notes invalides');
      clean = {};
      for (const a of ATTRS) {
        const r = intIn(ratings[a.key], 1, 10, NaN);
        if (Number.isNaN(r)) throw bad(`Note « ${a.label} » entre 1 et 10`);
        clean[a.key] = r;
      }
    }
    tx(db, () => {
      db.prepare('DELETE FROM attr_ratings WHERE rater_id = ? AND target_id = ?').run(rater.id, t.id);
      if (clean) {
        const ins = db.prepare('INSERT INTO attr_ratings (rater_id, target_id, attr, rating) VALUES (?, ?, ?, ?)');
        for (const a of ATTRS) ins.run(rater.id, t.id, a.key, clean[a.key]);
      }
      if (refreshLevel(t.id)) recomputeRatings();
    });
  }

  /** Joueurs à noter par `rater`, avec les notes qu'il a déjà mises. */
  function ratingsFor(rater) {
    const players = db.prepare('SELECT id, name, role, games FROM users WHERE active = 1 AND id <> ? ORDER BY name_key').all(rater.id);
    const mine = db.prepare('SELECT target_id, attr, rating FROM attr_ratings WHERE rater_id = ?').all(rater.id);
    const by = new Map();
    for (const r of mine) {
      if (!by.has(r.target_id)) by.set(r.target_id, {});
      by.get(r.target_id)[r.attr] = r.rating;
    }
    return { min: PEER_MIN, attrs: ATTRS, players: players.map((p) => ({ id: p.id, name: p.name, role: p.role, games: p.games, card: playerCard(p.id), myRatings: by.get(p.id) || null })) };
  }

  const unratedCount = (rater) =>
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM users u WHERE u.active = 1 AND u.id <> ?
         AND NOT EXISTS (SELECT 1 FROM attr_ratings r WHERE r.rater_id = ? AND r.target_id = u.id)`,
      )
      .get(rater.id, rater.id).n;

  /** Détail des notes par votant (organisateurs). */
  function ratingDetails() {
    const rows = db
      .prepare(
        `SELECT r.target_id, r.rater_id, v.name AS rater, r.attr, r.rating FROM attr_ratings r
         JOIN users v ON v.id = r.rater_id ORDER BY v.name_key`,
      )
      .all();
    const out = new Map();
    for (const r of rows) {
      if (!out.has(r.target_id)) out.set(r.target_id, new Map());
      const t = out.get(r.target_id);
      if (!t.has(r.rater_id)) t.set(r.rater_id, { rater: r.rater, ratings: {} });
      t.get(r.rater_id).ratings[r.attr] = r.rating;
    }
    const res = new Map();
    for (const [target, votes] of out) {
      res.set(
        target,
        [...votes.values()].map((v) => ({ ...v, avg: Math.round((ATTRS.reduce((t, a) => t + (v.ratings[a.key] || 0), 0) / ATTRS.length) * 10) / 10 })),
      );
    }
    return res;
  }

  /** Nouveau compte créé : prévient organisateurs et capitaines. */
  function notifyNewAccount(user) {
    if (settings().notify_staff_signups !== '1') return;
    const staff = db.prepare("SELECT id, role FROM users WHERE active = 1 AND role IN ('admin', 'captain') AND id <> ?").all(user.id);
    const levelLabel = { 3: 'débutant', 5: 'moyen', 7: 'bon', 9: 'très bon' }[user.level] || `niveau ${user.level}`;
    const total = db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get().n;
    for (const role of ['admin', 'captain']) {
      const ids = staff.filter((u) => u.role === role).map((u) => u.id);
      fire(ids, {
        title: `Nouveau joueur : ${user.name}`,
        body: `${user.name} vient de créer son compte (niveau ${levelLabel}). Vous êtes ${total} dans le groupe.${role === 'admin' ? ' Tu peux ajuster son niveau dans Organisation.' : ''}`,
        url: role === 'admin' ? '/#/admin' : `/#/joueur/${user.id}`,
        tag: `user-${user.id}`,
      });
    }
  }

  function notifyRole(userId, role, actor) {
    const label = { captain: 'capitaine', admin: 'organisateur' }[role];
    if (!label || userId === actor.id) return;
    fire([userId], {
      title: `Tu es maintenant ${label}`,
      body:
        role === 'captain'
          ? `${actor.name} t'a nommé capitaine : tu peux faire les équipes, saisir le score et gérer les matchs.`
          : `${actor.name} t'a nommé organisateur : tu as accès à toute l'organisation du groupe.`,
      url: role === 'admin' ? '/#/admin' : '/#/',
      tag: 'role',
    });
  }

  // ---------- Matchs ----------
  function createMatch({ startsAt, location, capacity, notes }) {
    const s = settings();
    const date = parseLocalDateTime(startsAt, s.timezone);
    if (!date) throw bad('Date invalide');
    const r = db
      .prepare('INSERT INTO matches (starts_at, location, capacity, notes) VALUES (?, ?, ?, ?)')
      .run(date.toISOString(), String(location ?? s.location).slice(0, 120), intIn(capacity, 2, 40, Number(s.capacity)), String(notes || '').slice(0, 500));
    const m = getMatch(r.lastInsertRowid);
    fire(activeUserIds(), {
      title: 'Nouveau match',
      body: `${cap(dayLabel(m.starts_at))} à ${timeLabel(m.starts_at)}. ${m.capacity} places, inscris-toi !`,
      url: `/#/match/${m.id}`,
      tag: `match-${m.id}`,
    });
    return m;
  }

  function updateMatch(id, patch) {
    const m = requireMatch(id);
    const s = settings();
    const next = { ...m };
    if (patch.startsAt !== undefined) {
      const d = parseLocalDateTime(patch.startsAt, s.timezone);
      if (!d) throw bad('Date invalide');
      next.starts_at = d.toISOString();
    }
    if (patch.location !== undefined) next.location = String(patch.location).slice(0, 120);
    if (patch.capacity !== undefined) next.capacity = intIn(patch.capacity, 2, 40, m.capacity);
    if (patch.notes !== undefined) next.notes = String(patch.notes).slice(0, 500);

    const promoted = tx(db, () => {
      db.prepare('UPDATE matches SET starts_at = ?, location = ?, capacity = ?, notes = ? WHERE id = ?').run(
        next.starts_at,
        next.location,
        next.capacity,
        next.notes,
        m.id,
      );
      return next.capacity !== m.capacity ? normalize(getMatch(m.id)) : [];
    });
    notifyPromoted(next, promoted);
    checkFull(m.id);
    if (next.starts_at !== m.starts_at || next.location !== m.location) {
      const users = activeEntries(m.id).map((e) => e.user_id);
      fire(users, {
        title: 'Match modifié',
        body: `Nouveau rendez-vous : ${dayLabel(next.starts_at)} à ${timeLabel(next.starts_at)}${next.location ? `, ${next.location}` : ''}.`,
        url: `/#/match/${m.id}`,
        tag: `match-${m.id}`,
      });
    }
    return getMatch(m.id);
  }

  function cancelMatch(id, reason) {
    const m = requireMatch(id);
    if (isPlayed(m)) throw conflict('Le match est déjà joué');
    db.prepare('UPDATE matches SET cancelled = 1, cancel_reason = ? WHERE id = ?').run(String(reason || '').slice(0, 200) || null, m.id);
    fire(
      activeEntries(m.id).map((e) => e.user_id),
      {
        title: 'Match annulé',
        body: `Le match du ${dayLabel(m.starts_at)} est annulé${reason ? ` : ${reason}` : '.'}`,
        url: `/#/match/${m.id}`,
        tag: `match-${m.id}`,
      },
    );
    return getMatch(m.id);
  }

  function restoreMatch(id) {
    const m = requireMatch(id);
    db.prepare('UPDATE matches SET cancelled = 0, cancel_reason = NULL WHERE id = ?').run(m.id);
    return getMatch(m.id);
  }

  /** Crée les matchs hebdo dont la date d'ouverture des inscriptions est atteinte. */
  function ensureUpcomingMatches() {
    const s = settings();
    const now = clock();
    const openMs = Number(s.open_days_before) * 24 * H;
    const created = [];
    for (const slot of upcomingSlots(now, s.weekday, s.time, 3, s.timezone)) {
      if (slot.startsAt - now > openMs) continue;
      const near = db
        .prepare('SELECT id FROM matches WHERE slot = ? OR (starts_at > ? AND starts_at < ?)')
        .get(slot.slot, new Date(slot.startsAt - 12 * H).toISOString(), new Date(slot.startsAt.getTime() + 12 * H).toISOString());
      if (near) continue;
      const plan = db.prepare('SELECT * FROM planned_slots WHERE slot = ?').get(slot.slot);
      if (plan?.skipped) continue; // pas de five ce jeudi-là
      const r = db
        .prepare('INSERT INTO matches (slot, starts_at, location, capacity) VALUES (?, ?, ?, ?)')
        .run(slot.slot, slot.startsAt.toISOString(), plan?.location || s.location, Number(s.capacity));
      created.push(getMatch(r.lastInsertRowid));
    }
    return created;
  }

  /** Les prochains jeudis pas encore ouverts aux inscriptions, avec leur lieu prévu. */
  function plannedSlots(weeks = 6) {
    const s = settings();
    const now = clock();
    const openMs = Number(s.open_days_before) * 24 * H;
    const out = [];
    for (const slot of upcomingSlots(now, s.weekday, s.time, weeks, s.timezone)) {
      const near = db
        .prepare('SELECT id FROM matches WHERE slot = ? OR (starts_at > ? AND starts_at < ?)')
        .get(slot.slot, new Date(slot.startsAt - 12 * H).toISOString(), new Date(slot.startsAt.getTime() + 12 * H).toISOString());
      if (near) continue;
      const plan = db.prepare('SELECT * FROM planned_slots WHERE slot = ?').get(slot.slot);
      out.push({
        slot: slot.slot,
        startsAt: slot.startsAt.toISOString(),
        opensAt: new Date(Math.max(now.getTime(), slot.startsAt.getTime() - openMs)).toISOString(),
        location: plan?.location || s.location,
        customLocation: !!plan?.location && plan.location !== s.location,
        skipped: !!plan?.skipped,
      });
    }
    return out;
  }

  function planSlot(slot, { location, skipped } = {}) {
    const s = settings();
    const target = upcomingSlots(clock(), s.weekday, s.time, 26, s.timezone).find((x) => x.slot === slot);
    if (!target) throw bad('Date hors calendrier');
    if (db.prepare('SELECT 1 FROM matches WHERE slot = ?').get(slot)) throw conflict('Ce match est déjà ouvert : modifie-le directement');
    const loc = String(location ?? '').trim().slice(0, 120);
    db.prepare(
      `INSERT INTO planned_slots (slot, location, skipped) VALUES (?, ?, ?)
       ON CONFLICT(slot) DO UPDATE SET location = excluded.location, skipped = excluded.skipped`,
    ).run(slot, loc && loc !== s.location ? loc : null, skipped ? 1 : 0);
    db.prepare('DELETE FROM planned_slots WHERE location IS NULL AND skipped = 0').run();
    return plannedSlots(26).find((x) => x.slot === slot);
  }

  /** Dernier match joué : score et MVP (si le vote est clos). */
  function lastResult() {
    const m = db.prepare('SELECT * FROM matches WHERE cancelled = 0 AND score_a IS NOT NULL ORDER BY starts_at DESC LIMIT 1').get();
    if (!m) return null;
    const es = activeEntries(m.id).filter((e) => e.spot === 'confirmed' && e.team);
    const winners = new Set(mvpWinners(m));
    return {
      id: m.id,
      startsAt: m.starts_at,
      scoreA: m.score_a,
      scoreB: m.score_b,
      mvp: es.filter((e) => winners.has(e.id)).map((e) => ({ name: e.guest_name || e.user_name })),
    };
  }

  // ---------- Équipes ----------
  function recentPairCounts(nMatches = 3) {
    const ms = db
      .prepare('SELECT id FROM matches WHERE cancelled = 0 AND score_a IS NOT NULL ORDER BY starts_at DESC LIMIT ?')
      .all(nMatches);
    const counts = new Map();
    for (const m of ms) {
      const es = db
        .prepare("SELECT user_id, team FROM entries WHERE match_id = ? AND state = 'active' AND spot = 'confirmed' AND team IS NOT NULL AND guest_name IS NULL")
        .all(m.id);
      for (let i = 0; i < es.length; i++)
        for (let j = i + 1; j < es.length; j++) {
          if (es[i].team !== es[j].team) continue;
          const k = pairKey(`u${es[i].user_id}`, `u${es[j].user_id}`);
          counts.set(k, (counts.get(k) || 0) + 1);
        }
    }
    return counts;
  }

  function generateTeams(matchId, { rng } = {}) {
    const m = requireMatch(matchId);
    if (m.cancelled) throw conflict('Ce match est annulé');
    if (isPlayed(m)) throw conflict('Le match est déjà joué');
    const es = activeEntries(m.id).filter((e) => e.spot === 'confirmed');
    if (es.length < 2) throw bad('Il faut au moins 2 joueurs confirmés');
    const players = es.map((e) => {
      let profile;
      if (e.guest_name) profile = PROFILE_ATTRS.map(() => e.guest_level ?? 5);
      else {
        const c = playerCard(e.user_id);
        profile = PROFILE_ATTRS.map((k) => c.attrs[k].value);
      }
      return { key: e.guest_name ? `g${e.id}` : `u${e.user_id}`, entryId: e.id, strength: entryStrength(e), profile };
    });
    const res = balanceTeams(players, { pairCounts: recentPairCounts(3), rng });
    const byKey = new Map(players.map((p) => [p.key, p.entryId]));
    tx(db, () => {
      const up = db.prepare('UPDATE entries SET team = ? WHERE id = ?');
      res.A.forEach((k) => up.run('A', byKey.get(k)));
      res.B.forEach((k) => up.run('B', byKey.get(k)));
      db.prepare('UPDATE matches SET teams_at = ? WHERE id = ?').run(nowIso(), m.id);
    });
    once(`teams:${m.id}`, () => {
      for (const t of ['A', 'B']) {
        const users = es.filter((e) => res[t].includes(e.guest_name ? `g${e.id}` : `u${e.user_id}`)).map((e) => e.user_id);
        fire(users, {
          title: 'Les équipes sont faites',
          body: `Tu joues en ${teamName(t)} ${isSameLocalDay(m.starts_at) ? 'ce soir' : dayLabel(m.starts_at)}.`,
          url: `/#/match/${m.id}`,
          tag: `match-${m.id}`,
        });
      }
    });
    return res;
  }

  function setTeams(matchId, assignments) {
    const m = requireMatch(matchId);
    if (m.cancelled) throw conflict('Ce match est annulé');
    const es = new Map(activeEntries(m.id).filter((e) => e.spot === 'confirmed').map((e) => [e.id, e]));
    tx(db, () => {
      const up = db.prepare('UPDATE entries SET team = ? WHERE id = ?');
      for (const [id, team] of Object.entries(assignments || {})) {
        if (!es.has(Number(id))) throw bad('Joueur inconnu dans ce match');
        if (![null, 'A', 'B'].includes(team)) throw bad('Équipe invalide');
        up.run(team, Number(id));
      }
      db.prepare('UPDATE matches SET teams_at = COALESCE(teams_at, ?) WHERE id = ?').run(nowIso(), m.id);
    });
    if (isPlayed(m)) recomputeRatings();
  }

  function clearTeams(matchId) {
    const m = requireMatch(matchId);
    if (isPlayed(m)) throw conflict('Le match est déjà joué');
    tx(db, () => {
      db.prepare('UPDATE entries SET team = NULL WHERE match_id = ?').run(m.id);
      db.prepare('UPDATE matches SET teams_at = NULL WHERE id = ?').run(m.id);
    });
  }

  // ---------- Résultats, Elo, MVP ----------
  function saveResult(matchId, { scoreA, scoreB }) {
    const m = requireMatch(matchId);
    if (m.cancelled) throw conflict('Ce match est annulé');
    const a = intIn(scoreA, 0, 99, NaN);
    const b = intIn(scoreB, 0, 99, NaN);
    if (Number.isNaN(a) || Number.isNaN(b)) throw bad('Score invalide');
    const es = activeEntries(m.id).filter((e) => e.spot === 'confirmed' && e.team);
    if (!es.some((e) => e.team === 'A') || !es.some((e) => e.team === 'B')) throw bad("Fais d'abord les équipes");
    const firstTime = !isPlayed(m);
    tx(db, () => {
      db.prepare('UPDATE matches SET score_a = ?, score_b = ? WHERE id = ?').run(a, b, m.id);
      recomputeRatings();
    });
    if (firstTime) {
      once(`result:${m.id}`, () =>
        fire(
          es.map((e) => e.user_id),
          {
            title: `${teamName('A')} ${a} – ${b} ${teamName('B')}`,
            body: "Résultat enregistré. Vote pour l'homme du match !",
            url: `/#/match/${m.id}`,
            tag: `match-${m.id}`,
          },
        ),
      );
    }
    return getMatch(m.id);
  }

  function clearResult(matchId) {
    const m = requireMatch(matchId);
    tx(db, () => {
      db.prepare('UPDATE matches SET score_a = NULL, score_b = NULL WHERE id = ?').run(m.id);
      db.prepare('UPDATE entries SET goals = 0 WHERE match_id = ?').run(m.id);
      db.prepare('DELETE FROM mvp_votes WHERE match_id = ?').run(m.id);
      recomputeRatings();
    });
  }

  /** Rejoue tous les matchs dans l'ordre pour recalculer l'Elo (simple et toujours cohérent). */
  function recomputeRatings() {
    tx(db, () => {
      const users = db.prepare('SELECT id, level FROM users').all();
      const elo = new Map(users.map((u) => [u.id, levelRating(u.level)]));
      const games = new Map(users.map((u) => [u.id, 0]));
      db.exec('DELETE FROM rating_history');
      const hist = db.prepare('INSERT INTO rating_history (user_id, match_id, rating_before, rating_after) VALUES (?, ?, ?, ?)');
      const ms = db.prepare('SELECT * FROM matches WHERE cancelled = 0 AND score_a IS NOT NULL ORDER BY starts_at, id').all();
      for (const m of ms) {
        const es = db
          .prepare("SELECT * FROM entries WHERE match_id = ? AND state = 'active' AND spot = 'confirmed' AND team IS NOT NULL")
          .all(m.id);
        const A = es.filter((e) => e.team === 'A');
        const B = es.filter((e) => e.team === 'B');
        if (!A.length || !B.length) continue;
        const r = (e) => (e.guest_name ? levelRating(e.guest_level) : elo.get(e.user_id));
        const d = eloDelta({ avgA: mean(A.map(r)), avgB: mean(B.map(r)), scoreA: m.score_a, scoreB: m.score_b });
        for (const [team, sign] of [
          [A, 1],
          [B, -1],
        ]) {
          for (const e of team) {
            if (e.guest_name) continue;
            const before = elo.get(e.user_id);
            const after = before + sign * d;
            elo.set(e.user_id, after);
            games.set(e.user_id, games.get(e.user_id) + 1);
            hist.run(e.user_id, m.id, before, after);
          }
        }
      }
      const up = db.prepare('UPDATE users SET elo = ?, games = ? WHERE id = ?');
      for (const u of users) up.run(elo.get(u.id), games.get(u.id), u.id);
    });
  }

  function mvpClosesAt(m) {
    return new Date(new Date(m.starts_at).getTime() + Number(settings().mvp_vote_hours) * H);
  }

  function mvpWinners(m) {
    if (!isPlayed(m) || clock() < mvpClosesAt(m)) return [];
    const rows = db
      .prepare(
        `SELECT v.entry_id, COUNT(*) AS n FROM mvp_votes v JOIN entries e ON e.id = v.entry_id
         WHERE v.match_id = ? AND e.state = 'active' GROUP BY v.entry_id`,
      )
      .all(m.id);
    const max = Math.max(0, ...rows.map((r) => r.n));
    return max > 0 ? rows.filter((r) => r.n === max).map((r) => r.entry_id) : [];
  }

  function vote(matchId, user, entryId) {
    const m = requireMatch(matchId);
    if (!isPlayed(m)) throw conflict("Le vote s'ouvre une fois le score saisi");
    if (clock() >= mvpClosesAt(m)) throw conflict('Le vote est terminé');
    const es = activeEntries(m.id).filter((e) => e.spot === 'confirmed' && e.team);
    if (!es.some((e) => e.user_id === user.id && !e.guest_name)) throw new HttpError(403, 'Seuls les joueurs du match votent');
    const target = es.find((e) => e.id === Number(entryId));
    if (!target) throw bad('Joueur inconnu dans ce match');
    if (target.user_id === user.id && !target.guest_name) throw bad('Pas de vote pour soi-même');
    db.prepare(
      `INSERT INTO mvp_votes (match_id, voter_id, entry_id) VALUES (?, ?, ?)
       ON CONFLICT(match_id, voter_id) DO UPDATE SET entry_id = excluded.entry_id, created_at = excluded.created_at`,
    ).run(m.id, user.id, target.id);
  }

  // ---------- Sérialisation ----------
  function serializeMatch(m, viewer) {
    const s = settings();
    const isAdmin = canManage(viewer);
    const entries = activeEntries(m.id);
    const cards = new Map();
    const cardOf = (e) => {
      if (e.guest_name) return { overall: (e.guest_level ?? 5) * 10, profile: null };
      if (!cards.has(e.user_id)) cards.set(e.user_id, playerCard(e.user_id));
      const c = cards.get(e.user_id);
      return { overall: c.overall, profile: c.profile };
    };
    const dto = (e) => ({
      id: e.id,
      userId: e.user_id,
      name: e.guest_name || e.user_name,
      isGuest: !!e.guest_name,
      hostName: e.guest_name ? e.user_name : null,
      team: e.spot === 'confirmed' ? e.team : null,
      mine: !!viewer && e.user_id === viewer.id,
      ...cardOf(e),
      ...(isAdmin ? { strength: Math.round(entryStrength(e)), level: e.guest_name ? e.guest_level : e.user_level } : {}),
    });
    const confirmedE = entries.filter((e) => e.spot === 'confirmed');
    const waitE = entries.filter((e) => e.spot === 'waitlist');
    const mine = entries.find((e) => viewer && e.user_id === viewer.id && !e.guest_name);
    const teamed = confirmedE.filter((e) => e.team);
    let teams = null;
    if (m.teams_at && teamed.length) {
      const avg = (t) => mean(teamed.filter((e) => e.team === t).map(entryStrength));
      teams = { prediction: Math.round(expectedScore(avg('A'), avg('B')) * 100) };
    }
    const played = isPlayed(m);
    let mvp = null;
    if (played) {
      const closesAt = mvpClosesAt(m);
      const open = clock() < closesAt;
      const votes = db.prepare('SELECT entry_id, voter_id FROM mvp_votes WHERE match_id = ?').all(m.id);
      const counts = {};
      for (const v of votes) counts[v.entry_id] = (counts[v.entry_id] || 0) + 1;
      const myVote = votes.find((v) => v.voter_id === viewer?.id)?.entry_id ?? null;
      const canVote = open && teamed.some((e) => viewer && e.user_id === viewer.id && !e.guest_name);
      const reveal = !open || myVote !== null || isAdmin;
      mvp = { open, closesAt: closesAt.toISOString(), canVote, myVote, totalVotes: votes.length, counts: reveal ? counts : null, winners: mvpWinners(m) };
    }
    const started = isStarted(m);
    return {
      id: m.id,
      startsAt: m.starts_at,
      location: m.location,
      capacity: m.capacity,
      notes: m.notes,
      cancelled: !!m.cancelled,
      cancelReason: m.cancel_reason,
      started,
      played,
      scoreA: m.score_a,
      scoreB: m.score_b,
      teamNames: { A: s.team_a_name, B: s.team_b_name },
      confirmed: confirmedE.map(dto),
      waitlist: waitE.map(dto),
      me: mine
        ? { entryId: mine.id, spot: mine.spot, team: mine.spot === 'confirmed' ? mine.team : null, waitPosition: mine.spot === 'waitlist' ? waitE.findIndex((e) => e.id === mine.id) + 1 : null }
        : null,
      teams,
      mvp,
      canJoin: !m.cancelled && !played && (!started || isAdmin),
      canManage: isAdmin,
    };
  }

  function summarize(m, viewer) {
    const es = activeEntries(m.id);
    const mine = es.find((e) => viewer && e.user_id === viewer.id && !e.guest_name);
    return {
      id: m.id,
      startsAt: m.starts_at,
      location: m.location,
      capacity: m.capacity,
      cancelled: !!m.cancelled,
      played: isPlayed(m),
      scoreA: m.score_a,
      scoreB: m.score_b,
      confirmedCount: es.filter((e) => e.spot === 'confirmed').length,
      waitlistCount: es.filter((e) => e.spot === 'waitlist').length,
      my: mine ? { spot: mine.spot, team: mine.team } : null,
    };
  }

  function listMatches(viewer) {
    const cutoff = new Date(clock().getTime() - 3 * H).toISOString();
    const upcoming = db
      .prepare('SELECT * FROM matches WHERE score_a IS NULL AND starts_at > ? ORDER BY starts_at LIMIT 10')
      .all(cutoff)
      .map((m) => summarize(m, viewer));
    const past = db
      .prepare('SELECT * FROM matches WHERE score_a IS NOT NULL OR starts_at <= ? ORDER BY starts_at DESC LIMIT 60')
      .all(cutoff)
      .map((m) => summarize(m, viewer));
    const s = settings();
    return { upcoming, planned: plannedSlots(6), past, defaultLocation: s.location, teamNames: { A: s.team_a_name, B: s.team_b_name } };
  }

  function nextMatch() {
    const cutoff = new Date(clock().getTime() - 3 * H).toISOString();
    return db.prepare('SELECT * FROM matches WHERE cancelled = 0 AND score_a IS NULL AND starts_at > ? ORDER BY starts_at LIMIT 1').get(cutoff) || null;
  }

  /** Dernier match joué où le joueur peut encore voter et ne l'a pas fait. */
  function pendingVote(viewer) {
    if (!viewer) return null;
    const ms = db
      .prepare('SELECT * FROM matches WHERE cancelled = 0 AND score_a IS NOT NULL ORDER BY starts_at DESC LIMIT 3')
      .all();
    for (const m of ms) {
      if (clock() >= mvpClosesAt(m)) continue;
      const played = db
        .prepare("SELECT 1 FROM entries WHERE match_id = ? AND user_id = ? AND guest_name IS NULL AND state = 'active' AND spot = 'confirmed' AND team IS NOT NULL")
        .get(m.id, viewer.id);
      const voted = db.prepare('SELECT 1 FROM mvp_votes WHERE match_id = ? AND voter_id = ?').get(m.id, viewer.id);
      if (played && !voted) return { matchId: m.id, startsAt: m.starts_at };
    }
    return null;
  }

  // ---------- Stats ----------
  function playedMatchRows({ from, to } = {}) {
    let sql = 'SELECT * FROM matches WHERE cancelled = 0 AND score_a IS NOT NULL';
    const params = [];
    if (from) {
      sql += ' AND starts_at >= ? AND starts_at < ?';
      params.push(from.toISOString(), to.toISOString());
    }
    return db.prepare(`${sql} ORDER BY starts_at, id`).all(...params);
  }

  const resultFor = (team, m) => {
    const [gf, ga] = team === 'A' ? [m.score_a, m.score_b] : [m.score_b, m.score_a];
    return { gf, ga, r: gf > ga ? 'V' : gf < ga ? 'D' : 'N' };
  };

  function availableSeasons() {
    const tz = settings().timezone;
    const set = new Set([seasonOf(clock(), tz)]);
    for (const m of playedMatchRows()) set.add(seasonOf(new Date(m.starts_at), tz));
    return [...set].sort((a, b) => b - a);
  }

  function stats(season) {
    const tz = settings().timezone;
    const range = season === 'all' ? {} : seasonRange(Number(season) || seasonOf(clock(), tz), tz);
    const rows = new Map();
    const row = (id, name) => {
      if (!rows.has(id))
        rows.set(id, { userId: id, name, played: 0, wins: 0, draws: 0, losses: 0, mvps: 0, lateCancels: 0, form: [] });
      return rows.get(id);
    };
    for (const m of playedMatchRows(range)) {
      const es = db
        .prepare(
          `SELECT e.*, u.name AS user_name FROM entries e JOIN users u ON u.id = e.user_id
           WHERE e.match_id = ? AND e.state = 'active' AND e.spot = 'confirmed' AND e.team IS NOT NULL AND e.guest_name IS NULL`,
        )
        .all(m.id);
      const winners = new Set(mvpWinners(m));
      for (const e of es) {
        const st = row(e.user_id, e.user_name);
        const { r } = resultFor(e.team, m);
        st.played++;
        if (r === 'V') st.wins++;
        else if (r === 'N') st.draws++;
        else st.losses++;
        if (winners.has(e.id)) st.mvps++;
        st.form.push(r);
      }
    }
    let lateSql = `SELECT e.user_id, u.name, COUNT(*) AS n FROM entries e JOIN matches m ON m.id = e.match_id JOIN users u ON u.id = e.user_id
                   WHERE e.late_cancel = 1`;
    const p = [];
    if (range.from) {
      lateSql += ' AND m.starts_at >= ? AND m.starts_at < ?';
      p.push(range.from.toISOString(), range.to.toISOString());
    }
    for (const l of db.prepare(`${lateSql} GROUP BY e.user_id`).all(...p)) row(l.user_id, l.name).lateCancels = l.n;

    const players = [...rows.values()].map((r) => ({
      ...r,
      winRate: r.played ? Math.round((r.wins / r.played) * 100) : 0,
      form: r.form.slice(-5),
    }));
    return { season: season === 'all' ? 'all' : Number(season) || seasonOf(clock(), tz), seasons: availableSeasons(), players };
  }

  function playerProfile(userId, viewer) {
    const u = db.prepare('SELECT id, name, level, elo, games, role, created_at FROM users WHERE id = ?').get(Number(userId));
    if (!u) throw new HttpError(404, 'Joueur introuvable');
    const canSeeRating = viewer && (viewer.id === u.id || canManage(viewer));
    const hist = new Map(
      db.prepare('SELECT match_id, rating_after FROM rating_history WHERE user_id = ?').all(u.id).map((r) => [r.match_id, r.rating_after]),
    );
    const history = [];
    const mates = new Map();
    const totals = { played: 0, wins: 0, draws: 0, losses: 0, mvps: 0 };
    for (const m of playedMatchRows()) {
      const es = db
        .prepare(
          `SELECT e.*, u.name AS user_name FROM entries e JOIN users u ON u.id = e.user_id
           WHERE e.match_id = ? AND e.state = 'active' AND e.spot = 'confirmed' AND e.team IS NOT NULL`,
        )
        .all(m.id);
      const me = es.find((e) => e.user_id === u.id && !e.guest_name);
      if (!me) continue;
      const { gf, ga, r } = resultFor(me.team, m);
      const mvp = mvpWinners(m).includes(me.id);
      totals.played++;
      if (mvp) totals.mvps++;
      if (r === 'V') totals.wins++;
      else if (r === 'N') totals.draws++;
      else totals.losses++;
      for (const e of es) {
        if (e.guest_name || e.user_id === u.id || e.team !== me.team) continue;
        const k = mates.get(e.user_id) || { userId: e.user_id, name: e.user_name, played: 0, wins: 0 };
        k.played++;
        if (r === 'V') k.wins++;
        mates.set(e.user_id, k);
      }
      history.push({
        matchId: m.id,
        startsAt: m.starts_at,
        team: me.team,
        result: r,
        goalsFor: gf,
        goalsAgainst: ga,
        mvp,
        ...(canSeeRating && hist.has(m.id) ? { rating: Math.round(hist.get(m.id)) } : {}),
      });
    }
    const duo =
      [...mates.values()]
        .filter((k) => k.played >= 3)
        .map((k) => ({ ...k, winRate: Math.round((k.wins / k.played) * 100) }))
        .sort((a, b) => b.winRate - a.winRate || b.played - a.played)[0] || null;
    const lateCancels = db.prepare('SELECT COUNT(*) AS n FROM entries WHERE user_id = ? AND late_cancel = 1').get(u.id).n;
    return {
      id: u.id,
      name: u.name,
      since: u.created_at,
      totals: { ...totals, winRate: totals.played ? Math.round((totals.wins / totals.played) * 100) : 0, lateCancels },
      form: history.slice(-5).map((h) => h.result),
      bestDuo: duo,
      card: playerCard(u.id),
      attrDefs: ATTRS,
      history: history.reverse(),
      ...(canSeeRating
        ? { level: u.level, peer: peerSummary(u.id), peerMin: PEER_MIN, strength: Math.round(blendedStrength(u)), ratingStart: levelRating(u.level) }
        : {}),
      teamNames: { A: settings().team_a_name, B: settings().team_b_name },
    };
  }

  // ---------- Rappels (appelé par le planificateur) ----------
  function runReminders() {
    const s = settings();
    const now = clock();
    const created = ensureUpcomingMatches();
    if (s.remind_open === '1') {
      for (const m of created) {
        once(`open:${m.id}`, () =>
          fire(activeUserIds(), {
            title: 'Inscriptions ouvertes',
            body: `${cap(dayLabel(m.starts_at))} à ${timeLabel(m.starts_at)}${m.location ? `, ${m.location}` : ''}. ${m.capacity} places, inscris-toi !`,
            url: `/#/match/${m.id}`,
            tag: `match-${m.id}`,
          }),
        );
      }
    }
    const upcoming = db
      .prepare('SELECT * FROM matches WHERE cancelled = 0 AND score_a IS NULL AND starts_at > ?')
      .all(now.toISOString());
    for (const m of upcoming) {
      const left = new Date(m.starts_at) - now;
      const hU = Number(s.remind_unregistered_hours);
      if (hU > 0 && left <= hU * H) {
        once(`unreg:${m.id}`, () => {
          const es = activeEntries(m.id);
          const free = m.capacity - es.filter((e) => e.spot === 'confirmed').length;
          if (free <= 0) return;
          const registered = new Set(es.map((e) => e.user_id));
          fire(
            activeUserIds().filter((id) => !registered.has(id)),
            {
              title: `Il reste ${plural(free, 'place')}`,
              body: `${cap(isSameLocalDay(m.starts_at) ? "ce soir" : dayLabel(m.starts_at))} à ${timeLabel(m.starts_at)}. Tu viens ?`,
              url: `/#/match/${m.id}`,
              tag: `match-${m.id}`,
            },
          );
        });
      }
      const hC = Number(s.remind_confirmed_hours);
      if (hC > 0 && left <= hC * H) {
        once(`conf:${m.id}`, () => {
          const es = activeEntries(m.id).filter((e) => e.spot === 'confirmed');
          const byUser = new Map();
          for (const e of es) {
            const x = byUser.get(e.user_id) || { team: null, guests: 0 };
            if (e.guest_name) x.guests++;
            else x.team = e.team;
            byUser.set(e.user_id, x);
          }
          for (const [uid, x] of byUser) {
            const when = isSameLocalDay(m.starts_at) ? "C'est ce soir" : `C'est ${dayLabel(m.starts_at)}`;
            const team = x.team ? ` en ${teamName(x.team)}` : '';
            const guests = x.guests ? ` (avec ${plural(x.guests, 'invité')})` : '';
            fire([uid], {
              title: `${when} !`,
              body: `${timeLabel(m.starts_at)}${m.location ? `, ${m.location}` : ''}. Tu joues${team}${guests}.`,
              url: `/#/match/${m.id}`,
              tag: `match-${m.id}`,
            });
          }
        });
      }
    }
    return { created: created.length };
  }

  return {
    settings,
    notifyCaptainAction,
    getMatch,
    requireMatch,
    join,
    addGuest,
    addPlayer,
    deleteUser,
    notifyRole,
    notifyNewAccount,
    ratePlayer,
    ratingsFor,
    unratedCount,
    peerSummary,
    playerCard,
    ratingDetails,
    refreshLevel,
    refreshAllLevels,
    cancelEntry,
    createMatch,
    updateMatch,
    cancelMatch,
    restoreMatch,
    ensureUpcomingMatches,
    generateTeams,
    setTeams,
    clearTeams,
    saveResult,
    clearResult,
    recomputeRatings,
    vote,
    serializeMatch,
    listMatches,
    nextMatch,
    pendingVote,
    plannedSlots,
    planSlot,
    lastResult,
    stats,
    playerProfile,
    runReminders,
  };
}
