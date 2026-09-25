# ASTECH Explorer — Manifeste de l'application

> **But** : décrire l'application **ASTECH Explorer** (proxy local au-dessus de
> la base Oracle **ASTECH** / schéma `ASTECHIVR`) telle qu'**imaginée**, pour
> servir de spécification à **Google Stitch** afin de générer l'interface
> graphique. Ce document couvre tout ce qui a été demandé : gestion des agents
> (comptes), synchronisation **Studio-RH**, gestion locative, gestion des
> référentiels, gestion des interventions, gestion des indices.

---

## 0. Vision & feuille de route

**ASTECH Explorer** = un **proxy local** (Node.js, HTTP/JSON) en façade de la
base Oracle ASTECH, avec une **UI web**. ASTECH est la source de vérité ; le
proxy agrège et présente les données, et gère une **couche de décision**
(réconciliation RH, indices) avec, in fine, des **écritures contrôlées** (hors
du périmètre strictement lecture seule, voir §7).

Ordre de réalisation :

1. **Agents / comptes** (priorité n°1) — lister et qualifier les comptes
   (utilisateur à droits vs simple agent), les activer/désactiver.
2. **Synchro Studio-RH** — confronter les agents ASTECH et Studio-RH,
   désactiver les orphelins ASTECH, créer les comptes manquants.
3. **Gestion locative** (déjà largement modélisée).
4. **Référentiels** (biens immo, véhicules, matériel…).
5. **Interventions**.
6. **Indices** (gestion + mise à jour depuis Internet).

---

## 1. Contexte technique

- Oracle 19c EE — `10.103.130.25:1523`, service `PIVRY01`, schéma `ASTECHIVR`.
- **node-oracledb en mode thick obligatoire** (thin échoue : `NJS-116`).
- Config via SQLite AppDSI `oracle_settings (type='ASTECH')`, `config.json`, ou
  `ORACLE_ASTECH_*`.
- Port par défaut **8099**. Recherche `UPPER(...) LIKE :q`, `FETCH FIRST n ROWS ONLY`.
- Colonnes Oracle en MAJUSCULES → normaliser en minuscules.
- **Périmètre temporel** : pour la gestion locative, **avant 2024 = essais**
  (reprise) → ignorés. `CUTOFF = 01/01/2024`.
- Le schéma contient **1 212 procédures**, **294 fonctions**, **2 packages**,
  **335 triggers**, **933 vues** (détail §10).

---

## 2. Modules fonctionnels

### 2.1 Agents / comptes (priorité)

**Objectif** : disposer d'une vision propre des personnes connues du logiciel,
avec une distinction essentielle :

- **Utilisateur** = compte **avec droits** (≥ 1 ligne `SBCG_USERPROFIL`) → peut
  se connecter et utiliser le logiciel.
- **Agent simple** = compte **sans droit**. La plupart sont présents car ils ont
  été, à un moment, **bénéficiaires d'EPI** (ou demandeurs ponctuels), pas pour
  utiliser le logiciel.

Autres attributs : actif/inactif, service, rôle, groupes, autorisations.

**Sous-écrans** : liste des agents, fiche agent (identité, droits, groupes,
autorisations), statistiques (total / actifs / utilisateurs / agents simples),
répartition par service et par rôle.

**Chemin d'écriture (création / désactivation)** :
- La création d'un compte = 3 tables + satellites, gérés par des **triggers** :
  1) `USR_ID = MAX(USR_ID)+1` (pas de séquence) puis `INSERT INTO SBCG_USERS` ;
  2) `INSERT INTO DEMANDEUR` → triggers `INS_DEMANDEUR` / `ALL_DEMANDEUR`
     (log `L_MESSAGE`, `AFFECTATIONPERSONNEL`, `DEMANDEURVISU`…) ;
  3) `INSERT INTO SBCG_USERPROFIL` (droits) → triggers `ALL_SBCG_USERPROFIL` qui
     créent les **9 `DEMANDEURAUTH` + 273 `DEMANDEURAUTHP`** par défaut.
  Chemin « officiel » équivalent : `INSUPDDEMANDEUR` / `MAJ_UTILISATEUR`.
