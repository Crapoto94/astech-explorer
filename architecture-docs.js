/**
 * Inventaire des PDF d'architecture publiés dans public/vendor/... (servis par
 * /docs/architecture-pdf/) + repères de pages pour les liens contextuels du MD
 * et de l'écran « Architecture ».
 */
'use strict';

const DOCS = [
  { fichier: '00_DossierArchitectureTechnique_ASTech.pdf', titre: "Dossier d'Architecture Technique AS-Tech", pages: 48, role: 'Référence architecture (composants, flux, préconisations).' },
  { fichier: '01_DossierIntegration_AS-Tech_Ivry.pdf', titre: "Dossier d'intégration AS-Tech / Ivry", pages: null, role: 'Architecture déployée à Ivry (serveurs, flux, environnements, interfaces).' },
  { fichier: '02_DossierExploitation_ASTech.pdf', titre: "Dossier d'exploitation AWO / OPUS", pages: null, role: 'Démarrage/arrêt, sauvegardes, restauration, supervision, liste des exécutables.' },
  { fichier: '03_Installation_Serveurs_Oracle_Ivry.pdf', titre: 'Installation des serveurs Oracle (Ivry)', pages: 2, role: 'Oracle01/Oracle02, IPs, services, sauvegardes expdp, bascule PROD→TEST.' },
  { fichier: '04_Symphonie_Box_Architecture_Preconisation.pdf', titre: 'Symphonie Box — Architecture & préconisations', pages: 11, role: 'Micro-services Docker, ports, supervision, prérequis.' },
  { fichier: '05_Symphonie_Box_HTTPS.pdf', titre: 'Symphonie Box — HTTPS', pages: null, role: 'Mise en place du certificat SSL et configuration NGINX.' },
  { fichier: '06_Symphonie_Box_Import_Parametrage.pdf', titre: 'Symphonie Box — Import & paramétrage de la VM', pages: null, role: "Import OVA/OVF/VMDK, IP/nom, enregistrement DNS." },
  { fichier: '07_Symphonie_Box_Configuration_Proxy.pdf', titre: 'Symphonie Box — Configuration proxy', pages: null, role: 'Proxy global de la box (http_proxy, apt).' },
  { fichier: '08_Symphonie_Box_Ajout_SSH_CLIENT.pdf', titre: 'Symphonie Box — Ajout connexion SSH', pages: null, role: 'Clé SSH, compte administrateur, port 3422.' },
  { fichier: '09_InstallationClientApplicatif_ASTech.pdf', titre: 'Installation du client applicatif AS-Tech', pages: null, role: 'Déploiement du client lourd, lanceur, composants MSI.' },
  { fichier: '10_Mise_a_jour_AWO_Opus.pdf', titre: 'Mise à jour AWO / OPUS', pages: null, role: 'Procédure de mise à jour (schéma + binaires + Symphonie).' },
  { fichier: '11_FS_AWO_Interface_SEDIT_Locatif.pdf', titre: 'FS — Interface AWO ↔ SEDIT (Locatif)', pages: 28, role: 'Spécification fonctionnelle de l\'interface SEDIT (locatif).' },
  { fichier: '12_FS_OPUS_SEDIT_Architecture_Preconisations.pdf', titre: 'FS — OPUS ↔ SEDIT, architecture', pages: 11, role: 'Architecture/préconisations de l\'interface OPUS ↔ SEDIT.' },
];

// Repères : rubrique du MD -> [fichier PDF, page (1-indexée)]
const SOURCES = {
  editeur: ['00_DossierArchitectureTechnique_ASTech.pdf', 4],
  produits: ['00_DossierArchitectureTechnique_ASTech.pdf', 9],
  awo: ['00_DossierArchitectureTechnique_ASTech.pdf', 10],
  symphonie: ['00_DossierArchitectureTechnique_ASTech.pdf', 10],
  lanceur: ['00_DossierArchitectureTechnique_ASTech.pdf', 35],
  serveurs: ['01_DossierIntegration_AS-Tech_Ivry.pdf', null],
  environnements: ['01_DossierIntegration_AS-Tech_Ivry.pdf', null],
  composants: ['01_DossierIntegration_AS-Tech_Ivry.pdf', null],
  services_windows: ['02_DossierExploitation_ASTech.pdf', null],
  oracle: ['03_Installation_Serveurs_Oracle_Ivry.pdf', 1],
  oracle_sauvegardes: ['03_Installation_Serveurs_Oracle_Ivry.pdf', 1],
  flux: ['01_DossierIntegration_AS-Tech_Ivry.pdf', null],
  interfaces: ['02_DossierExploitation_ASTech.pdf', null],
  exploitation: ['02_DossierExploitation_ASTech.pdf', null],
  symphonie_box: ['04_Symphonie_Box_Architecture_Preconisation.pdf', 1],
  symphonie_https: ['05_Symphonie_Box_HTTPS.pdf', 1],
  symphonie_ssh: ['08_Symphonie_Box_Ajout_SSH_CLIENT.pdf', 1],
  symphonie_import: ['06_Symphonie_Box_Import_Parametrage.pdf', 1],
  client_lourd: ['09_InstallationClientApplicatif_ASTech.pdf', null],
  maj: ['10_Mise_a_jour_AWO_Opus.pdf', null],
  sedit_locatif: ['11_FS_AWO_Interface_SEDIT_Locatif.pdf', 1],
  sedit_opus: ['12_FS_OPUS_SEDIT_Architecture_Preconisations.pdf', 1],
};

module.exports = { DOCS, SOURCES };
