# Qlick Boost

Solution SaaS de l'agence **[Qlick](https://qlick.fr)** (Bordeaux & La Réunion), aux couleurs de sa charte graphique, pour aider les commerces de proximité à obtenir plus d'avis Google, plus d'abonnés Instagram et plus de clients fidèles, grâce à une **roue de la fortune** accessible par QR code.

## Parcours client (mobile, sans application)
1. Le client scanne le QR code (table, comptoir, ticket).
2. Il choisit une action : avis Google, abonnement Instagram, ou participation libre.
3. Il saisit son prénom et son email, accepte le règlement (et, s'il le souhaite, les offres marketing).
4. Il tourne la roue. Le tirage est fait **côté serveur** (probabilités et stocks invisibles pour le client).
5. S'il gagne, il reçoit un bon cadeau avec un code unique et un QR code (`/coupon/QLK-XXXXXX`).

## Espace agence Qlick (`/admin`)
- Liste des clients avec leurs participations, avis générés et dernière activité
- Création d'un espace client et du message de bienvenue avec mot de passe provisoire
- Choix de l'offre (Essai, Essentiel, Pro, Réseau), notes internes, suspension et réactivation
- **Ouvrir l'espace** d'un client pour le configurer à sa place

En local : `admin@qlick.fr` / `admin1234`. En production, le compte est défini par `QLICK_ADMIN_EMAIL` et `QLICK_ADMIN_PASSWORD`.

## Espace commerçant (`/dashboard`)
- **Personnalisation** : logo, couleur, textes, règlement du jeu (modèle généré automatiquement), aperçu en direct
- **Actions** : avis Google, Instagram, TikTok, Facebook ou participation libre. La roue suggère une action différente à chaque visite.
- **Page caisse** `/caisse/<commerce>` : le personnel valide les gains avec un code PIN, sans accès au compte (8 essais max par 15 min)
- **Flyer A5** `/flyer/<commerce>` et **QR code public** `/qr/<commerce>.png`
- **Vue d'ensemble** : participations, avis générés, contacts, taux de retour, graphique sur 30 jours.
- **Ma roue** : lots, couleurs, poids (probabilités), stocks, gagnant/perdant, aperçu en direct.
- **Paramètres** : lien d'avis Google, Instagram, couleur, délai entre deux participations, validité du bon, délai avant utilisation.
- **QR code** : PNG HD et chevalet imprimable.
- **Valider un gain** : vérification du code en caisse et utilisation unique.
- **Clients** : liste des participants, recherche et export CSV (compatible Excel).
- **Réponses IA** : réponse personnalisée à un avis Google, générée par Claude. Sans clé API, un modèle de réponse local est utilisé.

## Tests
```bash
npm test   # parcours complet : agence → client → joueur → caisse
```

## Lancer le projet
```bash
cd qlick-boost
npm install
npm run seed     # compte démo : demo@qlick.fr / demo1234, roue publique : /play/demo
npm start        # http://localhost:3000
```

Les variables d'environnement (production, IA, démo, code d'invitation) et la mise en ligne sont décrites dans **[DEPLOIEMENT.md](DEPLOIEMENT.md)**.

## Architecture
- `server.js` : API Express (auth, roue, tirage, bons, stats, QR, export CSV)
- `ai.js` : génération des réponses aux avis avec le SDK Anthropic
- `db.js` : stockage dans un fichier JSON (MVP). À remplacer par PostgreSQL ou Supabase en production.
- `public/style.css` : charte Qlick (fond `#06030D`, dégradé `#8B5CF6` → `#D946EF`, polices Unbounded + Instrument Sans)
- `public/` : site vitrine, jeu client, bon cadeau, connexion, tableau de bord (HTML/CSS/JS sans framework)

## Mise en production
Voir **[DEPLOIEMENT.md](DEPLOIEMENT.md)** : VPS IONOS avec `docker-compose.yml` + `Caddyfile` (HTTPS automatique), ou Render (`render.yaml` à la racine du dépôt). Sauvegarde quotidienne automatique dans `data/backups/` (30 jours).

## Prochaines étapes
- Base PostgreSQL et hébergement (Render, Railway, Fly.io)
- Paiement des abonnements avec Stripe Billing
- Envoi du bon par email (Brevo, Resend) et campagnes email/SMS
- Synchronisation des avis via l'API Google Business Profile, avec réponse automatique
- Automatisations n8n ou Make par webhook à chaque participation (CRM, Slack, Google Sheets)
- Multi-établissements et marque blanche pour les clients de l'agence

> Conformité : Google interdit de conditionner une récompense à un avis **positif**. Ici, tous les participants jouent, quelle que soit la note, et une participation sans avis peut être activée. Affichez le règlement du jeu en boutique.
