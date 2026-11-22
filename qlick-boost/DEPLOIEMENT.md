# Mettre Qlick Boost en production

Ce guide met Qlick Boost en ligne sur une adresse du type **https://boost.qlick.fr**, avec un certificat HTTPS, des données sauvegardées et l'IA activée.

Deux options :

| | **A. Render** (recommandé pour démarrer) | **B. Serveur VPS + Docker** |
|---|---|---|
| Difficulté | Aucune ligne de commande | Notions de serveur Linux |
| Coût indicatif | Environ 7 $/mois (offre Starter + disque) | 5 à 10 €/mois (OVH, Hostinger, Scaleway…) |
| HTTPS, redémarrage, déploiement à chaque `git push` | Automatiques | À configurer (Caddy, voir plus bas) |
| Sauvegardes du disque | Instantanés automatiques de Render | À mettre en place vous-même |

Les tarifs changent souvent : vérifiez-les sur le site de l'hébergeur avant de vous engager.

---

## Avant de commencer : ce qu'il vous faut

1. Le code sur GitHub : c'est déjà le cas (dépôt `vincent-turpin/formation-workflow`).
   Fusionnez d'abord la branche `claude/lucid-ptolemy-nn7a0w` dans `main`, ou indiquez cette branche à l'hébergeur.
2. L'accès à la zone DNS de `qlick.fr`, chez votre registrar (OVH, Gandi, Ionos…), pour créer le sous-domaine.
3. Optionnel : une clé API Anthropic pour les réponses aux avis par IA, à créer sur https://console.anthropic.com.
   Sans clé, l'outil propose une réponse modèle fixe.

---

## Option A : Render (recommandé)

### 1. Créer le service

1. Créez un compte sur https://render.com, en vous connectant avec GitHub.
2. Cliquez sur **New → Blueprint**, puis choisissez le dépôt `formation-workflow`.
3. Render lit le fichier `render.yaml` à la racine du dépôt et prépare tout :
   - le service web `qlick-boost`, en région Francfort ;
   - un disque persistant de 1 Go monté sur `/data` ;
   - une clé secrète `QLICK_SECRET` générée automatiquement.
4. Render vous demande les variables marquées « à compléter » :

