# Guide de création d'une application dans l'environnement Ville

Ce document décrit les conventions à respecter pour créer une nouvelle application
intégrée à l'écosystème de la Ville (DSI). Il reprend la stack technique, la base de
données PostgreSQL partagée, l'utilisation de l'API centrale de production
(`https://api.ivry.local`) et les bonnes pratiques de codage.

> **Mise à jour** : ajout de la section 3.6 « Interroger une IA » — l'API centrale APM
> expose désormais un service d'interrogation IA (`/api/v1/ai/*`), vérifié directement
> dans le code source de l'APM (`routes/ai.js` et `routes/proxy.js`, commit `5a87ba5`).

---

## 1. Environnement technique

L'application doit être **fullstack** avec un frontend et un backend séparés, en
reprenant exactement les mêmes outils que les applications existantes.

### Backend
- **Node.js** + **Express 5**
- Dépendances usuelles : `pg` (PostgreSQL), `axios`, `dotenv`, `cors`,
  `jsonwebtoken`, `bcryptjs`, `multer` (uploads), `swagger-jsdoc` + `swagger-ui-express`.
- Démarrage : `node server.js` (scripts `start` / `dev` dans `package.json`).

### Frontend
- **React 18** + **TypeScript**
- **Vite** comme bundler (`vite`, `vite build`, `vite preview`)
- **Tailwind CSS** pour le style
- `react-router-dom` pour le routing, `axios` pour les appels API,
  `lucide-react` pour les icônes, `framer-motion` pour les animations.

### Conteneurisation
Fournir un `docker-compose.yml` sur le modèle existant (un service `backend`, un
service `frontend`), avec `restart: always` et l'URL de l'API passée en
argument de build au frontend via la variable `VITE_API_URL`.

```yaml
services:
  backend:
    build: { context: ./backend }
    restart: always
    ports: ["PORT_BACK:PORT_BACK"]
    environment:
      - NODE_ENV=production
  frontend:
    build:
      context: ./frontend
      args:
        - VITE_API_URL=${APP_API_URL:-http://localhost:PORT_BACK}
    restart: always
    ports: ["PORT_FRONT:80"]
    depends_on: [backend]
```

> Choisir un couple de ports libres et propre à l'application (ne pas réutiliser
> ceux d'une app existante).

### 1.1 Configuration & variables d'environnement

> ⚠️ **Règle impérative : toutes les URLs d'API (et tous les ports, clés, accès DB)
> sont des paramètres, jamais des valeurs en dur dans le code.** On ne code jamais
> une URL comme `http://10.103.130.106:3001` ou `https://api.ivry.local` dans un
> fichier source : on lit `process.env.XXX_API_URL`. Cela permet de changer
> d'environnement (dev / recette / prod) sans modifier le code, et de basculer une IP
> provisoire vers son nom DNS définitif d'un simple changement de `.env`.

Centraliser **toute** la configuration dans un fichier `.env` (non committé,
ajouté au `.gitignore`). Fournir un `.env.example` documenté dans le dépôt.

```dotenv
# --- Base de données PostgreSQL (Ville) ---
POSTGRES_HOST=        # voir équipe DSI
POSTGRES_PORT=5432
POSTGRES_DB=ivry_admin
POSTGRES_USER=        # voir équipe DSI
POSTGRES_PASSWORD=    # voir équipe DSI

# --- API centrale APM (services transverses) ---
APM_API_URL=https://api.ivry.local
APM_API_KEY=          # clé X-API-KEY fournie par l'admin APM

# --- API métier Hub DSI (données Ville + fonctions métier) ---
HUBDSI_API_URL=http://10.103.130.106:3001   # provisoire, cible https://dsihub.ivry.local
HUBDSI_API_KEY=       # clé dsk_... fournie par l'admin Hub DSI

# --- Application ---
PORT=                 # port d'écoute du backend
JWT_SECRET=           # secret de signature des JWT applicatifs
NODE_ENV=production
```

Côté frontend, l'URL du backend est injectée **au build** via `VITE_API_URL`
(variable Vite), jamais en dur dans les composants.

---

