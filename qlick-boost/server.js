// Qlick Boost — serveur principal
// Roue de la fortune gamifiée : le client scanne un QR code, laisse un avis
// Google (ou suit le compte Instagram), tourne la roue et reçoit un bon cadeau.
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const QRCode = require('qrcode');
const db = require('./db');
const { generateReviewReply } = require('./ai');

const app = express();
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const SECRET = process.env.QLICK_SECRET || 'dev-secret-change-me';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECURE_COOKIE = BASE_URL.startsWith('https://');
const DEMO = process.env.QLICK_DEMO === '1' || !PROD;

if (PROD) {
  const missing = [];
  if (!process.env.QLICK_SECRET || process.env.QLICK_SECRET.length < 32) missing.push('QLICK_SECRET (32 caractères minimum)');
  if (!process.env.BASE_URL) missing.push('BASE_URL');
  if (missing.length) {
    console.error(`Configuration de production incomplète : ${missing.join(', ')}`);
    process.exit(1);
  }
}

// derrière l'hébergeur (Render, Railway, Nginx…) : IP réelle et HTTPS
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (SECURE_COOKIE) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.get('/healthz', (req, res) => res.json({ ok: true }));
const SIGNUP_CODE = process.env.QLICK_SIGNUP_CODE || '';
app.get('/api/config', (req, res) => res.json({ demo: DEMO, inviteRequired: !!SIGNUP_CODE }));
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------- utilitaires ----------
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function unsign(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (payload.exp && payload.exp < Date.now()) return null;
  return payload;
}

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function setCookie(res, name, value, maxAgeSec) {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${SECURE_COOKIE ? '; Secure' : ''}`);
}

function slugify(s) {
  return s.toString().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'commerce';
}

function couponCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = 'QLK-';
  for (let i = 0; i < 6; i++) c += alphabet[crypto.randomInt(alphabet.length)];
  return c;
}

const DEFAULT_PRIZES = [
  { label: 'Café offert', color: '#8B5CF6', weight: 30, stock: null, kind: 'win' },
  { label: '-10% sur l\'addition', color: '#D946EF', weight: 25, stock: null, kind: 'win' },
  { label: 'Perdu… retentez !', color: '#B3AACF', weight: 25, stock: null, kind: 'lose' },
  { label: 'Dessert offert', color: '#6D28D9', weight: 12, stock: null, kind: 'win' },
  { label: 'Boisson offerte', color: '#C026D3', weight: 7, stock: null, kind: 'win' },
  { label: 'Repas offert', color: '#110824', weight: 1, stock: 5, kind: 'win' },
];

// ---------- auth ----------
function requireAuth(req, res, next) {
  const s = unsign(getCookie(req, 'qlick_session'));
  if (!s) return res.status(401).json({ error: 'Non connecté' });
  const data = db.load();
  const user = data.users.find((u) => u.id === s.uid);
  if (!user) return res.status(401).json({ error: 'Session invalide' });
  req.user = user;
  req.business = data.businesses.find((b) => b.ownerId === user.id);
  next();
}

function createBusinessFor(user, name) {
  const data = db.load();
  let slug = slugify(name);
  while (data.businesses.some((b) => b.slug === slug)) slug = `${slugify(name)}-${crypto.randomInt(1000, 9999)}`;
  const business = {
    id: uid(), ownerId: user.id, name, slug, createdAt: now(),
    googleReviewUrl: '', instagramUrl: '', primaryColor: '#8B5CF6',
    welcomeText: `Tentez votre chance chez ${name} !`,
    actions: { google: true, instagram: false, none: false },
    cooldownDays: 30, couponValidityDays: 30, minDelayHours: 0,
    collectPhone: false, plan: 'trial',
  };
  data.businesses.push(business);
  DEFAULT_PRIZES.forEach((p) => data.prizes.push({ id: uid(), businessId: business.id, ...p, active: true }));
  db.save();
  return business;
}

app.post('/api/auth/signup', (req, res) => {
  const { email, password, businessName, inviteCode } = req.body || {};
  if (SIGNUP_CODE && String(inviteCode || '').trim() !== SIGNUP_CODE) return res.status(403).json({ error: 'Code d\'invitation invalide. Contactez Qlick : contact@qlick.fr' });
  if (!email || !password || !businessName) return res.status(400).json({ error: 'Champs requis : email, mot de passe, nom du commerce' });
  if (password.length < 8) return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum' });
  const data = db.load();
  const e = email.trim().toLowerCase();
  if (data.users.some((u) => u.email === e)) return res.status(409).json({ error: 'Un compte existe déjà avec cet email' });
  const user = { id: uid(), email: e, password: hashPassword(password), createdAt: now() };
  data.users.push(user);
  createBusinessFor(user, businessName.trim());
  setCookie(res, 'qlick_session', sign({ uid: user.id, exp: Date.now() + 7 * 864e5 }), 7 * 86400);
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const data = db.load();
  const user = data.users.find((u) => u.email === String(email || '').trim().toLowerCase());
  if (!user || !verifyPassword(String(password || ''), user.password)) return res.status(401).json({ error: 'Identifiants incorrects' });
  setCookie(res, 'qlick_session', sign({ uid: user.id, exp: Date.now() + 7 * 864e5 }), 7 * 86400);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  setCookie(res, 'qlick_session', '', 0);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ email: req.user.email, business: req.business, playUrl: `${BASE_URL}/play/${req.business.slug}` });
});

// ---------- configuration du commerce ----------
const EDITABLE = ['name', 'googleReviewUrl', 'instagramUrl', 'primaryColor', 'welcomeText', 'cooldownDays', 'couponValidityDays', 'minDelayHours', 'collectPhone', 'actions'];
app.put('/api/business', requireAuth, (req, res) => {
  const b = req.business;
  for (const k of EDITABLE) if (k in req.body) b[k] = req.body[k];
  b.cooldownDays = Math.max(0, Number(b.cooldownDays) || 0);
  b.couponValidityDays = Math.max(1, Number(b.couponValidityDays) || 30);
  b.minDelayHours = Math.max(0, Number(b.minDelayHours) || 0);
  db.save();
  res.json(b);
});

// ---------- lots ----------
app.get('/api/prizes', requireAuth, (req, res) => {
  res.json(db.load().prizes.filter((p) => p.businessId === req.business.id));
});

app.put('/api/prizes', requireAuth, (req, res) => {
  const list = Array.isArray(req.body) ? req.body : [];
  if (list.length < 2 || list.length > 12) return res.status(400).json({ error: 'La roue doit contenir entre 2 et 12 segments' });
  const data = db.load();
  data.prizes = data.prizes.filter((p) => p.businessId !== req.business.id);
  for (const p of list) {
    data.prizes.push({
      id: p.id || uid(), businessId: req.business.id,
      label: String(p.label || 'Lot').slice(0, 40),
      color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#8B5CF6',
      weight: Math.max(0, Number(p.weight) || 0),
      stock: p.stock === null || p.stock === '' || p.stock === undefined ? null : Math.max(0, parseInt(p.stock, 10) || 0),
      kind: p.kind === 'lose' ? 'lose' : 'win',
      active: p.active !== false,
    });
  }
  db.save();
  res.json(data.prizes.filter((p) => p.businessId === req.business.id));
});

// ---------- statistiques ----------
app.get('/api/stats', requireAuth, (req, res) => {
  const data = db.load();
  const parts = data.participations.filter((p) => p.businessId === req.business.id);
  const days = 30;
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    series.push({ date: d, count: parts.filter((p) => p.createdAt.slice(0, 10) === d).length });
  }
  const byPrize = {};
  parts.forEach((p) => { byPrize[p.prizeLabel] = (byPrize[p.prizeLabel] || 0) + 1; });
  const byAction = {};
  parts.forEach((p) => { byAction[p.action] = (byAction[p.action] || 0) + 1; });
  res.json({
    totalParticipations: parts.length,
    googleReviews: parts.filter((p) => p.action === 'google').length,
    instagramFollows: parts.filter((p) => p.action === 'instagram').length,
    winners: parts.filter((p) => p.kind === 'win').length,
    redeemed: parts.filter((p) => p.redeemedAt).length,
    contacts: new Set(parts.map((p) => p.email)).size,
    optins: new Set(parts.filter((p) => p.marketingOptIn).map((p) => p.email)).size,
    series, byPrize, byAction,
  });
});

// ---------- participants / CRM ----------
app.get('/api/participations', requireAuth, (req, res) => {
  const list = db.load().participations.filter((p) => p.businessId === req.business.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(list);
});

app.get('/api/participations.csv', requireAuth, (req, res) => {
  const list = db.load().participations.filter((p) => p.businessId === req.business.id);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['date', 'prenom', 'email', 'telephone', 'action', 'lot', 'code', 'utilise_le', 'optin_marketing']]
    .concat(list.map((p) => [p.createdAt, p.firstName, p.email, p.phone, p.action, p.prizeLabel, p.code, p.redeemedAt, p.marketingOptIn]));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="qlick-contacts-${req.business.slug}.csv"`);
  res.send('﻿' + rows.map((r) => r.map(esc).join(';')).join('\n'));
});