- Désactivation : `UPDATE SBCG_USERS SET USR_DATINVALID = …` (aucun trigger sur
  `SBCG_USERS`) et/ou suppression des `SBCG_USERPROFIL` (⚠️ triggers `*_REDIS`).
- **Toujours** via un compte d'écriture **nominatif**, jamais le compte schéma —
  pour l'attribution (§7).

### 2.2 Synchronisation Studio-RH

**Objectif** : confronter les agents ASTECH à la base **Studio-RH**
(`C:\dev\Studio-RH`, application Next.js + Prisma) via son **API** (clé d'API à
fournir ; mécanisme/config à préciser lors de l'intégration).

**Clé d'appariement** : le **matricule** (ASTECH `USR_NAME` / `DEMANDEUR.SDEM_COD`
↔ Studio-RH identifiant agent, cf. `employeeID`).

**Deux listes de travail** :

1. **Comptes ASTECH actifs sans agent actif dans Studio-RH**
   → proposer la **désactivation** dans ASTECH (unitaire ou en masse).
2. **Agents Studio-RH actifs sans compte dans ASTECH**
   → proposer la **création** dans ASTECH en **simple agent** (sans droits),
   unitairement ou en masse.

**Workflow** : *Aperçu (dry-run)* → revue ligne à ligne (cases à cocher) →
*Appliquer* → **journal d'audit**. Aucune écriture sans confirmation explicite.

**Écran « Réconciliation RH »** : tableau à 3 volets (Concordants · À désactiver
dans ASTECH · À créer dans ASTECH), filtres, sélection multiple, actions groupées.

### 2.3 Gestion locative

Voir §3.3 et §4.1 (biens, baux, locataires, échéances à venir/passées, révisions).

### 2.4 Gestion des référentiels

Référentiels transverses (patrimoine et logistique), consultables et
recherchables :

- **Biens immobiliers / patrimoine** (`ARBO`, `ARBO_LOCATIF`, `ARBO_ADR`,
  catégories, sous-catégories, genres).
- **Véhicules / parc roulant** (parc auto, marques, modèles, énergies ; cf.
  tables `PARC*`, `PNEUS`, `FLUID_*` à confirmer à l'étape d'exploration).
- **Matériel / stock** (`STOCK*`, `CATALOGUESTOCK`, `FOURNISSEUR`).
- **Tiers / fournisseurs**, **services**, **groupes**, **types**.

Écrans : liste + fiche par référentiel, filtres, compteurs.

### 2.5 Gestion des interventions

Domaine technique de la GMAO (`INTERVENTIONS*`, `DEMANDES*`, `TACHE*` — noms
exacts à confirmer à l'étape d'exploration).

Écrans : liste des interventions (recherche, filtres date/état/type/bien),
fiche intervention, demandes rattachées, intervenants.

### 2.6 Gestion des indices

- **Lister** les indices présents dans ASTECH (`INDICEINSEE`,
  `INDICEINSEECATEGORIE`) : type (IRL, ILAT, ICC, ILC…), année, trimestre,
  valeur, date de publication.
- **Proposer une mise à jour depuis Internet** : comparer les valeurs ASTECH à
  la **source de référence** (série INSEE de l'IRL/ILAT ; à rechercher et à
  mapper code ASTECH ↔ série INSEE), détecter les manques et écarts, puis
  proposer l'ajout/mise à jour (`INSEE_TAUX`, `INSEE_DATP`), avec validation
  manuelle.

**Écran « Indices »** : table par type, colonnes `code · libellé · année ·
trimestre · valeur ASTECH · valeur source · écart · statut (à jour / à mettre à
jour / manquant)` + action « Récupérer les indices depuis Internet ».

---

## 3. Modèle de données

### 3.1 Agents / comptes

