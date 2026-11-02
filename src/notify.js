// Envoi des notifications : Web Push (PWA) + email optionnel (SMTP).
import webpush from 'web-push';
import { getSettings, setSettings } from './db.js';

export function ensureVapidKeys(db) {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  const s = getSettings(db);
  if (s.vapid_public && s.vapid_private) return { publicKey: s.vapid_public, privateKey: s.vapid_private };
  const keys = webpush.generateVAPIDKeys();
  setSettings(db, { vapid_public: keys.publicKey, vapid_private: keys.privateKey });
  return keys;
}

export async function createNotifier(db, { subject = 'mailto:admin@example.com', appUrl = '', log = console } = {}) {
  const vapid = ensureVapidKeys(db);
  webpush.setVapidDetails(subject, vapid.publicKey, vapid.privateKey);

  let mailer = null;
  if (process.env.SMTP_HOST) {
    const nodemailer = (await import('nodemailer')).default;
    const port = Number(process.env.SMTP_PORT || 587);
    mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  async function pushTo(userId, payload) {
    const subs = db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(userId);
    let ok = 0;
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
          { TTL: 12 * 3600, urgency: 'high' },
        );
        ok++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          db.prepare('DELETE FROM push_subs WHERE id = ?').run(sub.id); // abonnement expiré
        } else {
          log.warn?.(`[push] échec pour l'utilisateur ${userId}: ${err.statusCode || ''} ${err.message}`);
        }
      }
    }
    return ok;
  }

  async function mailTo(user, payload) {
    if (!mailer || !user.email || !user.notify_email) return 0;
    const s = getSettings(db);
    const link = appUrl ? `${appUrl.replace(/\/$/, '')}${payload.url || '/'}` : '';
    await mailer.sendMail({
      from: `"${s.group_name}" <${from}>`,
      to: user.email,
      subject: payload.title,
      text: `${payload.body}\n\n${link}`.trim(),
    });
    return 1;
  }

  return {
    publicKey: vapid.publicKey,
    emailEnabled: !!mailer,
    async send(userIds, payload) {
      const ids = [...new Set(userIds)].filter(Boolean);
      if (!ids.length) return { push: 0, email: 0 };
      const users = db
        .prepare(`SELECT id, email, notify_email FROM users WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids);
      let push = 0;
      let email = 0;
      await Promise.all(
        users.map(async (u) => {
          push += await pushTo(u.id, payload);
          try {
            email += await mailTo(u, payload);
          } catch (err) {
            log.warn?.(`[mail] échec pour l'utilisateur ${u.id}: ${err.message}`);
          }
        }),
      );
      return { push, email };
    },
  };
}
