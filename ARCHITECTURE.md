# Architecture AS-Tech — contexte d'Ivry-sur-Seine

> Document de référence détaillé, établi à partir des **dossiers techniques
> fournisseurs AS-Tech Solutions** (dossier local `DOC TECHNIQUE/`, non
> versionné), des **constats en base Oracle** `ASTECHIVR` et des documents
> d'exploitation. À lire en complément de `MANIFEST.md` et `SKILL.md`.

---

## 1. L'éditeur : AS-Tech Solutions

| | |
|---|---|
| Société | AS-Tech Solutions |
| Adresse | 1280 avenue des Platanes, 34970 Lattes / Boirargues |
| Téléphone | 01.60.42.74.40 |
| Web | www.astech-solutions.com |
| Contact | contact@astech-solutions.com |

Éditeur d'une suite de gestion du **patrimoine**, de la **GMAO**, de la
**comptabilité** et du **parc automobile** pour collectivités, développée selon
des méthodes AGILE.

---

## 2. Les produits de la suite

| Produit | Rôle | Technologie |
|---|---|---|
| **AWO** — AS-Tech Web Office | Application **client/serveur (client lourd)** : patrimoine, GMAO, comptabilité, parc auto, agents. Le cœur métier du client. | **.NET / C#**, **Crystal Reports 13**, .NET Framework 4.8 ; accès données **OLEDB** (client Oracle natif ou SQL Server). |
| **OPUS / Symphonie** | Portail **full web** (consultation, saisie nomade), architecture **micro-services**. | **PHP (Symfony) + Angular**, **Docker** ; NGINX, RabbitMQ, Elasticsearch, Mercure, Talend ; accès données **OCI8** (Oracle) / SQLSRV. |
| **Gamme Nomade** | Applications mobiles (iOS / Android) de saisie déportée. | S'appuient sur le serveur Symphonie. |
| **Infocentre / Pilotage / Univers BO** | Éditions, statistiques, reporting. | Crystal Reports, Business Objects. |

**Lanceur applicatif** — `ASTechLance.exe` : identifie l'utilisateur, met à
jour le poste (télédistribution MSI/HTTP) et ouvre le client lourd. Compatible
**SSO (Single Sign-On) / LDAP**.

---

## 3. Architecture déployée à Ivry

L'architecture recommandée est de **4 serveurs applicatifs** ; la base de
données est gérée à part par la ville (voir §5).

| Rôle | OS | Spécifications | Fonction |
|---|---|---|---|
| Serveur métier **production** | Windows Server 2022 | 2 vCPU / 8 Go RAM ; disque applicatif ≥ 20 Go, disque « fichiers » ≥ 10 Go | IIS (API + MAJ client), Services Windows infocentre, utilitaires d'exploitation |
| Serveur métier **test** | Windows Server 2022 | idem | idem, cloisonné |
| **Symphonie Box** production | **Ubuntu Server 20.04 LTS** (VM) | 2 vCPU / 4 Go RAM / 80 Go | Micro-services Docker (OPUS) |
| **Symphonie Box** test | Ubuntu Server 20.04 LTS (VM) | idem | idem |

La **Symphonie Box** est une **VM pré-configurée** livrée sous forme d'image à
importer (OVA / OVF / **VMDK**), à déployer via VMware/vSphere ou un autre
hyperviseur.

### Environnements

Deux environnements **cloisonnés** par collectivité :

- **Production** ;
- **Test** — recette / qualification / formation.

Cloisonnement : **un schéma Oracle par environnement** ; les serveurs métier
sont mutualisés entre les deux environnements ; **une Symphonie Box par
environnement**.

---

## 4. Composants & services

### Serveur métier Windows

- **IIS** — site `ASTechSolutions` (port **80**) : API métiers (.NET ASMX/XML),
  publication des mises à jour du client lourd, génération de PDF (Crystal
  Reports).
- **Services Windows infocentre** :
  - `SBCG.Export_SRVC` — publipostage / envoi de mails groupés ;
  - `SBCG.Export_SRVC_FormDyn` — indexation des formulaires dynamiques ;
  - `ASTech.IntrfRelv_Srvc` — interface relevés / carburant.
- **Batch / tâches planifiées** — scripts SQL, appels d'utilitaires d'interface
  (RH, carburant), sauvegardes/archivages locaux.
- **Utilitaire de mise à jour** — `MAJDSK.exe` / `ASTechUFLG.exe` (migration de
  schéma + binaires, **contrôle de version**).

### Symphonie Box (Linux / Docker)

Écosystème de conteneurs :

| Conteneur | Rôle |
|---|---|
| **NGINX** | Serveur web |
| **PHP** | Interpréteur (couche métier) |
| **RabbitMQ** | Gestionnaire de file d'attente (broker / consumer) |
| **Elasticsearch** | Moteur d'indexation |
| **Mercure** | Push temps réel (notifications navigateurs / mobiles) |
| **Talend** | ETL pour les interfaces |
| **Zabbix (agent)** | Supervision / diagnostic |