## 2. Base de données PostgreSQL (schéma dédié)

Les données sont stockées dans le **PostgreSQL partagé de la Ville**. On ne crée
**pas** de nouvelle base : on crée un **nouveau schéma** dédié à l'application à
l'intérieur de la base existante. Les paramètres de connexion sont identiques à
ceux des autres applications.

### Paramètres de connexion (identiques à l'existant)

| Paramètre | Variable d'env | Valeur |
|-----------|----------------|--------|
| Hôte      | `POSTGRES_HOST` | *(voir équipe DSI)* |
| Port      | `POSTGRES_PORT` | `5432` |
| Base      | `POSTGRES_DB`   | `ivry_admin` |
| Utilisateur | `POSTGRES_USER` | *(voir équipe DSI)* |
| Mot de passe | `POSTGRES_PASSWORD` | *(voir équipe DSI)* |

> **Les identifiants réels (hôte, utilisateur, mot de passe) ne sont pas inscrits dans
> ce document.** Les demander à l'équipe DSI et les fournir uniquement via un fichier
> `.env` non committé. Ne jamais coder de secret en dur ni le mettre dans un dépôt git.

### Module de connexion (`pg_db.js`)

Reprendre le pattern du pool `pg` et créer le schéma de l'application au démarrage.
**Important : préfixer toutes les tables par le nom du schéma de l'app** (ex.
`monapp.ma_table`) pour ne pas entrer en collision avec les schémas existants
(`hub`, `magapp`, `glpi`, `hub_rencontres`, …).

```js
const { Pool } = require('pg');

// Tous les identifiants proviennent du .env — aucune valeur en dur ici.
const pool = new Pool({
  user:     process.env.POSTGRES_USER,
  host:     process.env.POSTGRES_HOST,
  database: process.env.POSTGRES_DB || 'ivry_admin',
  password: process.env.POSTGRES_PASSWORD,
  port:     process.env.POSTGRES_PORT || 5432,
});

async function setupDb() {
  const client = await pool.connect();
  try {
    // 1 schéma dédié à VOTRE application
    await client.query('CREATE SCHEMA IF NOT EXISTS monapp;');

    await client.query(`
      CREATE TABLE IF NOT EXISTS monapp.exemple (
        id         SERIAL PRIMARY KEY,
        libelle    VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB] Schéma monapp initialisé');
  } finally {
    client.release();
  }
}

// Petit wrapper pratique (placeholders $1, $2…)
const db = {
  all: (sql, p = []) => pool.query(sql, p).then(r => r.rows),
  get: (sql, p = []) => pool.query(sql, p).then(r => r.rows[0]),
  run: (sql, p = []) => pool.query(sql, p).then(r => ({ changes: r.rowCount })),
};

module.exports = { pool, db, setupDb };
```

Règles à respecter :
- **Un schéma = une application.** Ne jamais écrire dans les schémas des autres apps.
- Pour l'authentification/les comptes, le schéma `hub` (table `hub.users`) est le
  référentiel partagé : le lire si besoin, mais ne pas le modifier sans coordination.
- Utiliser les placeholders positionnels PostgreSQL (`$1`, `$2`…), pas `?`.

---

## 3. Utilisation de l'API centrale de production

L'API centrale (**APM – API Proxy Manager**) est en production sur
**`https://api.ivry.local`**. Elle mutualise les services transverses : envoi de
SMS, envoi de mail, recherche / authentification Active Directory, Azure AD (Entra),
requêtes Oracle (RH/Finances), Office 365, GLPI, **interrogation d'une IA (cloud ou
modèle local)**… Votre application **n'implémente pas ces intégrations elle-même** :
elle appelle l'API centrale.

### 3.1 Fonctionnement des jetons (authentification)

Il existe **deux mécanismes d'authentification distincts** sur l'API centrale :

#### a) Clé API (`X-API-KEY`) — pour les applications

