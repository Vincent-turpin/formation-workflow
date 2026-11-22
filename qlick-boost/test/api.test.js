// Test de bout en bout de l'API : node --test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3900 + Math.floor(Math.random() * 90);
const URL_ = `http://127.0.0.1:${PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qlick-test-'));
let server;

// mini-client HTTP avec cookies
function client() {
  const jar = {};
  return async (method, p, body) => {
    const res = await fetch(URL_ + p, {
      method, headers: { 'Content-Type': 'application/json', Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
  };
}

before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT, NODE_ENV: 'development', QLICK_DB: path.join(DIR, 'db.json'), BASE_URL: URL_ },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(URL_ + '/healthz')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Le serveur ne démarre pas');
});
after(() => { server.kill(); fs.rmSync(DIR, { recursive: true, force: true }); });

test('parcours complet : agence → client → joueur → caisse', async () => {
  const admin = client(), merchant = client(), player = client(), cashier = client();

  // 1. l'agence crée un client
  assert.equal((await admin('POST', '/api/auth/login', { email: 'admin@qlick.fr', password: 'admin1234' })).status, 200);
  const created = await admin('POST', '/api/admin/clients', { businessName: 'Café Test', email: 'gerant@test.fr', plan: 'essentiel' });
  assert.equal(created.status, 200);
  const { password } = created.data.credentials;
  const slug = created.data.client.slug;

  // 2. le client se connecte et configure son jeu
  const login = await merchant('POST', '/api/auth/login', { email: 'gerant@test.fr', password });
  assert.equal(login.data.redirect, '/dashboard');
  assert.equal((await merchant('GET', '/api/admin/clients')).status, 403, 'un client ne voit pas l\'espace agence');
  const me = (await merchant('GET', '/api/me')).data;
  const upd = await merchant('PUT', '/api/business', {
    googleReviewUrl: 'https://g.page/r/test/review', instagramUrl: 'https://instagram.com/test',
    actions: { google: true, instagram: true, tiktok: false, facebook: false, none: true }, cooldownDays: 30,
  });
  assert.equal(upd.status, 200);
  assert.equal((await merchant('POST', '/api/reviews/reply', { rating: 5, text: 'Top' })).status, 402, 'IA réservée à l\'offre Pro');

  // 3. un joueur participe
  const cfg = (await player('GET', `/api/public/${slug}`)).data;
  assert.equal(cfg.suggestedAction, 'google');
  assert.ok(!('weight' in cfg.segments[0]), 'les probabilités ne sont pas exposées');
  const spin = await player('POST', `/api/public/${slug}/spin`, { firstName: 'Léa', email: 'lea@test.fr', action: 'google', consent: true });
  assert.equal(spin.status, 200);
  assert.equal((await player('POST', `/api/public/${slug}/spin`, { firstName: 'Léa', email: 'lea@test.fr', action: 'google', consent: true })).status, 409, 'une seule participation');
  assert.equal((await player('GET', `/api/public/${slug}`)).data.suggestedAction, 'instagram', 'séquence adaptative');

  // 4. la caisse valide le gain (on force un code gagnant si la roue a perdu)
  let code = spin.data.code;
  if (!code) {
    for (let i = 0; i < 40 && !code; i++) {
      const p = client();
      const r = await p('POST', `/api/public/${slug}/spin`, { firstName: 'X', email: `x${i}@test.fr`, action: 'none', consent: true });
      code = r.data.code;
    }
  }
  assert.ok(code, 'au moins un gain sur 40 tirages');
  assert.equal((await cashier('POST', `/api/staff/${slug}/login`, { pin: '000000x' })).status, 401);
  const pin = me.business.staffPin;
  assert.equal((await cashier('POST', `/api/staff/${slug}/lookup`, { pin, code })).status, 200);
  assert.equal((await cashier('POST', `/api/staff/${slug}/redeem`, { pin, code })).status, 200);
  assert.equal((await cashier('POST', `/api/staff/${slug}/redeem`, { pin, code })).status, 409, 'usage unique');

  // 5. pages publiques
  assert.equal((await player('GET', `/qr/${slug}.png`)).status, 200);
  assert.match((await player('GET', `/flyer/${slug}`)).data, /Tentez/);
  assert.match((await player('GET', `/api/public/${slug}/rules`)).data.rules, /Café Test/);

  // 6. suspension par l'agence
  await admin('PUT', `/api/admin/clients/${created.data.client.id}`, { active: false });
  assert.equal((await player('GET', `/api/public/${slug}`)).status, 404);
});

test('production : refuse de démarrer sans secret', async () => {
  const r = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, NODE_ENV: 'production', QLICK_SECRET: '', BASE_URL: '', PORT: PORT + 1 }, stdio: 'ignore' });
  const code = await new Promise((res) => r.on('exit', res));
  assert.equal(code, 1);
});
