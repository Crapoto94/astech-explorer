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
7. **Documents associés (GED)** — inventaire des tables/champs porteurs de
   documents, chemins de stockage, dépôts par date, modèle hybride.

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

Domaine GMAO — **implémenté** (exploré 2026-09). Tables : `INTERVENTIONS` (en
cours) **UNION** `INTERVENTIONSTERMINEES` (clôturées), `DEMANDES` /
`DEMANDESTERMINEES` (+ `*DETAIL`), `TACHE`/`TACHEAFFECT`, `AFFECTATIONINTERVENTION`.

- **Interventions** : liste paginée (recherche, filtres période/état/type),
  fiche intervention + demandes rattachées. Vue `INTERV_SELECT` = UNION des deux
  tables, jointe à `ARBO`/`SERVICE`.
- **Demandes d'intervention** : bouton « Demande d'intervention » ouvrant une
  **modale** reprenant tous les champs d'une `DEMANDE` (nature→`TYPE`, degré→
  `DEGRE`, urgence, dates, objet, bien `ARBO`, service `SOUSSERVICE`, catégorie/
  sous-catégorie `CATEGORIE_LOC`/`SOUSCATEGORIE_LOC`, demandeur, complément).
  Endpoint des listes déroulantes : `GET /api/demandes/options`. Création
  effective conditionnée à `ASTECH_ALLOW_WRITES`.
- NB : ~95 000 interventions historiques ; le rattachement
  `INTERVENTIONS.SSIG_ARBO = ARBO.ARB_ID` peut nécessiter un cast
  (`TO_CHAR`) dans les `UNION` (sinon `ORA-01722`).
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

### 2.7 Documents associés (GED)

**Objectif** : inventorier où sont stockés les documents dans ASTECH, montrer
les **chemins de stockage** et les **dépôts par date**, et expliquer le
**modèle documentaire hybride**.

- **Modèle hybride** : (1) **GED centrale** = table `DOC` (+ satellites
  `DOC_ANNEX`, `DOC_DEMAT`, `DOC_HISTO`) ; (2) **rattachement polymorphe**
  `DOC_AFFECT` (`DAFF_FRM` formulaire + `DAFF_ENTID` identifiant, sans clé
  étrangère) ; (3) **champs document dédiés** dans une vingtaine de tables
  (`CONTRAT_LOCATIF.CONTL_PJ1..15`, `DEMANDEUR.SDEM_REPDOC`, `BIMMAQ_IE.MIE_FILE`,
  `*_ENGRATTACH`, `OP_*`, `GFI_INT_LIQR`, `SIG*`, `DF_FORM_ENDPOINT`…) — la GED
  centrale reste la source quasi unique, les champs dédiés sont surtout vides.
- **Fichiers uniques** : `DOC` contient **plusieurs lignes par même fichier**
  (doublons / versions). L'UI regroupe par **fichier unique** (`DOC_FOLDER` +
  `DOC_FILE`) et affiche le **nombre de versions** (`DOC_REVIS`) et
  d'enregistrements.
- **Chemins** : arborescence **dépliable** des `DOC_FOLDER` (UNC/Windows,
  ex. `\\tsclient → C → Documents and Settings → …`) avec comptage cumulé par
  niveau ; dépliage d'un dossier = liste de ses fichiers.
- **Par date** : arborescence **année → mois → jour** sur `DOC.DOC_CDATE` (date
  de dépôt) ; déplier un jour liste les fichiers déposés (avec versions).
- **Filtre** : bouton « Masquer les PJ de POSTE004 » (`?excludePoste=1`) qui
  retire le dossier très majoritaire `\\POSTE004\C$\TEMP` de tous les agrégats.

---
### 2.8 Parc automobile (implémenté)

Un véhicule est un `ARBO` de **genre `GVEH`** (`ARB_REF` = immatriculation,
`ARB_SERIE` = n° de série). Vue pivot **`V_PARC_COMSMA`** (filtre `CATEGORIE='GVEH'`,
**665 véhicules**) :

- Identité : marque/modèle (via `ARBO_MATE` → `PATRIMARQUE`/`PATRIMODELE`,
  **vides en base** ; libellé souvent dans `ARB_DES`), année, n° inventaire,
  sous-catégorie (`ARB_SCAT` : 96 libellés parc, ex. `G.KANGOOVL`).