| Entité | Table source | Champs clés |
|---|---|---|
| Compte | `SBCG_USERS` | `USR_ID`, `USR_NAME` (matricule), `USR_DETAIL`, `USR_DATINVALID`, `USR_MAJ`, `USR_DATMAJPWD` |
| Demandeur | `DEMANDEUR` | `SDEM_COD`, `SDEM_USR`, `SDEM_DES`, `SDEM_SSERV`, `SDEM_EMAIL`, `SDEM_AUTHSYS`, `SDEM_ROLEAPP`, `SDEM_ROLEGEST/ORDON/COMPTA`, `SDEM_SIGN` |
| Droits menu | `SBCG_USERPROFIL` | `USR_ID`, `MNU_ID`, `USRP_MNUTAB`, `USRP_SOC`, `USRP_AUTH` (bitmask 0/1/3/7/9/15) |
| Menus | `SBCG_MENUS` | `MNU_ID`, `MNU_IDRES`, `MNU_MOD`, `MNU_OPT` |
| Groupes | `GROUPEUTIL` / `GROUPEUTILDETAIL` | `GRU_COD/DES`, `GRUD_GRP/GRUD_DEM` |
| Autorisations | `DEMANDEURAUTH` / `DEMANDEURAUTHP` | `DEMA_/DEMAP_*` |
| Services | `SERVICE` / `SOUSSERVICE` | `SSER_COD/NOM`, `SSSER_SER` |

**Dérivés** :
- `actif` = `EXISTS(SELECT 1 FROM SBCG_USERPROFIL P WHERE P.USR_ID=U.USR_ID)`
- `type` = `Utilisateur` si droits > 0, sinon `Agent simple`
- `admin` = `ROLEGEST='O' AND ROLEORDON='O' AND ROLECOMPTA='O'`
- `roles` = décodage `SDEM_ROLEAPP` (U/D/R/I/C/A/S)

**Compteurs (2026-09)** : total **4 941** ; actifs **269** ; inactifs/agents
simples **4 672** ; admins **30**.

### 3.2 Synchro Studio-RH

- **ASTECH** : `SBCG_USERS.USR_NAME` (matricule) + `USR_DETAIL` + service
  (`DEMANDEUR.SDEM_SSERV`) + `USR_DATINVALID` + droits (`SBCG_USERPROFIL`).
- **Studio-RH** : agents (Prisma) — identifiant/matricule, nom/prénom, e-mail,
  service/unité, **statut actif**, dates d'entrée/sortie *(schéma exact et
  endpoints API à confirmer lors de l'intégration, clé d'API à fournir)*.

### 3.3 Gestion locative

| Entité | Table source | Champs clés |
|---|---|---|
| Bien | `ARBO` + `ARBO_LOCATIF` + `ARBO_ADR` | `ARB_ID/CODE/DES`, `ARBLOC_*`, `ARBA_*`, catégorie/genre |
| Contrat / bail | `CONTRAT` + `CONTRAT_LOCATIF` | `CONT_ID/COD/DATDEB/DATFIN/ACTIF`, `CONTL_CONTRACTANT/MTACT/DEPMT/DATENTREE/DATSORTIE/DATDEBQUIT/DATCLO/REVID/DATREVD/DATREVP` |
| Rattachement | `CONTRAT_AFF` / `CONTRAT_AFFL` | `CONTAF_ARBID/PRINC`, `CONTAFL_*` |
| Lignes de loyer | `CONTRAT_RUB` | `CONTRU_*` |
| Échéances | `CONTRAT_ECH` (prévisionnel) + `CONTRAT_ECHTERMINEE` (historique) | `CONTEC_DATE/DES/MTHT/MTTC/NUMQUIT/DATQUIT/NUMMAN/DATGF` |
| Révisions | `CONTRAT_REVISION` + `INDICEINSEE` | `CONTRV_*`, `INSEE_*` |

**Règles locatives** : séparation **à venir / passé** sur `CONTEC_DATE` ;
statut `Mandatée` > `Émise` > `Échue (non émise)` > `Planifiée` ; **périmètre
≥ 2024**. Volumes : 249 biens, 263 contrats, 166 locataires, 2 925 échéances
prévisionnelles + 2 086 historiques, 315 révisions.

### 3.4 Référentiels / interventions / indices

Noms de tables **à confirmer** à l'étape suivante (exploration) :
`ARBO*`, `PARC*`, `PNEUS`, `FLUID_*`, `STOCK*`, `CATALOGUESTOCK`,
`FOURNISSEUR*`, `INTERVENTIONS*`, `DEMANDES*`, `TACHE*`, `INDICEINSEE`,
`INDICEINSEECATEGORIE`.

