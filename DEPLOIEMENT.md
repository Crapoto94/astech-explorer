# Déploiement — ASTECH Explorer

Application Node.js + Oracle (mode **THICK**), livrée en image Docker `astech-explorer:latest`,
exposée sur le port **8099**. Tout se pilote par variables d'environnement (fichier `.env`).

---

## 1. Prérequis serveur

- Docker + Docker Compose (`docker compose version`).
- Accès réseau à la base Oracle ASTECH et, si utilisé, à Studio-RH.
- Aucun client Oracle à installer : l'Instant Client est **embarqué** dans l'image.

---

## 2. Mise en place (à la main)

```bash
# 1) Récupérer les sources
git clone <repo> astech-explorer && cd astech-explorer

# 2) Créer le fichier d'environnement à partir de l'exemple
cp .env.example .env
chmod 600 .env          # contient les mots de passe

# 3) Éditer .env (voir §3), PUIS démarrer
docker compose up -d --build

# 4) Vérifier
docker logs --tail 30 astech-explorer
curl -s http://localhost:8099/api/config
```

L'application est ensuite joignable sur `http://<serveur>:8099`.

---

## 3. Variables d'environnement (`.env`)

| Variable | Rôle | Défaut |
|---|---|---|
| `ORACLE_ASTECH_HOST/PORT/SERVICE/USER/PASSWORD` | Base Oracle **PROD** | — |
| `ORACLE_ASTECH_TEST_HOST/PORT/SERVICE/USER/PASSWORD` | Base Oracle **TEST** (optionnelle) | — |
| `ASTECH_ENV` | Profil actif au démarrage (`prod`/`test`) | `prod` |
| `STUDIO_RH_API_URL` / `STUDIO_RH_API_KEY` | Source Studio-RH | — |
| `APM_API_URL` / `APM_API_KEY` | Authentification AD via l'APM de la Ville | — |
| `ASTECH_REQUIRE_AUTH` | `1` = impose la connexion AD | `0` |
| `ASTECH_SESSION_SECRET` | Secret de signature des sessions (HMAC) | généré |
| `ASTECH_ALLOW_WRITES` | `1` = autorise les écritures | `0` |
| `ASTECH_API_KEYS` | Clés API référentiels `nom:cle,...` | vide |
| `PORT` | Port HTTP | `8099` |

À laisser par défaut sauf besoin : `ASTECH_LIMIT`, `ASTECH_API_DEFAULT_LIMIT`,
`ASTECH_API_MAX_LIMIT`, `ASTECH_KEYS_FILE`, `ASTECH_JOURNAL_FILE`, `ASTECH_RH_JOURNAL_FILE`
(déjà positionnés dans `docker-compose.yml`, persistés dans le volume `astech-data`).

> Le mot de passe Oracle ne doit **jamais** être écrit en dur dans `docker-compose.yml`
> ni commité. Il vit uniquement dans `.env` (ignoré par git).

---

## 4. Profils PROD / TEST

- Le serveur crée **un pool Oracle par profil** disponible.
- Le profil actif se choisit **par requête** : en-tête `X-ASTECH-Env: test` ou paramètre `?env=test`.
  L'UI propose un sélecteur **PROD/TEST** en haut à droite dès que les deux profils existent.
- Pour activer le TEST : renseigner les 5 variables `ORACLE_ASTECH_TEST_*` puis redémarrer.
- `/api/env` liste les profils disponibles et l'état des écritures.

---

## 5. Écritures contrôlées

- Désactivées par défaut (`ASTECH_ALLOW_WRITES=0`) : l'application est en lecture seule.
- Pour les autoriser : `ASTECH_ALLOW_WRITES=1` puis redémarrer.
- En **production**, une écriture exige en plus une confirmation explicite (`confirm:"PROD"`).
- Tester d'abord sur la base **TEST** (indices, création/désactivation de comptes, demandes).
- Chaque écriture est journalisée (JSONL) dans le volume `astech-data`.

---

## 6. Clés d'API (référentiels, lecture seule)

```bash
node apikey.js create --name "Partenaire"     # affiche la clé UNE fois
node apikey.js list
node apikey.js revoke <id>
```

Reportez la clé dans `ASTECH_API_KEYS` (`Partenaire:ast_...`) pour la rendre durable,
ou gérez-la depuis l'UI (page « Clés API »).

---

## 7. Exploitation

```bash
docker compose logs -f astech-explorer   # journaux
docker compose restart astech-explorer   # redémarrage
docker compose down                      # arrêt (le volume de données est conservé)
docker compose up -d --build             # reconstruction après mise à jour
```

Mise à jour : `git pull` puis `docker compose up -d --build`.

---

## 8. Dépannage

| Symptôme | Cause probable |
|---|---|
| `DPI-1047` au démarrage | Instant Client non trouvé (image non reconstruite : `--build`). |
| `Cannot find module './apikeys'` | Image ancienne : reconstruire (`--build`). |
| `ORA-01005: null password given` | `ORACLE_ASTECH_PASSWORD` absent de `.env`. |
| Écritures refusées (`403`) | `ASTECH_ALLOW_WRITES` ≠ `1`. |
| Pas de demande de connexion dans Docker | `APM_*` / `ASTECH_REQUIRE_AUTH` non transmis au conteneur (voir `docker-compose.yml`) : le conteneur ne lit pas `.env`. |
| Profil TEST absent de l'UI | Variables `ORACLE_ASTECH_TEST_*` non renseignées. |