- Compteurs/kilométrage : `ARBO_NRJ` (`ARBN_CPTACT1`, carburant, conso, type).
- Affectation : `ARBO_AFFP` → `DETAIL.PSOC_DES` (structure/service).
- État & valorisation : états général/carrosserie/intérieur/pneus, valeur
  comptable (`ARBO_PLAN.ARBPL_VNCFIN`), valeur estimée — issus du formulaire
  `PATRI_FORM` (`FRM_FRMID=2`, rubriques `FRM_CTRID` : 0=propriétaire, 3/31=
  état méca, 5=carrosserie, 7=PV, 8=CR accident, 9=intérieur, 11=général,
  13=pneus, 34=réparations). La table `VEH_CERTIF` (`VCI_ARBOID`/`VCI_RUBID`/
  `VCI_VAL`) reprend ces rubriques.
- **Conducteurs & permis** : `PERMIS` (18 catégories), `PERMISCONDUCTEUR`
  (`SPERM_CON` = matricule `DEMANDEUR.SDEM_COD`, `SPERM_CAT`, dates `DATCAT`/
  `DATVAL`) — **901 habilitations**. Autorisations prêt/loc véhicule :
  `DEMANDEURGRPAUTH.DGA_PRETVEH`/`DGA_LOCVEH_*`.
- **Sinistres** : `SINISTRE` (+ `SINISTRECOUT`/`TIERS`/`TYPE`, **vides**).
- Réservations/prêts : pas de table dédiée vivante ; dispo via
  `ARBO_MATE.ARBMA_DISPO`/`INDISPO*` ; `TOURNEES`/`PLANNINGAGENT` **vides**.
- **Contrôle technique** : aucune table dédiée (rubriques dans `PATRI_FORM`).
- Endpoints `/api/parc` (+ `stats`, `permis`, `/vehicule/:id`) ; UI `#/parc`
  (onglets Véhicules / Permis).

### 2.9 Magasins & stock (implémenté)

Un magasin est une **structure** `V_SOCIETES` (code) ; les articles sont dans
`STOCK` via `STOCK.SREF_SOC = V_SOCIETES.COD` (11 magasins : 30, 35, 41, 85,
69, 5A…). Colonnes utiles : `SREF_COD`/`SREF_DES`/`SREF_FAM`/`SREF_SOUFAM`,
`SREF_NSTOCK` (stock), `SREF_PUMP` (PAMP), emplacement
`SREF_ALL`/`SREF_TRAV`/`SREF_CASIER`/`SREF_POS`. Endpoints `/api/magasins`,
`/api/magasin/:code` ; UI `#/magasins`.

### 2.10 Procédures stockées & triggers (implémenté)

Visualisation du code serveur (`ALL_OBJECTS`/`ALL_SOURCE`) : **1 509 objets**
(1 212 procédures, 294 fonctions, 2 packages, **335 triggers**). Classement par
**domaine** (préfixe du nom : `RPT*`=rapports 705, `BO_*`=Business Objects 96,
`OP_*`=opérations, `F_*`=fonctions, `P_*`/`SP_*`=API/transactions…) et, pour les
triggers, par **table cible**. Description générique déduite du nom. Filtres
**type** et **statut valide/invalide** ; fiche = source PL/SQL. Endpoints
`/api/procedures` (+ `?q&type&group`) et `/api/procedure/:name?type=` ; UI
`#/procedures`.

### 2.11 Authentification AD (implémenté)

Connexion des agents via l'**APM de la Ville** :
`POST {APM_API_URL}/api/v1/ad/authenticate` (header `X-API-KEY`, permission
`ad_auth`). Le proxy émet ensuite un **jeton de session HMAC** (`X-ASTECH-Token`,
TTL 8 h) ; aucun mot de passe n'est stocké. Écran de connexion + pastille agent
dans l'en-tête. Variables : `APM_API_URL`, `APM_API_KEY`, `ASTECH_REQUIRE_AUTH`,
`ASTECH_AGENT_ALLOW`/`DENY`, `ASTECH_SESSION_SECRET`, `ASTECH_SESSION_TTL_MS`.
Voir `GUIDE_NOUVELLE_APP_VILLE.md` §3.2.


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

### 3.5 Documents — GED (exploré 2026-09)

