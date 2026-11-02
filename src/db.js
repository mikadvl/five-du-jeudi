import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = [
  // v1
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    email TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'player',
    level INTEGER NOT NULL DEFAULT 5,
    elo REAL NOT NULL DEFAULT 1000,
    games INTEGER NOT NULL DEFAULT 0,
    notify_email INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE UNIQUE INDEX ux_users_email ON users(lower(email)) WHERE email IS NOT NULL AND email <> '';

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE matches (
    id INTEGER PRIMARY KEY,
    slot TEXT UNIQUE,
    starts_at TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    capacity INTEGER NOT NULL DEFAULT 12,
    cancelled INTEGER NOT NULL DEFAULT 0,
    cancel_reason TEXT,
    teams_at TEXT,
    score_a INTEGER,
    score_b INTEGER,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX ix_matches_start ON matches(starts_at);

  CREATE TABLE entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    guest_name TEXT,
    guest_level INTEGER,
    state TEXT NOT NULL DEFAULT 'active',
    spot TEXT NOT NULL DEFAULT 'confirmed',
    team TEXT,
    goals INTEGER NOT NULL DEFAULT 0,
    late_cancel INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    cancelled_at TEXT
  );
  CREATE UNIQUE INDEX ux_entries_player ON entries(match_id, user_id) WHERE guest_name IS NULL AND state = 'active';
  CREATE INDEX ix_entries_match ON entries(match_id, state, id);

  CREATE TABLE mvp_votes (
    match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    voter_id INTEGER NOT NULL REFERENCES users(id),
    entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (match_id, voter_id)
  );

  CREATE TABLE rating_history (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    rating_before REAL NOT NULL,
    rating_after REAL NOT NULL,
    PRIMARY KEY (user_id, match_id)
  );

  CREATE TABLE push_subs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE sent_notifications (
    key TEXT PRIMARY KEY,
    at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  `,
  // v2 : jeudis planifiés à l'avance (lieu différent, ou pas de five ce jour-là)
  `
  CREATE TABLE planned_slots (
    slot TEXT PRIMARY KEY,
    location TEXT,
    skipped INTEGER NOT NULL DEFAULT 0
  );
  `,
];

export const DEFAULT_SETTINGS = {
  group_name: 'Five du jeudi',
  location: 'UrbanSoccer Montaudran', // lieu par défaut
  venues: '["UrbanSoccer Montaudran"]', // lieux proposés quand on change le lieu d'un match
  weekday: '4', // 0 = dimanche ... 4 = jeudi
  time: '20:00',
  capacity: '12',
  open_days_before: '6', // création auto du match (et notif "inscriptions ouvertes") X jours avant
  remind_unregistered_hours: '26', // relance des non-inscrits s'il reste des places (0 = off)
  remind_confirmed_hours: '8', // rappel aux joueurs confirmés (0 = off)
  remind_open: '1',
  team_a_name: 'Chasubles',
  team_b_name: 'Sans chasuble',
  mvp_vote_hours: '72',
  timezone: 'Europe/Paris',
  invite_code: '',
};

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  seedSettings(db);
  return db;
}

function migrate(db) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  for (let v = version; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

function seedSettings(db) {
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    insert.run(k, k === 'invite_code' ? crypto.randomBytes(4).toString('hex') : v);
  }
}

let depth = 0;
/** Transaction simple (réentrante : les appels imbriqués rejoignent la transaction en cours). */
export function tx(db, fn) {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* déjà annulée */
    }
    throw err;
  } finally {
    depth--;
  }
}

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
}

export function setSettings(db, values) {
  const up = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  tx(db, () => {
    for (const [k, v] of Object.entries(values)) up.run(k, String(v));
  });
}
