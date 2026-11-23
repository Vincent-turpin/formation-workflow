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
app.get('/api/config', (req, res) => res.json({ demo: DEMO && !process.env.QLICK_DEMO_PASSWORD, inviteRequired: !!SIGNUP_CODE }));
app.use(express.json({ limit: '1mb' }));
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

// actions proposées avant de jouer (ordre = séquence suggérée visite après visite)
const SOCIAL_ACTIONS = ['google', 'instagram', 'tiktok', 'facebook'];
const ACTION_URL = { google: 'googleReviewUrl', instagram: 'instagramUrl', tiktok: 'tiktokUrl', facebook: 'facebookUrl' };
const actionAvailable = (b, a) => !!b.actions?.[a] && (a === 'none' || !!b[ACTION_URL[a]]);
const newPin = () => String(crypto.randomInt(0, 1e6)).padStart(6, '0');

// fonctionnalités par offre (voir la page Tarifs)
const PLANS = {
  trial: { label: 'Essai 14 jours', ai: true, csv: true },
  essentiel: { label: 'Essentiel', ai: false, csv: false },
  pro: { label: 'Pro', ai: true, csv: true },
  reseau: { label: 'Réseau & sur-mesure', ai: true, csv: true },
};
const planOf = (b) => PLANS[b?.plan] || PLANS.trial;

// comptes administrateurs Qlick : définis par QLICK_ADMIN_EMAIL / QLICK_ADMIN_PASSWORD
function ensureAdmin() {
  const email = (process.env.QLICK_ADMIN_EMAIL || (PROD ? '' : 'admin@qlick.fr')).trim().toLowerCase();
  const password = process.env.QLICK_ADMIN_PASSWORD || (PROD ? '' : 'admin1234');
  if (!email || !password) {
    if (PROD) console.warn('Aucun administrateur Qlick : définissez QLICK_ADMIN_EMAIL et QLICK_ADMIN_PASSWORD.');
    return;
  }
  const data = db.load();
  let u = data.users.find((x) => x.email === email);
  if (!u) {
    u = { id: uid(), email, password: hashPassword(password), createdAt: now(), role: 'admin' };
    data.users.push(u);
    console.log(`Administrateur Qlick créé : ${email}`);
  } else {
    if (u.role !== 'admin') u.role = 'admin';
    // le mot de passe défini dans la configuration fait foi (utile pour le réinitialiser)
    if (!verifyPassword(password, u.password)) { u.password = hashPassword(password); console.log(`Mot de passe administrateur mis à jour : ${email}`); }
  }
  db.save();
}

function migrate() {
  const data = db.load();
  for (const b of data.businesses) {
    if (!b.staffPin) b.staffPin = newPin();
    b.actions = { google: false, instagram: false, tiktok: false, facebook: false, none: false, ...b.actions };
    for (const k of Object.values(ACTION_URL)) b[k] ??= '';
  }
  db.save();
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
  req.session = s;
  req.business = data.businesses.find((b) => b.ownerId === user.id);
  next();
}
function requireBusiness(req, res, next) {
  if (!req.business) return res.status(403).json({ error: 'Aucun établissement lié à ce compte' });
  next();
}
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Réservé à l\'équipe Qlick' });
  next();
}
function requirePlan(feature) {
  return (req, res, next) => {
    if (!planOf(req.business)[feature]) return res.status(402).json({ error: 'Fonctionnalité incluse dans l\'offre Pro. Contactez Qlick pour changer d\'offre.' });
    next();
  };
}
const startSession = (res, payload) => setCookie(res, 'qlick_session', sign({ ...payload, exp: Date.now() + 7 * 864e5 }), 7 * 86400);

