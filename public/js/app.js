// Five du jeudi — front (JS natif, sans build). Routage par hash, rendu par template strings.

const view = document.getElementById('view');
const tabbar = document.getElementById('tabbar');
const sheetEl = document.getElementById('sheet');
const sheetBox = sheetEl.querySelector('.sheet');
const toastEl = document.getElementById('toast');

const state = { me: null, group: null, vapid: null, emailEnabled: false, hasUsers: true, installPrompt: null };
const current = { match: null, path: '/', home: null, planned: [] };

// ---------- Utilitaires ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Erreur ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const tz = () => state.group?.timezone || 'Europe/Paris';
const fmt = (iso, opts) => new Intl.DateTimeFormat('fr-FR', { timeZone: tz(), ...opts }).format(new Date(iso));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const dayLong = (iso) => cap(fmt(iso, { weekday: 'long', day: 'numeric', month: 'long' }));
const weekday = (iso) => cap(fmt(iso, { weekday: 'long' }));
const dayShort = (iso) => fmt(iso, { day: 'numeric', month: 'short' });
const hour = (iso) => fmt(iso, { hour: '2-digit', minute: '2-digit' });
const plural = (n, w, p) => `${n} ${n > 1 ? p || `${w}s` : w}`;
const ordinal = (n) => (n === 1 ? '1er' : `${n}e`);
const initials = (name) => {
  const words = String(name || '?').trim().split(/\s+/);
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
};
const mapsUrl = (place) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;
const storage = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* stockage indisponible */
    }
  },
};

let toastTimer;
function toast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('is-error', isError);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), isError ? 4500 : 2800);
}

// ---------- Feuille (modale du bas) ----------
let lastFocus = null;
function openSheet(html) {
  lastFocus = document.activeElement;
  sheetBox.innerHTML = html;
  sheetEl.hidden = false;
  document.body.style.overflow = 'hidden';
  const first = sheetBox.querySelector('input:not([type=hidden]), select, textarea, button');
  setTimeout(() => first?.focus(), 30);
  return sheetBox;
}
function closeSheet() {
  sheetEl.hidden = true;
  sheetBox.innerHTML = '';
  document.body.style.overflow = '';
  lastFocus?.focus?.();
}
sheetEl.addEventListener('click', (e) => {
  if (e.target === sheetEl || e.target.closest('[data-close]')) closeSheet();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !sheetEl.hidden) closeSheet();
});

function confirmSheet({ title, text, confirm, danger = false }) {
  return new Promise((resolve) => {
    openSheet(`
      <h2 id="sheet-title">${esc(title)}</h2>
      ${text ? `<p class="muted">${text}</p>` : ''}
      <div class="actions">
        <button type="button" class="btn" data-answer="no">Garder</button>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-dark'}" data-answer="yes">${esc(confirm)}</button>
      </div>`);
    const finish = (answer) => {
      sheetBox.removeEventListener('click', onClick);
      obs.disconnect();
      if (!sheetEl.hidden) closeSheet();
      resolve(answer);
    };
    const onClick = (e) => {
      const b = e.target.closest('[data-answer]');
      if (b) finish(b.dataset.answer === 'yes');
    };
    const obs = new MutationObserver(() => sheetEl.hidden && finish(false));
    sheetBox.addEventListener('click', onClick);
    obs.observe(sheetEl, { attributes: true, attributeFilter: ['hidden'] });
  });
}

