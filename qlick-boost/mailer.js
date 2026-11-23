// Envoi d'emails transactionnels via l'API Brevo (ex-Sendinblue, service français).
// Sans BREVO_API_KEY, les emails ne sont pas envoyés : ils sont seulement affichés dans les journaux.
const API_URL = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email';
const FROM_EMAIL = process.env.MAIL_FROM || 'noreply@qlick.fr';
const FROM_NAME = process.env.MAIL_FROM_NAME || 'Qlick Boost';

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// gabarit HTML simple, aux couleurs du commerce
function layout({ title, body, color = '#8B5CF6', footer = '' }) {
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#F5F3FF;font-family:Arial,Helvetica,sans-serif;color:#1A1033">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:16px;overflow:hidden">
<tr><td style="background:${color};height:6px"></td></tr>
<tr><td style="padding:28px 28px 8px"><h1 style="font-size:20px;margin:0 0 14px">${escapeHtml(title)}</h1>${body}</td></tr>
<tr><td style="padding:18px 28px 26px;font-size:12px;color:#6B6390">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

async function sendMail({ to, subject, html, replyTo, fromName }) {
  if (!to) return { sent: false, reason: 'destinataire manquant' };
  if (!process.env.BREVO_API_KEY) {
    console.log(`[email non envoyé : BREVO_API_KEY absente] à ${to} — ${subject}`);
    return { sent: false, reason: 'BREVO_API_KEY absente' };
  }
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: FROM_EMAIL, name: fromName || FROM_NAME },
        to: [{ email: to }],
        ...(replyTo ? { replyTo: { email: replyTo } } : {}),
        subject, htmlContent: html,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[email] échec ${res.status} vers ${to} : ${(await res.text()).slice(0, 200)}`);
      return { sent: false, reason: `Brevo ${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    console.error(`[email] erreur vers ${to} : ${e.message}`);
    return { sent: false, reason: e.message };
  }
}

module.exports = { sendMail, layout, escapeHtml, enabled: () => !!process.env.BREVO_API_KEY };