function createBusinessFor(user, name) {
  const data = db.load();
  let slug = slugify(name);
  while (data.businesses.some((b) => b.slug === slug)) slug = `${slugify(name)}-${crypto.randomInt(1000, 9999)}`;
  const business = {
    id: uid(), ownerId: user.id, name, slug, createdAt: now(),
    googleReviewUrl: '', instagramUrl: '', tiktokUrl: '', facebookUrl: '', primaryColor: '#8B5CF6', staffPin: newPin(),
    welcomeText: `Tentez votre chance chez ${name} !`,
    actions: { google: true, instagram: false, tiktok: false, facebook: false, none: true },
    cooldownDays: 30, couponValidityDays: 30, minDelayHours: 0,
    collectPhone: false, plan: 'trial', active: true,
    logo: null, winText: 'Félicitations !', loseText: 'Pas de chance cette fois… Merci pour votre participation, retentez votre chance lors de votre prochaine visite !',
    rulesText: '', notes: '',
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
  startSession(res, { uid: user.id });
  res.json({ ok: true, redirect: '/dashboard' });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const data = db.load();
  const user = data.users.find((u) => u.email === String(email || '').trim().toLowerCase());
  if (!user || !verifyPassword(String(password || ''), user.password)) return res.status(401).json({ error: 'Identifiants incorrects' });
  startSession(res, { uid: user.id });
  res.json({ ok: true, redirect: user.role === 'admin' ? '/admin' : '/dashboard' });
});

app.post('/api/auth/password', requireAuth, (req, res) => {
  const { current, next } = req.body || {};
  if (req.session.as) return res.status(403).json({ error: 'Impossible en mode « connecté en tant que »' });
  if (!verifyPassword(String(current || ''), req.user.password)) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
  if (String(next || '').length < 8) return res.status(400).json({ error: 'Nouveau mot de passe : 8 caractères minimum' });
  req.user.password = hashPassword(String(next));
  db.save();
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  setCookie(res, 'qlick_session', '', 0);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  const b = req.business;
  res.json({
    email: req.user.email, role: req.user.role || 'client', impersonating: !!req.session.as,
    business: b || null, plan: b ? { id: b.plan, ...planOf(b) } : null,
    playUrl: b ? `${BASE_URL}/play/${b.slug}` : null,
  });
});

// ---------- configuration du commerce ----------
const EDITABLE = ['name', 'googleReviewUrl', 'instagramUrl', 'tiktokUrl', 'facebookUrl', 'primaryColor', 'welcomeText', 'cooldownDays', 'couponValidityDays', 'minDelayHours', 'collectPhone', 'actions', 'winText', 'loseText', 'rulesText'];
const TEXT_LIMITS = { name: 80, welcomeText: 200, winText: 120, loseText: 300, rulesText: 8000, googleReviewUrl: 500, instagramUrl: 500, tiktokUrl: 500, facebookUrl: 500 };
app.put('/api/business', requireAuth, requireBusiness, (req, res) => {
  const b = req.business;
  for (const k of EDITABLE) if (k in req.body) b[k] = req.body[k];
  for (const [k, max] of Object.entries(TEXT_LIMITS)) b[k] = String(b[k] ?? '').slice(0, max);
  if (!/^#[0-9a-f]{6}$/i.test(b.primaryColor)) b.primaryColor = '#8B5CF6';
  for (const k of Object.values(ACTION_URL)) if (b[k] && !/^https:\/\//i.test(b[k])) b[k] = '';
  b.actions = Object.fromEntries([...SOCIAL_ACTIONS, 'none'].map((a) => [a, !!b.actions?.[a]]));
  if ('logo' in req.body) {
    const logo = req.body.logo;
    if (logo === null) b.logo = null;
    else if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logo) && logo.length < 400_000) b.logo = logo;
    else return res.status(400).json({ error: 'Logo : PNG, JPG ou WebP de 300 Ko maximum' });
  }
  b.cooldownDays = Math.max(0, Number(b.cooldownDays) || 0);
  b.couponValidityDays = Math.max(1, Number(b.couponValidityDays) || 30);
  b.minDelayHours = Math.max(0, Number(b.minDelayHours) || 0);
  db.save();
  res.json(b);
});

// ---------- lots ----------
app.get('/api/prizes', requireAuth, requireBusiness, (req, res) => {
  res.json(db.load().prizes.filter((p) => p.businessId === req.business.id));
});

