# Audit de la documentation éditeur — AS-Tech (`DOC TECHNIQUE`)

Analyse de la **documentation fournisseur** (éditeur AS-Tech Solutions) fournie localement dans `DOC TECHNIQUE/` et diffusée dans l'application (PDF sous `/docs/architecture-pdf/`). Réalisé le 26/09/2026.

## 1. Inventaire des documents éditeur

| Document | Format | Volume | Rôle |
|---|---|---|---|
| `DossierArchitectureTechnique_ASTech.pdf` | PDF | 48 p. / 7 585 mots | Référence architecture (composants, rôles, flux, interfaces) |
| `AS-Tech_Ivry_DossierIntegration.docx` | DOCX | 4 470 mots | Architecture déployée à Ivry (serveurs, flux, environnements) |
| `DossierExploitation_ASTech.docx` | DOCX | 1 434 mots | Exploitation AWO/OPUS (démarrage, arrêt, logs, mise à jour) |
| `Installation Serveurs Oracle Ivry.docx` | DOCX | 503 mots | Installation Oracle01/Oracle02, services, sauvegardes |
| `AS-Tech_Symphonie_Box_Architecture_Preconisation.docx` | DOCX | 1 615 mots | Micro-services Docker, ports, supervision, prérequis |
| `AS-Tech_Symphonie_Box_HTTPS.docx` | DOCX | 2 738 mots | Certificat SSL et configuration NGINX |
| `AS-Tech_Symphonie_Box_Import_Parametrage.docx` | DOCX | 1 018 mots | Import OVA/OVF/VMDK, IP/nom, DNS |
| `AS-Tech_Symphonie_Box_Configuration_Proxy.docx` | DOCX | 363 mots | Proxy global de la box (http_proxy, apt) |
| `AS-Tech_Symphonie_Box_Ajout_SSH_CLIENT.docx` | DOCX | 693 mots | Clé SSH, compte administrateur, port 3422 |
| `InstallationClientApplicatif_ASTech.docx` | DOCX | 2 443 mots | Déploiement du client lourd, lanceur, MSI |
| `Mise_a_jour_AWO_Opus.docx` | DOCX | 738 mots | Procédure de mise à jour (schéma + binaires + Symphonie) |
| `FS_AWO_Interface_SEDIT_Locatif.pdf` | PDF | 28 p. / 5 196 mots | Spécification fonctionnelle interface SEDIT (locatif) |
| `FS_OPUS_SEDIT_Architecture_Preconisations.pdf` | PDF | 11 p. / 1 666 mots | Architecture interface OPUS vers SEDIT |
| `Opus_NEOCITY_Architecture_PreconisationsRempli.pdf` | PDF | 7 p. / ~1 100 mots | Architecture interface OPUS ↔ NEOCITY (flux, statuts, comptes, paramétrage) |
| `212153_PV_INSTALLATION_3906-1.pdf` | PDF | 1 p. / 163 mots | PV d'installation (client CD-33, autre collectivité) |
| `RE Axel BION ... 204571 ... .msg` | Outlook | 23 255 car. | Échange technique Ivry du 20/06/2024 |
| `RE ExterneRE Points divers support.msg` | Outlook | 21 034 car. | Points divers support (2024-09-25) |
| `Hébergement_AsTechOnLine.fr_PAS.zip` | ZIP (4 PDF) | ISO 27001, HDS, PAS, Annexe Novadys | Sécurité de l'hébergement SaaS (pas de l'on-prem Ivry) |

Constat : la quasi-totalité des documents est orientée infrastructure / déploiement / exploitation. Un seul document est une spécification fonctionnelle (interface SEDIT Locatif).

## 2. Ce que la documentation éditeur couvre

- Déploiement et installation : serveurs métier Windows, Symphonie Box (5 documents), Oracle, client lourd, mises à jour.
- Exploitation de base : ordre de démarrage/arrêt, emplacement des logs, procédure de mise à jour.
- Architecture générale : rôles (client applicatif, base, IIS, services Windows, batch, Symphonie Box, serveur de fichier), environnements PROD/TEST.
- Flux réseau par environnement et ouverture de ports.
- Une interface tierce documentée finement : SEDIT (locatif) et OPUS.
- Sécurité côté SaaS : ISO 27001, HDS, Plan d'Assurance Sécurité, annexe d'architecture Novadys.

## 3. Ce qui manque pour comprendre réellement l'application

### 3.1 Fonctionnel métier

- Aucune référence fonctionnelle des modules AWO / OPUS / Symphonie (agents, gestion locative, interventions, GED, indices, parc, magasins) : les documents expliquent comment installer l'application, pas comment elle fonctionne.
- Seule exception : `FS_AWO_Interface_SEDIT_Locatif.pdf` (interface locative avec SEDIT).
- Pas de manuel utilisateur, pas de description des écrans, pas de règles de gestion.

### 3.2 Modèle de données

- Aucun dictionnaire de données ni schéma relationnel fourni par l'éditeur.
- Seule mention : « export de la base contenant la structure initiale et les bibliothèques » (sans données), sans description des tables/vues.
- Conséquence : comprendre les données impose de rétro-ingénierer la base (715 tables, 933 vues).

### 3.3 API

