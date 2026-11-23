// Satisfaction, emails (Brevo simulé) et Google Business Profile (API Google simulée) : node --test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 4000 + Math.floor(Math.random() * 90);
const MOCK = PORT + 100;
const URL_ = `http://127.0.0.1:${PORT}`;
const M = `http://127.0.0.1:${MOCK}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qlick-test-'));
const mails = [], replies = [];
let server, mock;

function client() {
  const jar = {};
  return async (method, p, body, opts = {}) => {
    const res = await fetch(p.startsWith('http') ? p : URL_ + p, {
      method, redirect: opts.redirect || 'follow',
      headers: { 'Content-Type': 'application/json', Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : await res.text() };
  };
}

before(async () => {
  // faux Brevo + fausse API Google
  mock = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const u = new URL(req.url, M);
      if (u.pathname === '/brevo') { mails.push(JSON.parse(raw)); return send(201, { messageId: 'x' }); }
      if (u.pathname === '/token') {
        const p = new URLSearchParams(raw);
        if (p.get('grant_type') === 'authorization_code') return send(200, { access_token: 'at1', refresh_token: 'rt-secret' });
        if (p.get('refresh_token') === 'rt-secret') return send(200, { access_token: 'at2' });
        return send(400, { error: 'invalid_grant' });
      }
      if (u.pathname === '/v1/accounts') return send(200, { accounts: [{ name: 'accounts/1' }] });
      if (u.pathname === '/v1/accounts/1/locations') return send(200, { locations: [{ name: 'locations/9', title: 'Café Test', storefrontAddress: { locality: 'Bordeaux' } }] });
      if (u.pathname === '/v4/accounts/1/locations/9/reviews') {
        assert.equal(req.headers.authorization, 'Bearer at2');
        return send(200, { averageRating: 4.2, totalReviewCount: 2, reviews: [
          { reviewId: 'r1', reviewer: { displayName: 'Paul' }, starRating: 'TWO', comment: 'Trop d\'attente', createTime: '2026-11-20T10:00:00Z' },
          { reviewId: 'r2', reviewer: { displayName: 'Inès' }, starRating: 'FIVE', comment: 'Parfait', createTime: '2026-11-19T10:00:00Z', reviewReply: { comment: 'Merci !' } },
        ] });
      }
      if (u.pathname === '/v4/accounts/1/locations/9/reviews/r1/reply' && req.method === 'PUT') { replies.push(JSON.parse(raw)); return send(200, {}); }
      send(404, { error: { message: 'inconnu ' + u.pathname } });
    });
  }).listen(MOCK);

  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'), stdio: 'ignore',
    env: {
      ...process.env, PORT, NODE_ENV: 'development', QLICK_DB: path.join(DIR, 'db.json'), BASE_URL: URL_,
      BREVO_API_KEY: 'test', BREVO_API_URL: `${M}/brevo`,
      GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', GOOGLE_AUTH_URL: `${M}/auth`, GOOGLE_TOKEN_URL: `${M}/token`,
      GBP_ACCOUNTS_API: M, GBP_INFO_API: M, GBP_REVIEWS_API: M,
    },
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(URL_ + '/healthz')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Le serveur ne démarre pas');
});
after(() => { server.kill(); mock.close(); fs.rmSync(DIR, { recursive: true, force: true }); });

test('satisfaction : note privée, alerte au commerçant et email de suivi au client', async () => {
  const admin = client(), merchant = client(), player = client(), happy = client();
  await admin('POST', '/api/auth/login', { email: 'admin@qlick.fr', password: 'admin1234' });
  const c = await admin('POST', '/api/admin/clients', { businessName: 'Café Test', email: 'gerant@cafe.fr', plan: 'pro' });
  const slug = c.data.client.slug;
  await merchant('POST', '/api/auth/login', { email: 'gerant@cafe.fr', password: c.data.credentials.password });
  await merchant('PUT', '/api/business', { googleReviewUrl: 'https://g.page/r/x/review', alertEmail: 'alertes@cafe.fr', actions: { google: true, none: true } });

  // le lien Google est proposé quelle que soit la note (même configuration publique)
  const cfg = (await player('GET', `/api/public/${slug}`)).data;
  assert.equal(cfg.feedbackEnabled, true);
  assert.ok(cfg.actionUrls.google);

  // note 2/5 : deux emails
  assert.equal((await player('POST', `/api/public/${slug}/spin`, { rating: 2, feedback: 'Service lent', firstName: 'Léa', email: 'lea@test.fr', action: 'google', consent: true })).status, 200);
  // note 5/5 : aucun email
  assert.equal((await happy('POST', `/api/public/${slug}/spin`, { rating: 5, firstName: 'Tom', email: 'tom@test.fr', action: 'google', consent: true })).status, 200);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(mails.length, 2);
  const alert = mails.find((m) => m.to[0].email === 'alertes@cafe.fr');
  const follow = mails.find((m) => m.to[0].email === 'lea@test.fr');
  assert.ok(alert && /Service lent/.test(alert.htmlContent) && alert.replyTo.email === 'lea@test.fr');
  assert.ok(follow && follow.replyTo.email === 'alertes@cafe.fr' && follow.sender.name === 'Café Test');

  const fb = (await merchant('GET', '/api/feedback')).data;
  assert.equal(fb.count, 2);
  assert.equal(fb.average, 3.5);
  assert.equal(fb.toHandle, 1);
  const low = fb.items.find((x) => x.rating === 2);
  assert.ok(low.followupSentAt);
  await merchant('PUT', `/api/feedback/${low.id}`, { handled: true });
  assert.equal((await merchant('GET', '/api/feedback')).data.toHandle, 0);

  // Google Business Profile
  const st0 = (await merchant('GET', '/api/google/status')).data;
  assert.equal(st0.configured, true); assert.equal(st0.connected, false);
  const go = await merchant('GET', '/api/google/connect', null, { redirect: 'manual' });
  const auth = new URL(go.headers.get('location'));
  assert.equal(auth.searchParams.get('scope'), 'https://www.googleapis.com/auth/business.manage');
  const cb = await merchant('GET', `/api/google/callback?code=abc&state=${encodeURIComponent(auth.searchParams.get('state'))}`, null, { redirect: 'manual' });
  assert.match(cb.headers.get('location'), /google=ok/);
  const st = (await merchant('GET', '/api/google/status')).data;
  assert.equal(st.connected, true); assert.equal(st.location.title, 'Café Test — Bordeaux');
  const me = (await merchant('GET', '/api/me')).data;
  assert.ok(!JSON.stringify(me).includes('rt-secret') && !('google' in me.business), 'le jeton Google ne sort jamais');
  const dbRaw = fs.readFileSync(path.join(DIR, 'db.json'), 'utf8');
  assert.ok(!dbRaw.includes('rt-secret'), 'jeton chiffré sur le disque');

  const rv = (await merchant('GET', '/api/google/reviews')).data;
  assert.equal(rv.reviews.length, 2); assert.equal(rv.reviews[0].rating, 2);
  const sug = await merchant('POST', '/api/google/reviews/r1/suggest', { author: 'Paul', rating: 2, comment: 'Trop d\'attente' });
  assert.equal(sug.status, 200); assert.ok(sug.data.reply.length > 20);
  assert.equal((await merchant('POST', '/api/google/reviews/r1/reply', { comment: 'Merci Paul, désolés pour l\'attente.' })).status, 200);
  assert.deepEqual(replies, [{ comment: 'Merci Paul, désolés pour l\'attente.' }]);
  assert.equal((await merchant('POST', '/api/google/reviews/..%2Fx/reply', { comment: 'x' })).status, 400);

  // déconnexion
  await merchant('POST', '/api/google/disconnect');
  assert.equal((await merchant('GET', '/api/google/status')).data.connected, false);
});