---

## 4. API du proxy (surface proposée)

Base `http://localhost:8099/api`.

### 4.1 Gestion locative (existante)

| Méthode | Endpoint | Paramètres | Réponse |
|---|---|---|---|
| GET | `/dashboard` | — | KPIs + prochaines échéances + dernières quittances + derniers contrats |
| GET | `/biens` | `q` | `{ rows }` |
| GET | `/bien/:id` | — | `{ bien, contrats, futures, passees }` |
| GET | `/locataires` | `q` | `{ rows }` |
| GET | `/locataire` | `name` | `{ locataire, contrats, futures, passees }` |
| GET | `/contrats` | `q` | `{ rows }` |
| GET | `/contrat/:id` | — | `{ contrat, futures, passees }` |
| GET | `/quittances` | `q` | `{ futures, passees }` |

### 4.2 Agents / comptes

| Méthode | Endpoint | Paramètres | Réponse |
|---|---|---|---|
| GET | `/agents` | `q`, `type` (utilisateur/simple/all), `actif`, `service`, `role`, `page` | `{ rows, total, stats }` |
| GET | `/agent/:matricule` | — | `{ compte, demandeur, droits, groupes, autorisations, epi }` |
| GET | `/agents/stats` | — | `{ total, actifs, utilisateurs, agents_simples, admins, par_service, par_role }` |
| GET | `/services` | `q` | `{ rows }` |
| GET | `/groupes` | `q` | `{ rows }` |
| GET | `/roles` | — | `[ { lettre, libelle, nb } ]` |
| GET | `/menus` | — | arbre des menus |

### 4.3 Synchronisation Studio-RH

| Méthode | Endpoint | Paramètres | Réponse |
|---|---|---|---|
| GET | `/sync/rh/preview` | `scope` | `{ concordants, orphelins_astech, orphelins_rh, stats }` |
| POST | `/sync/rh/desactiver` | `matricules[]`, `dryRun` | résultats + journal |
| POST | `/sync/rh/creer` | `agents[]`, `dryRun` | résultats + journal |
| GET | `/sync/rh/journal` | `date`, `action` | historique des actions |

### 4.4 Référentiels / interventions / indices

| Méthode | Endpoint | Paramètres | Réponse |
|---|---|---|---|
| GET | `/referentiels/:type` | `q` | `{ rows }` (`type` = `biens`, `vehicules`, `materiel`, `tiers`, `services`…) |
| GET | `/referentiels/:type/:id` | — | fiche |
| GET | `/interventions` | `q`, `du`, `au`, `etat`, `type`, `bien` | `{ rows }` |
| GET | `/intervention/:id` | — | fiche + demandes + intervenants |
| GET | `/indices` | `type`, `annee` | `[ indice ]` |
| GET | `/indices/verifier` | `type` | comparaison ASTECH ↔ source Internet |
| POST | `/indices/maj` | `indices[]`, `dryRun` | propositions / application + journal |

### 4.5 Principes transverses

- Filtres `q` (plein-texte casse-insensible) + filtres dédiés ;
- tri/pagination explicites ; plafond serveur (300–500) ;
- erreurs `{ error }` + code HTTP ;
- aucun secret exposé.

---

## 5. Règles métier transverses

| Indicateur | Règle |
|---|---|
| Compte **actif** | ≥ 1 ligne `SBCG_USERPROFIL` |
| **Utilisateur** vs **agent simple** | droits > 0 / droits = 0 |
| **Admin** | GEST+ORDON+COMPTA = `O` (30) |
| Échéance **à venir** | `CONTEC_DATE >= TRUNC(SYSDATE)` et `>= 01/01/2024` |
| Statut échéance | Mandatée > Émise > Échue (non émise) > Planifiée |
| **Orphelin ASTECH** | actif ASTECH **et** pas d'agent actif Studio-RH |
| **Orphelin RH** | agent actif Studio-RH **et** pas de compte ASTECH |
| Indice **à jour** | `INSEE_TAUX` ASTECH = valeur source |