C'est le mécanisme à utiliser pour **votre application**. Chaque application déclarée
reçoit une **clé API** (chaîne aléatoire de 64 caractères hex) générée par
l'administrateur APM. Cette clé :
- se transmet dans le **header HTTP `X-API-KEY`** de chaque requête,
- est rattachée à une application et à une liste de **routes autorisées**
  (permissions granulaires : `mail_send`, `sms_send`, `ad_auth`, `ad_search`,
  `oracle_query`, `ai_query`, `ai_read`, etc., ou `*` pour tout),
- peut être restreinte par **IP de confiance** (si l'option est activée côté APM,
  seules les IP déclarées peuvent l'utiliser),
- est **loguée** : chaque appel (endpoint, payload masqué, statut) est tracé côté APM.

> **À demander à l'administrateur APM** : la création de votre application pour
> obtenir une clé API, avec la liste des permissions nécessaires (ex. `mail_send`,
> `ad_auth`, `ai_query`, `ai_read`). Conserver la clé dans le `.env` du backend
> (`APM_API_KEY`), **jamais côté frontend**, jamais committée.

Toutes les routes applicatives sont préfixées par **`/api/v1/`**.

#### b) JWT (`Authorization: Bearer …`) — pour l'admin APM

Le JWT (obtenu via `POST /api/auth/login` avec un compte admin) sert uniquement à
**l'administration de l'APM lui-même** (gérer les apps, les clés, consulter les
logs, **paramétrer les fournisseurs IA**). Votre application n'en a normalement
**pas** besoin : elle utilise la clé API.

### 3.2 Authentifier un agent via l'Active Directory

Pour vérifier les identifiants d'un agent (login Ville), appeler la route
`POST /api/v1/ad/authenticate` avec la clé API. L'APM effectue le bind LDAP contre
l'AD et renvoie le succès ou l'échec.

```js
const axios = require('axios');

const APM_URL = process.env.APM_API_URL || 'https://api.ivry.local';
const APM_KEY = process.env.APM_API_KEY; // clé X-API-KEY de votre app

async function authentifierAgent(username, password) {
  try {
    const { data } = await axios.post(
      `${APM_URL}/api/v1/ad/authenticate`,
      { username, password },
      { headers: { 'X-API-KEY': APM_KEY } }
    );
    return data; // { success: true, dn: "CN=..." }
  } catch (err) {
    // 401 => identifiants invalides / utilisateur introuvable
    return { success: false, error: err.response?.data?.error || err.message };
  }
}
```

> Permission requise sur la clé : `ad_auth`.
> Pour seulement **rechercher** un agent (sans mot de passe), utiliser
> `GET /api/v1/ad/search?q=nom` (permission `ad_search`) ou
> `GET /api/v1/ad/user?identifier=...` (permission `ad_read`) pour récupérer toutes
> ses informations (mail, service, etc.).

Bonne pratique : après authentification AD réussie, générer **votre propre JWT
applicatif** (signé par votre backend) pour gérer la session dans votre app, plutôt
que de redemander le mot de passe à chaque requête.

### 3.3 Envoyer un mail

Pour envoyer un email, appeler `POST /api/v1/mail/send` avec la clé API. L'APM se
charge du fournisseur configuré (SMTP ou Brevo).

**Important — template & footer :**
- **Le `content` que vous envoyez n'est que le corps du message.** Par défaut, l'APM
  l'**encapsule dans le template HTML institutionnel** (en-tête, mise en forme, pied
  de page de la collectivité). Vous n'avez donc **pas** à reconstruire l'habillage :
  envoyez uniquement le contenu utile.
- **Les éléments du pied de page (footer) sont à transmettre en paramètres** :
  `footer1`, `footer2`, `footer3` (les trois lignes du pied de page) et `footerColor`
  (couleur, ex. `#0055A4`). S'ils sont omis, l'APM applique le footer par défaut
  configuré globalement.
- Pour envoyer un mail **brut, sans le template** (rare), passer `is_raw: true` : le
  `content` est alors envoyé tel quel et le template/footer ne sont pas appliqués.