// ---------- Icônes ----------
const ICON = {
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  chevron: '<svg class="chev" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 6 6 6-6 6"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 6-6 6 6 6"/></svg>',
  check: '<svg class="check" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="22" fill="#0B7F3E"/><path d="M13 22.5l6 6 12-13" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const isAdmin = () => state.me?.role === 'admin';
const canManage = () => ['admin', 'captain'].includes(state.me?.role);
const ROLES = { player: 'Joueur', captain: 'Capitaine', admin: 'Organisateur' };
const backLink = (href, label) => `<header class="topbar"><a class="back" href="${href}">${ICON.back}${label}</a></header>`;
const homeTopbar = () => `<header class="topbar"><span class="group">${esc(state.group.name)}</span>
  <a class="av av-b av-sm" href="#/profil" aria-label="Mon profil">${esc(initials(state.me.name))}</a></header>`;

// ---------- Routage ----------
const routes = [
  [/^\/$/, viewHome, 'home'],
  [/^\/match\/(\d+)$/, viewMatch, 'matchs'],
  [/^\/matchs$/, viewMatches, 'matchs'],
  [/^\/classement$/, viewStats, 'classement'],
  [/^\/joueur\/(\d+)$/, viewPlayer, 'classement'],
  [/^\/profil$/, viewProfile, 'profil'],
  [/^\/admin$/, viewAdmin, 'profil'],
  [/^\/connexion$/, viewLogin, null],
  [/^\/inscription$/, viewRegister, null],
  [/^\/bienvenue$/, viewWelcome, 'home'],
];

async function render() {
  const raw = location.hash.slice(1) || '/';
  const [path, qs] = raw.split('?');
  const query = new URLSearchParams(qs || '');
  current.path = path;
  if (!state.me && path !== '/connexion' && path !== '/inscription') {
    location.replace(state.hasUsers ? '#/connexion' : '#/inscription');
    return;
  }
  if (state.me && (path === '/connexion' || path === '/inscription')) {
    location.replace('#/');
    return;
  }
  const route = routes.find(([re]) => re.test(path)) || routes[0];
  const params = path.match(route[0]) || [];
  tabbar.hidden = !state.me;
  tabbar.querySelectorAll('a').forEach((a) => {
    if (a.dataset.tab === route[2]) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (!view.innerHTML) view.innerHTML = '<p class="loading">Chargement…</p>';
  try {
    await route[1](params[1], query);
    applyWidths();
  } catch (err) {
    if (err.status === 401) {
      state.me = null;
      location.replace('#/connexion');
      return;
    }
    view.innerHTML = `<div class="card empty"><h2>Impossible d'afficher la page</h2><p>${esc(err.message)}</p>
      <p style="margin-top:16px"><a class="btn" href="#/">Revenir au match</a></p></div>`;
  }
  if (document.activeElement === document.body) view.focus({ preventScroll: true });
}

// La CSP limite les styles : largeurs et tracés posés via le CSSOM.
function applyWidths(root = view) {
  root.querySelectorAll('[data-w]').forEach((el) => (el.style.width = `${el.dataset.w}%`));
}

// ---------- Match ----------
async function viewHome() {
  const data = await api('GET', '/api/home');
  current.home = data;
  current.match = data.next;
  view.innerHTML = await homeHtml(data);
}

async function homeHtml(data) {
  let html = homeTopbar();
  html += await setupNudgeHtml();
  if (data.pendingVote) {
    html += `<a class="banner" href="#/match/${data.pendingVote.matchId}">
      <span>Vote pour l'homme du match du ${esc(fmt(data.pendingVote.startsAt, { weekday: 'long', day: 'numeric' }))}</span>${ICON.chevron.replace('class="chev"', '')}</a>`;
  }
  if (!data.next) {
    html += `<div class="card empty">
      <h2>Pas de match prévu</h2>
      <p>Le prochain jeudi s'ouvre ici automatiquement. Le calendrier montre les dates et lieux à venir.</p>
      <div class="btn-row" style="margin-top:16px"><a class="btn" href="#/matchs">Voir le calendrier</a>${canManage() ? '<button class="btn btn-dark" data-action="create-match">Créer un match</button>' : ''}</div>
    </div>`;
  } else {
    html += matchHtml(data.next);
  }
  if (data.last && data.last.id !== data.next?.id) html += lastResultHtml(data.last, data.teamNames);
  return html;
}

async function viewMatch(id) {
  const m = await api('GET', `/api/matches/${id}`);
  current.match = m;
  view.innerHTML = backLink('#/matchs', 'Calendrier') + matchHtml(m);
}

async function showMatch(m) {
  current.match = m;
  if (current.path === '/') {
    current.home = { ...current.home, next: m };
    view.innerHTML = await homeHtml(current.home);
  } else {
    view.innerHTML = backLink('#/matchs', 'Calendrier') + matchHtml(m);
  }
  applyWidths();
}

function matchHtml(m) {
  return [heroHtml(m), m.notes ? `<p class="card note">${esc(m.notes)}</p>` : '', statusHtml(m), m.played ? scoreHtml(m) : '', playersHtml(m), waitlistHtml(m), mvpHtml(m), m.canManage ? adminToolsHtml(m) : ''].join('');
}

function heroHtml(m) {
  const full = m.confirmed.length >= m.capacity;
  const [label, cls] = m.cancelled
    ? ['Annulé', '']
    : m.played
      ? ['Terminé', '']
      : m.started
        ? ['En cours', 'chip-dark']
        : full
          ? ['Complet', 'chip-full']
          : ['Inscriptions ouvertes', 'chip-open'];
  const circ = 289;
  const ratio = Math.min(1, m.confirmed.length / m.capacity);
  const ring =
    m.cancelled || m.played
      ? ''
      : `<div class="ring" role="img" aria-label="${m.confirmed.length} joueurs sur ${m.capacity}">
      <svg viewBox="0 0 108 108" width="100%" height="100%" aria-hidden="true">
        <circle class="track" cx="54" cy="54" r="46"/>
        <circle class="fill" cx="54" cy="54" r="46" stroke-dasharray="${(circ * ratio).toFixed(1)} ${circ}" transform="rotate(-90 54 54)"/>
      </svg>
      <div class="label"><b>${m.confirmed.length}</b><span>sur ${m.capacity}</span></div>
    </div>`;
  return `<section class="card hero">
    <div class="hero-main">
      <span class="chip ${cls}">${label}</span>
      <h1 class="hero-date">${esc(weekday(m.startsAt))}<br>${esc(dayShort(m.startsAt))}</h1>
      <div class="meta">
        <span>${ICON.clock}${esc(hour(m.startsAt))}</span>
        ${m.location ? `<a href="${mapsUrl(m.location)}" target="_blank" rel="noopener">${ICON.pin}${esc(m.location)}</a>` : ''}
      </div>
      ${m.cancelled && m.cancelReason ? `<p class="muted">${esc(m.cancelReason)}</p>` : ''}
    </div>
    ${ring}
  </section>`;
}

function statusHtml(m) {
  if (m.cancelled || m.played) return '';
  const myGuests = [...m.confirmed, ...m.waitlist].filter((e) => e.mine && e.isGuest);
  if (!m.me) {
    if (!m.canJoin) return '';
    const free = m.capacity - m.confirmed.length;
    const full = free <= 0;
    return `<section class="card dark status">
      <div>
        <p class="status-title">${full ? 'Complet' : 'Tu viens ?'}</p>
        <p class="status-sub">${full ? "Inscris-toi en liste d'attente : tu seras prévenu si une place se libère." : `Il reste ${plural(free, 'place')}.`}</p>
      </div>
      <div class="btn-row">
        <button class="btn btn-light" data-action="join">${full ? "Liste d'attente" : 'Je viens'}</button>
        <button class="btn btn-outline-light" data-action="join-guest">Avec un +1</button>
      </div>
    </section>`;
  }
  const me = m.me;
  const inGame = me.spot === 'confirmed';
  const sub = inGame
    ? me.team
      ? `<span class="dot ${me.team === 'A' ? 'dot-a' : ''}" ${me.team === 'B' ? 'style="background:#fff"' : ''}></span>Équipe ${esc(m.teamNames[me.team])}`
      : 'Les équipes ne sont pas encore faites.'
    : "On te prévient dès qu'une place se libère.";
  const canChange = m.canJoin;
  const guests = myGuests.length
    ? `<ul class="guest-list">${myGuests
        .map((g) => {
          const confirmed = m.confirmed.some((e) => e.id === g.id);
          return `<li><span>${esc(g.name)} <span class="small">+1, ${confirmed ? 'joue' : "en liste d'attente"}</span></span>
            ${canChange ? `<button class="btn btn-outline-light" data-action="remove-guest" data-id="${g.id}" data-name="${esc(g.name)}">Retirer</button>` : ''}</li>`;
        })
        .join('')}</ul>`
    : '';
  return `<section class="card dark status">
    <div class="status-head">
      <div>
        <p class="status-title">${inGame ? 'Tu joues' : `${ordinal(me.waitPosition)} en liste d'attente`}</p>
        <p class="status-sub">${sub}</p>
      </div>
      ${inGame ? ICON.check : ''}
    </div>
    ${guests}
    ${
      canChange
        ? `<div class="btn-row">
      <button class="btn btn-light" data-action="add-guest">Ajouter un +1</button>
      <button class="btn btn-outline-light" data-action="leave">${inGame ? 'Me désister' : 'Me retirer'}</button>
    </div>`
        : ''
    }
  </section>`;
}

function avatarHtml(e, m) {
  const cls = ['av'];
  if (e.team === 'A') cls.push('av-a');
  else if (e.team === 'B') cls.push('av-b');
  if (e.mine && !e.isGuest) cls.push('is-me');
  const badge = e.isGuest ? '<span class="badge">+1</span>' : m.played && e.goals ? `<span class="badge" aria-label="${plural(e.goals, 'but')}">${e.goals}</span>` : '';
  const label = `${e.name}${e.isGuest ? `, invité de ${e.hostName}` : ''}${m.played && e.goals ? `, ${plural(e.goals, 'but')}` : ''}`;
  const sub = m.canManage && !m.played && e.strength !== undefined ? `<span class="sub">${e.strength}</span>` : '';
  return `<li aria-label="${esc(label)}"><span class="${cls.join(' ')}" aria-hidden="true">${esc(initials(e.name))}${badge}</span>
    <span class="name" aria-hidden="true">${e.mine && !e.isGuest ? 'Toi' : esc(e.name.split(' ')[0])}</span>${sub}</li>`;
}

function playersHtml(m) {
  if (m.cancelled) return '';
  const teamed = m.confirmed.filter((e) => e.team);
  if (teamed.length) {
    const A = teamed.filter((e) => e.team === 'A');
    const B = teamed.filter((e) => e.team === 'B');
    const p = m.teams?.prediction;
    const showP = !m.played && p !== undefined;
    const unassigned = m.confirmed.filter((e) => !e.team);
    return `<div class="section-head"><h2>Les équipes</h2><button class="link" data-action="share">Partager</button></div>
    <section class="card teams-card">
      <div class="team-head"><span><span class="dot dot-a"></span>${esc(m.teamNames.A)}</span>${showP ? `<span class="num">${p} %</span>` : ''}</div>
      <ul class="roster">${A.map((e) => avatarHtml(e, m)).join('')}</ul>
      ${
        showP
          ? `<div class="forecast">
        <div class="forecast-bar" role="img" aria-label="${esc(`Pronostic : ${m.teamNames.A} ${p} %, ${m.teamNames.B} ${100 - p} %`)}"><span class="a" data-w="${p}"></span><span class="b"></span></div>
        <p>Pronostic selon les niveaux et les derniers résultats</p>
      </div>`
          : '<div class="divider"></div>'
      }
      <ul class="roster">${B.map((e) => avatarHtml(e, m)).join('')}</ul>
      <div class="team-head"><span><span class="dot dot-b"></span>${esc(m.teamNames.B)}</span>${showP ? `<span class="num">${100 - p} %</span>` : ''}</div>
      ${unassigned.length ? `<p class="small muted">Sans équipe pour l'instant : ${unassigned.map((e) => esc(e.name)).join(', ')}.</p>` : ''}
    </section>`;
  }
  const slots = [];
  const total = Math.max(m.capacity, m.confirmed.length);
  for (let i = 0; i < total; i++) {
    const e = m.confirmed[i];
    slots.push(e ? avatarHtml(e, m) : `<li aria-label="Place libre"><span class="av av-empty" aria-hidden="true">${i + 1}</span><span class="name muted" aria-hidden="true">Libre</span></li>`);
  }
  return `<div class="section-head"><h2>Les joueurs</h2><span class="muted">${m.confirmed.length} sur ${m.capacity}</span></div>
  <section class="card"><ul class="roster">${slots.join('')}</ul></section>`;
}

function waitlistHtml(m) {
  if (!m.waitlist.length || m.cancelled || m.played) return '';
  const shown = m.waitlist.slice(0, 3);
  return `<section class="card wait-card" aria-label="Liste d'attente">
    <div class="wait-head">
      <span class="av-stack" aria-hidden="true">${shown.map((e) => `<span class="av">${esc(initials(e.name))}</span>`).join('')}</span>
      <p><strong>${plural(m.waitlist.length, 'joueur')} en liste d'attente</strong><br><span class="small muted">Le premier remonte dès qu'une place se libère.</span></p>
    </div>
    <ol class="wait-list">${m.waitlist
      .map((e) => `<li class="${e.mine && !e.isGuest ? 'me' : ''}">${e.mine && !e.isGuest ? 'Toi' : esc(e.name)}${e.isGuest ? ` <span class="small muted">(+1 de ${esc(e.hostName)})</span>` : ''}</li>`)
      .join('')}</ol>
  </section>`;
}

function scoreLine(a, b, names) {
  return `<div class="scoreline" role="img" aria-label="${esc(`${names.A} ${a}, ${names.B} ${b}`)}">
    <span class="team">${esc(names.A)}</span>
    <span class="score">${a > b ? `<span class="win">${a}</span>` : a} – ${b > a ? `<span class="win">${b}</span>` : b}</span>
    <span class="team team-b">${esc(names.B)}</span>
  </div>`;
}

function scoreHtml(m) {
  return `<section class="card score-card">${scoreLine(m.scoreA, m.scoreB, m.teamNames)}</section>`;
}

function lastResultHtml(r, names) {
  const mvp = r.mvp.length
    ? `<p class="small"><span class="chip chip-dark">MVP</span> ${r.mvp.map((x) => `${esc(x.name)}${x.goals ? `, ${plural(x.goals, 'but')}` : ''}`).join(' et ')}</p>`
    : r.topScorer
      ? `<p class="small muted">Meilleur buteur : ${esc(r.topScorer.name)}, ${plural(r.topScorer.goals, 'but')}</p>`
      : '';
  return `<div class="section-head"><h2>Dernier match</h2><a href="#/match/${r.id}">Détails</a></div>
  <section class="card score-card">
    <p class="small muted">${esc(dayLong(r.startsAt))}</p>
    ${scoreLine(r.scoreA, r.scoreB, names)}
    ${mvp}
  </section>`;
}

function mvpHtml(m) {
  if (!m.played || !m.mvp) return '';
  const all = m.confirmed.filter((e) => e.team);
  const byId = new Map(all.map((e) => [e.id, e]));
  const v = m.mvp;
  let body = '';
  if (!v.open) {
    if (!v.winners.length) body = '<p class="muted">Aucun vote pour ce match.</p>';
    else {
      const names = v.winners.map((id) => esc(byId.get(id)?.name || '?')).join(' et ');
      const n = v.counts?.[v.winners[0]] || 0;
      body = `<div class="mvp-winner"><span class="av av-b av-lg" aria-hidden="true">${esc(initials(byId.get(v.winners[0])?.name))}</span><div><strong>${names}</strong><span class="muted">${plural(n, 'vote')}</span></div></div>`;
    }
  } else {
    if (v.canVote) {
      const options = all.filter((e) => !(e.mine && !e.isGuest));
      body += `<form data-form="mvp" class="form-grid">
        <div class="choices" role="radiogroup" aria-label="Homme du match">${options
          .map((e) => `<label class="choice"><input type="radio" name="entryId" value="${e.id}" ${v.myVote === e.id ? 'checked' : ''} required><span>${esc(e.name)}</span></label>`)
          .join('')}</div>
        <button class="btn btn-dark btn-block" type="submit">${v.myVote ? 'Changer mon vote' : 'Voter'}</button>
      </form>`;
    }
    if (v.counts) {
      const ranked = Object.entries(v.counts).sort((a, b) => b[1] - a[1]);
      body += `<ul class="list" style="margin-top:8px">${ranked
        .map(([id, n]) => `<li><span class="row static"><span class="grow">${esc(byId.get(Number(id))?.name || '?')}</span><span class="num">${n}</span></span></li>`)
        .join('')}</ul>`;
    } else if (!v.canVote) {
      body += `<p class="muted">${plural(v.totalVotes, 'vote')} pour l'instant.</p>`;
    }
    body += `<p class="small muted" style="margin-top:10px">Vote ouvert jusqu'au ${esc(fmt(v.closesAt, { weekday: 'long', day: 'numeric' }))} à ${esc(hour(v.closesAt))}.</p>`;
  }
  return `<div class="section-head"><h2>Homme du match</h2></div><section class="card">${body}</section>`;
}

function adminToolsHtml(m) {
  const b = (action, label, extra = '') => `<button class="btn btn-small" data-action="${action}" ${extra}>${label}</button>`;
  const hasTeams = m.confirmed.some((e) => e.team);
  let btns = [];
  if (m.cancelled) btns = [b('restore-match', 'Rétablir le match')];
  else if (m.played) btns = [b('result', 'Corriger le score'), b('teams-edit', 'Ajuster les équipes')];
  else {
    btns = [
      `<button class="btn btn-small btn-dark" data-action="teams-generate" ${m.confirmed.length < 2 ? 'disabled' : ''}>${hasTeams ? 'Refaire les équipes' : 'Faire les équipes'}</button>`,
      hasTeams ? b('teams-edit', 'Ajuster les équipes') : '',
      hasTeams ? b('result', 'Saisir le score') : '',
      b('edit-match', 'Lieu, date, places'),
      b('add-player', 'Inscrire un joueur'),
      m.confirmed.length || m.waitlist.length ? b('manage-entries', 'Gérer les inscrits') : '',
      `<button class="btn btn-small btn-danger" data-action="cancel-match">Annuler le match</button>`,
    ];
  }
  return `<div class="section-head"><h2>Organisation</h2></div><div class="btn-row">${btns.join('')}</div>`;
}

// ---------- Feuilles d'action ----------
const SELF_LEVELS = [
  [3, 'Débutant'],
  [5, 'Moyen'],
  [7, 'Bon'],
  [9, 'Très bon'],
];
const LEVELS = [
  [3, 'Débutant'],
  [5, 'Moyen'],
  [7, 'Bon'],
  [9, 'Très bon'],
];
function guestSheet(mode) {
  openSheet(`
    <h2 id="sheet-title">${mode === 'join' ? 'Tu viens avec qui ?' : 'Ajouter un +1'}</h2>
    <form data-form="guest" data-mode="${mode}" class="form-grid">
      <label class="field"><span>Prénom de ton +1</span><input class="input" name="name" required maxlength="40" autocomplete="off"></label>
      <fieldset class="field">
        <legend>Son niveau</legend>
        <div class="levels">${LEVELS.map(([v, l]) => `<label class="choice"><input type="radio" name="level" value="${v}" ${v === 5 ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
        <small>Sert uniquement à équilibrer les équipes.</small>
      </fieldset>
      <div class="actions">
        <button type="button" class="btn" data-close>Annuler</button>
        <button class="btn btn-dark" type="submit">${mode === 'join' ? 'Valider' : 'Ajouter'}</button>
      </div>
    </form>`);
}

const stepper = (name, value, min = 0, max = 99, label = '') =>
  `<div class="stepper" data-min="${min}" data-max="${max}" role="group" ${label ? `aria-label="${esc(label)}"` : ''}>
    <button type="button" data-step="-1" aria-label="Moins">−</button>
    <output aria-live="polite">${value}</output>
    <input type="hidden" name="${name}" value="${value}">
    <button type="button" data-step="1" aria-label="Plus">+</button>
  </div>`;

function venuePickerHtml(value) {
  const venues = state.group.venues || [];
  return `<label class="field"><span>Lieu</span><input class="input" name="location" maxlength="120" value="${esc(value || '')}" autocomplete="off"></label>
    ${
      venues.length
        ? `<div class="venue-picks" role="group" aria-label="Lieux habituels">${venues
            .map((v) => `<button type="button" data-action="pick-venue" data-venue="${esc(v)}" aria-pressed="${v === value}">${esc(v)}</button>`)
            .join('')}</div>`
        : ''
    }`;
}

function resultSheet(m) {
  const teamed = m.confirmed.filter((e) => e.team);
  const rows = (t) =>
    teamed
      .filter((e) => e.team === t)
      .map((e) => `<li><span class="grow">${esc(e.name)}</span>${stepper(`g_${e.id}`, e.goals || 0, 0, 50, `Buts de ${e.name}`)}</li>`)
      .join('');
  openSheet(`
    <h2 id="sheet-title">Score final</h2>
    <form data-form="result" class="form-grid">
      <div class="row-2">
        <div class="field"><span>${esc(m.teamNames.A)}</span>${stepper('scoreA', m.scoreA ?? 0, 0, 99, m.teamNames.A)}</div>
        <div class="field"><span>${esc(m.teamNames.B)}</span>${stepper('scoreB', m.scoreB ?? 0, 0, 99, m.teamNames.B)}</div>
      </div>
      <h3>Buteurs ${esc(m.teamNames.A)}</h3>
      <ul class="goal-rows">${rows('A')}</ul>
      <h3>Buteurs ${esc(m.teamNames.B)}</h3>
      <ul class="goal-rows">${rows('B')}</ul>
      <div class="actions">
        <button type="button" class="btn" data-close>Annuler</button>
        <button class="btn btn-dark" type="submit">Enregistrer</button>
      </div>
      ${m.played ? '<button type="button" class="link link-danger" data-action="clear-result">Effacer le résultat</button>' : ''}
    </form>`);
}

function teamsEditSheet(m) {
  openSheet(`
    <h2 id="sheet-title">Ajuster les équipes</h2>
    <form data-form="teams" class="form-grid">
      <ul class="goal-rows">${m.confirmed
        .map(
          (e) => `<li><span class="grow">${esc(e.name)}${e.strength !== undefined ? ` <span class="small muted">${e.strength}</span>` : ''}</span>
          <span class="choices">${['A', 'B']
            .map((t) => `<label class="choice"><input type="radio" name="t_${e.id}" value="${t}" ${e.team === t ? 'checked' : ''}><span>${esc(m.teamNames[t])}</span></label>`)
            .join('')}</span></li>`,
        )
        .join('')}</ul>
      <div class="actions">
        <button type="button" class="btn" data-close>Annuler</button>
        <button class="btn btn-dark" type="submit">Enregistrer</button>
      </div>
      ${m.played ? '' : '<button type="button" class="link link-danger" data-action="clear-teams">Défaire les équipes</button>'}
    </form>`);
}

function matchFormHtml(values, submitLabel) {
  return `
    <label class="field"><span>Date et heure</span><input class="input" type="datetime-local" name="startsAt" required value="${esc(values.startsAt || '')}"></label>
    ${venuePickerHtml(values.location)}
    <label class="field"><span>Nombre de places</span><input class="input" type="number" name="capacity" min="2" max="40" required value="${esc(values.capacity || 12)}"></label>
    <label class="field"><span>Info pour les joueurs</span><textarea class="input" name="notes" maxlength="500" placeholder="Terrain 3, 7 € chacun…">${esc(values.notes || '')}</textarea></label>
    <div class="actions">
      <button type="button" class="btn" data-close>Annuler</button>
      <button class="btn btn-dark" type="submit">${submitLabel}</button>
    </div>`;
}

function createMatchSheet() {
  openSheet(`<h2 id="sheet-title">Nouveau match</h2><form data-form="create-match" class="form-grid">${matchFormHtml({ location: state.group.location, capacity: state.group.capacity }, 'Créer le match')}</form>`);
}

function plannedSheet(p) {
  openSheet(`<h2 id="sheet-title">${esc(dayLong(p.startsAt))}</h2>
    <form data-form="planned" data-slot="${esc(p.slot)}" class="form-grid">
      <p class="muted">Les inscriptions ouvriront le ${esc(fmt(p.opensAt, { weekday: 'long', day: 'numeric', month: 'long' }))}. Tu peux déjà choisir le lieu.</p>
      ${venuePickerHtml(p.location)}
      <label class="switch"><span>Pas de five ce jeudi</span><input type="checkbox" name="skipped" ${p.skipped ? 'checked' : ''}></label>
      <div class="actions">
        <button type="button" class="btn" data-close>Annuler</button>
        <button class="btn btn-dark" type="submit">Enregistrer</button>
      </div>
    </form>`);
}

function manageEntriesSheet(m) {
  const row = (e, wait) => `<li><span class="grow">${esc(e.name)}${e.isGuest ? ` <span class="small muted">+1 de ${esc(e.hostName)}</span>` : ''}${wait ? ' <span class="chip">attente</span>' : ''}</span>
      <button class="btn btn-small btn-danger" data-action="admin-remove" data-id="${e.id}" data-name="${esc(e.name)}">Retirer</button></li>`;
  openSheet(`<h2 id="sheet-title">Inscrits</h2>
    <ul class="goal-rows">${m.confirmed.map((e) => row(e, false)).join('')}${m.waitlist.map((e) => row(e, true)).join('')}</ul>
    <div class="actions"><button type="button" class="btn" data-close>Fermer</button></div>`);
}

async function addPlayerSheet(m) {
  const players = await api('GET', '/api/players');
  const taken = new Set([...m.confirmed, ...m.waitlist].filter((e) => !e.isGuest).map((e) => e.userId));
  const free = players.filter((p) => !taken.has(p.id));
  if (!free.length) return toast('Tout le monde est déjà inscrit');
  openSheet(`<h2 id="sheet-title">Inscrire un joueur</h2>
    <form data-form="add-player" class="form-grid">
      <label class="field"><span>Joueur</span><select class="input" name="userId" required>${free.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
      <div class="actions"><button type="button" class="btn" data-close>Annuler</button><button class="btn btn-dark" type="submit">Inscrire</button></div>
    </form>`);
}

// ---------- Actions (clics) ----------
const actions = {
  async join() {
    await showMatch(await api('POST', `/api/matches/${current.match.id}/join`, { guests: [] }));
    toast(current.match.me?.spot === 'confirmed' ? "C'est noté, tu joues !" : "Tu es en liste d'attente");
  },
  'join-guest': () => guestSheet('join'),
  'add-guest': () => guestSheet('add'),
  async leave() {
    const m = current.match;
    const hasGuests = [...m.confirmed, ...m.waitlist].some((e) => e.mine && e.isGuest);
    const late = new Date(m.startsAt) - Date.now() < 24 * 3600e3 && m.me.spot === 'confirmed';
    const parts = [];
    if (hasGuests) parts.push('Tes +1 seront retirés aussi.');
    if (late) parts.push("C'est dans moins de 24 h : pense à prévenir le groupe. Le premier de la liste d'attente prendra ta place.");
    const ok = await confirmSheet({
      title: m.me.spot === 'confirmed' ? 'Te désister ?' : "Quitter la liste d'attente ?",
      text: parts.join(' '),
      confirm: m.me.spot === 'confirmed' ? 'Me désister' : 'Me retirer',
      danger: true,
    });
    if (!ok) return;
    await showMatch(await api('POST', `/api/entries/${m.me.entryId}/cancel`));
    toast('Désinscription enregistrée');
  },
  async 'remove-guest'(el) {
    const ok = await confirmSheet({ title: `Retirer ${el.dataset.name} ?`, confirm: 'Retirer', danger: true });
    if (!ok) return;
    await showMatch(await api('POST', `/api/entries/${el.dataset.id}/cancel`));
  },
  async 'admin-remove'(el) {
    const m = await api('POST', `/api/entries/${el.dataset.id}/cancel`);
    await showMatch(m);
    toast(`${el.dataset.name} retiré`);
    if (m.confirmed.length || m.waitlist.length) manageEntriesSheet(m);
    else closeSheet();
  },
  async 'teams-generate'() {
    const m = current.match;
    if (m.confirmed.some((e) => e.team)) {
      const ok = await confirmSheet({ title: 'Refaire les équipes ?', text: 'Une nouvelle répartition équilibrée sera tirée.', confirm: 'Refaire' });
      if (!ok) return;
    }
    await showMatch(await api('POST', `/api/matches/${m.id}/teams`));
    toast('Équipes faites');
  },
  'teams-edit': () => teamsEditSheet(current.match),
  async 'clear-teams'() {
    closeSheet();
    await showMatch(await api('DELETE', `/api/matches/${current.match.id}/teams`));
  },
  result: () => resultSheet(current.match),
  async 'clear-result'() {
    closeSheet();
    const ok = await confirmSheet({ title: 'Effacer le résultat ?', text: 'Les buts, votes et indices de forme liés à ce match seront recalculés.', confirm: 'Effacer', danger: true });
    if (!ok) return;
    await showMatch(await api('DELETE', `/api/matches/${current.match.id}/result`));
  },
  'add-player': () => addPlayerSheet(current.match),
  'manage-entries': () => manageEntriesSheet(current.match),
  async 'edit-match'() {
    const v = await api('GET', `/api/matches/${current.match.id}/edit`);
    openSheet(`<h2 id="sheet-title">Modifier le match</h2><form data-form="edit-match" class="form-grid">${matchFormHtml(v, 'Enregistrer')}<p class="small muted">Les inscrits sont prévenus si la date ou le lieu change.</p></form>`);
  },
  'create-match': () => createMatchSheet(),
  'pick-venue'(el) {
    const form = el.closest('form');
    form.querySelector('[name=location]').value = el.dataset.venue;
    form.querySelectorAll('[data-action=pick-venue]').forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
  },
  'plan-slot'(el) {
    const p = current.planned.find((x) => x.slot === el.dataset.slot);
    if (p) plannedSheet(p);
  },
  'cancel-match'() {
    openSheet(`<h2 id="sheet-title">Annuler le match ?</h2>
      <form data-form="cancel-match" class="form-grid">
        <p class="muted">Les inscrits seront prévenus.</p>
        <label class="field"><span>Raison (facultatif)</span><input class="input" name="reason" maxlength="200" placeholder="Terrain indisponible…"></label>
        <div class="actions"><button type="button" class="btn" data-close>Garder le match</button><button class="btn btn-danger" type="submit">Annuler le match</button></div>
      </form>`);
  },
  async 'restore-match'() {
    await showMatch(await api('POST', `/api/matches/${current.match.id}/restore`));
  },
  async share() {
    const m = current.match;
    const list = (t) =>
      m.confirmed
        .filter((e) => e.team === t)
        .map((e) => e.name)
        .join(', ');
    const text = `${state.group.name} – ${dayLong(m.startsAt)} à ${hour(m.startsAt)}${m.location ? `, ${m.location}` : ''}\n\n${m.teamNames.A} : ${list('A')}\n${m.teamNames.B} : ${list('B')}\n\n${location.origin}/#/match/${m.id}`;
    if (navigator.share) {
      try {
        await navigator.share({ text });
      } catch {
        /* partage annulé */
      }
    } else {
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    }
  },
  async 'push-enable'() {
    await enablePush();
    await api('POST', '/api/me/test-notification').catch(() => {});
    toast('Rappels activés');
    render();
  },
  'setup-later'() {
    storage.set('fdj-setup-later', '1');
    if (current.path === '/') view.querySelector('.push-nudge')?.remove();
    else location.hash = '#/';
  },
  async 'push-test'() {
    const r = await api('POST', '/api/me/test-notification');
    toast(r.push ? 'Notification envoyée' : "Aucun appareil n'a reçu la notification", !r.push);
  },
  async 'push-disable'() {
    await disablePush();
    toast('Notifications désactivées sur cet appareil');
    render();
  },
  async install() {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    render();
  },
  async 'copy-invite'(el) {
    const url = `${location.origin}/#/inscription?code=${encodeURIComponent(el.dataset.code)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("Lien d'invitation copié");
    } catch {
      openSheet(`<h2 id="sheet-title">Lien d'invitation</h2><input class="input" readonly value="${esc(url)}"><div class="actions"><button class="btn" data-close>Fermer</button></div>`);
    }
  },
  'manage-user'(el) {
    const u = JSON.parse(el.dataset.user);
    openSheet(`<h2 id="sheet-title">${esc(u.name)}</h2>
      <form data-form="user" data-id="${u.id}" class="form-grid">
        <label class="field"><span>Niveau (1 à 10)</span>
          <select class="input" name="level">${Array.from({ length: 10 }, (_, i) => i + 1)
            .map((n) => `<option value="${n}" ${n === u.level ? 'selected' : ''}>${n}${n === 5 ? ' – niveau moyen du groupe' : n === 1 ? ' – débutant' : n === 10 ? ' – le crack' : ''}</option>`)
            .join('')}</select>
          <small>Point de départ de l'équilibrage. Les résultats prennent le relais au fil des matchs (indice actuel : ${u.elo}, ${plural(u.games, 'match', 'matchs')}).</small>
        </label>
        <fieldset class="field">
          <legend>Rôle</legend>
          <div class="levels" style="grid-template-columns:repeat(3,minmax(0,1fr))">${Object.entries(ROLES)
            .map(([v, l]) => `<label class="choice"><input type="radio" name="role" value="${v}" ${u.role === v ? 'checked' : ''}><span>${l}</span></label>`)
            .join('')}</div>
          <small>Capitaine : gère les matchs (équipes, score, lieu, inscrits, annulation). Organisateur : en plus, les réglages du groupe et les comptes.</small>
        </fieldset>
        <label class="switch"><span>Compte actif</span><input type="checkbox" name="active" ${u.active ? 'checked' : ''}></label>
        <div class="actions"><button type="button" class="btn" data-close>Annuler</button><button class="btn btn-dark" type="submit">Enregistrer</button></div>
        <button type="button" class="link" data-action="reset-password" data-id="${u.id}" data-name="${esc(u.name)}">Générer un nouveau mot de passe</button>
        <button type="button" class="link link-danger" data-action="delete-user" data-id="${u.id}" data-name="${esc(u.name)}">Supprimer le compte</button>
      </form>`);
  },
  async 'reset-password'(el) {
    const ok = await confirmSheet({ title: `Nouveau mot de passe pour ${el.dataset.name} ?`, text: "L'ancien ne fonctionnera plus.", confirm: 'Générer' });
    if (!ok) return;
    const r = await api('POST', `/api/admin/users/${el.dataset.id}/reset-password`);
    openSheet(`<h2 id="sheet-title">Mot de passe provisoire</h2>
      <p class="muted">Transmets-le à ${esc(el.dataset.name)}, qui pourra le changer depuis son profil.</p>
      <p class="num" style="font-size:34px;margin:16px 0;user-select:all">${esc(r.password)}</p>
      <div class="actions"><button class="btn" data-close>Fermer</button></div>`);
  },
  async 'delete-user'(el) {
    const ok = await confirmSheet({
      title: `Supprimer ${el.dataset.name} ?`,
      text: 'Tout est effacé : compte, inscriptions, +1, buts, votes et historique. Les classements sont recalculés. C\'est définitif.',
      confirm: 'Supprimer définitivement',
      danger: true,
    });
    if (!ok) return;
    await api('DELETE', `/api/admin/users/${el.dataset.id}`);
    toast(`${el.dataset.name} supprimé`);
    render();
  },
  'set-theme'(el) {
    applyTheme(el.dataset.theme);
    render();
  },
  async logout() {
    await disablePush().catch(() => {});
    await api('POST', '/api/auth/logout');
    state.me = null;
    view.innerHTML = '';
    location.hash = '#/connexion';
  },
};

document.addEventListener('click', async (e) => {
  const stepBtn = e.target.closest('[data-step]');
  if (stepBtn) {
    const box = stepBtn.closest('.stepper');
    const input = box.querySelector('input');
    const v = Math.min(Number(box.dataset.max), Math.max(Number(box.dataset.min), Number(input.value) + Number(stepBtn.dataset.step)));
    input.value = v;
    box.querySelector('output').textContent = v;
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  e.preventDefault();
  if (el.disabled) return;
  el.disabled = true;
  try {
    await actions[el.dataset.action](el, e);
  } catch (err) {
    toast(err.message, true);
  } finally {
    el.disabled = false;
  }
});

// ---------- Formulaires ----------
const forms = {
  async login(form, fd) {
    const r = await api('POST', '/api/auth/login', { login: fd.get('login'), password: fd.get('password') });
    state.me = r.user;
    await syncPushSubscription();
    location.hash = (await needsSetup()) ? '#/bienvenue' : '#/';
  },
  async register(form, fd) {
    const r = await api('POST', '/api/auth/register', {
      name: fd.get('name'),
      email: fd.get('email'),
      password: fd.get('password'),
      inviteCode: fd.get('inviteCode'),
      level: Number(fd.get('level') || 5),
    });
    state.me = r.user;
    state.hasUsers = true;
    location.hash = '#/bienvenue';
  },
  async guest(form, fd) {
    const g = { name: fd.get('name'), level: Number(fd.get('level') || 5) };
    const id = current.match.id;
    const m =
      form.dataset.mode === 'join'
        ? await api('POST', `/api/matches/${id}/join`, { guests: [g] })
        : await api('POST', `/api/matches/${id}/guests`, g);
    closeSheet();
    await showMatch(m);
    const guestEntry = [...m.confirmed, ...m.waitlist].filter((e) => e.mine && e.isGuest).pop();
    const guestIn = guestEntry && m.confirmed.some((e) => e.id === guestEntry.id);
    toast(guestIn ? `${g.name} est dans l'équipe` : `${g.name} est en liste d'attente`);
  },
  async result(form, fd) {
    const goals = {};
    for (const [k, v] of fd.entries()) if (k.startsWith('g_')) goals[k.slice(2)] = Number(v);
    const m = await api('PUT', `/api/matches/${current.match.id}/result`, { scoreA: Number(fd.get('scoreA')), scoreB: Number(fd.get('scoreB')), goals });
    closeSheet();
    await showMatch(m);
    toast('Score enregistré');
  },
  async teams(form, fd) {
    const assignments = {};
    for (const [k, v] of fd.entries()) if (k.startsWith('t_')) assignments[k.slice(2)] = v;
    const m = await api('PUT', `/api/matches/${current.match.id}/teams`, { assignments });
    closeSheet();
    await showMatch(m);
  },
  async mvp(form, fd) {
    await showMatch(await api('POST', `/api/matches/${current.match.id}/mvp`, { entryId: Number(fd.get('entryId')) }));
    toast('Vote enregistré');
  },
  async 'edit-match'(form, fd) {
    const m = await api('PUT', `/api/matches/${current.match.id}`, Object.fromEntries(fd));
    closeSheet();
    await showMatch(m);
    toast('Match modifié');
  },
  async 'create-match'(form, fd) {
    const m = await api('POST', '/api/matches', Object.fromEntries(fd));
    closeSheet();
    location.hash = `#/match/${m.id}`;
    toast('Match créé, tout le monde est prévenu');
  },
  async planned(form, fd) {
    await api('PUT', `/api/planned/${encodeURIComponent(form.dataset.slot)}`, { location: fd.get('location'), skipped: form.querySelector('[name=skipped]').checked });
    closeSheet();
    toast('Calendrier mis à jour');
    render();
  },
  async 'cancel-match'(form, fd) {
    const m = await api('POST', `/api/matches/${current.match.id}/cancel`, { reason: fd.get('reason') });
    closeSheet();
    await showMatch(m);
  },
  async 'add-player'(form, fd) {
    const m = await api('POST', `/api/matches/${current.match.id}/players`, { userId: Number(fd.get('userId')) });
    closeSheet();
    await showMatch(m);
  },
  async profile(form, fd) {
    const r = await api('PUT', '/api/me', { name: fd.get('name'), email: fd.get('email') });
    state.me = r.user;
    toast('Profil enregistré');
    render();
  },
  async password(form, fd) {
    await api('PUT', '/api/me/password', { current: fd.get('current'), next: fd.get('next') });
    form.reset();
    toast('Mot de passe changé');
  },
  async settings(form, fd) {
    const body = Object.fromEntries(fd);
    body.remind_open = form.querySelector('[name=remind_open]').checked ? 1 : 0;
    body.notify_staff_signups = form.querySelector('[name=notify_staff_signups]').checked ? 1 : 0;
    body.venues = [body.location, ...String(body.other_venues || '').split('\n')];
    delete body.other_venues;
    await api('PUT', '/api/admin/settings', body);
    await loadMe();
    toast('Réglages enregistrés');
    render();
  },
  async user(form, fd) {
    await api('PUT', `/api/admin/users/${form.dataset.id}`, {
      level: Number(fd.get('level')),
      role: fd.get('role') || 'player',
      active: form.querySelector('[name=active]').checked,
    });
    closeSheet();
    toast('Joueur mis à jour');
    render();
  },
};

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form || !forms[form.dataset.form]) return;
  e.preventDefault();
  const btn = form.querySelector('[type=submit]');
  const errEl = form.querySelector('[data-error]');
  if (btn) btn.disabled = true;
  if (errEl) errEl.hidden = true;
  try {
    await forms[form.dataset.form](form, new FormData(form));
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } else toast(err.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
});

document.addEventListener('input', (e) => {
  if (e.target.matches('input[name=location]')) {
    e.target
      .closest('form')
      ?.querySelectorAll('[data-action=pick-venue]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.venue === e.target.value)));
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.matches('[data-pref=notifyEmail]')) {
    try {
      const r = await api('PUT', '/api/me', { notifyEmail: e.target.checked });
      state.me = r.user;
      toast(e.target.checked ? 'Rappels par email activés' : 'Rappels par email coupés');
    } catch (err) {
      toast(err.message, true);
      e.target.checked = !e.target.checked;
    }
  }
});

// ---------- Calendrier ----------
async function viewMatches() {
  const d = await api('GET', '/api/matches');
  current.planned = d.planned;
  const datebox = (iso, planned = false) =>
    `<span class="datebox${planned ? ' planned' : ''}"><span class="d">${fmt(iso, { day: 'numeric' })}</span><span class="m">${esc(fmt(iso, { month: 'short' }))}</span></span>`;
  const venue = (loc) =>
    loc && loc !== d.defaultLocation ? `<span class="sub"><span class="chip chip-full">${esc(loc)}</span></span>` : `<span class="sub">${esc(loc || '')}</span>`;

  const upcomingRow = (m) => {
    let right;
    if (m.cancelled) right = '<span class="chip">Annulé</span>';
    else if (m.my) right = m.my.spot === 'confirmed' ? '<span class="chip chip-open">Tu joues</span>' : '<span class="chip">En attente</span>';
    else if (m.confirmedCount >= m.capacity) right = '<span class="chip chip-full">Complet</span>';
    else right = `<span class="chip">${m.confirmedCount}/${m.capacity}</span>`;
    return `<li><a class="row" href="#/match/${m.id}">${datebox(m.startsAt)}
      <span class="grow"><span class="title">${esc(weekday(m.startsAt))} à ${esc(hour(m.startsAt))}</span>${venue(m.location)}</span>${right}</a></li>`;
  };
  const plannedRow = (p) => {
    const sub = p.skipped
      ? '<span class="sub">Pas de five ce jeudi</span>'
      : `${venue(p.location)}<span class="sub">Inscriptions le ${esc(fmt(p.opensAt, { weekday: 'short', day: 'numeric', month: 'short' }))}</span>`;
    const inner = `${datebox(p.startsAt, true)}
      <span class="grow"><span class="title">${esc(weekday(p.startsAt))} à ${esc(hour(p.startsAt))}</span>${sub}</span>
      ${p.skipped ? '<span class="chip">Off</span>' : ''}`;
    return canManage()
      ? `<li><button class="row" data-action="plan-slot" data-slot="${esc(p.slot)}" aria-label="${esc(`Planifier le ${dayLong(p.startsAt)}`)}">${inner}${ICON.chevron}</button></li>`
      : `<li><span class="row static">${inner}</span></li>`;
  };
  const pastRow = (m) => {
    let title;
    let sub = m.location || '';
    let right = '';
    if (m.cancelled) title = 'Annulé';
    else if (!m.played) title = 'Score à saisir';
    else if (m.my?.team) {
      const [gf, ga] = m.my.team === 'A' ? [m.scoreA, m.scoreB] : [m.scoreB, m.scoreA];
      const r = gf > ga ? 'V' : gf < ga ? 'D' : 'N';
      title = `${r === 'V' ? 'Victoire' : r === 'D' ? 'Défaite' : 'Nul'} ${gf} – ${ga}`;
      sub = `En ${d.teamNames[m.my.team]}${m.my.goals ? `, ${plural(m.my.goals, 'but')}` : ''}`;
      right = `<span class="result-dot r-${r}" aria-hidden="true">${r}</span>`;
    } else {
      title = `${m.scoreA} – ${m.scoreB}`;
      sub = `${d.teamNames.A} contre ${d.teamNames.B}`;
    }
    return `<li><a class="row" href="#/match/${m.id}">${datebox(m.startsAt)}
      <span class="grow"><span class="title">${esc(title)}</span><span class="sub">${esc(sub)}</span></span>${right}</a></li>`;
  };

  view.innerHTML = `
    <div class="section-head" style="padding-top:12px"><h1>Calendrier</h1>${canManage() ? '<button class="btn btn-small btn-dark" data-action="create-match">Nouveau match</button>' : ''}</div>
    <div class="section-head"><h2>À venir</h2></div>
    ${
      d.upcoming.length || d.planned.length
        ? `<ul class="list card card-tight">${d.upcoming.map(upcomingRow).join('')}${d.planned.map(plannedRow).join('')}</ul>`
        : '<p class="card empty">Rien de prévu pour le moment.</p>'
    }
    ${canManage() && d.planned.length ? '<p class="small muted">Touche un jeudi pas encore ouvert pour changer son lieu ou le sauter.</p>' : ''}
    <div class="section-head"><h2>Résultats</h2></div>
    ${d.past.length ? `<ul class="list card card-tight">${d.past.map(pastRow).join('')}</ul>` : '<p class="card empty">Aucun match joué pour le moment.</p>'}`;
}

// ---------- Classement ----------
const SORTS = [
  ['winRate', 'Victoires'],
  ['goals', 'Buts'],
  ['mvps', 'MVP'],
  ['played', 'Matchs'],
  ['lateCancels', 'Dernière minute'],
];
const MIN_GAMES = 3;
const statLabel = (sort, p) =>
  sort === 'winRate' ? `${p.winRate} %` : sort === 'goals' ? plural(p.goals, 'but') : sort === 'mvps' ? `${p.mvps} MVP` : sort === 'played' ? plural(p.played, 'match', 'matchs') : `${p.lateCancels}`;

async function viewStats(_, query) {
  const sort = SORTS.some(([k]) => k === query.get('tri')) ? query.get('tri') : 'winRate';
  const d = await api('GET', `/api/stats?season=${encodeURIComponent(query.get('saison') || '')}`);
  const seasonParam = String(d.season);
  const players = [...d.players].sort((a, b) => {
    if (sort === 'winRate') {
      const qa = a.played >= MIN_GAMES;
      const qb = b.played >= MIN_GAMES;
      if (qa !== qb) return qa ? -1 : 1;
    }
    return b[sort] - a[sort] || b.played - a.played || a.name.localeCompare(b.name);
  });
  const qualifies = (p) => p[sort] > 0 && (sort !== 'winRate' || p.played >= MIN_GAMES);
  const podium = players.length >= 3 && players.slice(0, 3).every(qualifies) ? players.slice(0, 3) : null;
  const rest = podium ? players.slice(3) : players;
  const href = (season, tri) => `#/classement?saison=${season}&tri=${tri}`;
  const podCard = (p, rank, first = false) => `<a href="#/joueur/${p.userId}" class="${first ? 'first' : ''}">
      <span class="av" aria-hidden="true">${esc(initials(p.name))}</span><span class="who">${esc(p.name)}</span>
      <span class="val">${sort === 'winRate' ? `${p.winRate} %` : p[sort]}</span><span class="rank">${rank === 1 ? '1er' : `${rank}e`}, ${plural(p.played, 'match', 'matchs')}</span></a>`;
  view.innerHTML = `
    <h1 style="padding-top:12px">Classement</h1>
    <nav class="segmented" aria-label="Saison">
      ${d.seasons.map((y) => `<a href="${href(y, sort)}" aria-current="${seasonParam === String(y)}">Saison ${y}-${String(y + 1).slice(2)}</a>`).join('')}
      <a href="${href('all', sort)}" aria-current="${seasonParam === 'all'}">Depuis le début</a>
    </nav>
    ${podium ? `<div class="podium">${podCard(podium[1], 2)}${podCard(podium[0], 1, true)}${podCard(podium[2], 3)}</div>` : ''}
    <nav class="chips" aria-label="Trier par">${SORTS.map(([k, l]) => `<a href="${href(seasonParam, k)}" aria-current="${k === sort}">${l}</a>`).join('')}</nav>
    ${
      players.length
        ? `<ol class="list card card-tight" ${podium ? 'start="4"' : ''}>${rest
            .map((p, i) => {
              const rank = i + (podium ? 4 : 1);
              return `<li><a class="row ${p.userId === state.me.id ? 'me-row' : ''}" href="#/joueur/${p.userId}">
            <span class="rank-num">${rank}</span>
            <span class="av av-sm" aria-hidden="true">${esc(initials(p.name))}</span>
            <span class="grow"><span class="title">${esc(p.name)}${p.userId === state.me.id ? ' (toi)' : ''}</span>
              <span class="sub">${plural(p.played, 'match', 'matchs')}, ${p.wins}-${p.draws}-${p.losses}, ${plural(p.goals, 'but')}</span></span>
            <span class="stat-val"><b>${sort === 'winRate' && p.played < MIN_GAMES ? '–' : esc(statLabel(sort, p))}</b>${sort === 'winRate' ? `<span class="bar"><span data-w="${p.played ? p.winRate : 0}"></span></span>` : ''}</span>
          </a></li>`;
            })
            .join('')}</ol>
      ${sort === 'winRate' ? `<p class="small muted">${MIN_GAMES} matchs minimum pour être classé au pourcentage de victoires.</p>` : ''}
      ${sort === 'lateCancels' ? '<p class="small muted">Désistements à moins de 24 h du coup d’envoi.</p>' : ''}`
        : '<div class="card empty"><h2>Pas encore de stats</h2><p>Le classement se remplit dès que le premier score est saisi.</p></div>'
    }`;
}

// ---------- Fiche joueur ----------
function sparkline(points) {
  if (points.length < 2) return '';
  const w = 320;
  const h = 84;
  const min = Math.min(...points) - 10;
  const max = Math.max(...points) + 10;
  const x = (i) => (i / (points.length - 1)) * w;
  const y = (v) => h - ((v - min) / (max - min)) * h;
  const d = points.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Évolution de l'indice de forme">
    <line x1="0" x2="${w}" y1="${y(points[0]).toFixed(1)}" y2="${y(points[0]).toFixed(1)}"/><path d="${d}" vector-effect="non-scaling-stroke"/></svg>`;
}

async function viewPlayer(id) {
  const p = await api('GET', `/api/players/${id}`);
  const t = p.totals;
  const isMe = p.id === state.me.id;
  const ratings = p.history
    .slice()
    .reverse()
    .map((h) => h.rating)
    .filter((r) => r !== undefined);
  view.innerHTML = `
    ${backLink('#/classement', 'Classement')}
    <div class="player-head">
      <span class="av av-b av-lg" aria-hidden="true">${esc(initials(p.name))}</span>
      <div><h1>${esc(p.name)}</h1>
      ${p.form.length ? `<p class="form" style="margin-top:8px" aria-label="Forme : ${p.form.join(', ')}">${p.form.map((r) => `<span class="result-dot r-${r}">${r}</span>`).join('')}</p>` : ''}</div>
    </div>
    <div class="statgrid">
      <div><span class="num">${t.played}</span><span class="lbl">Matchs</span></div>
      <div><span class="num">${t.played ? `${t.winRate}%` : '–'}</span><span class="lbl">Victoires</span></div>
      <div><span class="num">${t.goals}</span><span class="lbl">Buts</span></div>
      <div><span class="num">${t.mvps}</span><span class="lbl">MVP</span></div>
      <div><span class="num">${t.played ? (t.goals / t.played).toFixed(1).replace('.', ',') : '–'}</span><span class="lbl">Buts par match</span></div>
      <div><span class="num">${t.lateCancels}</span><span class="lbl">Dernière minute</span></div>
    </div>
    ${
      p.strength !== undefined
        ? `<section class="card">
      <div class="section-head" style="padding:0"><h2>Indice de forme</h2><span class="num" style="font-size:30px">${p.strength}</span></div>
      ${sparkline([p.ratingStart, ...ratings])}
      <p class="small muted" style="margin-top:8px">Mélange du niveau de départ (${p.level}/10) et des résultats. Sert à équilibrer les équipes. Visible par ${isMe ? 'toi' : 'le joueur'} et les organisateurs.</p>
    </section>`
        : ''
    }
    ${
      p.bestDuo
        ? `<section class="card">
      <h2>Meilleur duo</h2>
      <p><a href="#/joueur/${p.bestDuo.userId}"><strong>${esc(p.bestDuo.name)}</strong></a> : ${p.bestDuo.winRate} % de victoires ensemble sur ${plural(p.bestDuo.played, 'match', 'matchs')}.</p>
    </section>`
        : ''
    }
    <div class="section-head"><h2>Historique</h2></div>
    ${
      p.history.length
        ? `<ul class="list card card-tight">${p.history
            .map(
              (h) => `<li><a class="row" href="#/match/${h.matchId}">
        <span class="result-dot r-${h.result}">${h.result}</span>
        <span class="grow"><span class="title">${esc(dayLong(h.startsAt))}</span>
          <span class="sub">${esc(p.teamNames[h.team])} ${h.goalsFor} – ${h.goalsAgainst}${h.goals ? `, ${plural(h.goals, 'but')}` : ''}</span></span>
        ${h.mvp ? '<span class="chip chip-dark">MVP</span>' : ''}</a></li>`,
            )
            .join('')}</ul>`
        : '<p class="card empty">Pas encore de match joué.</p>'
    }`;
}

// ---------- Profil ----------
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
const isMobile = () => isIOS() || /android|mobile/i.test(navigator.userAgent);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) || null;
}

function b64ToU8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function enablePush() {
  if (!pushSupported()) throw new Error('Notifications non disponibles sur ce navigateur');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications refusées dans le navigateur');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(state.vapid) }));
  await api('POST', '/api/push/subscribe', sub.toJSON());
}

async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('DELETE', '/api/push/subscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

async function syncPushSubscription() {
  const sub = await currentSubscription().catch(() => null);
  if (sub) await api('POST', '/api/push/subscribe', sub.toJSON()).catch(() => {});
}

/** Où en est cet appareil : app installée ? rappels activés ? */
async function setupState() {
  const standalone = isStandalone();
  const mobile = isMobile();
  const sub = await currentSubscription().catch(() => null);
  let push;
  if (isIOS() && !standalone) push = 'needs-install'; // iOS : notifications uniquement depuis l'app installée
  else if (!pushSupported()) push = 'unsupported';
  else if (sub) push = 'on';
  else push = Notification.permission === 'denied' ? 'denied' : 'off';
  return { installed: standalone || !mobile, standalone, canPrompt: !!state.installPrompt, push, ios: isIOS() };
}

async function needsSetup() {
  const s = await setupState();
  return !s.installed || s.push === 'off' || s.push === 'needs-install';
}

async function setupNudgeHtml() {
  if (storage.get('fdj-setup-later')) return '';
  const s = await setupState();
  if (s.installed && s.push !== 'off') return '';
  const quick = s.installed && s.push === 'off';
  return `<section class="card push-nudge stack">
    <div><p><strong>${quick ? 'Active les rappels' : "Installe l'app et active les rappels"}</strong></p>
    <p class="small muted" style="margin-top:4px">Pour savoir quand les inscriptions ouvrent, quand une place se libère et dans quelle équipe tu joues.</p></div>
    <div class="btn-row">${
      quick ? '<button class="btn btn-small btn-dark" data-action="push-enable">Activer</button>' : '<a class="btn btn-small btn-dark" href="#/bienvenue">Configurer</a>'
    }<button class="btn btn-small" data-action="setup-later">Plus tard</button></div>
  </section>`;
}

const SHARE_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-label="Partager" role="img"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
const STEP_CHECK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

async function viewWelcome() {
  const s = await setupState();
  let install;
  if (s.installed) install = `<p class="muted">${s.standalone ? "C'est fait : tu utilises l'app installée." : 'Sur ordinateur, rien à installer.'}</p>`;
  else if (s.canPrompt)
    install = `<p class="muted">Le Five arrive sur ton écran d'accueil, comme une vraie appli.</p><button class="btn btn-dark btn-block" data-action="install">Installer l'app</button>`;
  else if (s.ios)
    install = `<ol class="howto">
      <li>Touche ${SHARE_ICON} <strong>Partager</strong> dans la barre de Safari.</li>
      <li>Choisis <strong>Sur l'écran d'accueil</strong>, puis <strong>Ajouter</strong>.</li>
      <li>Ouvre le Five depuis la nouvelle icône (reconnecte-toi si on te le demande).</li>
    </ol>`;
  else install = `<p class="muted">Dans le menu du navigateur (⋮), choisis <strong>Installer l'application</strong> ou <strong>Ajouter à l'écran d'accueil</strong>.</p>`;

  const pushBody = {
    on: `<p class="muted">Rappels activés sur cet appareil.</p><button class="btn btn-small" data-action="push-test">M'envoyer un test</button>`,
    off: `<p class="muted">Ouverture des inscriptions, place qui se libère, équipes, rappel le jour J.</p><button class="btn btn-dark btn-block" data-action="push-enable">Activer les rappels</button>`,
    'needs-install': `<p class="muted">Sur iPhone, les rappels s'activent depuis l'app installée : fais l'étape 1, ouvre le Five depuis l'icône, puis reviens ici.</p>`,
    denied: `<p class="muted">Les notifications sont bloquées pour le Five. Réautorise-les dans les réglages du téléphone ou du navigateur, puis reviens ici.</p>`,
    unsupported: `<p class="muted">Ce navigateur ne gère pas les notifications. Utilise Chrome sur Android ou Safari sur iPhone.</p>`,
  }[s.push];
  const step = (n, done, title, body) => `<section class="card step${done ? ' is-done' : ''}">
    <span class="step-num" aria-hidden="true">${done ? STEP_CHECK : n}</span>
    <div class="step-body"><h2>${title}</h2>${body}</div>
  </section>`;
  const allDone = s.installed && (s.push === 'on' || s.push === 'unsupported' || s.push === 'denied');
  view.innerHTML = `
    <div style="padding-top:12px"><h1>Bienvenue ${esc(state.me.name.split(' ')[0])}</h1>
    <p class="muted" style="margin-top:10px;font-size:16px">Deux réglages et tu ne rates plus un jeudi.</p></div>
    ${step(1, s.installed, "Installe l'app", install)}
    ${step(2, s.push === 'on', 'Active les rappels', pushBody)}
    <a class="btn btn-dark btn-block" href="#/">${allDone ? "C'est parti" : 'Continuer'}</a>
    ${allDone ? '' : '<button class="link" data-action="setup-later" style="align-self:center">Plus tard</button>'}`;
}

async function notificationsCardHtml() {
  let body;
  if (!pushSupported()) {
    body =
      isIOS() && !isStandalone()
        ? "<p class=\"muted\">Sur iPhone, ajoute d'abord l'app à l'écran d'accueil : bouton Partager, puis « Sur l'écran d'accueil ». Ouvre-la depuis l'icône et active les notifications ici.</p>"
        : '<p class="muted">Ce navigateur ne gère pas les notifications.</p>';
  } else if (Notification.permission === 'denied') {
    body = '<p class="muted">Les notifications sont bloquées pour ce site dans les réglages du navigateur.</p>';
  } else if (await currentSubscription()) {
    body = `<p>Activées sur cet appareil.</p>
      <div class="btn-row"><button class="btn btn-small" data-action="push-test">M'envoyer un test</button><button class="btn btn-small btn-ghost" data-action="push-disable">Désactiver</button></div>`;
  } else {
    body = `<p class="muted">Ouverture des inscriptions, place libérée, équipes, rappel le jour J.</p>
      <button class="btn btn-dark btn-block" data-action="push-enable">Activer les notifications</button>`;
  }
  const email = state.emailEnabled
    ? `<div class="divider"></div><label class="switch"><span>Recevoir aussi les rappels par email${state.me.email ? '' : ' <span class="small muted">(ajoute ton email ci-dessous)</span>'}</span>
        <input type="checkbox" data-pref="notifyEmail" ${state.me.notifyEmail ? 'checked' : ''} ${state.me.email ? '' : 'disabled'}></label>`
    : '';
  return `<section class="card stack"><h2>Notifications</h2>${body}${email}<a class="link" href="#/bienvenue">Guide d'installation</a></section>`;
}

async function viewProfile() {
  const me = state.me;
  const install = state.installPrompt
    ? `<section class="card stack"><h2>Installer l'app</h2><p class="muted">Ajoute le five sur ton écran d'accueil, comme une vraie appli.</p><button class="btn btn-dark btn-block" data-action="install">Installer</button></section>`
    : '';
  view.innerHTML = `
    <div class="player-head" style="padding-top:12px"><span class="av av-b av-lg" aria-hidden="true">${esc(initials(me.name))}</span><h1>${esc(me.name)}</h1></div>
    <div class="btn-row"><a class="btn" href="#/joueur/${me.id}">Mes stats</a>${me.role === 'admin' ? '<a class="btn btn-dark" href="#/admin">Organisation</a>' : ''}</div>
    ${await notificationsCardHtml()}${install}
    <section class="card stack">
      <h2>Apparence</h2>
      <nav class="segmented" aria-label="Thème">${[
        ['auto', 'Automatique'],
        ['light', 'Clair'],
        ['dark', 'Sombre'],
      ]
        .map(([v, l]) => `<a href="#" data-action="set-theme" data-theme="${v}" aria-current="${currentTheme() === v}">${l}</a>`)
        .join('')}</nav>
      <p class="small muted">Automatique suit le réglage du téléphone.</p>
    </section>
    <section class="card">
      <h2>Mon compte</h2>
      <form data-form="profile" class="form-grid" style="margin-top:14px">
        <label class="field"><span>Prénom ou pseudo</span><input class="input" name="name" required minlength="2" maxlength="30" value="${esc(me.name)}" autocomplete="nickname"></label>
        <label class="field"><span>Email</span><input class="input" type="email" name="email" value="${esc(me.email || '')}" autocomplete="email" placeholder="facultatif"></label>
        <button class="btn" type="submit">Enregistrer</button>
      </form>
    </section>
    <section class="card">
      <h2>Mot de passe</h2>
      <form data-form="password" class="form-grid" style="margin-top:14px">
        <label class="field"><span>Mot de passe actuel</span><input class="input" type="password" name="current" required autocomplete="current-password"></label>
        <label class="field"><span>Nouveau mot de passe</span><input class="input" type="password" name="next" required minlength="6" autocomplete="new-password"></label>
        <button class="btn" type="submit">Changer le mot de passe</button>
      </form>
    </section>
    <button class="btn btn-danger btn-block" data-action="logout">Me déconnecter</button>`;
}

// ---------- Thème ----------
function currentTheme() {
  return storage.get('fdj-theme') || 'auto';
}
function applyTheme(t) {
  storage.set('fdj-theme', t);
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelectorAll('meta[name=theme-color]').forEach((m) => m.setAttribute('content', bg));
}

// ---------- Organisation ----------
const WEEKDAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

async function viewAdmin() {
  if (!isAdmin()) {
    location.replace('#/profil');
    return;
  }
  const [s, users] = await Promise.all([api('GET', '/api/admin/settings'), api('GET', '/api/admin/users')]);
  const num = (name, label, min, max, help) =>
    `<label class="field"><span>${label}</span><input class="input" type="number" name="${name}" min="${min}" max="${max}" required value="${esc(s[name])}">${help ? `<small>${help}</small>` : ''}</label>`;
  const txt = (name, label, max, help = '') =>
    `<label class="field"><span>${label}</span><input class="input" name="${name}" maxlength="${max}" value="${esc(s[name])}">${help ? `<small>${help}</small>` : ''}</label>`;
  const others = (s.venues || []).filter((v) => v !== s.location);
  view.innerHTML = `
    ${backLink('#/profil', 'Profil')}
    <h1>Organisation</h1>

    <section class="card stack">
      <h2>Inviter des potes</h2>
      <p class="muted">Code actuel : <strong class="num" style="color:var(--ink);font-size:18px">${esc(s.invite_code)}</strong></p>
      <button class="btn btn-dark btn-block" data-action="copy-invite" data-code="${esc(s.invite_code)}">Copier le lien d'invitation</button>
    </section>

    <form data-form="settings" class="view">
      <section class="card form-grid">
        <h2>Le créneau</h2>
        <div class="row-2">
          <label class="field"><span>Jour</span><select class="input" name="weekday">${WEEKDAYS.map((d, i) => `<option value="${i}" ${String(i) === String(s.weekday) ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
          <label class="field"><span>Heure</span><input class="input" type="time" name="time" required value="${esc(s.time)}"></label>
        </div>
        ${num('capacity', 'Nombre de places', 2, 40)}
      </section>

      <section class="card form-grid">
        <h2>Lieux</h2>
        ${txt('location', 'Lieu habituel', 120, 'Utilisé par défaut pour chaque nouveau match.')}
        <label class="field"><span>Autres lieux</span><textarea class="input" name="other_venues" placeholder="Un lieu par ligne">${esc(others.join('\n'))}</textarea><small>Proposés en un tap quand tu changes le lieu d'un match.</small></label>
      </section>

      <section class="card form-grid">
        <h2>Rappels</h2>
        ${num('open_days_before', 'Ouverture des inscriptions', 1, 14, 'Nombre de jours avant le match. Le match est créé automatiquement à ce moment-là.')}
        <label class="switch"><span>Prévenir tout le monde à l'ouverture</span><input type="checkbox" name="remind_open" ${String(s.remind_open) === '1' ? 'checked' : ''}></label>
        <label class="switch"><span>Prévenir organisateurs et capitaines à chaque inscription</span><input type="checkbox" name="notify_staff_signups" ${String(s.notify_staff_signups) === '1' ? 'checked' : ''}></label>
        ${num('remind_unregistered_hours', 'Relance des non-inscrits', 0, 168, "Heures avant le match, seulement s'il reste des places. 0 pour ne jamais relancer.")}
        ${num('remind_confirmed_hours', 'Rappel aux joueurs', 0, 72, 'Heures avant le match. 0 pour désactiver.')}
      </section>

      <section class="card form-grid">
        <h2>Équipes et vote</h2>
        <div class="row-2">${txt('team_a_name', 'Équipe A', 20)}${txt('team_b_name', 'Équipe B', 20)}</div>
        ${num('mvp_vote_hours', "Durée du vote pour l'homme du match", 1, 168, 'En heures après le coup d’envoi.')}
      </section>

      <section class="card form-grid">
        <h2>Groupe</h2>
        ${txt('group_name', 'Nom du groupe', 40)}
        ${txt('invite_code', "Code d'invitation", 32, 'Change-le pour bloquer les nouvelles inscriptions avec l’ancien lien.')}
        <input type="hidden" name="timezone" value="${esc(s.timezone)}">
      </section>
      <button class="btn btn-primary btn-block" type="submit">Enregistrer les réglages</button>
    </form>

    <section class="card stack">
      <h2>Match hors créneau</h2>
      <p class="muted">Un match en plus du jeudi habituel. Tout le monde est prévenu à la création.</p>
      <button class="btn btn-block" data-action="create-match">Créer un match</button>
    </section>

    <div class="section-head"><h2>Joueurs</h2><span class="muted">${users.filter((u) => u.active).length} actifs</span></div>
    <ul class="list card card-tight">${users
      .map(
        (u) => `<li><button class="row" data-action="manage-user" data-user="${esc(JSON.stringify(u))}">
        <span class="av av-sm" aria-hidden="true">${esc(initials(u.name))}</span>
        <span class="grow"><span class="title">${esc(u.name)} ${u.role === 'admin' ? '<span class="chip chip-dark">orga</span>' : u.role === 'captain' ? '<span class="chip chip-open">capitaine</span>' : ''}${u.active ? '' : ' <span class="chip">inactif</span>'}</span>
        <span class="sub">Niveau ${u.level}, indice ${u.elo}, ${plural(u.games, 'match', 'matchs')}${u.devices ? `, ${plural(u.devices, 'appareil')} notifié${u.devices > 1 ? 's' : ''}` : ', pas de notifications'}</span></span>
        ${ICON.chevron}</button></li>`,
      )
      .join('')}</ul>`;
}

// ---------- Connexion / inscription ----------
async function viewLogin() {
  view.innerHTML = `<section class="auth">
    <div><h1>${esc(state.group.name)}</h1><p class="lead">Connecte-toi pour t'inscrire au prochain match.</p></div>
    <form data-form="login" class="card form-grid">
      <label class="field"><span>Prénom ou email</span><input class="input" name="login" autocomplete="username" required></label>
      <label class="field"><span>Mot de passe</span><input class="input" type="password" name="password" autocomplete="current-password" required></label>
      <p class="error" data-error hidden></p>
      <button class="btn btn-dark btn-block" type="submit">Me connecter</button>
    </form>
    <div class="small muted">
      <p>Pas encore de compte ? <a href="#/inscription">Crée-le avec le code d'invitation</a>.</p>
      <p style="margin-top:6px">Mot de passe oublié : demande à un organisateur de t'en générer un nouveau.</p>
    </div>
  </section>`;
}

async function viewRegister(_, query) {
  const first = !state.hasUsers;
  view.innerHTML = `<section class="auth">
    <div><h1>${esc(state.group.name)}</h1>
      <p class="lead">${first ? "Premier compte : tu deviens organisateur. Le code d'invitation s'affiche dans les logs du serveur." : 'Crée ton compte avec le code envoyé par un organisateur.'}</p></div>
    <form data-form="register" class="card form-grid">
      <label class="field"><span>Prénom ou pseudo</span><input class="input" name="name" required minlength="2" maxlength="30" autocomplete="nickname"><small>C'est le nom que verront les autres.</small></label>
      <label class="field"><span>Email</span><input class="input" type="email" name="email" autocomplete="email" placeholder="facultatif"><small>${state.emailEnabled ? 'Pour recevoir les rappels par email.' : 'Pour te connecter avec ton email.'}</small></label>
      <label class="field"><span>Mot de passe</span><input class="input" type="password" name="password" required minlength="6" autocomplete="new-password"></label>
      <fieldset class="field">
        <legend>Ton niveau</legend>
        <div class="levels">${SELF_LEVELS.map(([v, l]) => `<label class="choice"><input type="radio" name="level" value="${v}" required><span>${l}</span></label>`).join('')}</div>
        <small>Sois honnête : ça sert uniquement à équilibrer les équipes. Il s'ajuste ensuite tout seul selon tes résultats.</small>
      </fieldset>
      <label class="field"><span>Code d'invitation</span><input class="input" name="inviteCode" required autocomplete="off" value="${esc(query.get('code') || '')}"></label>
      <p class="error" data-error hidden></p>
      <button class="btn btn-dark btn-block" type="submit">Créer mon compte</button>
    </form>
    ${first ? '' : '<p class="small muted">Déjà un compte ? <a href="#/connexion">Connecte-toi</a>.</p>'}
  </section>`;
}

// ---------- Démarrage ----------
async function loadMe() {
  const r = await api('GET', '/api/me');
  state.me = r.user;
  state.group = r.group;
  state.vapid = r.vapidPublicKey;
  state.emailEnabled = r.emailEnabled;
  state.hasUsers = r.hasUsers;
  document.title = r.group.name;
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.installPrompt = e;
  if (current.path === '/bienvenue') render();
});
window.addEventListener('appinstalled', () => {
  state.installPrompt = null;
  if (current.path === '/bienvenue') render();
});

window.addEventListener('hashchange', () => {
  if (!sheetEl.hidden) closeSheet();
  view.innerHTML = '';
  window.scrollTo(0, 0);
  render();
});

// Rafraîchit le match quand on revient sur l'app (ex. après une notification)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.me && sheetEl.hidden && (current.path === '/' || current.path.startsWith('/match/'))) render();
});

(async function start() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    await loadMe();
  } catch {
    view.innerHTML = '<div class="card empty"><h2>Serveur injoignable</h2><p>Vérifie ta connexion puis recharge la page.</p></div>';
    return;
  }
  if (state.me) syncPushSubscription();
  render();
})();