| Élément | Table / colonne | Rôle |
|---|---|---|
| Document | `DOC` (9 413 lignes) | 1 ligne = 1 document ; `DOC_FOLDER` (chemin), `DOC_FILE` (fichier), `DOC_REF`, `DOC_TITRE`, `DOC_OBS`, `DOC_KEYW` |
| Thème / module | `DOC_THEME` (`DOC.DOC_THEME`) | 26 thèmes, 12 porteurs : `PHDI`, `PHFAC`, `PLAN`, `CTAMIANT`, `FPV`, `PHSIT`, `PHART`, `PERMIS`… |
| Type / stockage | `V_DOCTYPE`, `V_DOCSTOCKG` | type `BUREAUTIQUE/IMAGE/VIDEO/PLAN/URL` ; stockage `BASE/EXTERN/INTERN` |
| Cycle de vie | `DOC` | `DOC_CDATE` (dépôt), `DOC_CUSER`, `DOC_MDATE`, `DOC_MUSER`, `DOC_DATE`, `DOC_VDATE`/`DOC_VUSER`, `DOC_PUBLIE`, `DOC_REVIS`, `DOC_EPUR(D)` |
| Rattachement | `DOC_AFFECT` | `DAFF_DOCID` → `DOC`, `DAFF_FRM` (formulaire <br>`26`=demande, `1`=patrimoine, `13`=amiante, `23`=permis, `2`=intervention, `25`=contrat locatif), `DAFF_ENTID` |
| Satellites | `DOC_ANNEX`, `DOC_DEMAT`, `DOC_KEYW`, `DOC_CARACT`, `TOPIC_DOC`, `DOCJ` | annexes, dématérialisé, mots-clés, caractéristiques, liens |
| Historique versions | `DOC_HISTO` (2 804 lignes / 2 222 docs) | `DOCH_DOCID`, `DOCH_REVIS`, `DOCH_FILE`, `DOCH_FOLDER`, `DOCH_SIZE`, `DOCH_STOCKG`, `DOCH_MUSER`, `DOCH_MDATE` |
| Vue | `V_DOC` | projection lisible (libellés thème/type/stockage, noms d'utilisateurs) |

**Versionning : oui** — `DOC.DOC_REVIS` = n° de révision (463 docs > 1, max 7) ;
les versions précédentes sont archivées dans **`DOC_HISTO`** (chemin/fichier/taille
par révision). Historique de références de fichiers, sans branches ni diff.

**Volumes / pièges** : `DOC` = **9 413 enregistrements mais seulement 6 335
fichiers uniques** (multi-rows par fichier ; ex. `picture.jpg` = 2 112 lignes,
281 groupes de doublons). Chemins = **354 dossiers**, dominés par
`\\POSTE004\C$\TEMP` (**7 191 enregistrements / 4 724 fichiers**, soit ~76 %).
En excluant POSTE004 : 2 222 enregistrements / 1 611 fichiers uniques. Autres
champs porteurs : `CONTRAT_LOCATIF.CONTL_PJ1..15` (0 rempli),
`DEMANDEUR.SDEM_REPDOC` (12), `BIMMAQ_IE.MIE_FILE` (vide).

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

### 4.5 Documents associés (GED)

| Méthode | Endpoint | Paramètres | Réponse |
|---|---|---|---|
| GET | `/documents` | `excludePoste=1` | modules, champs document, thèmes, types, stockages, chemins (fichiers uniques + enregistrements), transversal, `meta`, `versioning`, derniers docs |
| GET | `/documents/fichiers` | `folder`, `limit`, `offset` | fichiers uniques d'un dossier (+ nb de versions / enregistrements) |
| GET | `/documents/dates` | `excludePoste=1` | agrégat année/mois/jour (`DOC_CDATE`) en fichiers uniques + enregistrements |
| GET | `/documents/jour` | `date=YYYY-MM-DD`, `excludePoste=1` | fichiers uniques déposés ce jour |

### 4.6 Principes transverses

- Filtres `q` (plein-texte casse-insensible) + filtres dédiés ;
- tri/pagination explicites ; plafond serveur (300–500, 2 000 pour les listes) ;
- erreurs `{ error }` + code HTTP ;
- aucun secret exposé ;
- **authentification AD** (voir §7) : si `ASTECH_REQUIRE_AUTH=1`, toute route
  `/api/*` exige un jeton de session valide (`X-ASTECH-Token`).

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
| **Fichier document unique** | `(DOC_FOLDER, DOC_FILE)` — `DOC` peut contenir N lignes du même fichier |
| **Versions document** | `COUNT(DISTINCT DOC_REVIS)` + lignes `DOC_HISTO` |
| **PJ POSTE004** | `UPPER(NVL(DOC_FOLDER,' ')) LIKE '\\POSTE004\%'` |

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

### 6.8 Documents associés (GED)

- **Onglets** : Modules & thèmes · Tables & champs · Chemins de stockage ·
  Par date de dépôt · Transversal.
- **Modules & thèmes** : carte *Modèle documentaire hybride* (GED centrale,
  rattachement polymorphe `DOC_AFFECT`, champs dédiés) + carte *Métadonnées GED &
  versionning* (champs `DOC_*`, compteurs de révisions / archive `DOC_HISTO`),
  classification des thèmes, derniers documents.
- **Chemins de stockage** : arborescence dépliable (bascule Arborescence/Liste),
  nombre de **fichiers uniques** cumulé par nœud et « N ici », dépliage d'un
  dossier → liste des fichiers (extension, thème, nb de versions, taille, date).
- **Par date de dépôt** : arborescence année → mois → jour, dépliage d'un jour →
  fichiers déposés ce jour.
- **Transversal** : documents par entité (agent, bien, contrat, véhicule,
  intervention, permis, amiante, article).
- **Filtre** : bouton **« Masquer les PJ de POSTE004 »** (recalcule tout).

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
- **Authentification AD (APM de la Ville)** : `POST {APM_API_URL}/api/v1/ad/authenticate`
  (header `X-API-KEY`) ; le proxy délivre un **jeton de session signé HMAC**
  (`X-ASTECH-Token`, TTL 8 h). Variables : `APM_API_URL`, `APM_API_KEY`,
  `ASTECH_REQUIRE_AUTH` (1 = connexion obligatoire), `ASTECH_AGENT_ALLOW/DENY`,
  `ASTECH_SESSION_SECRET`, `ASTECH_SESSION_TTL_MS`. Aucun mot de passe stocké.
- Pièges : historique quittance tronqué à 2024 ; `CONTRAT_ECH` contient des
  échéances passées non émises ; plusieurs baux par bien/locataire ;
  `USR_DATINVALID` ≠ actif ; `V_OP_DEMANDEUR.VALID_ACCES` toujours NULL ;
  `DOC` contient plusieurs lignes par même fichier (versions/doublons) — toujours
  regrouper par `(DOC_FOLDER, DOC_FILE)`.

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
| Interventions | `/api/interventions`, `/api/intervention/:id`, `/api/demandes/options` |
| Indices | `/api/indices`, `/api/indices/verifier`, `/api/indices/pousser` |
| Docs associés (GED) | `/api/documents`, `/api/documents/fichiers`, `/api/documents/dates`, `/api/documents/jour` |
| Parc auto | `/api/parc`, `/api/parc/stats`, `/api/parc/permis`, `/api/parc/vehicule/:id` |
| Magasins | `/api/magasins`, `/api/magasin/:code` |
| Procédures & triggers | `/api/procedures`, `/api/procedure/:name` |
| Auth AD | `/api/auth/login`, `/api/auth/whoami`, `/api/auth/logout` |
| Profils & env | `/api/config`, `/api/env` |
| Synchro RH (écritures) | `/api/sync/rh/desactiver`, `/api/sync/rh/creer`, `/api/sync/rh/journal` |
| API publique v1 | `/api/v1/referentiels`, `/api/v1/referentiels/:type(/:id)`, `/api/admin/keys` |

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
`F_HAVE_AUTH_DEMANDEUR`, `DEMANDEURAUTH_ATTRIBAUTO`, `CREATIONINTERVENTION`,
`SP_CLOTURE_INTERVENTION`, `TERMINERDEMANDE`, `GETNEXTVALUE2`.

> Objets **INVALID** (non recompilés) constatés : 706 procédures, 79 fonctions,
> 52 triggers, 272 vues. Familles de procédures : `RPT*` (rapports, 705),
> `BO_*` (Business Objects, 96), `OP_*`, `F_*`, `P_*`, `SP_*`…
> Triggers classés par table cible ; types `BEFORE/AFTER EACH ROW`, `COMPOUND`,
> `AFTER STATEMENT`.

---

## 11. État d'avancement

**Implémenté** (appli `C:\dev\astech-explorer`, Node + Oracle thick, port 8099) :
tableau de bord, agents/comptes (+ filtre actif/inactif, création/désactivation),
synchro Studio-RH (+ réconciliation), gestion locative (biens, contrats,
échéances/quittances, révisions), référentiels (+ API v1 à clé), interventions &
**demandes d'intervention**, indices (confrontation INSEE BDM + pousser), **parc
automobile**, **magasins/stock**, **GED documents**, **procédures stockées &
triggers**, **auth AD (APM)**, profils **prod/test**, sélecteur de pagination,
clés d'API. Déploiement Docker (`Dockerfile` + `docker-compose.yml`) via
`pulldocker`.

**Reste à faire** : intégrer Studio-RH (schéma Prisma complet), écritures
« demandes d'intervention » (INSERT `DEMANDES` + trigger `INS_DEMANDES_ID`),
affiner les descriptions de procédures (commentaires source), contrôle technique
du parc (pas de table dédiée), recompilation des objets `INVALID` côté ASTECH.