app.put('/api/prizes', requireAuth, requireBusiness, (req, res) => {
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
app.get('/api/stats', requireAuth, requireBusiness, (req, res) => {
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
app.get('/api/participations', requireAuth, requireBusiness, (req, res) => {
  const list = db.load().participations.filter((p) => p.businessId === req.business.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(list);
});

app.get('/api/participations.csv', requireAuth, requireBusiness, requirePlan('csv'), (req, res) => {
  const list = db.load().participations.filter((p) => p.businessId === req.business.id);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['date', 'prenom', 'email', 'telephone', 'action', 'lot', 'code', 'utilise_le', 'optin_marketing']]
    .concat(list.map((p) => [p.createdAt, p.firstName, p.email, p.phone, p.action, p.prizeLabel, p.code, p.redeemedAt, p.marketingOptIn]));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="qlick-contacts-${req.business.slug}.csv"`);
  res.send('﻿' + rows.map((r) => r.map(esc).join(';')).join('\n'));
});

// ---------- validation des gains en caisse ----------
app.post('/api/redeem', requireAuth, requireBusiness, (req, res) => {
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
app.get('/api/qrcode.png', requireAuth, requireBusiness, async (req, res) => {
  const url = `${BASE_URL}/play/${req.business.slug}?src=qr`;
  const png = await QRCode.toBuffer(url, { width: Number(req.query.size) || 600, margin: 2, color: { dark: '#110824', light: '#FFFFFF' } });
  res.type('png').send(png);
});

// ---------- IA : réponses aux avis ----------
app.get('/api/reviews', requireAuth, requireBusiness, (req, res) => {
  res.json(db.load().reviews.filter((r) => r.businessId === req.business.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.post('/api/reviews/reply', requireAuth, requireBusiness, requirePlan('ai'), async (req, res) => {
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

// ---------- espace agence Qlick ----------
function businessSummary(b, data) {
  const parts = data.participations.filter((p) => p.businessId === b.id);
  const since = Date.now() - 30 * 864e5;
  const owner = data.users.find((u) => u.id === b.ownerId);
  return {
    id: b.id, name: b.name, slug: b.slug, plan: b.plan, planLabel: planOf(b).label, active: b.active !== false,
    createdAt: b.createdAt, ownerEmail: owner?.email, notes: b.notes || '', configured: SOCIAL_ACTIONS.some((a) => actionAvailable(b, a)),
    participations: parts.length, last30: parts.filter((p) => new Date(p.createdAt).getTime() > since).length,
    googleReviews: parts.filter((p) => p.action === 'google').length,
    lastActivity: parts.reduce((m, p) => (p.createdAt > m ? p.createdAt : m), ''),
    playUrl: `${BASE_URL}/play/${b.slug}`,
  };
}

app.get('/api/admin/clients', requireAuth, requireAdmin, (req, res) => {
  const data = db.load();
  res.json({ plans: PLANS, clients: data.businesses.map((b) => businessSummary(b, data)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
});

function tempPassword() {
  const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 12 }, () => a[crypto.randomInt(a.length)]).join('');
}

app.post('/api/admin/clients', requireAuth, requireAdmin, (req, res) => {
  const { businessName, email, plan, notes } = req.body || {};
  if (!businessName || !email) return res.status(400).json({ error: 'Nom de l\'établissement et email requis' });
  const e = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return res.status(400).json({ error: 'Email invalide' });
  const data = db.load();
  if (data.users.some((u) => u.email === e)) return res.status(409).json({ error: 'Un compte existe déjà avec cet email' });
  const password = tempPassword();
  const user = { id: uid(), email: e, password: hashPassword(password), createdAt: now(), createdBy: req.user.email };
  data.users.push(user);
  const b = createBusinessFor(user, String(businessName).trim().slice(0, 80));
  if (PLANS[plan]) b.plan = plan;
  b.notes = String(notes || '').slice(0, 1000);
  db.save();
  res.json({ client: businessSummary(b, data), credentials: { email: e, password, loginUrl: `${BASE_URL}/login` } });
});

app.put('/api/admin/clients/:id', requireAuth, requireAdmin, (req, res) => {
  const data = db.load();
  const b = data.businesses.find((x) => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Client introuvable' });
  if ('plan' in req.body && PLANS[req.body.plan]) b.plan = req.body.plan;
  if ('active' in req.body) b.active = !!req.body.active;
  if ('notes' in req.body) b.notes = String(req.body.notes).slice(0, 1000);
  db.save();
  res.json(businessSummary(b, data));
});

app.post('/api/admin/clients/:id/reset-password', requireAuth, requireAdmin, (req, res) => {
  const data = db.load();
  const b = data.businesses.find((x) => x.id === req.params.id);
  const owner = b && data.users.find((u) => u.id === b.ownerId);
  if (!owner) return res.status(404).json({ error: 'Client introuvable' });
  const password = tempPassword();
  owner.password = hashPassword(password);
  db.save();
  res.json({ credentials: { email: owner.email, password, loginUrl: `${BASE_URL}/login` } });
});

// « se connecter en tant que » : l'admin ouvre l'espace du client pour le configurer
app.post('/api/admin/clients/:id/impersonate', requireAuth, requireAdmin, (req, res) => {
  const b = db.load().businesses.find((x) => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Client introuvable' });
  startSession(res, { uid: b.ownerId, as: req.user.id });
  res.json({ ok: true, redirect: '/dashboard' });
});
app.post('/api/admin/stop-impersonate', requireAuth, (req, res) => {
  if (!req.session.as) return res.status(400).json({ error: 'Pas en mode « connecté en tant que »' });
  const admin = db.load().users.find((u) => u.id === req.session.as && u.role === 'admin');
  if (!admin) return res.status(403).json({ error: 'Session invalide' });
  startSession(res, { uid: req.session.as });
  res.json({ ok: true, redirect: '/admin' });
});

// ---------- API publique (côté client final) ----------
function publicBusiness(slug) {
  const data = db.load();
  const b = data.businesses.find((x) => x.slug === slug);
  if (!b || b.active === false) return null;
  const prizes = data.prizes.filter((p) => p.businessId === b.id && p.active);
  return { b, prizes };
}

app.get('/api/public/:slug', (req, res) => {
  const r = publicBusiness(req.params.slug);
  if (!r) return res.status(404).json({ error: 'Commerce introuvable' });
  const { b, prizes } = r;
  const device = getCookie(req, 'qlick_device');
  const visits = device ? db.load().participations.filter((p) => p.businessId === b.id && p.device === device).length : 0;
  const social = SOCIAL_ACTIONS.filter((a) => actionAvailable(b, a));
  res.json({
    name: b.name, primaryColor: b.primaryColor, welcomeText: b.welcomeText,
    // séquence adaptative : 1re visite → 1re action, 2e visite → 2e action…
    suggestedAction: social.length ? social[visits % social.length] : null,
    actionUrls: Object.fromEntries(social.map((a) => [a, b[ACTION_URL[a]]])),
    logoUrl: b.logo ? `/logo/${b.slug}?v=${b.logo.length}` : null,
    winText: b.winText || 'Félicitations !', loseText: b.loseText || '',
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
  if (![...SOCIAL_ACTIONS, 'none'].includes(action) || !actionAvailable(b, action)) return res.status(400).json({ error: 'Action non disponible' });

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
app.get('/logo/:slug', (req, res) => {
  const b = db.load().businesses.find((x) => x.slug === req.params.slug);
  const m = b?.logo?.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
  if (!m) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type(m[1]).send(Buffer.from(m[2], 'base64'));
});

// règlement du jeu : texte du commerçant ou modèle généré
function defaultRules(b, prizes) {
  const lots = prizes.filter((p) => p.kind === 'win').map((p) => `- ${p.label}`).join('\n') || '- (aucun lot gagnant configuré)';
  return `Article 1 – Organisateur
Le jeu « Roue de la fortune » est organisé par ${b.name} (ci-après « l'Organisateur »).

Article 2 – Participation
Le jeu est gratuit et sans obligation d'achat. Il est ouvert à toute personne physique majeure. La participation est limitée à une par personne (même adresse email ou même appareil) sur une période de ${b.cooldownDays} jours.
La participation n'est en aucun cas conditionnée au contenu ou à la note d'un éventuel avis : tous les participants jouent avec les mêmes chances.${b.actions?.none ? ' Les actions proposées (avis, abonnement à un réseau social) sont facultatives : il est possible de jouer directement.' : ''}

Article 3 – Lots
Les lots mis en jeu sont :
${lots}
Les lots sont soumis à disponibilité. Ils ne sont ni échangeables, ni remboursables, ni convertibles en espèces.

Article 4 – Utilisation des gains
Le bon cadeau est valable ${b.couponValidityDays} jours à compter de la participation${b.minDelayHours ? `, à partir de ${b.minDelayHours} heure(s) après la participation` : ''}, sur présentation du code dans l'établissement. Il est à usage unique.

Article 5 – Données personnelles
Les données collectées (prénom, email${b.collectPhone ? ', téléphone' : ''}) sont utilisées pour gérer la participation et, uniquement avec votre accord, pour vous adresser des offres de l'Organisateur. Elles sont conservées 3 ans maximum à compter du dernier contact. Vous pouvez exercer vos droits d'accès, de rectification et de suppression en contactant l'Organisateur. La plateforme technique est fournie par Qlick (5 rue Fénelon, 33000 Bordeaux), qui agit en tant que sous-traitant.

Article 6 – Plateformes tierces
Google, Instagram, TikTok et Facebook ne sont ni organisateurs ni parrains du jeu.

Article 7 – Acceptation
La participation implique l'acceptation pleine et entière du présent règlement.`;
}
app.get('/api/public/:slug/rules', (req, res) => {
  const r = publicBusiness(req.params.slug);
  if (!r) return res.status(404).json({ error: 'Commerce introuvable' });
  res.json({ name: r.b.name, primaryColor: r.b.primaryColor, rules: r.b.rulesText?.trim() || defaultRules(r.b, r.prizes) });
});
app.get('/api/rules-template', requireAuth, requireBusiness, (req, res) => {
  res.json({ rules: defaultRules(req.business, db.load().prizes.filter((p) => p.businessId === req.business.id && p.active)) });
});
// ---------- caisse : le personnel valide les gains avec le code PIN du commerce ----------
const pinAttempts = new Map();
function staffAuth(req, res) {
  const b = db.load().businesses.find((x) => x.slug === req.params.slug && x.active !== false);
  if (!b) { res.status(404).json({ error: 'Commerce introuvable' }); return null; }
  const key = `${req.ip}:${b.id}`;
  const recent = (pinAttempts.get(key) || []).filter((t) => t > Date.now() - 15 * 60e3);
  if (recent.length >= 8) { res.status(429).json({ error: 'Trop d\'essais, patientez 15 minutes.' }); return null; }
  const pin = String(req.body?.pin || '');
  const ok = b.staffPin && pin.length === b.staffPin.length && crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(b.staffPin));
  if (!ok) { pinAttempts.set(key, [...recent, Date.now()]); res.status(401).json({ error: 'Code PIN incorrect' }); return null; }
  return b;
}
const staffView = (p) => ({ code: p.code, label: p.prizeLabel, firstName: p.firstName, createdAt: p.createdAt, validFrom: p.validFrom, expiresAt: p.expiresAt, redeemedAt: p.redeemedAt });
function findCode(b, raw) {
  const clean = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return db.load().participations.find((p) => p.businessId === b.id && p.kind === 'win' && p.code.replace(/[^A-Z0-9]/g, '') === clean);
}
app.post('/api/staff/:slug/login', (req, res) => {
  const b = staffAuth(req, res);
  if (b) res.json({ ok: true, name: b.name, primaryColor: b.primaryColor, logoUrl: b.logo ? `/logo/${b.slug}` : null });
});
app.post('/api/staff/:slug/lookup', (req, res) => {
  const b = staffAuth(req, res); if (!b) return;
  const p = findCode(b, req.body?.code);
  if (!p) return res.status(404).json({ error: 'Code inconnu' });
  res.json(staffView(p));
});
app.post('/api/staff/:slug/redeem', (req, res) => {
  const b = staffAuth(req, res); if (!b) return;
  const p = findCode(b, req.body?.code);
  if (!p) return res.status(404).json({ error: 'Code inconnu' });
  if (p.redeemedAt) return res.status(409).json({ error: 'Gain déjà utilisé', ...staffView(p) });
  if (new Date(p.expiresAt) < new Date()) return res.status(410).json({ error: 'Gain expiré', ...staffView(p) });
  if (p.validFrom && new Date(p.validFrom) > new Date()) return res.status(400).json({ error: `Utilisable à partir du ${new Date(p.validFrom).toLocaleString('fr-FR')}`, ...staffView(p) });
  p.redeemedAt = now();
  db.save();
  res.json(staffView(p));
});
app.post('/api/business/staff-pin', requireAuth, requireBusiness, (req, res) => {
  req.business.staffPin = newPin();
  db.save();
  res.json({ staffPin: req.business.staffPin });
});
app.get('/caisse/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'staff.html')));

// QR code public (sticker, chevalet, partage au commerçant)
app.get('/qr/:slug.png', async (req, res) => {
  const b = db.load().businesses.find((x) => x.slug === req.params.slug);
  if (!b) return res.status(404).end();
  const png = await QRCode.toBuffer(`${BASE_URL}/play/${b.slug}?src=qr`, { width: 800, margin: 2, color: { dark: '#110824', light: '#FFFFFF' } });
  res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=3600').send(png);
});

// flyer A5 imprimable aux couleurs du commerce
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
app.get('/flyer/:slug', async (req, res) => {
  const b = db.load().businesses.find((x) => x.slug === req.params.slug);
  if (!b) return res.status(404).send('Introuvable');
  const qr = await QRCode.toString(`${BASE_URL}/play/${b.slug}?src=flyer`, { type: 'svg', margin: 0, color: { dark: '#110824', light: '#FFFFFF' } });
  const color = /^#[0-9a-f]{6}$/i.test(b.primaryColor) ? b.primaryColor : '#8B5CF6';
  const host = BASE_URL.replace(/^https?:\/\//, '');
  res.send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Flyer — ${escHtml(b.name)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@500;700&family=Instrument+Sans:wght@400;600&display=swap" rel="stylesheet">
<style>
@page{size:A5;margin:0}*{box-sizing:border-box}body{margin:0;font-family:'Instrument Sans',system-ui,sans-serif;background:#ddd}
.sheet{width:148mm;height:210mm;margin:10mm auto;background:radial-gradient(90mm 70mm at 90% 0%,${color}cc,transparent 70%),linear-gradient(170deg,#110824,#06030D);color:#F3EEFF;padding:14mm 12mm 10mm;display:flex;flex-direction:column;align-items:center;text-align:center;overflow:hidden}
.logo{max-height:22mm;max-width:60mm;background:#fff;border-radius:4mm;padding:2mm}
.name{font:500 13pt 'Unbounded',sans-serif;letter-spacing:.02em}
h1{font:700 26pt/1.05 'Unbounded',sans-serif;margin:7mm 0 3mm;letter-spacing:-.02em}
.sub{font-size:12pt;color:#C9B8FF}
.qr{background:#fff;padding:5mm;border-radius:6mm;width:70mm;height:70mm;margin:7mm 0 6mm;box-shadow:0 0 0 2mm ${color}55}
.qr svg{width:100%;height:100%;display:block}
ol{text-align:left;font-size:11pt;margin:0;padding-left:6mm;line-height:1.6}
.foot{margin-top:auto;font-size:7pt;color:#B3AACF}
@media print{body{background:none}.sheet{margin:0}.noprint{display:none}}
.noprint{text-align:center;margin:8mm}button{font:600 14px 'Instrument Sans';padding:12px 22px;border-radius:999px;border:0;background:linear-gradient(120deg,#8B5CF6,#D946EF);color:#fff;cursor:pointer}
</style></head><body>
<div class="noprint"><button onclick="print()">Imprimer le flyer A5</button></div>
<div class="sheet">
${b.logo ? `<img class="logo" src="/logo/${escHtml(b.slug)}" alt="${escHtml(b.name)}">` : `<div class="name">${escHtml(b.name)}</div>`}
<h1>Tentez<br>votre chance&nbsp;!</h1>
<div class="sub">Scannez, tournez la roue, gagnez un cadeau</div>
<div class="qr">${qr}</div>
<ol><li>Scannez le QR code avec votre téléphone</li><li>Tournez la roue</li><li>Présentez votre code en caisse</li></ol>
<div class="foot">Jeu gratuit sans obligation d'achat — règlement : ${escHtml(host)}/play/${escHtml(b.slug)}/reglement · Propulsé par Qlick</div>
</div></body></html>`);
});

app.get('/play/:slug/reglement', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reglement.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/play/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'play.html')));
app.get('/coupon/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'coupon.html')));

process.on('SIGINT', () => { db.flush(); process.exit(0); });
process.on('SIGTERM', () => { db.flush(); process.exit(0); });

if (require.main === module) {
  ensureAdmin();
  if (DEMO) require('./seed').seedDemo();
  migrate();
  db.backup(); setInterval(() => db.backup(), 24 * 3600e3).unref();
  app.listen(PORT, () => console.log(`Qlick Boost démarré sur ${BASE_URL}${PROD ? ' (production)' : ''}`));
}
module.exports = app;
