// Génération de réponses aux avis Google avec Claude.
// Sans clé ANTHROPIC_API_KEY, un modèle de réponse local est utilisé (mode démo).
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.QLICK_AI_MODEL || 'claude-opus-5-5';

const SYSTEM = `Tu es le community manager d'un commerce local français. Tu rédiges des réponses publiques aux avis Google.
Règles :
- Réponds en français (ou dans la langue de l'avis s'il est rédigé dans une autre langue).
- 2 à 5 phrases, naturelles, jamais robotiques, sans formules creuses répétitives.
- Remercie la personne par son prénom si disponible.
- Reprends un détail concret de l'avis pour montrer qu'il a été lu.
- Avis négatif (1-3 étoiles) : reste calme et professionnel, présente des excuses sincères sans te justifier longuement, propose de poursuivre en privé. N'invente aucun fait, geste commercial ou promesse.
- N'ajoute pas de hashtags ni d'emojis sauf si le ton demandé est "fun".
- Renvoie uniquement le texte de la réponse, sans guillemets ni préambule.`;

function fallbackReply({ businessName, author, rating, signature }) {
  const name = author ? ` ${author.split(' ')[0]}` : '';
  const sign = signature || `L'équipe ${businessName}`;
  if (rating >= 4) {
    return `Bonjour${name}, merci beaucoup pour ce super retour ! Toute l'équipe de ${businessName} est ravie que votre expérience vous ait plu. Au plaisir de vous accueillir à nouveau très bientôt !\n\n${sign}`;
  }
  return `Bonjour${name}, merci d'avoir pris le temps de partager votre avis. Nous sommes sincèrement désolés que votre expérience n'ait pas été à la hauteur de vos attentes. Nous aimerions en discuter avec vous : n'hésitez pas à nous contacter directement afin que nous puissions faire mieux.\n\n${sign}`;
}

let client = null;
async function generateReviewReply(input) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return { text: fallbackReply(input), source: 'modele' };
  }
  client = client || new Anthropic();
  const { businessName, author, rating, text, tone, signature } = input;
  const prompt = `Commerce : ${businessName}
Auteur de l'avis : ${author || 'inconnu'}
Note : ${rating}/5
Ton souhaité : ${tone}
Signature à utiliser en fin de réponse : ${signature || `L'équipe ${businessName}`}

Avis :
"""
${text || '(avis sans texte, note uniquement)'}
"""`;

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  if (response.stop_reason === 'refusal') return { text: fallbackReply(input), source: 'modele' };
  const out = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return { text: out || fallbackReply(input), source: 'ia' };
}

module.exports = { generateReviewReply };
