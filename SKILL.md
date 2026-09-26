---
name: astech
description: >-
  Accès direct à la base Oracle du progiciel ASTECH (GMAO / gestion technique
  et patrimoine de la Ville) — schéma `ASTECHIVR`, Oracle 19c, service
  `PIVRY01`. C'est la source de vérité pour les biens/patrimoine (`ARBO_*`),
  interventions, contrats, fournisseurs, stocks, fluides, sinistres, etc., dont
  AppDSI ne reprend qu'une copie partielle côté PostgreSQL (schéma `oracle`
  synchronisé via `backend/modules/oracle/`, type `ASTECH`). Explique comment se
  connecter à l'Oracle réel (paramètres en SQLite `oracle_settings`, type
  `ASTECH`) et surtout pourquoi le mode *thin* de node-oracledb échoue
  (`NJS-116`, vérificateur de mot de passe 10G) et comment contourner (Instant
  Client + SQL*Plus / mode *thick*). Décrit le modèle **utilisateurs & rôles** :
  `SBCG_USERS` (matricule = `USR_NAME`), `DEMANDEUR.SDEM_ROLEAPP` (chaîne de
  lettres décodée : U/D/R/I/C/A/S), les flags gestionnaire/ordonnateur/comptable
  (= « admin »), les groupes `GROUPEUTIL`/`GROUPEUTILDETAIL`, les droits par menu
  `SBCG_USERPROFIL.USRP_AUTH`, et le lien avec l'AD/SSO (e-mail `SDEM_EMAIL`,
  mapping `V_LDAP_ATTRIB` ↔ `sAMAccountName`). Déclencher dès qu'on parle
  d'ASTECH, de GMAO, de patrimoine/interventions/contrats côté ASTECH, du schéma
  Oracle `ASTECHIVR`, de synchro Oracle `ASTECH`, ou de recherche d'utilisateurs
  et de rôles ASTECH.
---

# ASTECH — accès Oracle direct (schéma `ASTECHIVR`)

## Contexte

**ASTECH** est le progiciel de **GMAO / gestion technique et patrimoine** de la
collectivité. AppDSI n'en réplique qu'une **copie partielle** côté PostgreSQL
(schéma `oracle`, type de synchro `ASTECH`, tables `oracle.astech_*` — voir
`backend/modules/oracle/`). Pour toute question fine (utilisateurs, rôles,
patrimoine, interventions), il faut se connecter **directement à l'Oracle
ASTECH**.

> ⚠️ Système de **production tiers**. Interroger par défaut en **lecture seule**
> (`SELECT`). Ne rien écrire sans autorisation explicite de l'utilisateur.

- Serveur : `10.103.130.25:1523`, **service `PIVRY01`**, **Oracle 19c EE**.
- Compte applicatif : **`ASTECHIVR`** (propriétaire : ~715 tables, ~1200
  procédures, ~933 vues).
- Paramètres de connexion (host/port/service/utilisateur/mot de passe) : table
  **SQLite** `oracle_settings`, ligne **`type = 'ASTECH'`**
  (`backend/data/database.sqlite`). Dans AppDSI : Admin → Oracle → carte
  **ASTECH**. (Ne pas confondre avec la table Postgres homonyme des migrations
  `010-012`, restée vide.)

## Se connecter

### Pourquoi le mode *thin* échoue

`node-oracledb` v6 utilise par défaut le mode **thin** (pur JS, sans client
Oracle). Sur ASTECH il renvoie :

```
NJS-116: password verifier type 0x939 is not supported by node-oracledb in Thin mode
```

Cause : le serveur négocie le **vérificateur de mot de passe « 10G » (0x939)**,
non supporté en thin. (Les autres types Oracle d'AppDSI — `FINANCES` sur le même
hôte port 1527, `RH`, `DELIB` — passent en thin.) Deux issues :

1. **SQL*Plus en mode thick** (recommandé pour explorer/requêter à la main).
2. Côté serveur Oracle : `SQLNET.ALLOWED_LOGON_VERSION_SERVER=12` (+ `_CLIENT`)
   dans `sqlnet.ora`, `lsnrctl reload`, puis `ALTER USER ASTECHIVR IDENTIFIED BY
   "<mdp>";` — pour que le thin fonctionne.

### Option 1 — SQL*Plus / Instant Client (thick)

Télécharger **Oracle Instant Client 21c** (basic + sqlplus), extraire, ajouter le
dossier au `PATH`, puis :

```powershell
# URLs directes (dossier versionné) :
# …/otn_software/nt/instantclient/2123000/instantclient-basic-windows.x64-21.23.0.0.0dbru.zip
# …/otn_software/nt/instantclient/2123000/instantclient-sqlplus-windows.x64-21.23.0.0.0dbru.zip
$ic = '<chemin>\instantclient_21_23'
$env:PATH = "$ic;$env:PATH"
& "$ic\sqlplus.exe" -S /nolog
```

Easy Connect (sans `tnsnames.ora`) :

```
connect ASTECHIVR/<mot_de_passe>@10.103.130.25:1523/PIVRY01
```

Lire le mot de passe depuis `oracle_settings (type='ASTECH')` plutôt que de le
saisir en clair ; ne jamais laisser traîner un fichier SQL contenant le `connect`.

### Option 2 — node-oracledb en mode thick

```js
const oracledb = require('oracledb');
oracledb.initOracleClient({ libDir: '<chemin>\\instantclient_21_23' }); // AVANT getConnection
// puis getConnection({ user, password, connectString: `${host}:${port}/${service}` })
```

