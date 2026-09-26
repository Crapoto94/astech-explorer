/**
 * Référentiel d'architecture AS-Tech (synthèse des dossiers techniques
 * fournisseurs + constats d'Ivry). Données statiques, exposées en lecture seule
 * par le proxy pour l'écran « Architecture » de l'application.
 *
 * Source : DOC TECHNIQUE/ (non versionné), ARCHITECTURE.md.
 */
'use strict';

const ARCHITECTURE = {
  edition: '2026-09',
  societe: { nom: 'AS-Tech Solutions', adresse: '1280 avenue des Platanes, 34970 Lattes / Boirargues', tel: '01.60.42.74.40', web: 'www.astech-solutions.com' },

  produits: [
    { cle: 'awo', nom: 'AWO — AS-Tech Web Office', role: "Application client/serveur (client lourd) : patrimoine, GMAO, comptabilité, parc auto, agents.", techno: '.NET / C# (noyau), Crystal Reports 13, .NET Framework 4.8 ; accès données OLEDB (client Oracle natif / SQL Server).' },
    { cle: 'opus', nom: 'OPUS / Symphonie', role: 'Portail full web (consultation, saisie nomade), architecture micro-services.', techno: 'PHP (Symfony) + Angular, Docker ; NGINX, RabbitMQ, Elasticsearch, Mercure, Talend ; accès données OCI8 (Oracle) / SQLSRV.' },
    { cle: 'nomade', nom: 'Gamme Nomade', role: 'Applications mobiles (iOS / Android) de saisie déportée.', techno: "S'appuient sur le serveur Symphonie." },
    { cle: 'infocentre', nom: 'Infocentre / Pilotage / Univers BO', role: 'Éditions, statistiques, reporting.', techno: 'Crystal Reports, Business Objects.' },
  ],

  lanceur: {
    exe: 'ASTechLance.exe',
    role: "Lanceur applicatif : identifie l'utilisateur, met à jour le poste (télédistribution MSI/HTTP) et ouvre le client lourd.",
    compat: 'SSO (Single Sign-On) / LDAP.',
  },

  serveurs: [
    { role: 'Serveur métier production', os: 'Windows Server 2022', detail: 'IIS (API + MAJ client), Services Windows infocentre, utilitaires.', spec: '2 vCPU / 8 Go RAM / disque applicatif ≥ 20 Go' },
    { role: 'Serveur métier test', os: 'Windows Server 2022', detail: 'Idem, cloisonné.', spec: '2 vCPU / 8 Go RAM' },
    { role: 'Symphonie Box production', os: 'Ubuntu 20.04 LTS (VM)', detail: 'Micro-services Docker (NGINX/PHP/RabbitMQ/Elasticsearch/Mercure/Talend). VM importée (OVA/OVF/VMDK) — IP et nom fournis par le client.', spec: '2 vCPU / 4 Go RAM / 80 Go' },
    { role: 'Symphonie Box test', os: 'Ubuntu 20.04 LTS (VM)', detail: 'Idem.', spec: '2 vCPU / 4 Go RAM / 80 Go' },
  ],
  nomenclature: {
    titre: 'Noms & adresses (ce que dit la documentation)',
    points: [
      "Ces documents AS-Tech sont des modèles génériques : ils décrivent des rôles, pas des machines nommées.",
      "Serveur de fichiers : aucun nom propre — désigné par le rôle « Serveur de fichiers Prod / Test » ; alias DNS à créer. Le partage documentaire s'appelle \\\\AWO\\StockageDocumentaire$.",
      "Symphonie Box : VM Ubuntu 20.04 LTS importée ; ni nom ni IP imposés. Le script de configuration (Import_Parametrage) fixe l'IP et le nom fournis par le client ; DNS optionnel. Compte SSH « administrateur », port 3422.",
      "Seul serveur explicitement nommé dans les dossiers d'Ivry : le NAS de sauvegarde nas-syno05 — et les serveurs Oracle01 / Oracle02.",
      "POSTE004 n'est référencé dans aucun document fournisseur : c'est un poste de travail (\\POSTE004\\C$\\TEMP), à ne pas confondre avec le serveur de fichiers documentaire.",
    ],
  },

  environnements: [
    { cle: 'prod', nom: 'Production', detail: 'Environnement de production.' },
    { cle: 'test', nom: 'Test (recette / qualification / formation)', detail: 'Recette des livrables AS-Tech, qualification des interfaces, formation des utilisateurs.' },
  ],
  cloisonnement: 'Un schéma Oracle par environnement. Serveurs métier mutualisés entre environnements ; une Symphonie Box par environnement.',

  composants: [
    { groupe: 'Serveur métier Windows', items: [
      { nom: 'IIS', detail: "Site ASTechSolutions (port 80) — API .NET (ASMX/XML), publication des MAJ du client lourd, génération PDF Crystal." },
      { nom: 'SBCG.Export_SRVC', detail: 'Service Windows — publipostage / envoi de mails groupés.' },
      { nom: 'SBCG.Export_SRVC_FormDyn', detail: 'Service Windows — indexation des formulaires dynamiques.' },
      { nom: 'ASTech.IntrfRelv_Srvc', detail: 'Service Windows — interface relevés / carburant.' },
      { nom: 'MAJDSK.exe / ASTechUFLG.exe', detail: 'Utilitaire de mise à jour (schéma + binaires), contrôle de version.' },
      { nom: 'Batch / planificateur', detail: "Scripts SQL, appels d'utilitaires d'interface (RH, carburant), sauvegardes locales." },
    ] },
    { groupe: 'Symphonie Box (Docker)', items: [
      { nom: 'NGINX', detail: 'Serveur web' },
      { nom: 'PHP', detail: 'Interpréteur (couche métier)' },
      { nom: 'RabbitMQ', detail: "Gestionnaire de file d'attente (broker/consumer)" },
      { nom: 'Elasticsearch', detail: "Moteur d'indexation" },
      { nom: 'Mercure', detail: 'Push temps réel (notifications navigateurs/mobiles)' },
      { nom: 'Talend', detail: "ETL pour les interfaces" },
      { nom: 'Zabbix (agent)', detail: 'Supervision / diagnostic' },
    ] },
    { groupe: 'Infrastructure', items: [
      { nom: 'Serveur de fichier (SMB 445)', detail: 'Rôle « Serveur de fichiers Prod / Test » (pas de nom propre dans la doc AS-Tech : désigné par rôle, avec alias DNS recommandé). Partage documentaire commun AWO/Symphonie : \\\\AWO\\StockageDocumentaire$ + partage d\'échange de fichiers (rapports/PDF). Disque « fichiers » ≥ 10 Go sur le serveur métier.' },
      { nom: 'Symphonie Box (VM)', detail: 'VM préconfigurée à importer (OVA/OVF/VMDK), Ubuntu Server 20.04 LTS. Ni nom ni IP ne sont imposés par la doc : le script de configuration fixe l\'IP et le nom fournis par le client (enregistrement DNS optionnel). Accès SSH compte « administrateur », port 3422.' },
      { nom: 'NAS de sauvegarde', detail: 'Serveur de fichier nas-syno05 (volume1//ORACLE_SAUVE) — dépôt des exports Oracle.' },
      { nom: 'Serveur Ansible (AS-Tech)', detail: 'Déploiement / mise à jour des Symphonie Box via SSH (port 3422), clé RSA 4096.' },
      { nom: 'Reverse proxy + WAF', detail: 'Recommandé devant la Symphonie Box (HTTP/HTTPS).' },
    ] },
  ],

  flux: [
    { source: 'Serveur métier / Symphonie / postes', dest: 'Serveur de données', proto: 'TCP', port: '1521', role: 'Accès base Oracle (listener)' },
    { source: 'Postes / Symphonie', dest: 'Serveur de fichiers', proto: 'SMB', port: '445', role: 'Stockage documentaire' },
    { source: 'Postes (client lourd)', dest: 'Serveur métier (IIS)', proto: 'HTTP(S)', port: '80/443', role: 'MAJ client + API' },
    { source: 'Navigateur / mobiles', dest: 'Symphonie Box', proto: 'HTTP(S)', port: '80/443', role: 'Application full web' },
    { source: 'Symphonie / métier / postes', dest: 'Serveur MAIL', proto: 'SMTP', port: '25', role: 'Notifications' },
    { source: 'Ansible AS-Tech', dest: 'Symphonie Box', proto: 'SSH', port: '3422', role: 'Déploiement / mise à jour' },
    { source: 'Supervision AS-Tech', dest: 'Symphonie Box', proto: 'HTTP', port: '10050/10051', role: 'Zabbix (diagnostic)' },
    { source: 'Symphonie Box', dest: 'Dépôts', proto: 'HTTPS', port: '—', role: '*.ubuntu.com, *.launchpad.net, registry-1.docker.io, auth.docker.io, production.cloudflare.docker.com, repo.zabbix.com' },
  ],

  oracle: {
    serveurs: [
      { nom: 'Oracle01', env: 'TEST', ip: '10.103.130.20', service: 'TIVRY01', schema: 'ASTECHIVR' },
      { nom: 'Oracle02', env: 'PROD', ip: '10.103.130.25', service: 'PIVRY01', schema: 'ASTECHIVR' },
    ],
    detail: [
      "Oracle Linux 8.10 — Oracle Database Enterprise 19.23, listener port 1523.",
      '8 CPU / 30 Go RAM ; disques : système 150 Go + données 600 Go.',
      'Compte propriétaire OS : oracle (/home/oracle).',
      'Jeu de caractères instance : WE8MSWIN1252.',
    ],
    sauvegardes: [
      'expdp quotidien (21h oracle01, 21h30 oracle02) via /home/exploit/scripts/ora_export_bdd.ksh.',
      'Dépôt sur le NAS nas-syno05 (volume1//ORACLE_SAUVE), purge > 5 jours.',
      'VM sauvegardées par VMware (double protection).',
      '⚠️ Pas de contrôle automatique du bon déroulement — contrôles manuels requis ; RMAN non mis en place.',
    ],
    bascule: 'PROD → TEST : /home/oracle/proc_ivry/astech/BasculProdTest (./BasculPROD_TEST.sh) à partir de expPIVRY01.dmp.',
  },

  interfaces: [
    { nom: 'ASINTERF.exe', role: 'Interface RH' },
    { nom: 'ASTech.SAGE_PIECE.exe', role: 'Interface SAGE (pièces)' },
    { nom: 'ASTech.IntrfRelv* / Lecexcel* / Litconso.exe / Parlabel.exe', role: 'Interfaces carburant / relevés / consommation' },
    { nom: 'CirilValorisation.exe / CivitasValorisation.exe', role: 'Interfaces CIRIL / CIVITAS' },
    { nom: 'GDAValorisation.exe / GDASolder.exe / majmarche.exe / majtiers.exe', role: 'Interface Grand Angle' },
    { nom: 'SeditValorisation.exe', role: 'Interface Sedit / BL' },
    { nom: 'astre_immo_export.exe', role: 'Interface ASTRE Immo' },
    { nom: 'LDAPTest.exe', role: 'Test connexion LDAP' },
    { nom: 'ASTech.AuthHELPDESK.exe / LicExp.exe / LicAppelExp.exe', role: 'Interne (auth, licences)' },
  ],

  exploitation: {
    demarrage: [
      'Instance Oracle',
      'Services IIS (serveur métier)',
      'ASTech.IntrfRelv_Srvc',
      'SBCG.Export_SRVC',
      'SBCG.Export_SRVC_FormDyn',
      'Symphonie Box',
    ],
    arret: 'Ordre inverse (Symphonie Box en premier).',
    purge: 'Logs : client (\\ASTechOffice\\Logs), maj (\\ASTechSolutions\\Update\\Tool\\Logs), service web (WSLogs), services infocentre (Logs).',
    sauvegarde_doc: 'Stockage documentaire : \\ASTechSolutions\\Documents\\Application (partage \\\\AWO\\StockageDocumentaire$).',
    coherence: 'Symphonie, serveur métier, client et base doivent être en phase de version : un contrôle bloque la connexion sinon.',
  },

  poste004: {
    present: false,
    question: 'POSTE004 est-il la Symphonie Box ?',
    conclusion: "NON. POSTE004 n'apparaît dans aucun des 13 documents fournisseur analysés, et ses caractéristiques ne correspondent pas à une Symphonie Box (VM Ubuntu, ports 80/443, SSH 3422) ni au serveur de fichiers documentaire (SMB 445, partage \\\\AWO\\StockageDocumentaire$).",
    indice: "\\\\POSTE004\\C$\\TEMP est le partage administratif C$ d'un POSTE DE TRAVAIL (dossier TEMP) : c'est une zone de transit où l'application dépose les photos de la GED. Il concentre 7 191 enregistrements / 4 724 fichiers (dont 4 713 en thème PHDI = PHOTO DEMANDE D'INTERVENTION), de 2024-07-18 à 2026-09-25.",
    autres: "Les 353 autres dossiers GED pointent surtout vers \\\\tsclient\\… (lecteurs redirigés d'une session Citrix/TSE).",
  },

  docs_source: [
    'DossierArchitectureTechnique_ASTech.pdf',
    'AS-Tech_Ivry_DossierIntegration.docx',
    'DossierExploitation_ASTech.docx',
    'Installation Serveurs Oracle Ivry.docx',
    'AS-Tech_Symphonie_Box_Architecture_Preconisation.docx',
    'AS-Tech_Symphonie_Box_HTTPS.docx',
    'AS-Tech_Symphonie_Box_Import_Parametrage.docx',
    'AS-Tech_Symphonie_Box_Configuration_Proxy.docx',
    'AS-Tech_Symphonie_Box_Ajout_SSH_CLIENT.docx',
    'InstallationClientApplicatif_ASTech.docx',
    'Mise_a_jour_AWO_Opus.docx',
    'FS_AWO_Interface_SEDIT_Locatif.pdf',
    'FS_OPUS_SEDIT_Architecture_Preconisations.pdf',
  ],
};

module.exports = { ARCHITECTURE };