---

## 6. Écrans UI à générer (pour Google Stitch)

### 6.0 Layout global

Header sombre (`#0f172a`) : titre, navigation **Tableau de bord · Agents ·
Synchro RH · Biens · Locataires · Contrats · Échéances · Référentiels ·
Interventions · Indices**, recherche globale. Contenu 1400 px max, cartes
blanches arrondies, badges compteurs, états vide/chargement/erreur.

### 6.1 Tableau de bord

KPIs : Biens · Contrats (actifs) · Locataires · Échéances (≥2024) · Éclôturées ·
Total loyers · **Agents (total / actifs / utilisateurs / simples / admins)** ·
**Orphelins RH**. Cartes : Derniers contrats, Prochaines échéances, Dernières
quittances, **Alertes synchro RH**.

### 6.2 Agents

- **Liste** : `Matricule · Nom · Service · Rôle (badges) · Type (Utilisateur /
  Agent simple) · Actif · Admin · Nb droits · Dernière MAJ`.
- **Filtres** : recherche, segment **Utilisateurs / Agents simples / Tous**,
  Actifs/Inactifs, service, rôle, admin.
- **Fiche** : Identité · Droits (menus + niveau) · Groupes · Autorisations ·
  historique EPI/demandes.
- **Stats** : répartition par service / rôle / type.

### 6.3 Synchro RH

- Bandeau compteurs : concordants, **à désactiver (ASTECH)**, **à créer (ASTECH)**.
- Trois tableaux avec cases à cocher, badges source, filtres, actions groupées.
- Boutons **Aperçu (dry-run)** / **Appliquer la sélection** + confirmation.
- Journal d'audit.

### 6.4 Locative

- **Biens** : liste + fiche (caractéristiques, baux, échéances à venir/passées).
- **Locataires** : liste + fiche (contrats, échéances).
- **Contrats** : liste + fiche (dates bail/contrat, quittancement depuis,
  clôture, révisions, échéances).
- **Échéances** : onglets **À venir** (asc) / **Passées** (desc), couleurs de
  statut, filtres.

### 6.5 Référentiels

- Sélecteur de référentiel (biens immo, véhicules, matériel, tiers, services…),
  liste + recherche + fiche.

### 6.6 Interventions

- Liste filtrable (date, état, type, bien) + fiche (détail, demandes,
  intervenants).

### 6.7 Indices

- Table par type (IRL/ILAT/…), colonnes `valeur ASTECH · valeur source · écart ·
  statut` + bouton **Récupérer les indices depuis Internet** + validation.

---

## 7. Contraintes, écritures & sécurité

- **Lecture seule par défaut** (production tierce).
- Les actions **désactiver / créer / mettre à jour** sont des **écritures
  contrôlées** : hors lecture seule, à autoriser explicitement, **toujours
  avec dry-run, confirmation et journal d'audit**. Prévoir un compte/mode
  d'écriture dédié.
