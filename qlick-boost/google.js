// Connexion à Google Business Profile (ex-Google My Business) :
// récupération des avis publiés sur Google et publication des réponses.
//
// Prérequis : un projet Google Cloud avec les API Business Profile activées
// (accès à demander à Google), et un identifiant OAuth « Application Web ».
// Variables : GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
const crypto = require('crypto');

const ENDPOINTS = {
  auth: process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
  token: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  accounts: process.env.GBP_ACCOUNTS_API || 'https://mybusinessaccountmanagement.googleapis.com',
  info: process.env.GBP_INFO_API || 'https://mybusinessbusinessinformation.googleapis.com',
  reviews: process.env.GBP_REVIEWS_API || 'https://mybusiness.googleapis.com',
};
const SCOPE = 'https://www.googleapis.com/auth/business.manage';
const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

const configured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

// le jeton d'accès longue durée est chiffré avant d'être enregistré (AES-256-GCM)
function key(secret) { return crypto.createHash('sha256').update('google-token:' + secret).digest(); }
function encrypt(text, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(secret), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}
function decrypt(payload, secret) {
  const [iv, tag, enc] = payload.split('.').map((s) => Buffer.from(s, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(secret), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

function authUrl(redirectUri, state) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return `${ENDPOINTS.auth}?${p}`;
}

async function tokenRequest(params) {
  const res = await fetch(ENDPOINTS.token, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google OAuth : ${data.error_description || data.error || res.status}`);
  return data;
}
const exchangeCode = (code, redirectUri) => tokenRequest({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' });
async function accessToken(refreshToken) {
  return (await tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' })).access_token;
}

async function gapi(token, url, opts = {}) {
  const res = await fetch(url, {
    ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...opts.headers },
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || res.status;
    const err = new Error(res.status === 403 || res.status === 429
      ? `Google refuse l'accès (${msg}). Vérifiez que l'accès aux API Business Profile a été accordé à votre projet Google Cloud.`
      : `Google : ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// toutes les fiches (établissements) accessibles par le compte connecté
async function listLocations(token) {
  const { accounts = [] } = await gapi(token, `${ENDPOINTS.accounts}/v1/accounts`);
  const out = [];
  for (const a of accounts) {
    const { locations = [] } = await gapi(token, `${ENDPOINTS.info}/v1/${a.name}/locations?readMask=name,title,storefrontAddress&pageSize=100`);
    for (const l of locations) {
      const city = l.storefrontAddress?.locality ? ` — ${l.storefrontAddress.locality}` : '';
      out.push({ path: `${a.name}/${l.name}`, title: `${l.title || l.name}${city}` });
    }
  }
  return out;
}

async function listReviews(token, locationPath) {
  const data = await gapi(token, `${ENDPOINTS.reviews}/v4/${locationPath}/reviews?pageSize=50&orderBy=updateTime%20desc`);
  return {
    averageRating: data.averageRating ?? null,
    total: data.totalReviewCount ?? 0,
    reviews: (data.reviews || []).map((r) => ({
      id: r.reviewId, author: r.reviewer?.isAnonymous ? 'Anonyme' : r.reviewer?.displayName || 'Anonyme',
      photo: r.reviewer?.profilePhotoUrl || null, rating: STARS[r.starRating] || null,
      comment: r.comment || '', createdAt: r.createTime, reply: r.reviewReply?.comment || null, repliedAt: r.reviewReply?.updateTime || null,
    })),
  };
}

async function replyToReview(token, locationPath, reviewId, comment) {
  if (!/^[\w-]+$/.test(reviewId)) throw Object.assign(new Error('Avis invalide'), { status: 400 });
  return gapi(token, `${ENDPOINTS.reviews}/v4/${locationPath}/reviews/${reviewId}/reply`, { method: 'PUT', body: JSON.stringify({ comment }) });
}

module.exports = { configured, authUrl, exchangeCode, accessToken, listLocations, listReviews, replyToReview, encrypt, decrypt };
