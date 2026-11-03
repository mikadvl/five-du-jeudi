// Gabarit HTML des emails (styles en ligne, mise en page en tableaux : compatible Gmail, Outlook, Apple Mail).

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** Libellé du bouton selon le lien de la notif. */
function ctaLabel(url = '') {
  if (url.includes('/match/')) return 'Voir le match';
  if (url.includes('/admin')) return "Ouvrir l'organisation";
  return "Ouvrir l'app";
}

export function renderEmail({ groupName, title, body, link, appUrl }) {
  const base = (appUrl || '').replace(/\/$/, '');
  const icon = base ? `${base}/icons/icon-192.png` : '';
  const profile = base ? `${base}/#/profil` : '';
  const cta = link
    ? `<tr><td style="padding:8px 32px 32px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="border-radius:999px;background:#101814">
            <a href="${esc(link)}" style="display:inline-block;padding:14px 28px;font:600 15px ${FONT};color:#ffffff;text-decoration:none;border-radius:999px">${ctaLabel(link)}</a>
          </td>
        </tr></table>
      </td></tr>`
    : '';

  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f2f4f3">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(body)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f2f4f3">
  <tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px">
      <tr><td style="padding:0 8px 16px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          ${icon ? `<td style="padding-right:10px"><img src="${esc(icon)}" width="32" height="32" alt="" style="display:block;border-radius:8px"></td>` : ''}
          <td style="font:600 15px ${FONT};color:#5e6a64">${esc(groupName)}</td>
        </tr></table>
      </td></tr>
      <tr><td style="background:#ffffff;border-radius:24px;border-top:6px solid #ff6b1a">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="padding:28px 32px 8px;font:800 26px/1.15 ${FONT};color:#101814;letter-spacing:-0.3px">${esc(title)}</td></tr>
          <tr><td style="padding:4px 32px 20px;font:400 16px/1.5 ${FONT};color:#3d4842">${esc(body)}</td></tr>
          ${cta}
        </table>
      </td></tr>
      <tr><td style="padding:18px 16px 0;font:400 12.5px/1.5 ${FONT};color:#7a8580;text-align:center">
        Tu reçois ce mail parce que tu joues au ${esc(groupName)}.<br>
        ${profile ? `<a href="${esc(profile)}" style="color:#5e6a64">Couper les rappels par email</a> dans ton profil.` : 'Tu peux couper les rappels par email dans ton profil.'}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = [title, '', body, link ? `\n${ctaLabel(link)} : ${link}` : '', '', `-- ${groupName}`, profile ? `Couper les rappels par email : ${profile}` : '']
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n')
    .trim();

  return { html, text };
}