- **Attribution & audit (traçabilité obligatoire)** : l'état actuel d'ASTECH est
  **faiblement attribuable** (écritures avec le compte schéma `ASTECHIVR`, logs
  `L_MESSAGE` sans acteur, `SBCG_TRACE`/`SBCG_AUTH` limités au client, pas
  d'audit Oracle). Le proxy doit imposer :
  - **comptes nominatifs / de service dédiés** (jamais le compte schéma) ;
  - **Oracle Unified Auditing** sur `SBCG_USERS`, `DEMANDEUR`, `SBCG_USERPROFIL`,
    `DEMANDEURAUTH(P)` et `EXECUTE` de `INSUPDDEMANDEUR`/`MAJ_UTILISATEUR` ;
  - journaux **centralisés/WORM** + séparation des rôles ;
  - renseigner `CLIENT_IDENTIFIER`/`MODULE`/`ACTION` et enrichir les triggers
    avec `SYS_CONTEXT('USERENV','OS_USER'|'SESSION_USER'|'IP_ADDRESS')` ;
  - **journal fonctionnel du proxy** : acteur, cible, avant/après, dry-run,
    horodatage — toute action non attribuable = alerte ;
  - identité opérateur : compte DB **nominatif** + `DBMS_SESSION.SET_IDENTIFIER`
    / `DBMS_APPLICATION_INFO` ; l'audit doit nommer l'agent (ex. `0015425`
    CHEVALIER MARC). **On ne masque pas l'usage d'un outil** et on n'usurpe
    l'identité de personne.
- **Ne jamais exposer** : `USR_PWD`, `USR_COMPTAPWD`, `SDEM_CODACCES`,
  `USR_ES_API_KEY`, `SDEM_MAILPWD`.
- Clé d'API Studio-RH : stockée côté serveur (env/config), jamais dans l'UI
  ni dans un fichier commité.
- Pièges : historique quittance tronqué à 2024 ; `CONTRAT_ECH` contient des
  échéances passées non émises ; plusieurs baux par bien/locataire ;
  `USR_DATINVALID` ≠ actif ; `V_OP_DEMANDEUR.VALID_ACCES` toujours NULL.

---

## 8. Design tokens (repris de l'app existante)

| Token | Valeur |
|---|---|
| Fond | `#f1f5f9` |
| Carte | `#ffffff` |
| Encre | `#0f172a` |
| Texte secondaire | `#64748b` |
| Lignes | `#e2e8f0` |
| Marque | `#1d4ed8` / bouton `#2563eb` |
| Header | `#0f172a`, texte `#cbd5e1` |
| Police | Inter / Segoe UI / Roboto |
| Rayons | 8–12 px |

Statuts échéances : Planifiée `#2563eb`, Échue `#d97706`, Émise `#16a34a`,
Mandatée `#7c3aed`. Synchro : à créer `#16a34a`, à désactiver `#dc2626`,
concordant `#64748b`.

---

## 9. Mapping écran → endpoints

| Écran | Endpoints |
|---|---|
| Tableau de bord | `/api/dashboard`, `/api/agents/stats`, `/api/sync/rh/preview` |
| Agents | `/api/agents`, `/api/agent/:matricule`, `/api/services`, `/api/groupes`, `/api/roles`, `/api/menus` |
| Synchro RH | `/api/sync/rh/preview`, `/api/sync/rh/desactiver`, `/api/sync/rh/creer`, `/api/sync/rh/journal` |
| Biens | `/api/biens`, `/api/bien/:id` |
| Locataires | `/api/locataires`, `/api/locataire?name=` |
| Contrats | `/api/contrats`, `/api/contrat/:id`, `/api/contrat/:id/revisions` |
| Échéances | `/api/quittances` (+ `/bien/:id`, `/locataire`, `/contrat/:id`) |
| Référentiels | `/api/referentiels/:type` |
| Interventions | `/api/interventions`, `/api/intervention/:id` |
| Indices | `/api/indices`, `/api/indices/verifier`, `/api/indices/maj` |

---

## 10. Inventaire Oracle `ASTECHIVR`

| Type d'objet | Nombre |
|---|---|
| **PROCEDURE** | **1 212** |
| **FUNCTION** | **294** |
| PACKAGE / PACKAGE BODY | 2 / 1 |
| TRIGGER | 335 |
| TABLE | 715 |
| VIEW | 933 |
| INDEX | 938 |
| SEQUENCE | 3 |

Procédures/fonctions notables : `F_CALCUL_REVIS`, `CONTRAT_ECHEANCIER(_LIGNES)`,
`CONTRAT_ECH_NUM`, `CHANGEMENT_TVA_ECHEANCES`, `MAJ_UTILISATEUR`,
`F_HAVE_AUTH_DEMANDEUR`, `DEMANDEURAUTH_ATTRIBAUTO`.

---

## 11. Étapes suivantes (après validation du manifeste)

1. **Explorer les tables** : agents/droits (fine), référentiels (véhicules,
   matériel), interventions, EPI, indices ; confirmer les noms/colonnes.
2. **Mettre à jour la SKILL** de compréhension de la base avec ces trouvailles.
3. **Intégrer Studio-RH** : confirmer schéma Prisma, endpoints API et clé.
4. Implémenter les endpoints proxy (agents, sync, référentiels, interventions,
   indices) puis les écrans.
