// Crée un compte de démo (demo@qlick.fr / demo1234) avec la roue publique /play/demo
// et quelques participations fictives pour peupler le tableau de bord.
const crypto = require('crypto');
const db = require('./db');

function seedDemo() {
const data = db.load();
if (data.users.some((u) => u.email === 'demo@qlick.fr')) return false;
const password = process.env.QLICK_DEMO_PASSWORD || 'demo1234';
const salt = crypto.randomBytes(16).toString('hex');
const user = { id: crypto.randomUUID(), email: 'demo@qlick.fr', password: `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`, createdAt: new Date().toISOString() };
data.users.push(user);
const business = {
  id: crypto.randomUUID(), ownerId: user.id, name: 'Le Petit Bistrot', slug: 'demo', createdAt: new Date().toISOString(),
  googleReviewUrl: 'https://search.google.com/local/writereview?placeid=DEMO', instagramUrl: 'https://instagram.com/',
  primaryColor: '#8B5CF6', welcomeText: 'Merci de votre visite ! Tentez de gagner un cadeau 🎁',
  actions: { google: true, instagram: true, none: true }, cooldownDays: 30, couponValidityDays: 30, minDelayHours: 0,
  collectPhone: false, plan: 'trial',
};
data.businesses.push(business);
const prizes = [
  ['Café offert', '#8B5CF6', 30, 'win'], ['-10% sur l\'addition', '#D946EF', 25, 'win'], ['Perdu… retentez !', '#B3AACF', 25, 'lose'],
  ['Dessert offert', '#6D28D9', 12, 'win'], ['Boisson offerte', '#C026D3', 7, 'win'], ['Repas offert', '#110824', 1, 'win'],
].map(([label, color, weight, kind]) => ({ id: crypto.randomUUID(), businessId: business.id, label, color, weight, stock: label === 'Repas offert' ? 5 : null, kind, active: true }));
data.prizes.push(...prizes);

const names = ['Marie', 'Lucas', 'Emma', 'Hugo', 'Léa', 'Nathan', 'Chloé', 'Louis', 'Inès', 'Jules', 'Manon', 'Tom', 'Sarah', 'Noah', 'Camille'];
const actions = ['google', 'google', 'google', 'instagram', 'none'];
for (let i = 0; i < 64; i++) {
  const created = new Date(Date.now() - Math.random() * 28 * 864e5);
  const p = prizes[[0, 0, 0, 1, 1, 2, 2, 3, 4][i % 9]];
  const n = names[i % names.length];
  data.participations.push({
    id: crypto.randomUUID(), businessId: business.id, createdAt: created.toISOString(),
    firstName: n, email: `${n.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')}.${i}@exemple.fr`, phone: '',
    action: actions[i % actions.length], marketingOptIn: i % 3 !== 0, device: crypto.randomUUID(), source: 'qr',
    prizeId: p.id, prizeLabel: p.label, kind: p.kind, code: 'QLK-D' + String(10000 + i),
    validFrom: created.toISOString(), expiresAt: new Date(created.getTime() + 30 * 864e5).toISOString(),
    redeemedAt: p.kind === 'win' && i % 5 < 2 ? new Date(created.getTime() + 3 * 864e5).toISOString() : null,
  });
}
db.flush();
console.log('Démo créée : demo@qlick.fr — roue publique : /play/demo');
return true;
}

module.exports = { seedDemo };
if (require.main === module && !seedDemo()) console.log('Compte démo déjà présent.');