Hôte : **Python**, **Docker**, **docker-compose**. Mise à jour automatisée par
le **serveur Ansible AS-Tech** via **SSH**.

### Infrastructure

- **Serveur de fichiers** (rôle « Serveur de fichiers Prod / Test ») : partage
  **SMB (445)** commun AWO/Symphonie. Partage documentaire
  **`\\AWO\StockageDocumentaire$`** + partage d'échange de fichiers
  (rapports/PDF générés par IIS et l'infocentre).
- **NAS de sauvegarde `nas-syno05`** (`volume1//ORACLE_SAUVE`) : dépôt des
  exports Oracle.
- **Reverse proxy + WAF** recommandé devant la Symphonie Box.

---

## 5. Base de données Oracle à Ivry

| Serveur | Environnement | Adresse IP | Service | Schéma | Listener |
|---|---|---|---|---|---|
| **Oracle01** | TEST | `10.103.130.20` | `TIVRY01` | `ASTECHIVR` | 1523 |
| **Oracle02** | PROD | `10.103.130.25` | `PIVRY01` | `ASTECHIVR` | 1523 |

- OS **Oracle Linux 8.10**, **Oracle Database Enterprise 19.23**.
- 8 CPU / 30 Go RAM ; disques : système 150 Go + données 600 Go.
- Compte propriétaire OS : `oracle` (`/home/oracle`).
- Jeu de caractères instance : **`WE8MSWIN1252`**.

### Sauvegardes

- **`expdp` quotidien** (21h oracle01, 21h30 oracle02) via
  `/home/exploit/scripts/ora_export_bdd.ksh`.
- Dépôt sur le NAS `nas-syno05` ; purge des exports > **5 jours**.
- VM sauvegardées par **VMware** (double protection).
- ⚠️ **Pas de contrôle automatique** du bon déroulement — contrôles manuels
  requis. **RMAN non mis en place** à ce jour.

### Bascule PROD → TEST

Répertoire `/home/oracle/proc_ivry/astech/BasculProdTest` sur oracle01 ;
exécuter `./BasculPROD_TEST.sh` à partir de `expPIVRY01.dmp` (renommé si besoin).

---

## 6. Flux réseau (par environnement)

| Source | Destination | Proto | Port | Rôle |
|---|---|---|---|---|
| Serveur métier | Serveur de données | TCP | **1521** | Accès base (MAJ, API IIS, infocentre, utilitaires) |
| Postes utilisateurs (client lourd) | Serveur de données | TCP | 1521 | Accès suite Office |
| Serveur Symphonie | Serveur de données | TCP | 1521 | Accès full web |
| Postes / Symphonie | Serveur de fichiers | SMB | 445 | Stockage documentaire |
| Postes (client lourd) | Serveur métier (IIS) | HTTP(S) | 80/443 | MAJ client + API |
| Serveur Symphonie | Serveur métier | HTTP(S) | 80/443 | API de reporting |
| Navigateur / mobiles | Symphonie Box | HTTP(S) | 80/443 | Application full web |
| Symphonie / métier / postes | Serveur MAIL | SMTP | 25 | Notifications |
| Ansible AS-Tech | Symphonie Box | SSH | **3422** | Déploiement / mise à jour (clé RSA 4096) |
| Supervision AS-Tech | Symphonie Box | HTTP | 10050/10051 | Zabbix (diagnostic) |
| Symphonie Box | Dépôts | HTTPS | — | `*.ubuntu.com`, `*.launchpad.net`, `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com`, `repo.zabbix.com` |

**Recommandations** : alias **DNS par rôle** (BDD Prod/Test, API/IIS Prod/Test,
Symphonie Prod/Test, Serveur de fichier Prod/Test) ; **compte de service** pour
le SMB et les services Windows ; certificat SSL sur IIS et NGINX si HTTPS.

---

## 7. Interfaces & progiciels tiers

| Exécutable | Rôle |
|---|---|
| `ASINTERF.exe` | Interface RH |
| `ASTech.SAGE_PIECE.exe` | Interface SAGE (pièces) |
| `ASTech.IntrfRelv*`, `Lecexcel*`, `Litconso.exe`, `Parlabel.exe` | Interfaces carburant / relevés / consommation |
| `CirilValorisation.exe`, `CivitasValorisation.exe` | Interfaces CIRIL / CIVITAS |
| `GDAValorisation.exe`, `GDASolder.exe`, `majmarche.exe`, `majtiers.exe` | Interface Grand Angle |
| `SeditValorisation.exe` | Interface Sedit / BL |
| `astre_immo_export.exe` | Interface ASTRE Immo |
| `LDAPTest.exe` | Test connexion LDAP |
| `ASTech.AuthHELPDESK.exe`, `LicExp.exe`, `LicAppelExp.exe` | Interne (auth, licences) |

---

## 8. Interface OPUS ↔ NEOCITY

Interface d'interopérabilité entre **OPUS Service** (ASTech Symphonie) et
**NEOCITY** (gestion des signalements / demandes). Document source :
`Opus_NEOCITY_Architecture_PreconisationsRempli.pdf` (voir §11).

### 8.1 Mode de fonctionnement

- **Transfert des signalements** : les signalements NEOCITY alimentent les
  **demandes** ASTech (thème `26 / Demandes`).
- **Mise à jour des statuts** : les changements de position côté ASTech sont
  renvoyés à NEOCITY.

Correspondance des statuts :

| Position ASTech | Statut NEOCITY |
|---|---|
| `E` / Envoi | `open` |
| `V` / Vérification | `pending` |
| `C` / En cours | `pending` |
| `T` / Terminé | `finished` |
| `R` / Rejeté | `rejected` |

### 8.2 Architecture

- **Service web NEOCITY** : expose des méthodes de mise à jour du statut des signalements.
- **ASTech Symphonie** : un container Docker **Talend** (ETL) porte l'interface et exporte les données (demandes) vers NEOCITY.
- Les échanges sont **bidirectionnels** via HTTP(S).

| Origine | Destination | Proto | Port | Rôle |
|---|---|---|---|---|
| Serveur d'API NEOCITY | Serveur Symphonie (container Nginx) | HTTP(S) | 80 / 443 | Transfert des signalements |
| Serveur Symphonie (container Nginx) | Serveur d'API NEOCITY | HTTP(S) | 80 / 443 | Mise à jour des statuts |
| Poste client (navigateur) | Serveur Symphonie (container Nginx) | HTTP(S) | 80 / 443 | Accès utilisateur |

### 8.3 Paramétrage et comptes

- Thème **`26 / Demandes` actif**, avec « Valeur par défaut en création de documents depuis ASTech Symphonie ».
- Utilisateur dédié **NEOCITY** : rôle demandeur, groupe demandeur avec droits de création de demandes d'intervention (destination « Service ») sur les sociétés concernées, accès au thème.
- En authentification externe (SSO/LDAP), l'utilisateur NEOCITY doit pouvoir s'y connecter.
- URL API As-Tech : `https://astech.ivry94.fr/app.php/` — URL API NEOCITY : `https://api.neocity.fr` (valeurs du document fournisseur).
- Attention : le document fournisseur contient des **identifiants en clair** (mot de passe, client secret et client ID NEOCITY). À considérer comme compromis : faire tourner les secrets et les sortir de la documentation.

---

## 9. Exploitation

**Démarrage** (ordre) : instance Oracle → services IIS → `ASTech.IntrfRelv_Srvc`
→ `SBCG.Export_SRVC` → `SBCG.Export_SRVC_FormDyn` → Symphonie Box.

**Arrêt** : ordre inverse (Symphonie Box d'abord).

- **Purge des logs** par composant : client (`\ASTechOffice\Logs`), maj
  (`\ASTechSolutions\Update\Tool\Logs`), service web (`WSLogs`), services
  infocentre (`Logs`).
- **Stockage documentaire** : `\ASTechSolutions\Documents\Application` (ou
  partage `\\AWO\StockageDocumentaire$`).
- **Cohérence de version** : Symphonie, serveur métier, client et base doivent
  être **en phase** — un contrôle de version **bloque la connexion** sinon.

---

## 10. Question : `POSTE004` est-il la Symphonie Box ?

**Non.** `POSTE004` n'est **pas** la Symphonie Box (ni un serveur de fichiers
documentaire). C'est un **poste de travail** qui sert de **répertoire de
stockage documentaire** parce que le paramètre applicatif `REPDOCUMENT` pointe
dessus. La Symphonie Box est une autre machine (`symphoniebox-prod.ivry.local`).

### Cause racine : paramètre `REPDOCUMENT`

La GED AS-Tech propose 3 modes de stockage (`DossierArchitectureTechnique`, §12) :
**Externe** (fichier non déplacé), **Interne** (fichier **déplacé** vers le
serveur documentaire prédéfini) et **Base** (fichier en base). Le répertoire du
mode « Interne » est défini par le paramètre **`REPDOCUMENT`**, avec rangement
`année\mois\extension` (paramètre `REPDOC_STOCKAGE = %DATAA%\%DATMM%\%EXT%`).

Dans la base ASTECH (`SBCG_PARAM`) :

| PAR_ID | PAR_SOC | PAR_NOM | PAR_VAL |
|---|---|---|---|
| 1439 | `00` | **`REPDOCUMENT`** | **`\\POSTE004\C$\TEMP`** |
| 6572 | `00` | `REP_OPUSEXPORT` | `\\POSTE004\C$\TEMP` |
| 1439 | `10` | `REPDOCUMENT` | `\\nas-ivry01\transversal\K:\Patrimoine\SEBC\CONTROLE AMIANTE` |

`POSTE004` n'est donc pas une machine « mystérieuse » : c'est la **valeur de
configuration** du dépôt documentaire (société `00`), restée sur un poste de
transit au lieu du serveur de fichiers documentaire (`\\AWO\StockageDocumentaire$`).

### Ce que montrent les données (`DOC`)

| Critère | `POSTE004` | Attendu pour une Symphonie Box |
|---|---|---|
| Chemin | `\\POSTE004\C$\TEMP` | partage documentaire SMB (`\\AWO\…`) |
| Nature | **poste de travail** (admin `C$`, dossier `TEMP`) | serveur Linux |
| Part dans la GED | **7 191 enregistrements / 4 724 fichiers** (dont 4 713 en `PHDI`) | — |
| Premier dépôt | **18/07/2024 14:45:59** (`IMG_6381.jpg`, titré « Rideau », par ASAPH PHILIPPE / 0000196) | — |
| Période | 2024-07-18 → 2026-09-25 | — |
| Volumes | 2024 : 142 · 2025 : 4 065 · 2026 : 2 984 | — |

Les premiers jours mêlent des dépôts de test (`test.pdf` par CHOUKRI MOHAMED et
BESSOL RENÉ) : le paramètre `REPDOCUMENT` a manifestement été figé lors de la
**mise en service de juillet 2024** et n'a jamais été corrigé. Le volume est
aujourd'hui porté par le **connecteur NEOCITY** (compte d'interface, 2 241
dépôts) et une cinquantaine d'agents (photos prises au téléphone :
`picture-1.jpg`, `20260925_155826.jpg`, identifiants numériques longs).