// ---------- validation des gains en caisse ----------
app.post('/api/redeem', requireAuth, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const data = db.load();
  const p = data.participations.find((x) => x.code === code && x.businessId === req.business.id);
  if (!p) return res.status(404).json({ error: 'Code introuvable' });
  if (p.kind !== 'win') return res.status(400).json({ error: 'Ce code ne correspond à aucun gain' });
  if (p.redeemedAt) return res.status(409).json({ error: `Déjà utilisé le ${new Date(p.redeemedAt).toLocaleString('fr-FR')}`, participation: p });
  if (p.validFrom && new Date(p.validFrom) > new Date()) return res.status(400).json({ error: `Utilisable à partir du ${new Date(p.validFrom).toLocaleString('fr-FR')}` });
  if (new Date(p.expiresAt) < new Date()) return res.status(410).json({ error: 'Bon expiré', participation: p });
  if (req.body.confirm) {
    p.redeemedAt = now();
    db.save();
  }
  res.json({ ok: true, participation: p, redeemed: !!req.body.confirm });
});

// ---------- QR code ----------
app.get('/api/qrcode.png', requireAuth, async (req, res) => {
  const url = `${BASE_URL}/play/${req.business.slug}?src=qr`;
  const png = await QRCode.toBuffer(url, { width: Number(req.query.size) || 600, margin: 2, color: { dark: '#110824', light: '#FFFFFF' } });
  res.type('png').send(png);
});

