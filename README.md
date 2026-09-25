# ASTECH Explorer

Petite application locale (Node + navigateur) de **consultation en lecture seule**
de la base Oracle **ASTECH** (GMAO / patrimoine / **gestion locative**) de la Ville.

## Fonctions

- **Tableau de bord** : nb de biens locatifs, contrats, contrats actifs, locataires,
  échéances (échéancier), total loyers/échéances ; derniers contrats et échéances récentes.
- **Biens locatifs** : liste/recherche + fiche bien (caractéristiques, adresse,
  catégorie, contrats/baux, échéances).
- **Locataires** : liste/recherche + fiche locataire (contrats, biens, échéances).
- **Contrats** : liste/recherche + fiche contrat (infos + échéances).
- **Échéances de loyer** : recherche sur l'échéancier des baux (statut Planifiée / Émise / Mandatée).

Recherche plein-texte par `LIKE` (casse-insensible) sur les colonnes clés.

## Prérequis

- **Oracle Instant Client** (mode *thick* obligatoire : le mode *thin* de
  `node-oracledb` échoue sur ASTECH avec `NJS-116`).
  Placer les libs dans `instantclient/instantclient_21_23/` (ou définir
  `ORACLE_CLIENT_LIB_DIR`).
- Node.js ≥ 18.

## Configuration (3 sources possibles, par ordre de priorité)

1. Variables d'environnement :
   `ORACLE_ASTECH_HOST`, `ORACLE_ASTECH_PORT`, `ORACLE_ASTECH_SERVICE`,
   `ORACLE_ASTECH_USER`, `ORACLE_ASTECH_PASSWORD`.
2. Fichier `config.json` (non commité) à la racine :
   ```json
   { "host": "10.103.130.25", "port": 1523, "service_name": "PIVRY01",
     "username": "ASTECHIVR", "password": "..." }
   ```
3. Base **SQLite d'AppDSI** : table `oracle_settings` (`type='ASTECH'`),
   au chemin `APPDSI_BACKEND` (défaut `C:/dev/AppDSI/backend`).

## Lancement

```
npm install
npm start
```
Puis ouvrir <http://localhost:8099>. (Sous Windows, `start.bat` équivaut à `node server.js`.)

## Modèle de données (gestion locative)

- **Bien** = entité patrimoine : `ARBO.ARB_ID = ARBO_LOCATIF.ARBLOC_ID`
  (adresse `ARBO_ADR`, classif. `CATEGORIE`/`SOUSCATEGORIE`, genre `PATRIGENE`).
- **Bail** : `CONTRAT` + `CONTRAT_LOCATIF` (`CONTL_*`, locataire `CONTL_CONTRACTANT`),
  rattaché au bien par `CONTRAT_AFF` (`CONTAF_ARBID`, `CONTAF_PRINC='O'`).
- **Échéances** : `CONTRAT_ECH` (échéancier prévisionnel du bail ; `CONTEC_NUMQUIT`/
  `CONTEC_DATQUIT` = n° et date de quittance une fois émises ; `CONTRAT_ECHTERMINEE` = historique).

> Les dates futures sont normales : il s'agit de l'échéancier **prévu** du bail.

Base Oracle **de production tierce** : l'application n'exécute que des `SELECT`.
