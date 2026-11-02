// Gestion des dates dans le fuseau du groupe (Europe/Paris par défaut), sans dépendance.
// Les dates sont stockées en UTC (ISO 8601) et converties pour l'affichage / la planification.

const dtfCache = new Map();
function formatter(tz) {
  if (!dtfCache.has(tz)) {
    dtfCache.set(
      tz,
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short',
      }),
    );
  }
  return dtfCache.get(tz);
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(date, tz) {
  const p = Object.fromEntries(formatter(tz).formatToParts(date).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour),
    mi: Number(p.minute),
    s: Number(p.second),
    weekday: WEEKDAYS[p.weekday],
  };
}

function offsetMs(date, tz) {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Heure locale (dans tz) -> Date UTC, en gérant les changements d'heure. */
export function zonedToUtc(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off1 = offsetMs(new Date(guess), tz);
  let ts = guess - off1;
  const off2 = offsetMs(new Date(ts), tz);
  if (off2 !== off1) ts = guess - off2;
  return new Date(ts);
}

/** "2026-11-05T20:00" (heure locale) -> Date UTC */
export function parseLocalDateTime(str, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(str || ''));
  if (!m) return null;
  return zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], tz);
}

export function toLocalInput(date, tz) {
  const p = localParts(date, tz);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

/**
 * Prochaines occurrences d'un créneau hebdo (ex. jeudi 20:00) strictement après `now`.
 * Retourne [{ slot: 'YYYY-MM-DD', startsAt: Date }]
 */
export function upcomingSlots(now, weekday, time, count, tz) {
  const [hh, mm] = String(time).split(':').map(Number);
  const lp = localParts(now, tz);
  const out = [];
  for (let i = 0; i < 7 * count + 8 && out.length < count; i++) {
    const day = new Date(Date.UTC(lp.y, lp.m - 1, lp.d + i));
    if (day.getUTCDay() !== Number(weekday)) continue;
    const startsAt = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, tz);
    if (startsAt <= now) continue;
    out.push({ slot: day.toISOString().slice(0, 10), startsAt });
  }
  return out;
}

/** Saison de foot : septembre -> août. Renvoie l'année de début. */
export function seasonOf(date, tz) {
  const p = localParts(date, tz);
  return p.m >= 9 ? p.y : p.y - 1;
}

export function seasonRange(startYear, tz) {
  return {
    from: zonedToUtc(startYear, 9, 1, 0, 0, tz),
    to: zonedToUtc(startYear + 1, 9, 1, 0, 0, tz),
  };
}