| Variable | Valeur |
|---|---|
| `BASE_URL` | `https://boost.qlick.fr` (l'adresse finale, sans `/` à la fin) |
| `QLICK_ADMIN_EMAIL` | L'email de l'équipe Qlick qui gère les clients (ex. `contact@qlick.fr`) |
| `QLICK_ADMIN_PASSWORD` | Un mot de passe solide pour cet accès agence |
| `ANTHROPIC_API_KEY` | Votre clé Anthropic, ou vide |
| `QLICK_DEMO_PASSWORD` | Un mot de passe solide pour le compte démo `demo@qlick.fr` |

5. Validez avec **Apply**. Le premier déploiement prend 2 à 3 minutes.
6. Vérifiez que `https://qlick-boost.onrender.com/healthz` affiche `{"ok":true}`. L'adresse exacte est affichée en haut de la page du service.

### 2. Brancher le sous-domaine boost.qlick.fr

1. Dans Render, ouvrez **Settings → Custom Domains → Add**, puis saisissez `boost.qlick.fr`.
2. Chez votre registrar, dans la zone DNS de `qlick.fr`, ajoutez :
   ```
   Type : CNAME    Nom : boost    Valeur : qlick-boost.onrender.com
   ```
3. Revenez sur Render et cliquez sur **Verify**. Le certificat HTTPS est créé automatiquement, en quelques minutes à quelques heures selon le DNS.

### 3. Mettre à jour l'application

Chaque `git push` sur la branche suivie redéploie l'application. Les données du disque `/data` sont conservées.

---

## Option B : VPS avec Docker

Ces étapes conviennent à un VPS Ubuntu 22.04 ou 24.04.

```bash
# 1. Installer Docker
curl -fsSL https://get.docker.com | sh

# 2. Récupérer le code
git clone https://github.com/vincent-turpin/formation-workflow.git
cd formation-workflow/qlick-boost

# 3. Créer le fichier de configuration
cp .env.example .env
nano .env            # renseignez BASE_URL, QLICK_SECRET (openssl rand -hex 32), ANTHROPIC_API_KEY…

# 4. Construire et lancer
docker build -t qlick-boost .
docker run -d --name qlick-boost --restart unless-stopped \
  --env-file .env -v qlick-data:/data -p 127.0.0.1:3000:3000 qlick-boost
```

Pour le HTTPS, installez **Caddy**, qui gère les certificats tout seul (`apt install caddy`). Mettez ces lignes dans `/etc/caddy/Caddyfile` :
```
boost.qlick.fr {
    reverse_proxy 127.0.0.1:3000
}
```
Puis lancez `systemctl reload caddy`. Côté DNS, créez un enregistrement **A** `boost` qui pointe vers l'adresse IP du VPS.

Pour mettre à jour :
```bash
git pull && docker build -t qlick-boost . && docker rm -f qlick-boost && docker run -d --name qlick-boost --restart unless-stopped --env-file .env -v qlick-data:/data -p 127.0.0.1:3000:3000 qlick-boost
```

Pour sauvegarder chaque nuit, ajoutez cette ligne avec `crontab -e` :
```
0 3 * * * docker cp qlick-boost:/data/db.json /root/backups/qlick-$(date +\%F).json
```

---

## Gérer vos clients une fois en ligne

### Le principe
- **Espace agence** (`https://boost.qlick.fr/admin`), réservé à l'équipe Qlick : liste de tous vos clients avec leurs chiffres, création des comptes, choix de l'offre, suspension.
- **Espace client** (`https://boost.qlick.fr/dashboard`), un par établissement : chaque client ne voit que ses propres données. Il personnalise sa roue (logo, couleur, textes, lots, règlement), imprime son QR code, valide les bons cadeaux et suit ses statistiques.
- **Roue publique** (`https://boost.qlick.fr/play/nom-du-commerce`) : la page que voient les clients du commerçant, à ses couleurs et avec son logo.

### Embarquer un nouveau client (10 minutes)
1. Dans `/admin`, cliquez sur **+ Nouveau client** : nom de l'établissement, email du gérant, offre et notes internes.
2. Un message de bienvenue s'affiche, avec l'identifiant et un mot de passe provisoire. **Copiez-le et envoyez-le** au client. Le mot de passe n'est affiché qu'une fois, mais **Nouveau mot de passe** en génère un autre.
3. Cliquez sur **Ouvrir l'espace** pour configurer le compte à sa place (bandeau « Mode agence ») :
   - **Personnalisation** : logo, couleur, message d'accueil, textes de gain et de perte, règlement (bouton **Partir du modèle**). L'aperçu est en direct.
   - **Paramètres** : lien d'avis Google (Google Business Profile → « Demander des avis ») et lien Instagram.
   - **Ma roue** : les lots et leurs probabilités.
   - **QR code** : imprimez le chevalet ou envoyez le PNG au client.
4. Cliquez sur **Revenir à l'espace agence**. Le client passe en statut **Actif** dès qu'un lien d'avis ou Instagram est renseigné.

### Offres
| Offre | Réponses IA | Export CSV |
|---|---|---|
| Essai 14 jours | ✅ | ✅ |
| Essentiel | — | — |
| Pro | ✅ | ✅ |
| Réseau & sur-mesure | ✅ | ✅ |

Vous changez l'offre d'un client directement dans la liste. **Suspendre** coupe immédiatement sa roue publique, par exemple en cas d'impayé. Ses données sont conservées et **Réactiver** remet tout en ligne.

> L'essai de 14 jours ne s'arrête pas tout seul : passez le client en Essentiel ou Pro à la signature, ou suspendez-le. La facturation se fait dans votre outil habituel (Odoo) tant que Stripe n'est pas branché.

---

## Toutes les variables d'environnement

| Variable | Obligatoire | Rôle |
|---|---|---|
| `NODE_ENV` | oui | `production` |
| `BASE_URL` | oui | Adresse publique, utilisée dans les QR codes et les liens des bons. Si elle commence par `https://`, les cookies sont sécurisés. |
| `QLICK_SECRET` | oui | Au moins 32 caractères aléatoires. Sans elle, le serveur refuse de démarrer en production. **Ne la changez plus ensuite** : tout le monde serait déconnecté. |
| `QLICK_DB` | conseillé | Emplacement du fichier de données sur le disque persistant (`/data/db.json`) |
| `QLICK_ADMIN_EMAIL` / `QLICK_ADMIN_PASSWORD` | oui | Compte de l'équipe Qlick qui donne accès à l'espace agence `/admin`. Il est créé au premier démarrage. Pour ajouter un second administrateur, changez l'email et redémarrez : le premier compte reste admin. |
| `ANTHROPIC_API_KEY` | non | Active les réponses aux avis par IA |
| `QLICK_AI_MODEL` | non | Modèle Claude utilisé (`claude-opus-5-5` par défaut) |
| `QLICK_DEMO` | non | `1` crée le compte démo et la roue `/play/demo`, utilisée par le bouton « Tester la roue » du site |
| `QLICK_DEMO_PASSWORD` | non | Mot de passe du compte démo (sinon `demo1234`, à éviter en ligne) |
| `QLICK_SIGNUP_CODE` | conseillé | Si cette variable est renseignée, il faut ce code pour créer un compte. Vous le donnez à vos clients. |

> **Pourquoi `QLICK_SIGNUP_CODE` ?** Le paiement en ligne n'est pas encore branché : sans ce code, n'importe qui pourrait créer un compte gratuitement. En attendant Stripe, vous facturez vos clients comme d'habitude (Odoo) et vous leur donnez le code.

---

## Liste de contrôle avant le lancement

**Technique**
- [ ] `https://boost.qlick.fr/healthz` répond `{"ok":true}`
- [ ] Se connecter à `/admin` avec le compte agence
- [ ] Créer un client de test, le configurer via « Ouvrir l'espace », scanner son QR code avec un téléphone, jouer, puis valider le bon en caisse
- [ ] Mettre en place une surveillance gratuite de `/healthz` (UptimeRobot ou Better Stack), avec alerte par email
- [ ] Vérifier que les sauvegardes fonctionnent : sur Render, onglet **Disks → Snapshots**

**Juridique** (à faire valider par votre conseil)
- [ ] **Règlement du jeu** : chaque commerçant doit l'afficher en boutique (lots, modalités, organisateur)
- [ ] **Politique de confidentialité RGPD** : Qlick est sous-traitant des données de participants collectées pour vos clients. Prévoyez un contrat de sous-traitance (DPA) dans vos conditions générales et une durée de conservation.
- [ ] **CGV / CGU** de l'abonnement Qlick Boost
- [ ] **Règles Google** : ne jamais récompenser uniquement les avis positifs. C'est respecté par défaut, puisque tout le monde joue, quelle que soit la note.

---

## Limites actuelles et prochaines étapes

La version actuelle convient pour lancer avec vos **premiers clients**, jusqu'à quelques dizaines d'établissements. Pour aller plus loin :

| Limite actuelle | Évolution recommandée |
|---|---|
| Données dans un fichier JSON, un seul serveur | Passer à PostgreSQL (Render Postgres, Supabase) pour plusieurs serveurs et plus de volume |
| Pas de paiement en ligne | Stripe Billing : essai de 14 jours, puis abonnement Essentiel ou Pro |
| Pas de « mot de passe oublié » ni d'emails | Envoi d'emails transactionnels (Brevo, Resend) : bon cadeau, rappel avant expiration, réinitialisation du mot de passe |
| Un compte = un établissement | Plusieurs établissements par compte (franchises) et plusieurs utilisateurs par établissement |
| Logo stocké dans la base | Stockage des fichiers sur S3 / Cloudflare R2 quand le nombre de clients grandit |
| Réponses IA à copier-coller | Connexion à l'API Google Business Profile pour publier les réponses directement |
| — | Webhook vers n8n à chaque participation (CRM, Odoo, Slack, Google Sheets) |