(En Docker, le mode thick exige d'embarquer Instant Client : image Debian/glibc,
pas `node:lts-alpine`. À réserver au local, sauf refonte d'image.)

## Modèle utilisateurs & rôles

### Utilisateurs — `SBCG_USERS` (~4 940 lignes)

| Colonne | Sens |
|---|---|
| `USR_ID` | PK (utilisée partout comme clé utilisateur) |
| `USR_NAME` | **matricule** (7 chiffres, ex. `0015425`) — identifiant de connexion ASTECH |
| `USR_DETAIL` | « NOM PRÉNOM » (ex. `CHEVALIER MARC`) |
| `USR_PWD` | code d'accès **chiffré** (base64, réversible — pas un vrai hash) |
| `USR_DATMAJPWD` | date de dernière écriture du mot de passe/code |
| `USR_DATINVALID` | date d'invalidité du compte |
| `USR_DEM`, `USR_GRPDEM`, `USR_SOC`, `USR_LANGID` | indicateurs (SOC=99, LANGID=1036) |

Colonnes `NOT NULL` (défauts) : `USR_ID` (PK), `USR_NAME`, `USR_PROP`(0),
`USR_LANGID`(1036), `USR_SOC`, `USR_MAJ`(sysdate), `USR_DEM`('N'),
`USR_GRPDEM`(1), `USR_NBR`(0), `USR_DATMAJPWD`(sysdate). **Pas de séquence**
pour `USR_ID` (l'appli fait `MAX+1`). Aucun trigger sur `SBCG_USERS`.

> ASTECH s'identifie par **matricule**, **pas** par login AD : `nchemame` /
> `machevalier` / `mchevalier` n'existent pas dans `SBCG_USERS`.

### Compte « actif » / « inactif »

⚠️ **Trois notions distinctes — ne pas les confondre** :

1. **`DEMANDEUR.SDEM_SIGN`** (`CHAR(1)` : `'O'`/`'N'`) = **le vrai flag « actif »
   d'ASTECH**. C'est lui que l'écran de gestion des utilisateurs compte comme
   *comptes actifs*. Constaté 2026-09 : **2 655** `'O'` / **2 285** `'N'`.
   *(Correction : la SKILL indiquait auparavant « actif = ≥ 1 `SBCG_USERPROFIL` » ;
   c'était la bonne définition de « utilisateur avec droits », pas du statut actif.)*
2. **`SBCG_USERPROFIL`** (droits/menus) = distingue un **utilisateur avec droits**
   (≥ 1 ligne → peut se connecter et utiliser le logiciel) d'un simple
   **demandeur / agent** (0 ligne : EPI, demandes ponctuelles) : **269** / **4 672**.
3. **`SBCG_USERS.USR_DATINVALID`** (DATE, nullable) = date d'invalidation
   programmée ; `NULL` = jamais invalidé. Ce n'est **pas** le discriminant
   actif/inactif (ABBES DJAMEL `0010787` a `NULL` mais `SDEM_SIGN='N'`).

Constaté (2026-09) :

| Compte | `USR_ID` | `SDEM_SIGN` | `SBCG_USERPROFIL` | `USR_DATINVALID` | Interprétation |
|---|---|---|---|---|---|
| CHEMAME NADIR `0004908` | 4690 | `O` | **15 322** lignes | `NULL` | Actif, utilisateur avec droits |
| NICOLAU MARIZA `0006050` | 4251 | `O` | 5 759 lignes | `NULL` | Actif, admin GEST/ORDON/COMPTA |
| ABBES DJAMEL `0010787` | 3284 | `N` | **0** ligne | `NULL` | **Inactif** (rôle `US` seul) |

**Compteurs (2026-09)** :

- **Total comptes** (`SBCG_USERS`) : **4 941**
- **Comptes actifs** (`DEMANDEUR.SDEM_SIGN='O'`) : **2 655**
- Comptes inactifs (`SDEM_SIGN='N'`) : **2 285**
- **Utilisateurs avec droits** (≥ 1 ligne `SBCG_USERPROFIL`) : **269**
- Agents simples / demandeurs (0 profil) : **4 672**
- Dont `USR_DATINVALID` non nul : 45 en date passée + 5 en date future ;
  45 des 45 « invalidés » **conservent** leurs profils (l'invalidation ne purge
  pas les droits).

> ⚠️ La vue `V_OP_DEMANDEUR` expose une colonne **`VALID_ACCES`** qui vaut
> **toujours `NULL`** (c'est un `NULL AS VALID_ACCES` dans le DDL) : inutile.
> `V_OP_DEMANDEUR` = `DEMANDEUR D INNER JOIN SBCG_USERS U ON D.SDEM_USR = U.USR_ID`
> (1 ligne par demandeur, 4 940 lignes).

### Créer / désactiver un compte (SQL direct vs procédure)

**Preuve de flux (cas FORTAS, matricule `0018451`, `USR_ID` 4976, 24/09/2026
18:57:31)** : `L_MESSAGE` contient `Demandeur : 0018451 | Creation` (trigger
`INS_DEMANDEUR`) et `… | Nouveau service prioritaire : BF9` (trigger
`INS_AFFECTATIONPERSONNEL`, via `ALL_DEMANDEUR`). Un simple `INSERT INTO
DEMANDEUR` a donc suffi : **les triggers font tout le reste**.

**Création minimale (aucune procédure obligatoire)** :
1. `USR_ID = MAX(USR_ID)+1` (**pas de séquence** pour `SBCG_USERS`) ;
2. `INSERT INTO SBCG_USERS(...)` (aucun trigger sur cette table) ;
3. `INSERT INTO DEMANDEUR(...)` → triggers `INS_DEMANDEUR` (log `L_MESSAGE`),
   `ALL_DEMANDEUR` (`AFFECTATIONPERSONNEL`, `DEMANDEURVISU`…) ;
4. `INSERT INTO SBCG_USERPROFIL(USR_ID, MNU_ID, USRP_MNUTAB, USRP_SOC,
   USRP_AUTH, USRP_MAJ)` × N → triggers `ALL_SBCG_USERPROFIL` /
   `SBCG_USERPROFIL_MAJOTHERMENUS` créent les **9 `DEMANDEURAUTH` + 273
   `DEMANDEURAUTHP`** par défaut ; triggers `*_REDIS` publient/rafraîchissent le
   cache externe ;
5. `COMMIT`.

Chemin « officiel » équivalent : **`INSUPDDEMANDEUR`** (926 lignes) ou
`MAJ_UTILISATEUR`, qui enchaînent tout (allocation `USR_ID`, droits par défaut).

**Désactivation** : `UPDATE SBCG_USERS SET USR_DATINVALID = ...` (aucun trigger
sur `SBCG_USERS`) et/ou suppression des lignes `SBCG_USERPROFIL` (⚠️ déclenche
`*_REDIS` : dépendance au cache externe).

### Traçabilité & audit (état constaté = faible)

- Écritures faites avec le **compte propriétaire partagé `ASTECHIVR`** (pas de
  compte nominatif) → **aucun acteur identifié**.
- Les triggers de journal (`INS_DEMANDEUR`, `INS_AFFECTATIONPERSONNEL`) écrivent
  dans `L_MESSAGE` avec `MES_ORIGINE = 202` constant, **sans** OS/user DB/IP.
- `SBCG_TRACE` (`USR_ID, FORM_ID, MAJ_TYPE, MAJ_DATE, MAJ_PK`) et `SBCG_AUTH`
  ne journalisent que les **écrans du client**, pas le SQL direct.
- `SBCG_HISTO` (`SBH_TYP/DAT/NUM/USR/ACTION`) trace surtout demandes/interventions
  + événements `REDIS` des triggers, **sans acteur** fiable.
- **Pas d'audit Oracle** (Unified Auditing) sur les tables comptes.

**Pour rendre les actions attribuables** : comptes nominatifs/de service dédiés
(jamais le compte schéma) ; **Oracle Unified Auditing** sur `SBCG_USERS`,
`DEMANDEUR`, `SBCG_USERPROFIL`, `DEMANDEURAUTH(P)` et `EXECUTE` de
`INSUPDDEMANDEUR`/`MAJ_UTILISATEUR` ; journaux centralisés/WORM + séparation des
rôles ; renseigner `CLIENT_IDENTIFIER`/`MODULE`/`ACTION` et enrichir les triggers
avec `SYS_CONTEXT('USERENV','OS_USER'|'SESSION_USER'|'IP_ADDRESS')` ; alerter sur
toute écriture hors client. → Toute action non attribuable devient une alerte.

### S'identifier comme acteur réel (attribution légitime)

But : quand **Marc CHEVALIER** (matricule `0015425`, `USR_ID` 3913) fait une
modification, que l'audit **le nomme lui**, pas le compte technique. C'est de la
bonne traçabilité ; **en revanche on ne masque pas** le fait qu'un outil/proxy a
été utilisé, et on n'usurpe l'identité de personne.

1. **Compte DB nominatif** (jamais le compte schéma partagé `ASTECHIVR`) :
   chaque opérateur dispose de son compte Oracle ; le proxy s'y connecte.
2. **Déclarer l'opérateur dans la session** (avant l'écriture) :
   ```sql
   BEGIN
     DBMS_SESSION.SET_IDENTIFIER('0015425');                       -- matricule
     DBMS_APPLICATION_INFO.SET_CLIENT_INFO('CHEVALIER MARC');
     DBMS_APPLICATION_INFO.SET_MODULE('ASTECH-Explorer','COMPTES');
     DBMS_APPLICATION_INFO.SET_ACTION('CREATION 0018451');
   END;
   /
   ```
3. **Utiliser les procédures officielles** (`INSUPDDEMANDEUR`, `MAJ_UTILISATEUR`)
   pour rester dans le chemin supporté.
4. **Auditer et vérifier** (côté DBA) :
   ```sql
   CREATE AUDIT POLICY pol_comptes ACTIONS
     INSERT, UPDATE, DELETE ON SBCG_USERS,
     INSERT, UPDATE, DELETE ON DEMANDEUR,
     INSERT, UPDATE, DELETE ON SBCG_USERPROFIL;
   AUDIT POLICY pol_comptes;
   -- contrôle :
   SELECT event_timestamp, dbusername, os_username, userhost,
          client_identifier, action_name, object_name, sql_text
     FROM unified_audit_trail
    WHERE object_name IN ('SBCG_USERS','DEMANDEUR','SBCG_USERPROFIL')
    ORDER BY event_timestamp DESC;
   ```

⚠️ Limites à connaître : `CLIENT_IDENTIFIER`/`MODULE` sont **déclarés par le
client** (donc falsifiables) ; une attribution **fiable** repose sur un **compte
DB nominatif** + `dbusername`/`os_username`/`userhost` audités par Oracle, pas
sur des champs posés par l'outil.

**Ce qu'on ne fait pas** (anti-forensique) : insérer des lignes `SBCG_TRACE`
faisant croire à une exécution d'écran client, réécrire/supprimer `L_MESSAGE`,
`SBCG_HISTO` ou `unified_audit_trail`, ou poser l'identité d'un **autre** agent
(usurpation). Une modification faite par un proxy reste **une modification par
proxy**, simplement correctement attribuée à son opérateur.

### Rôle métier — `DEMANDEUR.SDEM_ROLEAPP`

Le rôle est une **chaîne de lettres** (table `DEMANDEUR`, liée à `SBCG_USERS` par
`SDEM_USR = USR_ID`). Décodage **officiel** extrait de la vue
`V_OP_DEMANDEUR` (chaque lettre testée par `INSTR(SDEM_ROLEAPP, '<Lettre>')`) :

| Lettre | Rôle (alias vue) |
|---|---|
| **U** | Utilisateur (`UTI`) |
| **D** | Demandeur (`DEM`) |
| **R** | Affectataire (`AFF`) |
| **I** | Intervenant (`INTERV`) |
| **C** | Conducteur (`CONDUCTEUR`) |
| **A** | Usager (`USAGER`) |
| **S** | `ATT` |

Valeurs courantes : `US`, `UDS`, `UCS`, `UDIS`, `UDICS`… (toutes les combinaisons
observées n'utilisent que ces 7 lettres).

**Indicateurs complémentaires** (booléens `O`/`N`) : `SDEM_ROLEGEST`
(gestionnaire), `SDEM_ROLEORDON` (ordonnateur), `SDEM_ROLECOMPTA` (comptable).

> **« Admin » ASTECH = les 3 flags `GEST`/`ORDON`/`COMPTA` = `O`** (≈ 29 comptes).
> Il n'existe **pas** de lettre « admin » dans `SDEM_ROLEAPP`.

### Groupes d'intervention — `GROUPEUTIL` + `GROUPEUTILDETAIL`

- `GROUPEUTIL(GRU_COD, GRU_DES)` : ex. `GARDEM` (gardien demandeur), `MACHAT`,
  `SEBC`, `TESESPO`, `GESTLOC`…
- `GROUPEUTILDETAIL(GRUD_GRP, GRUD_DEM)` : appartenance groupe → **matricule**
  (`GRUD_DEM`).

### Droits par menu — `SBCG_USERPROFIL`

`(USR_ID, MNU_ID, USRP_SOC, USRP_AUTH, USRP_MAJ, USRP_MNUTAB)` — droits d'un
utilisateur menu par menu. **Clé primaire = `(USR_ID, MNU_ID, USRP_MNUTAB, USRP_SOC)`**
(donc pas de « doublons » : un même menu a une ligne par onglet `USRP_MNUTAB`).
`USRP_AUTH` est un **bitmask** : `0` (aucun), `1`, `3`, `7`, `9`, `15` (complet,
le plus fréquent). `USRP_MAJ` a pour défaut `sysdate`.

⚠️ Trigger **`SBCG_USERPROFIL_MAJOTHERMENUS`** (compound) : à l'insertion/maj
d'une ligne `USRP_AUTH = 15` sur certains menus, il **crée automatiquement** des
lignes dans `DEMANDEURAUTH` / `DEMANDEURAUTHP` (autorisations). Un simple
`INSERT ... SELECT` de droits déclenche donc des écritures ailleurs.

### Autorisations complémentaires — `DEMANDEURAUTH` / `DEMANDEURAUTHP`

- `DEMANDEURAUTH` : PK `(DEMA_DEMCOD, DEMA_AUTHTYP, DEMA_AUTH)`, colonnes
  `DEMA_DEMCOD` (=matricule), `DEMA_AUTHTYP` (ex. `4138`), `DEMA_AUTH` (ex.
  `10|1>1785` — **contient un `|`**), `DEMA_AUTHMAJ` (`O`/`N`).
- `DEMANDEURAUTHP` : PK `(DEMAP_DEMCOD, DEMAP_AUTHTYP, DEMAP_AUTH)`,
  `DEMAP_AUTHTYP` (ex. `525`), `DEMAP_AUTH` (ex. `10|1>1076`), `DEMAP_AUTHMAJ`.
- Tout nouveau demandeur reçoit par défaut **9** lignes `DEMANDEURAUTH` et
  **273** lignes `DEMANDEURAUTHP` (constaté identique pour plusieurs comptes).

### Services — `SERVICE` / `SOUSSERVICE`

`DEMANDEUR.SDEM_SSERV` → `SERVICE.SSER_COD` (`SSER_NOM`, `SSER_NOMLONG`).
Exemples : `BF1` = DIRECTION DES SYSTEMES D'INFORMATION (DSI), `BF9` = SERVICE
DEPLOIEMENT ET SUPPORT, `BF6` = SERVICE IRS (Infrastructure Réseaux Systèmes),
`BF7` = SERVICE UTILISATEURS, `BF8` = BUREAU DES PROJETS. Les sous-services sont
dans `SOUSSERVICE` (`SSSER_SER` = service parent).

### Mots de passe / codes stockés

- `SBCG_USERS.USR_PWD` et `DEMANDEUR.SDEM_CODACCES` contiennent le **même**
  code pour ~4 768/4 939 comptes : c'est un **blob base64 de 8 ou 16 octets**
  (chiffrement réversible legacy, pas un hash à sens unique).
- Ce code est **partagé par plusieurs comptes** (ex. `lV8KS96Aw9Y=` est à la fois
  chez ABBAS et NEMORIN) → ce n'est **pas** un mot de passe Windows personnel.
  En SSO, l'authentification se fait par l'AD ; ce champ n'est qu'un **code
  d'accès applicatif** (souvent recopié tel quel à la création d'un compte).
- Autres champs : `SBCG_USERS.USR_COMPTAPWD` (compta, 8 octets),
  `DEMANDEUR.SDEM_MAILPWD` (SMTP, souvent vide).
- Pour dater un mot de passe : `USR_DATMAJPWD` (et `USR_MAJ`).

### Autres tables utiles

- `SBCG_AUTH` / `SBCG_AUTH_NOMADE` : sessions ouvertes (`AUTH_USRID`,
  `AUTH_MODULE`, `AUTH_TOKEN`…).
- `EXT_PERSONNEL` : **personnels externes** (colonnes `USRCODE`, `USRNOM`,
  `USRLOGINSYS`, `USREMAIL`, `USRROLE`, `GROUPEUTIL`…).
- `ROLE` : rôles **patrimoine** (ex. `Affectataire`), **sans rapport** avec les
  rôles utilisateurs.
- `INTERVENANT` (`SSAL_*`) : intervenants/entreprises ; `DEMANDEUR` = demandeurs.

## Procédures stockées & objets PL/SQL

Le schéma `ASTECHIVR` **contient du code serveur** (inventaire `ALL_OBJECTS`,
constaté 2026-09) :

| Type | Nombre |
|---|---|
| `PROCEDURE` | **1 212** |
| `FUNCTION` | **294** |
| `PACKAGE` / `PACKAGE BODY` | 2 / 1 |
| `TRIGGER` | 335 |
| `VIEW` | 933 |
| `TABLE` | 715 |
| `INDEX` | 938 |
| `SEQUENCE` | 3 |

> Beaucoup d'objets sont `INVALID` (non recompilés) — normal sur une prod
> ancienne ; interroger `ALL_OBJECTS.STATUS`.

Procédures/fonctions notables côté **locatif / révision / échéancier** :

| Objet | Type | Rôle probable |
|---|---|---|
| `F_CALCUL_REVIS` | FUNCTION | Calcul d'une révision de loyer |
| `F_GETCONT_REVIS_ATT_MTHT_PREC` | FUNCTION | Loyer HT précédent pour révision |
| `CONTRAT_ECHEANCIER` / `CONTRAT_ECHEANCIER_LIGNES` | PROCEDURE | Génération de l'échéancier |
| `CONTRAT_ECH_NUM` / `CONTRAT_ECHLIGNE_NUM` / `CONTRAT_ECHLIGNE_MAJ` | PROCEDURE | Numérotation / MAJ échéances |
| `CHANGEMENT_TVA_ECHEANCES` | PROCEDURE | Recalcul TVA des échéances |
| `GET_ECHDAT` | FUNCTION | Date d'échéance |
| `MAJ_UTILISATEUR` / `MAJ_UTILISATEUR_TRIGGER` | PROCEDURE | Gestion comptes |
| `F_HAVE_AUTH_DEMANDEUR` | FUNCTION | Test de droit d'un demandeur |
| `DEMANDEURAUTH_ATTRIBAUTO` / `DEMANDEURAUTH_GRPDEM` | PROCEDURE | Attribution auto des droits |
| `MAJ_DEMANDEURAUTH_BIEN` / `PURGE_DEMANDEURAUTH_BIEN` | PROCEDURE | Droits par bien |

> Le code source des vues n'est **pas** dans `ALL_SOURCE` (seulement les
> procédures/fonctions/triggers). Pour le DDL d'une vue, utiliser
> `DBMS_METADATA.GET_DDL('VIEW','<NOM>','ASTECHIVR')` (récupérer le CLOB en
> chaîne ; `ALL_VIEWS.TEXT` est un `LONG` inutilisable en SQL direct).

## Indices de révision des loyers

L'indice de référence (IRL/ILAT…) et l'historique des révisions sont stockés
dans **deux familles de tables** :

### 1. Référentiel des indices INSEE — `INDICEINSEE`

| Colonne | Sens |
|---|---|
| `INSEE_ID` | PK |
| `INSEE_AN` | année |
| `INSEE_COD` | code (ex. `L2601`, `I2304`) |
| `INSEE_DES` | libellé (ex. `IRL 2026 TRIM 01`, `ILAT 2023 TRIM 04`) |
| `INSEE_TYP` | type (1 = IRL, 6 = ILAT…) |
| `INSEE_TRIM` / `INSEE_MOIS` | trimestre / mois |
| `INSEE_DATP` | date de publication |
| `INSEE_TAUX` | valeur de l'indice (ex. `137.42`) |
| `INSEE_TAUXMOYEN` | moyenne |

Complément : `INDICEINSEECATEGORIE` (`INSEECAT_AN/COD/CAT/TAUX`).

### 2. Historique des révisions appliquées — `CONTRAT_REVISION`

| Colonne | Sens |
|---|---|
| `CONTRV_ID` | PK = `CONTRAT_LOCATIF.CONTL_REVID` (dernière révision) |
| `CONTRV_CONTID` | → `CONTRAT.CONT_ID` |
| `CONTRV_DAT` | date de la révision |
| `CONTRV_INSEEP` | indice **précédent** (`INDICEINSEE.INSEE_ID`) |
| `CONTRV_INSEE` | indice **nouveau** |
| `CONTRV_POURC` | % d'évolution appliqué |
| `CONTRV_MTP` / `CONTRV_MT` | loyer **avant** / **après** |
| `CONTRV_IDPREC` | révision précédente (`-1` = initiale) |
| `CONTRV_DATAPPLI` | date d'application |
| `CONTRV_PASAUGM` / `CONTRV_RATTRAP` | passer au-dessus / rattrapage |

### 3. Niveau bail — `CONTRAT_LOCATIF`

- `CONTL_REVID` → dernière `CONTRAT_REVISION.CONTRV_ID`
- `CONTL_POURCENTREV` (%), `CONTL_DATREVD` (dernière révision),
  `CONTL_DATREVP` (prochaine révision), `CONTL_INSEE` / `CONTL_INSEEDEP` /
  `CONTL_INSEEVAL` (paramètres d'indice).

Vue prête à l'emploi : **`V_CONTRAT_REVISION`** (= `CONTRAT_REVISION` +
`CONTL_INSEEVAL` + `CONTRV_VALINDP`/`CONTRV_VALIND`, valeurs des indices
résolues) ; aussi `V_EXPORT_CONTRATLOCATIF` (`DATE_DERNIERE_REVISION`,
`DATE_PROCHAINE_REVISION`).

**Exemple réel (BOULMOT, contrat `000169` / `CONT_ID` 278)** : `CONTRV_ID` 407,
`CONTRV_DAT` 15/06/2026, indice `CONTRV_INSEEP` 376 (`IRL 2025 TRIM 01`=145.47)
→ `CONTRV_INSEE` 396 (`IRL 2026 TRIM 01`=137.42), `CONTRV_POURC` **+52.95 %**,
loyer 684.28 → **1046.64 €** (`CONTRV_DATAPPLI` 23/07/2026). L'échéance
quittancée ressort à **1 066.64 € TTC** (loyer + charges).

## Lien avec l'AD / SSO

- Utilisateurs **internes** : le lien AD se fait par
  - `DEMANDEUR.SDEM_EMAIL` = adresse AD (ex. `machevalier@ivry94.fr`,
    `sfortas@ivry94.fr`) ;
  - `DEMANDEUR.SDEM_AUTHSYS` = **login AD** (`sAMAccountName`) : ex. `IABBAS`,
    `IABBAS`… constatés en minuscules (`cnemorin`, `lrigoulat`) ou majuscules
    (`SFortas`) selon la source — le SSO matche a priori sans tenir compte de la
    casse.
  En SSP/SSO, ASTECH retrouve la ligne `DEMANDEUR` par ces champs ; l'ASTECH
  « mot de passe » (`USR_PWD`/`SDEM_CODACCES`) n'est alors qu'un code d'accès.
- Utilisateurs **externes** : mapping AD explicite via la table
  **`V_LDAP_ATTRIB`** (correspondance attributs ASTECH ↔ LDAP), notamment
  `ATTRIB_ASTECH = USRLOGINSYS` ↔ `ATTRIB_LDAP = sAMAccountName`, `USREMAIL` ↔
  `USREMAIL`, `USRROLE` (défaut `UD`).

### Récupérer un agent dans l'AD (via AppDSI)

AppDSI interroge l'AD (LDAPS) avec la config SQLite **`ad_settings`** (id=1 :
`host`, `base_dn`, `bind_dn`, `bind_password`, `is_enabled`) et la lib `ldapjs`
(voir `backend/modules/tickets/auto-actions.controller.js#searchAdUsers`).
Attributs utiles pour créer un compte ASTECH :
`sAMAccountName` (→ `SDEM_AUTHSYS`), **`employeeID`** (→ **matricule**
`SDEM_COD`/`USR_NAME`), `mail` (→ `SDEM_EMAIL`), `displayName`/`givenName`/`sn`
(→ `SDEM_DES`/`USR_DETAIL`), `department`/`company` (→ service), `title`.
Exemple réel (FORTAS) : `sAMAccountName=SFortas`, `employeeID=0018451`,
`mail=sfortas@ivry94.fr`, `department=SERVICE DEPLOIEMENT ET SUPPORT` (→ `BF9`).

## Repères métier (domaines)

`ARBO_*` (arborescence/patrimoine : `ARBO`, `ARBO_AFF`, `ARBO_LOC`, `ARBO_CTT`,
`ARBO_DROIT`…), `INTERVENTIONS*` / `DEMANDES*`, `CONTRAT*`, `FOURNISSEUR*`,
`STOCK*`, `PATRI*`, `FLUID_*` (eau/énergie), `SINISTRE*`, `FOURNISSEUR`,
`PNEUS`, `BADGES`, `TYPE` (types d'intervention : `SC`, `EV`, `CO`, `EN`, `RE`…).

## Exemples de requêtes

```sql
-- Retrouver un utilisateur par nom (ASTECH = matricule + NOM PRÉNOM)
SELECT usr_id, usr_name, usr_detail FROM SBCG_USERS WHERE upper(usr_detail) LIKE '%CHEVALIER%';

-- Profil/rôle d'un utilisateur
SELECT sdem_cod, sdem_des, sdem_roleapp, sdem_rolegest, sdem_roleordon, sdem_rolecompta, sdem_email
FROM DEMANDEUR WHERE sdem_cod = '0015425';

-- Comptes « admin » (gestionnaire + ordonnateur + comptable)
SELECT sdem_cod, sdem_des, sdem_roleapp FROM DEMANDEUR
WHERE sdem_rolegest = 'O' AND sdem_roleordon = 'O' AND sdem_rolecompta = 'O';

-- Droits par menu d'un utilisateur
SELECT count(*) FROM SBCG_USERPROFIL WHERE usr_id = 3913;

-- Groupes d'un matricule
SELECT gd.grud_grp, gu.gru_des FROM GROUPEUTILDETAIL gd
LEFT JOIN GROUPEUTIL gu ON gu.gru_cod = gd.grud_grp WHERE gd.grud_dem = '0015425';
```

Repères de référence (schéma réel, à titre d'exemple) :

| Nom | Matricule | `USR_ID` | `SDEM_ROLEAPP` | GEST/ORDON/COMPTA |
|---|---|---|---|---|
| NICOLAU MARIZA (admin) | 0006050 | 4251 | `UDCS` | O / O / O |
| CHEVALIER MARC | 0015425 | 3913 | `UDS` | N / N / N |
| CHEMAME NADIR | 0004908 | 4690 | `UDCS` | N / N / N |

## Pièges

- **Thin ≠ ASTECH** : ne pas conclure « identifiants invalides » — c'est
  `NJS-116` (vérificateur 10G). Utiliser le thick ou corriger `sqlnet.ora`.
- Le nom peut être mal orthographié : **NICOLAU** vs « Nicoleau ». Toujours
  chercher large (`LIKE '%NICOL%'`, `'%MARIZA%'`).
- `USR_PROP` et `USR_UTILISATION` sont (quasi) toujours `0`/vide : ne pas s'y fier
  pour les droits ; les droits sont dans `SBCG_USERPROFIL` et `SDEM_ROLEAPP`.
- La lettre `U` de `SDEM_ROLEAPP` est testée avec `INSTR(...) >= 0` (toujours vrai)
  dans `V_OP_DEMANDEUR` — `UTI` sort toujours `O`.
- Le mot de passe est stocké **en clair** dans `oracle_settings` (SQLite) : ne
  jamais le recopier dans un fichier commité ni dans un log.
- **Historique du quittancement tronqué à 2024** : `CONTRAT_ECHTERMINEE` ne
  contient que des échéances `>= 01/01/2024` (min global constaté). Ne pas en
  déduire qu'il n'y a jamais eu de loyers avant — c'est une reprise/migration.
- `CONTRAT_ECH` (prévisionnel) **contient aussi des échéances passées** jamais
  émises (baux clôturés, reprises). Une échéance `CONTEC_DATE < SYSDATE` sans
  `CONTEC_NUMQUIT`/`CONTEC_DATQUIT` n'est **pas** « planifiée » : la qualifier
  d'« échue (non émise) ».
- **`USR_DATINVALID` ≠ statut actif/inactif** : un compte inactif peut avoir la
  colonne à `NULL`. Le **statut actif** se lit sur **`DEMANDEUR.SDEM_SIGN='O'`**
  (2 655 actifs en 2026-09) ; les **droits** se lisent sur `SBCG_USERPROFIL`
  (269 utilisateurs avec droits). Ne pas confondre les deux (cf. section
  Utilisateurs).

## Intégration AppDSI

- Type de synchro Oracle **`ASTECH`** ajouté aux listes blanches :
  `backend/server.js` (import-tables + seed `oracle_settings`),
  `backend/routes/oracle-automation.routes.js`,
  `backend/modules/oracle/oracle-automation.controller.js`,
  préfixe de tables `oracle.astech_*` (`oracle-import-executor.js`),
  seed `oracle_automation_config` (`backend/shared/pg_db.js`).
- Config visible dans **Admin → Bases de données → Oracle** (carte ASTECH).
- Frontend : `frontend/src/pages/Admin.tsx` (listes de types + onglets).

## Module Gestion locative (immobilière)

Deux notions de « location » coexistent — ne pas confondre :

| Domaine | Tables |
|---|---|
| **Gestion locative (immobilière)** | `ARBO_LOCATIF`, `CONTRAT_LOCATIF`, `CONTRAT_ECH`(+`_ECHTERMINEE`), `CONTRAT_AFF`/`CONTRAT_AFFL` |
| Location de matériel/véhicules/salles | `ARBO_LOC`, `SAISIE_LOC`, `LOCATIONS`, `PREVISION_LOC`, `LOUEUR`, `TAUXLOCATION`, `CATEGORIE_LOC`… |

**Modèle des baux** (jointures officielles, cf. vues `V_BIEN_LOCATIF` /
`V_CONTRAT_LOCATIF`) :
- Le **bien locatif** est une **entité du patrimoine** : `ARBO.ARB_ID =
  ARBO_LOCATIF.ARBLOC_ID`. Description/nature = `ARBO.ARB_CODE`/`ARB_DES`/
  `ARB_NOMC`, genre via `PATRIGENE` (`ARB_GENRE → SGEN_COD`, libellé `SGEN_DES`),
  classif. `CATEGORIE.SCAT_DES` (`ARB_CAT`) / `SOUSCATEGORIE.SSCAT_DES`
  (`ARB_SCAT`), adresse `ARBO_ADR.ARBA_*` (`ARB_ID = ARBA_ID`).
- **Contrat ↔ bien** via `CONTRAT_AFF` (`CONTAF_ID = CONTRAT.CONT_ID`,
  `CONTAF_ARBID = ARB_ID`, `CONTAF_PRINC='O'`) — et `CONTRAT_AFFL`
  (`CONTAFL_CONTID = CONT_ID`) pour le fournisseur/RIB.
- **Bail** : `CONTRAT_LOCATIF.CONTL_ID = CONTRAT.CONT_ID`. Locataire =
  `CONTL_CONTRACTANT` (chaîne nom, pas d'id) ; loyer `CONTL_MTACT` ; dépôt
  `CONTL_DEPMT` ; dates `CONTL_DATENTREE/DATSORTIE`, signature, préavis.
  Quittancement paramétré par `CONTL_DATDEBQUIT`/`CONTL_DATQUIT`/`CONTL_QUITJOUR`/
  `CONTL_QUITMOIS`.
- **Échéances de loyer** : deux tables à **toujours considérer ensemble** :
  - `CONTRAT_ECH` (`CONTEC_CONTID = CONT_ID`) = **échéancier prévisionnel**
    (une ligne par mois prévu) : `CONTEC_DATE` (date/mois dû),
    `CONTEC_DES` (« MOIS DE … »), période `CONTEC_DATEDEB/DATEFIN`,
    `CONTEC_MTHT/MTTC`, `CONTEC_NUMQUIT`/`CONTEC_DATQUIT` (n° et date de
    quittance, **vides** tant que non émise), `CONTEC_DATGF` (mandatement),
    `CONTEC_STATUT` (quasi toujours `NULL` → ne pas s'en servir).
  - `CONTRAT_ECHTERMINEE` = **historique émis** (mêmes colonnes, +`CONTEC_REGL_*`),
    alimenté au fil du quittancement — mais **seulement depuis 2024** (reprise).
  - Champs de pilotage du quittancement sur `CONTRAT_LOCATIF` :
    `CONTL_DATDEBQUIT` (début du quittancement), `CONTL_DATQUIT`,
    `CONTL_QUITJOUR`/`CONTL_QUITMOIS`, `CONTL_DATHISTO` (entrée dans l'histo),
    `CONTL_DATCLO` (date de clôture).
- **Séparer « à venir » et « passé »** : référence `TRUNC(SYSDATE)` sur
  `CONTEC_DATE`. En 2026-09 : global **580 futures / 2 345 passées** dans
  `CONTRAT_ECH`.
- **Bien ↔ contrat, « contrat cadre » vs bail** : il n'existe pas de table
  « contrat cadre » distincte. Un même bien peut porter **plusieurs baux
  successifs** (ex. bien 5657 = `S043B01N01Z02L01`) : `2014081201` (2014→2016),
  `000015` (2014→2026), `000169` (2026→2028). `CONTRAT.DATDEB/DATFIN` = période
  du **contrat** ; `CONTRAT_LOCATIF.CONTL_DATENTREE/DATSORTIE` = **entrée/sortie
  du bail** (souvent vides) ; `CONTL_DATDEBQUIT` = début du quittancement. Les
  échéances sont rattachées à **un** `CONT_ID` précis (`CONTEC_CONTID`). Ne pas
  mélanger les dates d'un bail avec celles d'un autre du même bien/locataire.
- **Révisions** : voir section « Indices de révision » (`CONTRAT_REVISION`).
- **Volumes constatés (2026-09)** : 249 biens, 263 contrats, 166 locataires,
  2 925 échéances prévisionnelles + 2 086 historiques, 315 révisions. États
  `CONTRAT.CONT_ACTIF` : `O`=ouvert/en cours, `C`=clos, `N`=divers.

### Cas d'étude Boulmot (trou 07/2016 → 05/2024)

Locataire `BOULMOT FRANCOISE`, bien 5657, 3 baux : `2014081201` (fin
11/08/2016, clôturé seulement le 09/04/2024), `000015` (2014→27/01/2026,
quittancement démarré au **01/05/2024**), `000169` (28/01/2026→27/01/2028).
Aucune échéance entre 08/2016 et 04/2024 : conséquence directe de la **reprise
du quittancement en 2024** (l'historique `CONTRAT_ECHTERMINEE` débute au
01/01/2024) et non d'un bug applicatif.

## Application locale `astech-explorer`

Appli de consultation locale (Node + navigateur) construite sur ASTECH,
**en lecture seule (SELECT uniquement)**, dans `C:\dev\astech-explorer` (dépôt :
https://github.com/Crapoto94/astech), port **8099** :
- **Mode THICK obligatoire** (`oracledb.initOracleClient({ libDir: …/instantclient_21_23 })`) —
  le thin échoue (NJS-116). Sous Linux/Docker : Instant Client embarqué, `ORACLE_CLIENT_LIB_DIR`.
- Config Oracle par ordre de priorité : variables d'environnement
  `ORACLE_ASTECH_HOST/PORT/SERVICE/USER/PASSWORD`, puis `config.json`, puis
  `oracle_settings` (type `ASTECH`) de la SQLite d'AppDSI (chemin `APPDSI_BACKEND`).
- **Synchro Studio-RH** : la clé/URL de l'API se configurent côté serveur via les
  variables `STUDIO_RH_API_URL` et `STUDIO_RH_API_KEY`, ou dans le bloc
  `"studio_rh": { "url": "…", "api_key": "…" }` de `config.json`. Tant qu'elles ne
  sont pas fournies, l'écran Synchro RH affiche les comptes ASTECH et
  `/api/sync/rh/preview` renvoie `configured:false` (aucune confrontation).
- Endpoints : `/api/dashboard`, `/api/biens`, `/api/bien/:id`, `/api/locataires`,
  `/api/locataire?name=`, `/api/contrats`, `/api/contrat/:id`,
  `/api/contrat/:id/revisions`, `/api/revisions`, `/api/quittances`,
  `/api/agents` (+ `stats`, `/:matricule`), `/api/services`, `/api/groupes`,
  `/api/roles`, `/api/sync/rh/preview`, `/api/referentiels/:type` (+ `/:id`),
  `/api/referentiels-compteurs`, `/api/interventions` (+ `stats`, `/:num`),
  `/api/indices`.
- **Statut « actif »** = `DEMANDEUR.SDEM_SIGN='O'` ; **utilisateur avec droits** vs
  **agent simple** = présence/absence de `SBCG_USERPROFIL`.
- **Référentiels** : `biens`=`ARBO` (+`ARBO_ADR`/`CATEGORIE`/`PATRIGENE`),
  `vehicules`=`V_PARC_COMSMA` (`CATEGORIE='GVEH'`), `materiel`=`STOCK`,
  `tiers`=`FOURNISSEUR`, `services`=`SERVICE`, `groupes`=`GROUPEUTIL`.
- **Interventions** : `INTERVENTIONS` (en cours) UNION `INTERVENTIONSTERMINEES`
  (clôturées) ; filtres par défaut sur 12 mois (`ADD_MONTHS(SYSDATE,-12)`).
- **Indices** : `INDICEINSEE` (`INSEE_TYP` : 1=IRL, 2=ICC, 5=ILC, 6=ILAT ;
  `INSEE_COD` = lettre+AA+TT : L/C/B/I). Confrontation à l'INSEE BDM
  (`bdm.insee.fr`, séries 001515333=IRL, 000008630=ICC, 001532540=ILC,
  001617112=ILAT). **Tolérance d'écart = 0** (tout écart non nul est signalé).
  Pas de trigger ni d'unicité sur `(TYP,AN,TRIM)` ; PK `INSEE_ID` (ni séquence
  ni identity → `SEQ_INDICEINSEE` créée à la demande, repli `MAX+1`).
  FK entrantes : `CONTRAT_LOCATIF.CONTL_INSEEDEP`, `CONTRAT_REVISION.CONTRV_INSEE`
  / `CONTRV_INSEEP`, `CONTRAT.CONT_INSEEDEP`, `CONTRAT_LOC.CONTL_INSEE`.
- **Profils base prod/test** : le serveur monte un pool par profil. Le profil
  actif est choisi par requête via l'en-tête `X-ASTECH-Env: test` ou `?env=test`
  (défaut = `ASTECH_ENV`). Profils définis par `ORACLE_ASTECH_*` (prod) et
  `ORACLE_ASTECH_TEST_*` (test), ou `config.json` (`oracle_test`). Endpoint
  `/api/env`. Le front a un sélecteur PROD/TEST (en-tête mémorisé).
- **Pousser les indices** : `POST /api/indices/pousser` `{ scope, dryRun, confirm }`
  (`scope` = `manquants` \| `ecarts` \| `les_deux`). `dryRun:true` (défaut) =
  aperçu ; écriture réelle seulement si `ASTECH_ALLOW_WRITES=1` et, en prod,
  `confirm:"PROD"`. INSERT : `INSEE_ID` généré, `TAUXMOYEN=0`, `MOIS=0` ;
  UPDATE : sur `INSEE_ID` uniquement. Journal JSONL (`ASTECH_JOURNAL_FILE`),
  `create` sur `SEQ_INDICEINSEE` best-effort. Doublons `(TYP,AN,TRIM)`
  **signalés, jamais corrigés automatiquement** (ex. ILC 2025 : ID 392 trim 3 et
  ID 402 « TRIM 04 » stocké trim 3).
  ⚠️ Modifier `INSEE_TAUX` d'un indice référencé change `F_CALCUL_REVIS` et les
  rapports `RPT7342_*` ; tester d'abord sur la base de test.
- **Parc automobile** : un véhicule est un `ARBO` de genre **`GVEH`**
  (`ARB_REF`=immatriculation, `ARB_SERIE`=n° de série, `ARB_SCAT`=sous-catégorie,
  `ARB_SSERV`=service, `ARB_DAT1`=mise en service, `ARB_REFORME`). La vue
  **`V_PARC_COMSMA`** (filtre `CATEGORIE='GVEH'`) agrège marque/modèle
  (`PATRIMARQUE`/`PATRIMODELE` via `ARBO_MATE` — **vides en base**, marque souvent
  dans `ARB_DES`), compteur (`ARBO_NRJ.ARBN_CPTACT1`), affectation (`ARBO_AFFP`
  →`DETAIL.PSOC_DES`), et les données d'atelier/états/certificat issues du
  formulaire `PATRI_FORM` (`FRM_FRMID=2`, rubriques `FRM_CTRID` : 0=propriétaire,
  3/31=états, 5=carrosserie, 7=PV, 8=CR accident, 9=intérieur, 11=général,
  13=pneus, 34=réparations).
  Conducteurs/permis : **`PERMIS`** (18 catégories) + **`PERMISCONDUCTEUR`**
  (`SPERM_CON`=matricule `DEMANDEUR.SDEM_COD`, catégorie, `DATCAT`/`DATVAL`) ;
  `DEMANDEUR.SDEM_PERMIS` et `DGA_PRETVEH`/`LOCVEH` (autorisations).
  **`VEH_CERTIF`** (`VCI_ARBOID`/`VCI_RUBID`/`VCI_VAL`) = rubriques véhicule.
  Sinistres : **`SINISTRE`** (+`SINISTRECOUT`/`TIERS`/`TYPE`, **toutes vides**).
  Réservations/prêts : `ARBO_MATE.ARBMA_DISPO`/`INDISPO*`, `DEMANDEURGRPAUTH`
  (prêt véhicule) ; `TOURNEES`/`PLANNINGAGENT` existent mais **vides**.
  Contrôle technique : pas de table dédiée (rubriques dans `PATRI_FORM`).
  Endpoints : `/api/parc` (+`stats`, `/permis`, `/vehicule/:id`) ; UI route `#/parc`.
- **Procédures stockées** : `ALL_OBJECTS`/`ALL_SOURCE` du schéma `ASTECHIVR`
  (1212 `PROCEDURE`, 294 `FUNCTION`, 2 `PACKAGE` + 1 body ; **705 en `RPT*`** =
  rapports). Classement par groupe déduit du préfixe du nom (`PROC_GROUPS`) :
  rapports, arbo, interventions, contrats, comptabilité, agents, stock, parc,
  fluides, système, calculs, API/triggers, divers. Description heuristique
  (`procVerb` + préfixe). Endpoints `/api/procedures` (+ `?q&type&group`),
  `/api/procedure/:name?type=` (source). UI route `#/procedures`.
- **Docker Linux** : `Dockerfile` (base Oracle Linux 8 + `oracle-instantclient-basic`
  + Node 20) et `docker-compose.yml` ; voir README/DEPLOIEMENT pour les variables d'env.
- Recherche via `UPPER(...) LIKE :q` (bind), `FETCH FIRST n ROWS ONLY`,
  `rownum <= :lim`. Les colonnes Oracle reviennent en MAJUSCULES → **normaliser
  les clés en minuscules** côté serveur avant de les renvoyer au front.
- **Échéances** : le serveur construit une vue `ECHEANCE_SELECT` =
  `CONTRAT_ECH` **UNION ALL** `CONTRAT_ECHTERMINEE`, joint aux contrats/biens,
  et **renvoie `{ futures, passees }`** (séparation faite en SQL via
  `TRUNC(SYSDATE)`, tri `ASC` pour les futures / `DESC` pour les passées).
  Les endpoints par entité exposent donc `futures`/`passees` (plus de tableau
  unique). Colonnes clés : `date_echeance` (`CONTEC_DATE`, le **mois dû**),
  `date_quittance` (`CONTEC_DATQUIT`, la **date d'émission**), `statut`,
  `num_quittance`, `num_mandat`, `source` (`ECH` / `HIST`).
- **Statut échéance** calculé : `Mandatée` (DATGF) > `Émise` (NUMQUIT/DATQUIT) >
  `Échue (non émise)` (date passée sans quittance) > `Planifiée`.
- Front : `echeancesBlock()` affiche 2 cartes « Échéances à venir » / « Échéances
  passées » ; le tableau de bord montre « Prochaines échéances » et « Dernières
  quittances ». Fiche contrat enrichie : `quittancement depuis`, `clôture`,
  `dernière/prochaine révision`.