### Pourquoi `POSTE004` est introuvable sur le réseau

Le nom n'est **résolu par aucun canal** depuis le LAN :

- **DNS** : `POSTE004`, `POSTE004.ivry.local` et `POSTE004.ivry94.local` →
  « le nom DNS n'existe pas » (pas d'enregistrement `A`).
- **NetBIOS/WINS** : aucun serveur WINS configuré, cache NetBIOS vide.
- **ICMP/SMB** : `ping` → hôte inconnu, port **445** en timeout.

Autrement dit, `\\POSTE004\C$\TEMP` est une simple **chaîne de caractères en
base** ; rien n'oblige l'hôte à exister ou à être résolvable. Soit la machine a
été **renommée / décommissionnée / écartée du domaine**, soit elle écrit en
**local** (le service applicatif tourne dessus, `C:\TEMP` local), et seuls les
serveurs applicatifs y accèdent encore — pas ton poste.

> Conclusion : `POSTE004` = poste de travail utilisé comme **répertoire de dépôt
> documentaire** via `REPDOCUMENT = \\POSTE004\C$\TEMP`. À corriger : basculer
> `REPDOCUMENT` vers le serveur documentaire, **migrer les 4 724 fichiers**,
> puis retirer la dépendance à `POSTE004`.

Les 353 autres dossiers de la GED (2 222 enregistrements / 1 564 fichiers)
pointent surtout vers `\\tsclient\…` (lecteurs redirigés d'une session
**Citrix/TSE**, ex. `M:\BE-TRV\BE-PDF\BATIMENTS COMMUNAUX\…`,
`K:\Patrimoine\PARC AUTO\…`) — cohérent avec un usage client lourd en client
léger.

---

## 11. Sources analysées

Dossier `DOC TECHNIQUE/` (non versionné) :

- `DossierArchitectureTechnique_ASTech.pdf` (48 p.)
- `AS-Tech_Ivry_DossierIntegration.docx`
- `DossierExploitation_ASTech.docx`
- `Installation Serveurs Oracle Ivry.docx`
- `AS-Tech_Symphonie_Box_Architecture_Preconisation.docx`
- `AS-Tech_Symphonie_Box_HTTPS.docx`
- `AS-Tech_Symphonie_Box_Import_Parametrage.docx`
- `AS-Tech_Symphonie_Box_Configuration_Proxy.docx`
- `AS-Tech_Symphonie_Box_Ajout_SSH_CLIENT.docx`
- `InstallationClientApplicatif_ASTech.docx`
- `Mise_a_jour_AWO_Opus.docx`
- `FS_AWO_Interface_SEDIT_Locatif.pdf`
- `FS_OPUS_SEDIT_Architecture_Preconisations.pdf`
- `Opus_NEOCITY_Architecture_PreconisationsRempli.pdf`