```js
async function envoyerMail(to, subject, content) {
  const { data } = await axios.post(
    `${APM_URL}/api/v1/mail/send`,
    {
      to,            // "agent@ivry94.fr"
      subject,       // "Sujet du message"
      content,       // corps HTML — sera inséré dans le template institutionnel
      // --- Pied de page envoyé en paramètres ---
      footer1: 'Ville d’Ivry-sur-Seine',
      footer2: 'Direction des Systèmes d’Information',
      footer3: 'monapp@ivry94.fr — 01 00 00 00 00',
      footerColor: '#0055A4',
      // optionnels :
      // from_name, from_email,
      // is_raw: true,        // n'applique PAS le template HTML global
      // attachments: [{ filename: "doc.pdf", content: "<base64>" }]
    },
    { headers: { 'X-API-KEY': APM_KEY } }
  );
  return data; // { status: "success" }
}
```

Champs :
- **Obligatoires** : `to`, `subject`, `content` (corps inséré dans le template).
- **Footer (paramètres)** : `footer1`, `footer2`, `footer3`, `footerColor`.
- **Optionnels** : `from_name`, `from_email`, `is_raw` (booléen, désactive le
  template), `attachments` (tableau `{ filename, content }`, `content` en Base64).
- Permission requise sur la clé : `mail_send`.

### 3.4 Envoyer un SMS

Pour envoyer un SMS, appeler `POST /api/v1/sms/send` avec la clé API. L'APM relaie
vers le fournisseur SMS configuré (Frizbi) — votre application n'a pas à gérer le
fournisseur ni l'expéditeur.

```js
async function envoyerSms(mobile, message) {
  const { data } = await axios.post(
    `${APM_URL}/api/v1/sms/send`,
    {
      mobile,   // "0601020304"
      message,  // "Votre code de validation est 123456"
    },
    { headers: { 'X-API-KEY': APM_KEY } }
  );
  return data; // { status: "success", data: {...} }
}
```

Champs :
- **Obligatoires** : `mobile`, `message`.
- Permission requise sur la clé : `sms_send`.

### 3.5 Interroger une IA (texte, fournisseur cloud ou modèle local)

L'APM expose un service d'interrogation IA générique : il gère lui-même le ou les
fournisseurs configurés (**Groq** et **NVIDIA NIM** en cloud, **Ollama** pour un
modèle interne sur matériel dédié) et **bascule automatiquement** sur un autre
fournisseur actif si le premier échoue (panne, quota, clé invalide…). Votre
application ne choisit donc pas d'implémenter un client OpenAI/Groq/Ollama : elle
appelle uniquement l'APM avec un `prompt`, éventuellement en précisant un modèle.

> Les fournisseurs, clés API, URL Ollama et modèle par défaut sont paramétrés
> **côté admin APM uniquement** (écran « Paramétrage IA », JWT admin) — votre
> application n'a pas la main dessus, elle consomme la configuration existante via
> la clé API.

#### a) Lister les modèles disponibles

`GET /api/v1/ai/models` (permission `ai_read`) renvoie tous les modèles configurés,
avec leur fournisseur, leur statut actif/inactif et le résultat de leur dernier test
de santé (testé automatiquement toutes les heures côté APM).

```js
async function listerModelesIA() {
  const { data } = await axios.get(`${APM_URL}/api/v1/ai/models`, {
    headers: { 'X-API-KEY': APM_KEY }
  });
  return data;
  // [{ id, key: "groq:3", provider: "groq"|"nvidia"|"ollama", provider_label,
  //    name, model, is_active, active, is_default,
  //    last_test: { status: "ok"|"error"|"unknown", message, latency_ms, tested_at } }, …]
}
```

Utile pour proposer un sélecteur de modèle dans un écran d'administration
applicatif (ex. le sous-menu « Paramétrage des prompts IA »), sans coder de liste
en dur : elle peut évoluer côté APM sans changement de code applicatif.

#### b) Interroger un modèle (synchrone)

