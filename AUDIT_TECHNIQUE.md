# Audit technique — base Oracle ASTECHIVR

Analyse du dictionnaire Oracle (schéma `ASTECHIVR`), du 26/09/2026. Chiffres mesurés en direct via le compte applicatif (accès `ALL_*`). Les éléments marqués `[!]` restent à confirmer avec un accès DBA.

## 0. Périmètre mesuré

| Élément | Valeur |
|---|---|
| SGBD | Oracle Database 19c Enterprise Edition (19.23) |
| Tables | 715 |
| Vues | 933 |
| Index | 938 |
| Procédures | 1 212 |
| Fonctions | 294 |
| Déclencheurs (triggers) | 335 |
| Packages | 2 (+1 corps) |
| Volume PL/SQL | ~255 000 lignes |
| Contraintes | 659 PK · 983 FK · 4 566 CHECK · 0 désactivée |
| Charset base | WE8MSWIN1252 (NCHAR = AL16UTF16) |
| NLS | AMERICAN / AMERICA / BYTE / BINARY |

## 1. Non-conformités structurelles

| Constat | Volume | Impact |
|---|---|---|
| Tables sans clé primaire | 59 (ex. `MESSAGE`, `SBCG_ALERTES`, `MDP`, `SEMAPHORE`) | pas d'unicité garantie, doublons possibles |
| Tables sans clé étrangère | 312 / 715 | intégrité référentielle laissée à l'applicatif |
| Colonnes `CHAR` (longueur fixe) | 3 020 | padding, `TRIM` systématique, gaspillage |
| Colonnes "date" stockées en texte | 113 | tris/comparaisons faux, formats incohérents |
| Colonnes LOB (CLOB/BLOB/NCLOB) | 95 (84 + 21 + 14) | base volumineuse, sauvegardes lourdes |
| Vues pour 715 tables | 933 (jusqu'à 303 colonnes) | logique métier dans les vues |
| Tables pseudo-temporaires persistantes | ~44 (`TMP*`, `ZDEM*`, `FOURNISSEUR_TEMP`, `OP_*_TEMP`) | à remplacer par des GTT |
| Tables partitionnées | 0 | alors que 5 tables dépassent 400 000 lignes |
| Tables sans aucun index | 54 | accès dégradés |
| Statistiques absentes | 4 tables | plans d'exécution instables |
| Séquences | 3 pour 659 PK | identifiants générés par trigger/applicatif `[!]` |
| Colonnes commentées | 0 / 21 089 | dictionnaire de données inexistant |
| Nomenclature | `SBCG_`, `ARBO`, `L_*`, `G_*`, `TMP*`, `ZDEM`, `Real-isAnnuelle` (casse mixte) | aucune convention stable |

Tables les plus volumineuses : `DEMANDEURAUTHP` 1 279 567 · `MAJ_PROCEDURES_DETAIL` 1 232 723 · `SBCG_HISTO` 1 199 568 · `DEMANDEURAUTH_BIEN` 518 291 · `SAISIE_MO` 438 816 · `AFFECTATIONSTERMINEES` 406 113.

## 2. Non-conformités de sécurité (critique)

Secrets présents en base, a priori non chiffrés (colonnes `VARCHAR2`/`CLOB`) :

- Mots de passe applicatifs : `SBCG_USERS.USR_PWD`, `SBCG_USERS.USR_COMPTAPWD`, `MDP.MDPASS`.
- Mots de passe SMTP : `DEMANDEUR.SDEM_MAILPWD`, `EXT_PERSONNEL.USRSMTPPWD`, `I_PARAMIMPORT.SPARI_PWD`.
- Clé privée : `API_CERTIFICATE.ACERT_PRIVATE_KEY` (NCLOB), à côté de la clé publique.
- Jetons/tokens : `OAUTH_ACCESSTOKEN.TOKEN`, `REFRESH_TOKEN`, `SBCG_AUTH.AUTH_TOKEN`, `SBCG_USERS.USR_ES_API_KEY`, `BADGES.BADG_SECRET`.
- Divers : `SBCG_LICENCE.LIC_CLE`, `FOURNISSEUR.SREG_CLE`, `GFI_INT_LIQR.CLE_IBAN`.

Bonne pratique 2026 : hachage (PBKDF2 / bcrypt / Argon2) pour les mots de passe, chiffrement au repos (Oracle TDE / Wallet / coffre-fort) pour clés et secrets, jamais de clé privée ni de mot de passe SMTP en clair. Le simple compte de **consultation** accède aujourd'hui à tout cela.

## 3. Dette "logique dans la base" (point le plus lourd)

| Élément | Volume |
|---|---|
| PL/SQL total | ~255 000 lignes |
| `NVL(` | 5 643 |
| `TO_CHAR(` | 2 708 |
| `CURSOR` | 3 345 |
| `%TYPE` | 4 639 |
| `EXCEPTION` | 2 478 |
| `TO_DATE(` | 1 400 |
| `SYSDATE` | 781 |
| `EXECUTE IMMEDIATE` (SQL dynamique) | 600 |
| `RAISE_APPLICATION_ERROR` | 412 |
| `ROWNUM` | 207 |
| `NEXTVAL` | 275 |
| `DBMS_*` | 266 |
| `JSON_*` | 136 |
| `CONNECT BY` / `START WITH` | 47 / 34 |
| `MERGE` | 6 |
| `OVER(` (analytique) | 21 |
| `DECODE(` | 130 |
| Triggers `ALL_*` | 172 / 335 |
| Références `REDIS` dans le PL/SQL | 16 |

- Règles métier cachées dans 172 triggers `ALL_*`, invisibles du code applicatif : testabilité et versionnage difficiles.
- Effets de bord base vers un cache externe : triggers `SBCG_PARAM_REDIS`, `SBCG_MENUS_REDIS`, `SBCG_USERPROFIL_REDIS` (couplage non transactionnel).
- SQL stocké en données (dialecte Oracle dans les tables) : `EXPMACRO.EXPMAC_SQL`, `MACRO.SQLSTRING`, `MACROCONDITIONS.CONDSQL`, `OP_JOBSCRIPT.JOBS_SCRIPT`.
- `EXECUTE IMMEDIATE` (600) : risque d'injection si concaténation d'entrées utilisateur.

## 4. Décalage vs bonnes pratiques 2026

| Domaine | État constaté | Attendu 2026 |
|---|---|---|
| Documentation | 0 commentaire / 21 089 colonnes | dictionnaire de données versionné |
| Intégrité | 312 tables sans FK, 59 sans PK | PK/FK/contraintes systématiques |
| Types | 3 020 `CHAR`, 113 dates en texte | types adaptés, `TIMESTAMP`, pas de date texte |
| Unicode | WE8MSWIN1252, NCHAR mixte | AL32UTF8 + NLS_LENGTH_SEMANTICS=CHAR |
| Localisation | AMERICAN/AMERICA/BINARY | FRENCH/FRANCE, tri linguistique |
| Volumétrie | 0 partition, tables > 1 M | partitionnement / ILM / purge |
| Identifiants | 3 séquences pour 659 PK | identity/sequences, pas de MAX+1 |
| Logique | 255 k lignes PL/SQL + 172 triggers | services versionnés + tests, base = persistance |
| Sécurité | secrets en clair (SMTP, clé privée, tokens) | hachage + coffre-fort, TDE |
| Fichiers | 4 724 images sur C:\TEMP d'un poste | stockage objet + URL signées |
| Version SGBD | 19c EE (fin de cycle de support) | 23ai, édition/Cloud adaptés |
| Déploiement | client lourd .NET 4.8 + IIS + Crystal Reports + PHP + 2 VM Windows + 2 Symphonie Box | web/API, CI/CD, conteneurs, SSO AD |

## 5. Migration Oracle vers un autre SGBD (adhérence)

Techniquement possible, économiquement très lourd : ce n'est pas un changement de chaîne de connexion.

| Facteur d'adhérence | Volume | Effort |
|---|---|---|
| PL/SQL (procédures/fonctions/triggers) | ~1 843 objets / ~255 k lignes | réécriture complète (PL/pgSQL, T-SQL) |
| Vues | 933 | réécriture + validation |
| Fonctions Oracle-only | `NVL`, `DECODE`, `TO_CHAR/TO_DATE`, `SYSDATE`, `TRUNC`, `ROWNUM`, `CONNECT BY`, `DUAL`, `NEXTVAL`, `JSON_*` | conversion systématique |
| `%TYPE`/`%ROWTYPE`, packages | 4 725 références | refonte du typage |
| SQL dans les données | 4 tables CLOB | conversion des données, pas du code |
| Triggers `ALL_*` + Redis | 172 | réarchitecture |
| Applicatifs liés | AWO .NET 4.8 (ODP.NET), Crystal Reports, IIS, PHP Symphonie, client lourd déployé, Nomade | recompilation + revalidation + redéploiement |
| Charset | WE8MSWIN1252 | migration AL32UTF8 (projet à part) |

Cibles réalistes :

- **PostgreSQL** : meilleur candidat (PL/pgSQL proche de PL/SQL, SQL proche). Il faut malgré tout réécrire ~255 k lignes, convertir `CONNECT BY` en CTE récursives, `ROWNUM` en `LIMIT`, `DUAL`, `NVL` en `COALESCE`, `DECODE` en `CASE`, et revalider les 2 applicatifs + Crystal.
- **SQL Server / T-SQL** : pertinent seulement en stratégie Microsoft, même ampleur.
- **MariaDB / MySQL** : très défavorable (triggers, procédures, analytique), à écarter.

Le frein n'est pas le volume de données (plus gros objet ~1,3 M lignes) mais le code métier enfoui dans la base. Ordre de grandeur d'une migration complète : 18 à 36 mois-homme, risque élevé.

Alternatives plus rentables que la migration complète :

1. Rester Oracle mais réduire le coût (Standard Edition 2, Autonomous, Cloud) et migrer vers 23ai.
2. Découpler par domaine : exposer la lecture/écriture via des API (comme ASTECH Explorer) et extraire progressivement la logique.
3. Strangler pattern : nouvelles fonctions sur un service PostgreSQL coexistant avec le legacy Oracle.

## 6. Plan de remédiation priorisé

### P0 — sécurité et intégrité (3 à 6 mois)

1. Chiffrer/hacher : `USR_PWD`, `USR_COMPTAPWD`, `SDEM_MAILPWD`, `USRSMTPPWD`, `TOKEN`/`REFRESH_TOKEN`, `ACERT_PRIVATE_KEY` (TDE/Wallet).
2. Purger les tables d'authentification expirées : `OAUTH_ACCESSTOKEN` (103 k), `DEMANDEURAUTHP` (1,28 M).
3. Poser des PK sur les 59 tables concernées, des FK sur les tables structurantes.
4. Corriger `REPDOCUMENT` et migrer les 4 724 fichiers de POSTE004.

### P1 — données et exploitation (6 à 12 mois)

1. Migrer WE8MSWIN1252 vers AL32UTF8, NLS en FRENCH/FRANCE, CHAR vers VARCHAR2, dates-texte vers DATE.
2. Commenter le dictionnaire de données (objectif 100 % des tables et colonnes clés).
3. Partitionner/purger les tables > 1 M ; remplacer les 44 tables TMP par des GTT ; généraliser les séquences/identity.

### P2 — dette applicative (12 à 24 mois)

1. Réduire la logique en triggers (172 `ALL_*`), sortir les appels Redis des triggers.
2. Sécuriser les 600 `EXECUTE IMMEDIATE` et le SQL stocké en base.
3. Introduire des migrations versionnées et des tests ; mettre en place le SSO AD ; réduire la dépendance client lourd/Crystal.

### P3 — trajectoire

1. Oracle 23ai et mesure du coût EE.
2. Décider : réduire Oracle ou extraire vers PostgreSQL domaine par domaine.

## 7. Focus GED et POSTE004

- Le paramètre applicatif `REPDOCUMENT` (`SBCG_PARAM`, PAR_ID 1439, société 00) vaut `\\POSTE004\C$\TEMP` : c'est la valeur de stockage documentaire "Interne", pas un serveur.
- 7 191 enregistrements / 4 724 fichiers (76 % de la GED), thèmes PHDI et PHINT, du 18/07/2024 au 25/09/2026.
- `POSTE004` n'est résolu par aucun canal réseau (pas d'enregistrement DNS, pas de WINS, port 445 en timeout) : c'est une simple chaîne en base.
- Ce mode stocke les fichiers sur le disque dur (partage admin `C$`) d'une machine, sans redondance, sans contrôle d'intégrité, au lieu d'un stockage objet ou d'un partage documentaire sauvegardé.

## 8. Limites de l'audit

- Les vues `DBA_*`, la taille des segments et des LOB ne sont pas accessibles avec le compte applicatif (`ORA-00942`).
- Le hachage effectif des mots de passe et le mode de génération des identifiants par trigger restent à confirmer avec un accès DBA.