- L'API est mentionnée (« API métiers » via IIS/ASMX/XML, « Full web, API » pour Symphonie, APIs de la suite Nomade, interface SEDIT en mode Web Service, ETL Talend, édition Crystal) mais jamais documentée (aucune liste d'endpoints, aucun schéma d'authentification, aucun exemple, aucun WSDL).
- Voir la section 5.

### 3.4 Sécurité de l'installation on-premise

- Pas de modèle d'identité/permissions pour l'installation Ivry (comptes, rôles, habilitations).
- Le Plan d'Assurance Sécurité et les certifications (ISO 27001, HDS) concernent l'hébergement SaaS AsTechOnLine (Novadys), pas le déploiement chez la Ville.
- Le document `Opus_NEOCITY_Architecture_PreconisationsRempli.pdf` contient des **identifiants en clair** (mot de passe, client secret et client ID NEOCITY, identifiants d'utilisateur d'interface). À traiter comme compromis : rotation des secrets et retrait de la documentation.
- Pas de volet RGPD / données personnelles ni de politique de secrets.

### 3.5 Exploitation et soutien

- Démarrage/arrêt/logs et hotline uniquement : pas de runbook d'incident, pas de RTO/RPO, pas de procédure de sauvegarde/restauration détaillée, pas de supervision des flux, pas de gestion de crise.
- Pas de SLA, pas de matrice d'escalade, pas d'engagement de disponibilité.

### 3.6 Qualité et cycle de vie

- Pas de plan de tests ni de critères d'acceptation/qualification.
- Pas de changelog produit, pas de politique de versions ni de fin de support (EOL), pas de document de licence.
- Pas de feuille de route ni d'engagements d'évolution.

### 3.7 Forme et traçabilité

- Annexes à renseigner laissées vides : « Nom de la machine », « IP publique », « ports translatés » — donc noms réels des serveurs inconnus (cf. POSTE004).
- Diagrammes fournis en images (non recherchables, non exploitables automatiquement).
- Un PV d'un autre client (CD-33) sert de référence ; pas de PV Ivry.
- Documentation non versionnée côté Ville (`DOC TECHNIQUE/` hors dépôt Git) : pas d'historique, risque de perte.

## 4. Conformité aux bonnes pratiques (documentation éditeur)

| Pratique | Attendu | État |
|---|---|---|
| Docs-as-code | source versionnée, différable | Non (PDF/DOCX statiques, hors git) |
| Diataxis (4 types) | tutorials / how-to / reference / explanation | how-to et explanation fournis ; reference quasi absente ; 0 tutorial |
| Référence fonctionnelle | description des modules et règles | Absente (1 seule FS d'interface) |
| Dictionnaire de données | tables/colonnes documentées | Absent |
| API-first | spec OpenAPI/WSDL livrée | Absente (API seulement mentionnée) |
| Modèle de sécurité on-prem | identités, rôles, secrets | Absent (sécurité = SaaS uniquement) |
| Runbooks / SLA | exploitation, incidents, engagements | Absent (procédures de base seulement) |
| Tests / qualification | plan et critères d'acceptation | Absent |
| Changelog / versioning / EOL | cycle de vie produit | Absent |
| RGPD / données perso | traitement des données personnelles | Absent |
| Diagrammes exploitables | texte/vecteur, sources | Images non recherchables |
| Annexes complétées | noms/IP/ports réels | Vides |

## 5. L'API de l'éditeur (produit AS-Tech)

- Où est sa documentation ? Nulle part dans `DOC TECHNIQUE`. L'API n'est qu'évoquée : « API métiers » publiées par IIS (fichier ASMX / XML), « Full web, API » pour Symphonie, APIs d'accès pour la suite Nomade (téléphones/tablettes), interface SEDIT en mode Web Service, ETL Talend, édition Crystal. Un seul service réel est identifiable : `ASTechReports/CrystalWS.asmx?WSDL` (SOAP), découvert dans la base (paramètre `REPORTWSBASEURL`).
- Saurais-tu l'exploiter ? Pas avec les documents fournis : sans liste d'endpoints, sans WSDL/OpenAPI, sans schéma d'authentification ni exemples. Il faut la demander à AS-Tech, ou récupérer les WSDL des services ASMX déployés sur le serveur IIS.
- Lecture/écriture ? Inconnu faute de documentation ; les services ASMX d'édition sont a priori en lecture, mais rien ne le garantit.
- Lacunes : aucune référence d'API (endpoints, méthodes, paramètres, réponses, erreurs), aucune politique de versioning, aucune documentation d'authentification/autorisation, aucun catalogue des services exposés.

## 6. Synthèse

- Documentation éditeur solide sur l'infrastructure (déploiement/exploitation, Symphonie Box, Oracle, client lourd), quasi muette sur le fonctionnel, sur le modèle de données, sur l'API et sur la sécurité on-premise.
- Pour comprendre le fonctionnement réel de l'application, il faut compléter par la rétro-ingénierie de la base et par des demandes formelles à AS-Tech (dictionnaire de données, référence API, modèle de sécurité).
- L'API du produit AS-Tech n'est pas exploitable en l'état : elle doit être documentée par l'éditeur (WSDL/OpenAPI) avant tout usage.