`POST /api/v1/ai/query` (permission `ai_query`) envoie un prompt texte et renvoie
la réponse complète. C'est l'appel à utiliser pour la plupart des besoins
applicatifs (synthèse de document, synthèse d'un fil de discussion, détection de
thématiques, rédaction d'un email de synthèse…).

```js
async function interrogerIA(prompt, model /* optionnel */) {
  const { data } = await axios.post(
    `${APM_URL}/api/v1/ai/query`,
    { prompt, model }, // model: id, "provider:id", identifiant technique OU nom convivial — omis = modèle par défaut APM
    { headers: { 'X-API-KEY': APM_KEY }, timeout: 310000 } // l'APM peut mettre jusqu'à 5 min (modèle local)
  );
  return data;
  // { status: "success", provider, provider_label, model, model_name, response: "<texte>" }
}
```

Champs de la requête :
- **Obligatoire** : `prompt` (string). Il n'y a **pas** de format « messages »
  façon chat ni de `system prompt` séparé côté APM : construire un prompt unique
  (instructions + contenu) côté application appelante.
- **Optionnel** : `model` — sinon le modèle par défaut configuré côté APM est
  utilisé, avec bascule automatique sur un autre fournisseur actif en cas d'échec.
- `temperature` et `max_tokens` sont paramétrés globalement côté admin APM (pas
  par appel).
- Réponses d'erreur : `400` si `prompt` manquant, `503` si tous les modèles
  configurés ont échoué.

> Un prompt long (résumé d'un fil de discussion entier, synthèse hebdomadaire…)
> peut prendre plusieurs dizaines de secondes, voire quelques minutes sur un
> modèle local (Ollama) — **prévoir un timeout HTTP applicatif large** (ex. 5 min,
> comme l'exemple ci-dessus) plutôt que le timeout par défaut d'`axios`.

#### c) Variante asynchrone avec suivi de progression

Pour un appel front-end où l'utilisateur doit voir la génération apparaître au fil
de l'eau (ou pour éviter un long `await` bloquant côté backend), utiliser le
couple asynchrone :

```js
async function demarrerIA(prompt, model) {
  const { data } = await axios.post(
    `${APM_URL}/api/v1/ai/query-async`,
    { prompt, model },
    { headers: { 'X-API-KEY': APM_KEY } }
  );
  return data.queryId;
}

async function suivreIA(queryId) {
  const { data } = await axios.get(
    `${APM_URL}/api/v1/ai/query-progress/${queryId}`,
    { headers: { 'X-API-KEY': APM_KEY } }
  );
  return data;
  // status: "running" (response = texte partiel, tokensReceived croît) |
  //         "completed" (response = texte final, mêmes champs que /ai/query) |
  //         "error" (error = message)
  // Le job expire et n'est plus interrogeable après 35 min.
}
```

Champs :
- **Obligatoires** : `prompt`. **Optionnel** : `model`. Mêmes permissions que
  ci-dessus (`ai_query`).
- À interroger par polling (ex. toutes les 1-2 s) jusqu'à `status` !== `"running"`.

### 3.6 Documentation interactive (Swagger)

La liste complète et à jour des endpoints est disponible sur la **doc Swagger** de
l'API : `https://api.ivry.local/api-docs`. La spécification brute OpenAPI est sur
`https://api.ivry.local/swagger.json`. **Toujours s'y référer** avant d'intégrer un
nouveau service.

### 3.7 Récapitulatif des principaux endpoints

| Service | Méthode + Endpoint | Permission |
|---------|--------------------|------------|
| Envoi mail | `POST /api/v1/mail/send` | `mail_send` |
| Envoi SMS | `POST /api/v1/sms/send` | `sms_send` |
| Auth AD | `POST /api/v1/ad/authenticate` | `ad_auth` |
| Recherche AD | `GET /api/v1/ad/search?q=` | `ad_search` |
| Détails agent AD | `GET /api/v1/ad/user?identifier=` | `ad_read` |
| Recherche Azure/Entra | `GET /api/v1/azure/search?q=` | `azure_search` |
| Requête Oracle (SELECT) | `POST /api/v1/oracle/query` | `oracle_query` |
| Messages O365 | `GET /api/v1/o365/messages` | `o365_read` |
| Tickets GLPI | `GET /api/v1/glpi/tickets-count` | `glpi_read` |
| Liste modèles IA | `GET /api/v1/ai/models` | `ai_read` |
| Interroger une IA | `POST /api/v1/ai/query` | `ai_query` |
| Interroger une IA (async) | `POST /api/v1/ai/query-async` | `ai_query` |
| Suivi génération IA | `GET /api/v1/ai/query-progress/{queryId}` | `ai_query` |

---

## 4. API métier « Hub DSI » (APPDSI) — encore un autre jeton

⚠️ **À ne pas confondre avec l'API centrale APM.** Il existe une **seconde API**,
celle de l'application **Hub DSI (APPDSI)**, qui expose les **données de paramétrage
Ville** ainsi que des **fonctions métier déjà développées**. Elle possède son
**propre système de jeton, totalement distinct** de la clé `X-API-KEY` de l'APM :

| | API centrale **APM** | API métier **Hub DSI (APPDSI)** |
|--|----------------------|---------------------------------|
| Rôle | Services transverses (mail, SMS, AD, Oracle, IA…) | Données Ville + fonctions métier |
| Jeton | Clé `X-API-KEY` (64 hex) | Clé **`dsk_…`** (scopes) |
| Préfixe routes | `/api/v1/…` | `/api/…` |

### 4.1 Le jeton Hub DSI (`dsk_…`)

- Chaque clé commence par le préfixe **`dsk_`** et est rattachée à un **scope**
  (périmètre fonctionnel : `ville`, `tickets`, … ou `*` pour tout). Une clé de scope
  `ville` ne peut lire que les données Ville.
- Elle peut avoir une **date d'expiration** (`expires_at`) et être désactivée.
- La clé n'est affichée **qu'une seule fois** à sa création — la conserver dans le
  `.env` (`HUBDSI_API_KEY`), jamais côté frontend, jamais committée.
- Trois façons de la transmettre (au choix) :
  - en-tête **`X-API-Key: dsk_…`** (recommandé),
  - en-tête `Authorization: Bearer dsk_…`,
  - paramètre d'URL `?api_key=dsk_…`.

> **URL du Hub DSI** : l'application est accessible sur **`https://dsihub.ivry.local`**.
> Son API est, **pour le moment**, exposée sur **`http://10.103.130.106:3001/`**
> *(à vérifier — privilégier l'URL en `https://dsihub.ivry.local` dès qu'elle est
> disponible et ne pas coder l'IP en dur : passer par `HUBDSI_API_URL` dans le `.env`).*
>
> **À demander** : la création d'une clé `dsk_` avec le bon scope auprès de
> l'administrateur du Hub DSI (module *API Keys*).

```js
// .env :  HUBDSI_API_URL=http://10.103.130.106:3001   (provisoire, à vérifier)
//         cible : https://dsihub.ivry.local
const HUB_URL = process.env.HUBDSI_API_URL;   // base de l'API Hub DSI
const HUB_KEY = process.env.HUBDSI_API_KEY;   // clé dsk_...

const hub = (path) =>
  axios.get(`${HUB_URL}${path}`, { headers: { 'X-API-Key': HUB_KEY } })
       .then(r => r.data);
```

### 4.2 Données de paramétrage Ville (scope `ville`)

Données partagées de la collectivité, en **lecture** via une clé de scope `ville` :

| Donnée | Endpoint |
|--------|----------|
| Configuration générale (nom, code postal) | `GET /api/ville/config` |
| **Élus** (nom, rôle, délégation, contact) | `GET /api/ville/elus` |
| **Sites** (adresse, géolocalisation) | `GET /api/ville/sites` (ou `/sites/list`) |
| **Écoles** (adresse, directeur, contact) | `GET /api/ville/ecoles` |
| **Organisation** (directions / services) | `GET /api/directions-services` |
| **Encadrants / agents DSI** | `GET /api/calendrier-dsi/agents` *(voir Swagger)* |

```js
const elus   = await hub('/api/ville/elus');
const sites  = await hub('/api/ville/sites');
const ecoles = await hub('/api/ville/ecoles');
```

> Ces référentiels sont **maîtrisés par le Hub DSI** : votre application les
> **consomme en lecture**, elle ne les recrée pas et ne les modifie pas.

### 4.3 Fonctions métier déjà disponibles (appelables via API)

Le Hub DSI fournit aussi des **fonctions métier déjà développées**, réutilisables par
votre application via API (selon le scope accordé à votre clé) — inutile de les
réimplémenter :

- **Tâches** : `GET/POST /api/tasks`
- **Projets** : `GET/POST /api/projets`
- **Tickets** (GLPI) : `GET /api/tickets`
- **Réunions** : `GET /api/rencontres-reunions`
- **Rencontres budgétaires** : `GET /api/rencontres-budgetaires`
- **Contrats**, **consommables**, **parc**, **certificats**, etc.

> La liste exhaustive, les méthodes et les schémas sont dans la **doc Swagger du Hub
> DSI** : `${HUBDSI_API_URL}/api/docs`. **Toujours s'y référer** et demander le scope
> correspondant à la fonction visée.

### 4.4 Trois jetons, trois usages — résumé

1. **Clé `X-API-KEY` (APM)** → services transverses (`api.ivry.local/api/v1/…`),
   y compris l'interrogation IA.
2. **Clé `dsk_` (Hub DSI)** → données Ville + fonctions métier (`…/api/…`).
3. **JWT applicatif** → sessions internes de **votre propre** application.

Garder ces trois jetons **séparés**, chacun dans sa variable `.env` dédiée.

---

## 5. Bonnes pratiques de codage

### Code court et lisible
- **Fonctions courtes**, à responsabilité unique. Si un fichier dépasse ~300 lignes,
  le découper en modules.
- **Pas de duplication** : factoriser les appels à l'API centrale dans un seul
  module (ex. `services/apm.js`) plutôt que de répéter `axios` + `X-API-KEY` partout.
- Respecter le style du code existant : densité de commentaires, nommage, idiomes.
- Privilégier `async/await`, gérer explicitement les erreurs (try/catch + statut HTTP
  adapté).

### Organisation
- Backend **modulaire** : un dossier par domaine fonctionnel
  (`modules/<feature>/` avec `*.controller.js`, `*.routes.js`, `*.service.js`,
  `*.repository.js`). Séparer routes / logique métier / accès données.
- Un module dédié à la connexion DB (`pg_db.js`), un module dédié à l'API centrale.
- Centraliser la configuration dans `.env` (jamais de secret en dur dans le code).

### Sécurité
- **Secrets uniquement côté backend** et dans `.env` (clé APM, accès DB). Le frontend
  ne connaît que l'URL de son propre backend.
- Ne jamais committer `.env` (l'ajouter au `.gitignore`).
- Valider/échapper les entrées utilisateur ; utiliser les requêtes paramétrées
  (`$1, $2…`) — jamais de concaténation SQL.

### Documentation & API
- Documenter ses propres endpoints avec des annotations **Swagger** (`swagger-jsdoc`),
  comme l'APM, pour exposer une `/api-docs`.

### Création de "skills" (réutilisabilité)
- Pour les tâches répétitives (déploiement, génération de module, vérifications),
  créer des **skills** réutilisables plutôt que de refaire manuellement à chaque fois.
- Une skill encapsule une procédure documentée et reproductible : la documenter dans
  un `SKILL.md` avec son déclencheur et ses étapes.
- Penser « une responsabilité = une skill », réutilisable entre applications de la
  Ville.

---

## 6. Éléments techniques complémentaires

Points transverses à cadrer dès le début du projet :

### Déploiement
- Cible : **conteneurs Docker / Docker Compose**, comme l'APM. Le build et le run se
  font via `docker-compose up -d --build`, l'URL de l'API étant passée par `.env`.
  L'hôte d'exécution (VM, serveur physique, Proxmox, autre) est laissé au choix de
  l'infra — l'application ne doit dépendre d'aucune plateforme particulière.
- Prévoir un reverse-proxy (Nginx / Traefik) pour exposer l'app derrière son nom DNS
  en `https://` (ex. `https://monapp.ivry.local`) plutôt que par IP:port.
- Outils de supervision des conteneurs (Portainer ou autre) selon ce qui est en place.

### Santé & supervision
- Exposer un endpoint **`GET /api/status`** (ou `/health`) renvoyant l'état de l'app
  et de ses dépendances (DB, APIs). C'est ce que fait déjà l'APM (`/api/status`).
- Logs serveur structurés (niveau, horodatage, contexte) et exploitables
  (`server_out.log` / `server_err.log` ou stdout capté par Docker).

### Conventions d'API
- Préfixer et **versionner** ses propres routes (`/api/v1/...`) pour pouvoir évoluer
  sans casser les consommateurs.
- Codes HTTP cohérents (200/201/400/401/403/404/500) et corps d'erreur normalisé
  (`{ error: "..." }` ou `{ message: "..." }`).
- **Pagination** sur les listes potentiellement longues (`?limit=&offset=`), comme
  les logs de l'APM.
- Masquer les données sensibles (mots de passe, secrets, clés) dans les logs.

### Base de données
- **Migrations** versionnées (dossier `migrations/` avec scripts numérotés) plutôt
  que des `ALTER TABLE` dispersés — modèle déjà utilisé dans l'app Hub DSI.
- Colonnes temporelles en **`TIMESTAMPTZ`** et fuseau **`Europe/Paris`** ; dates de
  création/MAJ (`created_at` / `updated_at`).
- Index sur les colonnes de filtre/recherche fréquentes.

### Sécurité
- **Encodage `UTF-8`** partout (fichiers, réponses, DB) — attention aux accents.
- **CORS** restreint aux origines connues (pas de `*` ouvert en production).
- Limitation de débit (rate-limiting) sur les endpoints sensibles / publics.
- Validation systématique des entrées (taille des uploads, types MIME via `multer`).
- Rotation/expiration des jetons ; ne jamais logger une clé en clair.

### Uploads & fichiers
- Uploads gérés par **`multer`**, stockés hors du code (volume dédié), avec
  nettoyage des fichiers temporaires et limite de taille.

### Qualité & ergonomie de dev
- **Lint/format** : ESLint + TypeScript strict côté frontend (`npm run lint`).
- **README** de démarrage (install, `.env.example`, commandes dev/build/deploy).
- Workflow Git propre (branches, commits explicites) ; ne pas committer `node_modules`,
  `.env`, bases de données locales.
- Tests au moins sur la logique métier critique et les intégrations API.

---

## 7. Checklist de démarrage

- [ ] Repo avec `backend/` (Express) et `frontend/` (React+Vite+TS+Tailwind)
- [ ] `docker-compose.yml` (ports dédiés, `VITE_API_URL`)
- [ ] `pg_db.js` connecté au PostgreSQL Ville, **schéma dédié** créé au démarrage
- [ ] Tables préfixées par le schéma de l'app, requêtes paramétrées `$1…`
- [ ] `.env` ignoré par git, contenant les **trois jetons séparés** :
      DB + `APM_API_KEY`/`APM_API_URL` + `HUBDSI_API_KEY`/`HUBDSI_API_URL`
- [ ] Clé `X-API-KEY` demandée à l'admin **APM** (permissions : `mail_send`,
      `sms_send`, `ad_auth`, `ai_query`, `ai_read`…)
- [ ] Clé `dsk_` demandée à l'admin **Hub DSI** (scope : `ville`, `tickets`…)
- [ ] Module `services/apm.js` (appels `https://api.ivry.local/api/v1/…`, y compris
      `/ai/query` pour toute fonction IA applicative)
- [ ] Module `services/hubdsi.js` (appels Hub DSI `…/api/…`)
- [ ] Auth des agents via `POST /api/v1/ad/authenticate`
- [ ] Envoi de mail via `POST /api/v1/mail/send`, SMS via `POST /api/v1/sms/send`
- [ ] Fonctions IA (synthèse, analyse…) via `POST /api/v1/ai/query`, jamais
      d'appel direct à un fournisseur IA (Groq/NVIDIA/Ollama) depuis l'application
- [ ] Données Ville (élus, sites, écoles, organisation) lues via l'API Hub DSI
- [ ] Endpoints documentés (Swagger), code court et modulaire