// ---------- IA : réponses aux avis ----------
app.get('/api/reviews', requireAuth, (req, res) => {
  res.json(db.load().reviews.filter((r) => r.businessId === req.business.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.post('/api/reviews/reply', requireAuth, async (req, res) => {
  const { author, rating, text, tone, signature } = req.body || {};
  if (!text && !rating) return res.status(400).json({ error: 'Avis requis' });
  try {
    const reply = await generateReviewReply({
      businessName: req.business.name, author, rating: Number(rating) || 5, text: text || '', tone: tone || 'chaleureux', signature,
    });
    const data = db.load();
    const review = { id: uid(), businessId: req.business.id, author, rating, text, tone, reply: reply.text, source: reply.source, createdAt: now() };
    data.reviews.push(review);
    db.save();
    res.json(review);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'Génération impossible pour le moment' });
  }
});

// ---------- API publique (côté client final) ----------
function publicBusiness(slug) {
  const data = db.load();
  const b = data.businesses.find((x) => x.slug === slug);
  if (!b) return null;
  const prizes = data.prizes.filter((p) => p.businessId === b.id && p.active);
  return { b, prizes };
}

app.get('/api/public/:slug', (req, res) => {
  const r = publicBusiness(req.params.slug);
  if (!r) return res.status(404).json({ error: 'Commerce introuvable' });
  const { b, prizes } = r;
  res.json({
    name: b.name, primaryColor: b.primaryColor, welcomeText: b.welcomeText,
    googleReviewUrl: b.googleReviewUrl, instagramUrl: b.instagramUrl, actions: b.actions, collectPhone: b.collectPhone,
    // les poids (probabilités) ne sont jamais exposés au client
    segments: prizes.map((p) => ({ id: p.id, label: p.label, color: p.color })),
  });
});

// tirage pondéré côté serveur, en excluant les lots épuisés
function drawPrize(prizes) {
  const pool = prizes.filter((p) => p.weight > 0 && (p.stock === null || p.stock > 0));
  const total = pool.reduce((s, p) => s + p.weight, 0);
  if (!total) return prizes.find((p) => p.kind === 'lose') || prizes[0];
  let r = crypto.randomInt(1_000_000) / 1_000_000 * total;
  for (const p of pool) { if ((r -= p.weight) < 0) return p; }
  return pool[pool.length - 1];
}

const spinAttempts = new Map(); // anti-spam IP simple
app.post('/api/public/:slug/spin', (req, res) => {
  const r = publicBusiness(req.params.slug);
  if (!r) return res.status(404).json({ error: 'Commerce introuvable' });
  const { b, prizes } = r;
  const { firstName, email, phone, action, marketingOptIn, consent } = req.body || {};

  const ip = req.ip;
  const key = `${b.id}:${ip}`;
  const hits = (spinAttempts.get(key) || []).filter((t) => t > Date.now() - 3600e3);
  if (hits.length >= 10) return res.status(429).json({ error: 'Trop de tentatives, réessayez plus tard' });
  spinAttempts.set(key, [...hits, Date.now()]);

  const mail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return res.status(400).json({ error: 'Email invalide' });
  if (!firstName) return res.status(400).json({ error: 'Prénom requis' });
  if (!consent) return res.status(400).json({ error: 'Veuillez accepter le règlement du jeu' });
  if (!['google', 'instagram', 'none'].includes(action) || !b.actions[action]) return res.status(400).json({ error: 'Action non disponible' });

  const data = db.load();
  // une participation par email / appareil sur la période de cooldown
  const device = getCookie(req, 'qlick_device') || uid();
  const since = Date.now() - b.cooldownDays * 864e5;
  const already = data.participations.find((p) => p.businessId === b.id && (p.email === mail || p.device === device) && new Date(p.createdAt).getTime() > since);
  if (already && b.cooldownDays > 0) {
    const next = new Date(new Date(already.createdAt).getTime() + b.cooldownDays * 864e5).toLocaleDateString('fr-FR');
    return res.status(409).json({ error: `Vous avez déjà joué ! Prochaine participation possible le ${next}.`, code: already.kind === 'win' ? already.code : null });
  }

  const prize = drawPrize(prizes);
  if (prize.stock !== null && prize.kind === 'win') prize.stock -= 1;
  const created = new Date();
  const participation = {
    id: uid(), businessId: b.id, createdAt: created.toISOString(),
    firstName: String(firstName).slice(0, 60), email: mail, phone: phone ? String(phone).slice(0, 30) : '',
    action, marketingOptIn: !!marketingOptIn, device, source: req.query.src || 'direct',
    prizeId: prize.id, prizeLabel: prize.label, kind: prize.kind,
    code: couponCode(),
    validFrom: new Date(created.getTime() + b.minDelayHours * 3600e3).toISOString(),
    expiresAt: new Date(created.getTime() + b.couponValidityDays * 864e5).toISOString(),
    redeemedAt: null,
  };
  data.participations.push(participation);
  db.save();
  setCookie(res, 'qlick_device', device, 365 * 86400);

  res.json({
    segmentId: prize.id, label: prize.label, kind: prize.kind,
    code: participation.kind === 'win' ? participation.code : null,
    couponUrl: participation.kind === 'win' ? `${BASE_URL}/coupon/${participation.code}` : null,
    validFrom: participation.validFrom, expiresAt: participation.expiresAt,
  });
});

app.get('/api/public/coupon/:code', (req, res) => {
  const data = db.load();
  const p = data.participations.find((x) => x.code === req.params.code.toUpperCase());
  if (!p || p.kind !== 'win') return res.status(404).json({ error: 'Bon introuvable' });
  const b = data.businesses.find((x) => x.id === p.businessId);
  res.json({ business: b.name, primaryColor: b.primaryColor, firstName: p.firstName, label: p.prizeLabel, code: p.code, validFrom: p.validFrom, expiresAt: p.expiresAt, redeemedAt: p.redeemedAt });
});

app.get('/api/public/coupon/:code/qrcode.png', async (req, res) => {
  const png = await QRCode.toBuffer(req.params.code.toUpperCase(), { width: 300, margin: 1 });
  res.type('png').send(png);
});

// ---------- pages ----------
app.get('/play/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'play.html')));
app.get('/coupon/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'coupon.html')));

process.on('SIGINT', () => { db.flush(); process.exit(0); });
process.on('SIGTERM', () => { db.flush(); process.exit(0); });

if (require.main === module) {
  if (DEMO) require('./seed').seedDemo();
  app.listen(PORT, () => console.log(`Qlick Boost démarré sur ${BASE_URL}${PROD ? ' (production)' : ''}`));
}
module.exports = app;
