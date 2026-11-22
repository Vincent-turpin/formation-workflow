# Qlick Boost

Solution SaaS de l'agence **Qlick** pour aider les commerces de proximité à obtenir plus d'avis Google, plus d'abonnés Instagram et plus de clients fidèles, grâce à une **roue de la fortune** accessible par QR code.

## Parcours client (mobile, sans application)
1. Le client scanne le QR code (table, comptoir, ticket).
2. Il choisit une action : avis Google, abonnement Instagram, ou participation libre.
3. Il saisit son prénom et son email, accepte le règlement (et, s'il le souhaite, les offres marketing).
4. Il tourne la roue. Le tirage est fait **côté serveur** (probabilités et stocks invisibles pour le client).
5. S'il gagne, il reçoit un bon cadeau avec un code unique et un QR code (`/coupon/QLK-XXXXXX`).

## Espace commerçant (`/dashboard`)
- **Vue d'ensemble** : participations, avis générés, contacts, taux de retour, graphique sur 30 jours.
- **Ma roue** : lots, couleurs, poids (probabilités), stocks, gagnant/perdant, aperçu en direct.
- **Paramètres** : lien d'avis Google, Instagram, couleur, délai entre deux participations, validité du bon, délai avant utilisation.
- **QR code** : PNG HD et chevalet imprimable.
- **Valider un gain** : vérification du code en caisse et utilisation unique.
- **Clients** : liste des participants, recherche et export CSV (compatible Excel).
- **Réponses IA** : réponse personnalisée à un avis Google, générée par Claude. Sans clé API, un modèle de réponse local est utilisé.

## Lancer le projet
```bash
cd qlick-boost
npm install
npm run seed     # compte démo : demo@qlick.fr / demo1234, roue publique : /play/demo
npm start        # http://localhost:3000
```

Variables d'environnement :

| Variable | Rôle |
|---|---|
| `PORT` | Port HTTP (3000 par défaut) |
| `BASE_URL` | URL publique, utilisée dans les QR codes (ex. `https://boost.qlick.fr`) |
| `QLICK_SECRET` | Secret de signature des sessions, **obligatoire en production** |
| `ANTHROPIC_API_KEY` | Active la génération des réponses aux avis par IA |
| `QLICK_AI_MODEL` | Modèle Claude à utiliser (`claude-opus-5-5` par défaut) |
| `QLICK_DB` | Chemin du fichier de données (`data/db.json` par défaut) |

## Architecture
- `server.js` : API Express (auth, roue, tirage, bons, stats, QR, export CSV)
- `ai.js` : génération des réponses aux avis avec le SDK Anthropic
- `db.js` : stockage dans un fichier JSON (MVP). À remplacer par PostgreSQL ou Supabase en production.
- `public/` : site vitrine, jeu client, bon cadeau, connexion, tableau de bord (HTML/CSS/JS sans framework)

## Prochaines étapes pour la production
- Base PostgreSQL et hébergement (Render, Railway, Fly.io)
- Paiement des abonnements avec Stripe Billing
- Envoi du bon par email (Brevo, Resend) et campagnes email/SMS
- Synchronisation des avis via l'API Google Business Profile, avec réponse automatique
- Automatisations n8n ou Make par webhook à chaque participation (CRM, Slack, Google Sheets)
- Multi-établissements et marque blanche pour les clients de l'agence

> Conformité : Google interdit de conditionner une récompense à un avis **positif**. Ici, tous les participants jouent, quelle que soit la note, et une participation sans avis peut être activée. Affichez le règlement du jeu en boutique.
