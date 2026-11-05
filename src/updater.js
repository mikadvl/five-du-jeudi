// Mise à jour de l'app depuis l'interface : version installée, dernière version publiée (GitHub),
// et déclenchement de la mise à jour via l'API de TrueNAS (pull de l'image + redéploiement).
// L'app n'a jamais accès à Docker : c'est TrueNAS qui fait le travail, avec une clé d'API dédiée.
import WebSocket from 'ws';

const VERSION = process.env.APP_VERSION || 'dev';
const BUILT_AT = process.env.APP_BUILT_AT || null;
const REPO = process.env.GITHUB_REPO || 'mikadvl/five-du-jeudi';

const cfg = () => ({
  url: process.env.TRUENAS_URL || '',
  key: process.env.TRUENAS_API_KEY || '',
  app: process.env.TRUENAS_APP_NAME || 'five',
  insecure: process.env.TRUENAS_TLS_INSECURE === '1',
});

export const updateConfigured = () => {
  const c = cfg();
  return !!(c.url && c.key);
};

let latestCache = { at: 0, value: null };

/** Dernière version publiée = dernier build réussi sur main (GitHub Actions, dépôt public). */
export async function latestVersion({ force = false } = {}) {
  if (!force && Date.now() - latestCache.at < 10 * 60e3 && latestCache.value) return latestCache.value;
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/runs?branch=main&status=success&per_page=1`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'five-du-jeudi' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub a répondu ${res.status}`);
  const run = (await res.json()).workflow_runs?.[0];
  const value = run
    ? { sha: run.head_sha, short: run.head_sha.slice(0, 7), message: String(run.head_commit?.message || '').split('\n')[0], date: run.updated_at }
    : null;
  latestCache = { at: Date.now(), value };
  return value;
}

export async function versionInfo() {
  let latest = null;
  let error = null;
  try {
    latest = await latestVersion();
  } catch (err) {
    error = err.message;
  }
  const current = { sha: VERSION, short: VERSION.slice(0, 7), builtAt: BUILT_AT };
  return {
    current,
    latest,
    upToDate: latest ? latest.sha === VERSION : null,
    configured: updateConfigured(),
    appName: cfg().app,
    error,
  };
}

/** Appel JSON-RPC 2.0 sur le websocket de TrueNAS (wss://<nas>/api/current). */
function truenasCall(methods, { timeoutMs = 20000 } = {}) {
  const c = cfg();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(c.url, { rejectUnauthorized: !c.insecure, handshakeTimeout: 8000 });
    const pending = new Map();
    let id = 0;
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('TrueNAS ne répond pas'));
    }, timeoutMs);
    const call = (method, params = []) =>
      new Promise((res, rej) => {
        const n = ++id;
        pending.set(n, { res, rej });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }));
      });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(msg.error.data?.reason || msg.error.message || 'Erreur TrueNAS'));
      else p.res(msg.result);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Connexion à TrueNAS impossible : ${err.message}`));
    });
    ws.on('open', async () => {
      try {
        const ok = await call('auth.login_with_api_key', [c.key]);
        if (!ok) throw new Error("Clé d'API TrueNAS refusée");
        const results = [];
        for (const [method, params] of methods) results.push(await call(method, params));
        clearTimeout(timer);
        ws.close();
        resolve(results);
      } catch (err) {
        clearTimeout(timer);
        ws.close();
        reject(err);
      }
    });
  });
}

/** Demande à TrueNAS de télécharger la dernière image et de redéployer l'app. Renvoie l'identifiant du job. */
export async function triggerUpdate() {
  if (!updateConfigured()) throw new Error('Mise à jour depuis l’app non configurée');
  if (!cfg().url.startsWith('wss://')) throw new Error('TRUENAS_URL doit commencer par wss:// (TrueNAS révoque les clés utilisées sans chiffrement)');
  const [job] = await truenasCall([['app.pull_images', [cfg().app, { redeploy: true }]]]);
  return job;
}
