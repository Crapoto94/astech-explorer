/**
 * ASTECH Explorer — proxy local (lecture seule) au-dessus de la base Oracle ASTECH.
 * Mode THICK obligatoire (Instant Client). Config lue depuis la SQLite d'AppDSI
 * (oracle_settings/type ASTECH), config.json ou variables ORACLE_ASTECH_*.
 *
 * AUCUNE ÉCRITURE : toutes les requêtes de ce serveur sont des SELECT.
 * Lancement : node server.js  ->  http://localhost:8099
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const apikeys = require('./apikeys');

// Charge .env (local, non commité) avant toute lecture de process.env.
(function loadDotEnv() {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch { /* .env optionnel */ }
})();

const APPDSI = process.env.APPDSI_BACKEND || 'C:/dev/AppDSI/backend';
let oracledb;
try { oracledb = require('oracledb'); } catch { oracledb = require(APPDSI + '/node_modules/oracledb'); }

const PORT = process.env.PORT || 8099;
// Les écritures (pousser des indices) sont désactivées par défaut.
const WRITE_ENABLED = process.env.ASTECH_ALLOW_WRITES === '1';
const LIMIT = Number(process.env.ASTECH_LIMIT || 50000);
// Avant 2024 = données d'essai (reprise) : on ne les considère pas pour le locatif.
const CUTOFF = "DATE '2024-01-01'";
const IC = process.env.ORACLE_CLIENT_LIB_DIR || path.join(__dirname, 'instantclient', 'instantclient_21_23');
oracledb.initOracleClient({ libDir: IC });

// La source Studio-RH n'est pas encore branchée (clé/API à fournir).
// Configuration par ordre de priorité : variables d'env, puis config.json (bloc "studio_rh").
const STUDIO_RH = { url: '', key: '', configured: false, insecure: true };
function loadStudioRh() {
  let url = process.env.STUDIO_RH_API_URL || '';
  let key = process.env.STUDIO_RH_API_KEY || '';
  const cfgPath = path.join(__dirname, 'config.json');
  if ((!url || !key) && fs.existsSync(cfgPath)) {
    try {
      const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (c.studio_rh) { url = url || c.studio_rh.url || ''; key = key || c.studio_rh.api_key || ''; }
    } catch { /* ignore */ }
  }
  STUDIO_RH.url = url; STUDIO_RH.key = key; STUDIO_RH.configured = !!(url && key);
  // Certificat interne (CA auto-signée) : toléré par défaut, désactivable via STUDIO_RH_INSECURE_TLS=0.
  STUDIO_RH.insecure = process.env.STUDIO_RH_INSECURE_TLS !== '0';
}

// ─── Base : profils prod / test ───────────────────────────────────────────────
// Le profil actif est choisi par requête via l'en-tête « X-ASTECH-Env » ou
// ?env=test (défaut : prod). Chaque profil a son propre pool Oracle.
const DB_ENV = new AsyncLocalStorage();
const DB_PROFILES = {};       // id -> { user, password, connectString, label }
const DB_POOLS = {};          // id -> pool oracledb (créé à la demande)
let ACTIVE_ENV = 'prod';
let connectInfo = '';

function normEnv(v) {
  const s = String(v || '').toLowerCase().trim();
  if (s === 'test' || s === 'recette' || s === 'preprod' || s === 'dev') return 'test';
  if (s === 'prod' || s === 'production') return 'prod';
  return s;
}
function envFromPrefix(prefix) {
  const host = process.env[prefix + '_HOST'];
  if (!host) return null;
  return {
    user: process.env[prefix + '_USER'],
    password: process.env[prefix + '_PASSWORD'],
    connectString: `${host}:${process.env[prefix + '_PORT'] || 1521}/${process.env[prefix + '_SERVICE']}`,
  };
}
function readConfigJson() {
  try { const p = path.join(__dirname, 'config.json'); if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* ignore */ }
  return null;
}
async function loadDbConfigs() {
  const c = readConfigJson();
  // PROD : env ORACLE_ASTECH_*, puis config.json, puis SQLite AppDSI.
  let prod = envFromPrefix('ORACLE_ASTECH');
  if (!prod && c && (c.host || c.username)) prod = { user: c.username, password: c.password, connectString: `${c.host}:${c.port}/${c.service_name || c.service}` };
  if (!prod) {
    try {
      const { setupDb, getSqlite } = require(APPDSI + '/shared/database');
      await setupDb();
      const s = await getSqlite().get("SELECT host, port, service_name, username, password FROM oracle_settings WHERE type='ASTECH'");
      if (s && s.host) prod = { user: s.username, password: s.password, connectString: `${s.host}:${s.port}/${s.service_name}` };
    } catch { /* ignore */ }
  }
  // TEST : env ORACLE_ASTECH_TEST_*, puis config.json (bloc "oracle_test").
  let test = envFromPrefix('ORACLE_ASTECH_TEST');
  if (!test && c) {
    const t = c.oracle_test || c.test;
    if (t && t.host) test = { user: t.username || t.user, password: t.password, connectString: `${t.host}:${t.port || 1521}/${t.service_name || t.service}` };
  }
  const profiles = {};
  if (prod) profiles.prod = { ...prod, label: 'Production' };
  if (test) profiles.test = { ...test, label: 'Test / Recette' };
  if (!Object.keys(profiles).length) throw new Error('Paramètres ASTECH introuvables (env ORACLE_ASTECH_*, config.json ou oracle_settings).');
  return profiles;
}
function currentDbEnv() { return (DB_ENV.getStore() && DB_ENV.getStore().env) || ACTIVE_ENV; }
function dbEnvList() { return Object.keys(DB_PROFILES).map((id) => ({ id, label: DB_PROFILES[id].label, connectString: DB_PROFILES[id].connectString })); }
function dbConnectInfo() { const p = DB_PROFILES[currentDbEnv()] || DB_PROFILES[ACTIVE_ENV]; return (p && p.connectString) || connectInfo; }
async function getPool(envId) {
  const id = DB_PROFILES[envId] ? envId : ACTIVE_ENV;
  if (DB_POOLS[id]) return DB_POOLS[id];
  DB_POOLS[id] = await oracledb.createPool({ ...DB_PROFILES[id], poolMin: 1, poolMax: 4, poolIncrement: 1, poolPingInterval: 30 });
  return DB_POOLS[id];
}

// ─── Base ────────────────────────────────────────────────────────────────────
function normalizeRows(rows) {
  return (rows || []).map((r) => {
    const o = {};
    for (const k of Object.keys(r)) {
      let v = r[k];
      if (typeof v === 'string') v = v.replace(/\s+$/, '');
      o[k.toLowerCase()] = v;
    }
    return o;
  });
}
async function exec(sql, binds = {}, maxRows = LIMIT) {
  const conn = await (await getPool(currentDbEnv())).getConnection();
  try {
    const r = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows });
    return normalizeRows(r.rows);
  } finally { await conn.close(); }
}
// Transaction d'écriture (commit/rollback) sur le profil courant.
async function execTx(fn) {
  const conn = await (await getPool(currentDbEnv())).getConnection();
  try { const out = await fn(conn); await conn.commit(); return out; }
  catch (e) { try { await conn.rollback(); } catch { /* ignore */ } throw e; }
  finally { await conn.close(); }
}
async function one(sql, binds = {}) { const r = await exec(sql, binds, 1); return r[0] || null; }
const int = (v, def, max) => { const n = Math.max(0, Math.floor(Number(v))); return Number.isFinite(n) && n > 0 ? Math.min(n, max || 1000000) : def; };

// ─── Locatif ─────────────────────────────────────────────────────────────────
const BIEN_SELECT = `
  SELECT A.ARB_ID AS id, A.ARB_CODE AS code, A.ARB_DES AS bien, A.ARB_NOMC AS nom_court,
         TRIM(NVL(ADR.ARBA_ADR1,' ')||' '||NVL(ADR.ARBA_CP,' ')||' '||NVL(ADR.ARBA_VILLE,' ')) AS adresse,
         CAT.SCAT_DES AS categorie, SCAT.SSCAT_DES AS sous_cat, PG.SGEN_DES AS genre,
         AL.ARBLOC_TYPELOG AS type_log, AL.ARBLOC_DESTINATION AS destination,
         AL.ARBLOC_NBPIECES AS pieces, AL.ARBLOC_SURFACE AS surface,
         AL.ARBLOC_TIERS AS tiers, AL.ARBLOC_CONTACT AS contact
  FROM ARBO A
  JOIN ARBO_LOCATIF AL ON AL.ARBLOC_ID = A.ARB_ID
  LEFT JOIN PATRIGENE PG ON PG.SGEN_COD = A.ARB_GENRE
  LEFT JOIN ARBO_ADR ADR ON ADR.ARBA_ID = A.ARB_ID
  LEFT JOIN CATEGORIE CAT ON CAT.SCAT_COD = A.ARB_CAT
  LEFT JOIN SOUSCATEGORIE SCAT ON SCAT.SSCAT_COD = A.ARB_SCAT`;

const CONTRAT_SELECT = `
  SELECT C.CONT_ID AS id, C.CONT_COD AS code, C.CONT_DES AS objet, C.CONT_ACTIF AS actif,
         TO_CHAR(C.CONT_DATDEB,'DD/MM/YYYY') AS debut_contrat, TO_CHAR(C.CONT_DATFIN,'DD/MM/YYYY') AS fin_contrat,
         CL.CONTL_CONTRACTANT AS locataire, CL.CONTL_MTACT AS loyer, CL.CONTL_DEPMT AS depot,
         TO_CHAR(CL.CONTL_DATENTREE,'DD/MM/YYYY') AS entree, TO_CHAR(CL.CONTL_DATSORTIE,'DD/MM/YYYY') AS sortie,
         TO_CHAR(CL.CONTL_DATDEBQUIT,'DD/MM/YYYY') AS quittance_depuis, TO_CHAR(CL.CONTL_DATCLO,'DD/MM/YYYY') AS cloture,
         TO_CHAR(CL.CONTL_DATREVD,'DD/MM/YYYY') AS derniere_revision, TO_CHAR(CL.CONTL_DATREVP,'DD/MM/YYYY') AS prochaine_revision,
         A.ARB_ID AS bien_id, A.ARB_CODE AS code_bien, A.ARB_DES AS bien
  FROM CONTRAT C
  LEFT JOIN CONTRAT_LOCATIF CL ON CL.CONTL_ID = C.CONT_ID
  LEFT JOIN CONTRAT_AFF CAF ON CAF.CONTAF_ID = C.CONT_ID AND CAF.CONTAF_PRINC = 'O'
  LEFT JOIN ARBO A ON A.ARB_ID = CAF.CONTAF_ARBID`;

// Échéancier = CONTRAT_ECH (prévisionnel) UNION CONTRAT_ECHTERMINEE (historique émis).
// CONTEC_DATE = mois dû ; CONTEC_DATQUIT = date d'émission de la quittance.
const ECHEANCE_UNION = `
  SELECT E.CONTEC_ID AS id, E.CONTEC_CONTID AS contrat_id, E.CONTEC_NUMQUIT AS num_quittance,
         E.CONTEC_DATE AS date_echeance_ts,
         TO_CHAR(E.CONTEC_DATE,'DD/MM/YYYY') AS date_echeance, E.CONTEC_DES AS periode,
         TO_CHAR(E.CONTEC_DATEDEB,'DD/MM/YYYY') AS du, TO_CHAR(E.CONTEC_DATEFIN,'DD/MM/YYYY') AS au,
         E.CONTEC_MTHT AS montant_ht, E.CONTEC_MTTC AS montant_ttc,
         TO_CHAR(E.CONTEC_DATQUIT,'DD/MM/YYYY') AS date_quittance,
         E.CONTEC_NUMMAN AS num_mandat, TO_CHAR(E.CONTEC_DATGF,'DD/MM/YYYY') AS date_gf,
         CASE WHEN E.CONTEC_DATGF IS NOT NULL THEN 'Mandatée'
              WHEN E.CONTEC_NUMQUIT IS NOT NULL OR E.CONTEC_DATQUIT IS NOT NULL THEN 'Émise'
              WHEN E.CONTEC_DATE < TRUNC(SYSDATE) THEN 'Échue (non émise)'
              ELSE 'Planifiée' END AS statut,
         'ECH' AS source
  FROM CONTRAT_ECH E
  UNION ALL
  SELECT E.CONTEC_ID, E.CONTEC_CONTID, E.CONTEC_NUMQUIT,
         E.CONTEC_DATE,
         TO_CHAR(E.CONTEC_DATE,'DD/MM/YYYY'), E.CONTEC_DES,
         TO_CHAR(E.CONTEC_DATEDEB,'DD/MM/YYYY'), TO_CHAR(E.CONTEC_DATEFIN,'DD/MM/YYYY'),
         E.CONTEC_MTHT, E.CONTEC_MTTC,
         TO_CHAR(E.CONTEC_DATQUIT,'DD/MM/YYYY'),
         E.CONTEC_NUMMAN, TO_CHAR(E.CONTEC_DATGF,'DD/MM/YYYY'),
         CASE WHEN E.CONTEC_DATGF IS NOT NULL THEN 'Mandatée' ELSE 'Émise' END,
         'HIST'
  FROM CONTRAT_ECHTERMINEE E`;

const ECHEANCE_SELECT = `
  SELECT X.*, C.CONT_COD AS contrat, C.CONT_ID AS contrat_ref, CL.CONTL_CONTRACTANT AS locataire,
         A.ARB_CODE AS code_bien, A.ARB_DES AS bien, A.ARB_ID AS bien_id
  FROM (${ECHEANCE_UNION}) X
  JOIN CONTRAT C ON C.CONT_ID = X.contrat_id
  LEFT JOIN CONTRAT_LOCATIF CL ON CL.CONTL_ID = C.CONT_ID
  LEFT JOIN CONTRAT_AFF CAF ON CAF.CONTAF_ID = C.CONT_ID AND CAF.CONTAF_PRINC = 'O'
  LEFT JOIN ARBO A ON A.ARB_ID = CAF.CONTAF_ARBID`;

async function echeances(where, binds, limit = 5000) {
  const n = int(limit, 5000, 100000);
  const futures = await exec(`${ECHEANCE_SELECT}
    WHERE ${where} AND X.date_echeance_ts >= TRUNC(SYSDATE)
    ORDER BY X.date_echeance_ts ASC FETCH FIRST ${n} ROWS ONLY`, binds, n);
  const passees = await exec(`${ECHEANCE_SELECT}
    WHERE ${where} AND X.date_echeance_ts < TRUNC(SYSDATE) AND X.date_echeance_ts >= ${CUTOFF}
    ORDER BY X.date_echeance_ts DESC FETCH FIRST ${n} ROWS ONLY`, binds, n);
  return { futures, passees };
}

async function getDashboard() {
  const [kpi] = await exec(`SELECT
      (SELECT COUNT(*) FROM ARBO A JOIN ARBO_LOCATIF AL ON AL.ARBLOC_ID=A.ARB_ID) AS biens,
      (SELECT COUNT(*) FROM CONTRAT_LOCATIF) AS contrats,
      (SELECT COUNT(*) FROM CONTRAT WHERE CONT_ACTIF='O') AS contrats_actifs,
      (SELECT COUNT(DISTINCT conTL_contractant) FROM CONTRAT_LOCATIF) AS locataires,
      (SELECT COUNT(*) FROM CONTRAT_ECH WHERE CONTEC_DATE >= ${CUTOFF}) AS echeances,
      (SELECT COUNT(*) FROM CONTRAT_ECHTERMINEE) AS echeances_terminees,
      (SELECT NVL(SUM(conTL_mtact),0) FROM CONTRAT_LOCATIF) AS loyers_actifs,
      (SELECT NVL(SUM(contec_mttc),0) FROM CONTRAT_ECH WHERE CONTEC_DATE >= ${CUTOFF}) AS montant_echeances,
      (SELECT COUNT(*) FROM INTERVENTIONS) AS interventions,
      (SELECT COUNT(*) FROM DEMANDES) AS demandes
    FROM DUAL`);
  const [agents] = await exec(`SELECT COUNT(*) total,
      SUM(CASE WHEN sign='O' THEN 1 ELSE 0 END) actifs,
      SUM(CASE WHEN sign='N' OR sign IS NULL THEN 1 ELSE 0 END) inactifs,
      SUM(CASE WHEN nb>0 THEN 1 ELSE 0 END) utilisateurs,
      SUM(CASE WHEN nb>0 THEN 0 ELSE 1 END) simples
    FROM (${AGENT_BASE})`);
  const [admins] = await exec(`SELECT COUNT(*) n FROM DEMANDEUR
    WHERE sdem_rolegest='O' AND sdem_roleordon='O' AND sdem_rolecompta='O'`);
  const prochainesEcheances = await exec(`${ECHEANCE_SELECT} WHERE X.date_echeance_ts >= TRUNC(SYSDATE)
    ORDER BY X.date_echeance_ts ASC FETCH FIRST 8 ROWS ONLY`);
  const dernieresQuittances = await exec(`${ECHEANCE_SELECT} WHERE X.date_echeance_ts < TRUNC(SYSDATE) AND X.date_echeance_ts >= ${CUTOFF}
    ORDER BY X.date_echeance_ts DESC FETCH FIRST 8 ROWS ONLY`);
  const derniersContrats = await exec(`${CONTRAT_SELECT} WHERE (C.CONT_DATFIN IS NULL OR C.CONT_DATFIN >= ${CUTOFF})
    ORDER BY C.CONT_DATDEB DESC NULLS LAST FETCH FIRST 8 ROWS ONLY`);
  const indices = await indicesResume();
  const interventions = await intervKpis();
  return {
    kpi: { ...kpi, admins: admins ? admins.n : 0, total_agents: agents ? Number(agents.total) : 0,
      agents_actifs: agents ? Number(agents.actifs) : 0, agents_inactifs: agents ? Number(agents.inactifs) : 0,
      agents_utilisateurs: agents ? Number(agents.utilisateurs) : 0, agents_simples: agents ? Number(agents.simples) : 0 },
    prochainesEcheances, dernieresQuittances, derniersContrats, indices, interventions,
  };
}

async function listBiens(term) {
  return exec(`${BIEN_SELECT}
    WHERE UPPER(NVL(A.ARB_CODE,' ')||' '||NVL(A.ARB_DES,' ')||' '||NVL(ADR.ARBA_ADR1,' ')
               ||' '||NVL(ADR.ARBA_VILLE,' ')||' '||NVL(CAT.SCAT_DES,' ')) LIKE :q
    ORDER BY A.ARB_DES FETCH FIRST ${LIMIT} ROWS ONLY`, { q: '%' + term.toUpperCase() + '%' });
}
async function getBien(id) {
  const [bien] = await exec(`${BIEN_SELECT} WHERE A.ARB_ID = :id`, { id });
  if (!bien) return null;
  const contrats = await exec(`${CONTRAT_SELECT} WHERE CAF.CONTAF_ARBID = :id AND CAF.CONTAF_PRINC='O'
    AND (C.CONT_DATFIN IS NULL OR C.CONT_DATFIN >= ${CUTOFF}) ORDER BY C.CONT_DATDEB DESC`, { id });
  const echs = await echeances(`CAF.CONTAF_ARBID = :id AND CAF.CONTAF_PRINC='O'`, { id }, 5000);
  return { bien, contrats, ...echs };
}
async function listLocataires(term) {
  return exec(`SELECT * FROM (
      SELECT CL.CONTL_CONTRACTANT AS locataire, COUNT(*) AS nb_contrats,
             COUNT(DISTINCT CAF.CONTAF_ARBID) AS nb_biens, MAX(CL.CONTL_MTACT) AS loyer_max
      FROM CONTRAT_LOCATIF CL
      LEFT JOIN CONTRAT C ON C.CONT_ID = CL.CONTL_ID
      LEFT JOIN CONTRAT_AFF CAF ON CAF.CONTAF_ID = C.CONT_ID AND CAF.CONTAF_PRINC='O'
      WHERE UPPER(NVL(CL.CONTL_CONTRACTANT,' ')) LIKE :q
      GROUP BY CL.CONTL_CONTRACTANT ORDER BY CL.CONTL_CONTRACTANT)
    WHERE rownum <= ${LIMIT}`, { q: '%' + term.toUpperCase() + '%' });
}
async function getLocataire(name) {
  const contrats = await exec(`${CONTRAT_SELECT} WHERE UPPER(CL.CONTL_CONTRACTANT) = UPPER(:name)
    AND (C.CONT_DATFIN IS NULL OR C.CONT_DATFIN >= ${CUTOFF}) ORDER BY C.CONT_DATDEB DESC`, { name });
  const echs = await echeances(`UPPER(CL.CONTL_CONTRACTANT) = UPPER(:name)`, { name }, 5000);
  return { locataire: name, contrats, ...echs };
}
async function listContrats(term) {
  return exec(`${CONTRAT_SELECT}
    WHERE UPPER(NVL(C.CONT_COD,' ')||' '||NVL(C.CONT_DES,' ')||' '||NVL(CL.CONTL_CONTRACTANT,' ')
              ||' '||NVL(A.ARB_DES,' ')) LIKE :q
    AND (C.CONT_DATFIN IS NULL OR C.CONT_DATFIN >= ${CUTOFF})
    ORDER BY C.CONT_DATDEB DESC NULLS LAST FETCH FIRST ${LIMIT} ROWS ONLY`, { q: '%' + term.toUpperCase() + '%' });
}
async function getContrat(id) {
  const [contrat] = await exec(`${CONTRAT_SELECT} WHERE C.CONT_ID = :id`, { id });
  if (!contrat) return null;
  const echs = await echeances(`X.contrat_id = :id`, { id }, 5000);
  const revisions = await getContratRevisions(id);
  return { contrat, revisions, ...echs };
}
async function getContratRevisions(id) {
  return exec(`SELECT R.CONTRV_ID AS id, TO_CHAR(R.CONTRV_DAT,'DD/MM/YYYY') AS dat,
      TO_CHAR(R.CONTRV_DATAPPLI,'DD/MM/YYYY') AS dat_appli,
      R.CONTRV_POURC AS pourc, R.CONTRV_MTP AS loyer_avant, R.CONTRV_MT AS loyer_apres,
      R.CONTRV_INSEEP AS indice_prec_id, R.CONTRV_INSEE AS indice_id,
      IP.INSEE_DES AS indice_prec, INEW.INSEE_DES AS indice
    FROM CONTRAT_REVISION R
    LEFT JOIN INDICEINSEE IP ON IP.INSEE_ID = R.CONTRV_INSEEP
    LEFT JOIN INDICEINSEE INEW ON INEW.INSEE_ID = R.CONTRV_INSEE
    WHERE R.CONTRV_CONTID = :id ORDER BY R.CONTRV_DAT DESC NULLS LAST FETCH FIRST 5000 ROWS ONLY`, { id });
}
async function listQuittances(term) {
  const where = `UPPER(NVL(X.periode,' ')||' '||NVL(X.num_quittance,' ')||' '||NVL(CL.CONTL_CONTRACTANT,' ')
              ||' '||NVL(A.ARB_DES,' ')||' '||NVL(C.CONT_COD,' ')) LIKE :q`;
  return echeances(where, { q: '%' + term.toUpperCase() + '%' }, LIMIT);
}
async function listRevisions(term) {
  return exec(`SELECT R.CONTRV_ID AS id, C.CONT_COD AS contrat, C.CONT_ID AS contrat_id,
      CL.CONTL_CONTRACTANT AS locataire, A.ARB_CODE AS code_bien, A.ARB_DES AS bien, A.ARB_ID AS bien_id,
      TO_CHAR(R.CONTRV_DAT,'DD/MM/YYYY') AS dat, TO_CHAR(R.CONTRV_DATAPPLI,'DD/MM/YYYY') AS dat_appli,
      R.CONTRV_POURC AS pourc, R.CONTRV_MTP AS loyer_avant, R.CONTRV_MT AS loyer_apres,
      INEW.INSEE_DES AS indice
    FROM CONTRAT_REVISION R
    JOIN CONTRAT C ON C.CONT_ID = R.CONTRV_CONTID
    LEFT JOIN CONTRAT_LOCATIF CL ON CL.CONTL_ID = C.CONT_ID
    LEFT JOIN INDICEINSEE INEW ON INEW.INSEE_ID = R.CONTRV_INSEE
    LEFT JOIN CONTRAT_AFF CAF ON CAF.CONTAF_ID = C.CONT_ID AND CAF.CONTAF_PRINC='O'
    LEFT JOIN ARBO A ON A.ARB_ID = CAF.CONTAF_ARBID
    WHERE UPPER(NVL(CL.CONTL_CONTRACTANT,' ')||' '||NVL(C.CONT_COD,' ')||' '||NVL(A.ARB_DES,' ')) LIKE :q
    ORDER BY R.CONTRV_DAT DESC NULLS LAST FETCH FIRST ${LIMIT} ROWS ONLY`, { q: '%' + term.toUpperCase() + '%' });
}

// ─── Agents / comptes ────────────────────────────────────────────────────────
const AGENT_BASE = `
  SELECT u.USR_ID AS usr_id, u.USR_NAME AS matricule, u.USR_DETAIL AS nom,
         TO_CHAR(u.USR_DATINVALID,'DD/MM/YYYY') AS datinvalid,
         TO_CHAR(u.USR_MAJ,'DD/MM/YYYY HH24:MI') AS maj,
         d.SDEM_COD AS sdem_cod, d.SDEM_DES AS des, d.SDEM_SSERV AS sserv,
         d.SDEM_EMAIL AS email, d.SDEM_AUTHSYS AS authsys,
         TRIM(d.SDEM_ROLEAPP) AS roleapp, d.SDEM_SIGN AS sign,
         d.SDEM_ROLEGEST AS gest, d.SDEM_ROLEORDON AS ordon, d.SDEM_ROLECOMPTA AS compta,
         s.SSER_NOM AS service,
         (SELECT COUNT(*) FROM SBCG_USERPROFIL p WHERE p.USR_ID = u.USR_ID) AS nb
  FROM SBCG_USERS u
  LEFT JOIN DEMANDEUR d ON d.SDEM_USR = u.USR_ID
  LEFT JOIN SERVICE s ON s.SSER_COD = d.SDEM_SSERV`;

function agentWhere(f, binds) {
  const w = [];
  if (f.q) { w.push(`UPPER(NVL(nom,' ')||' '||NVL(matricule,' ')||' '||NVL(des,' ')||' '||NVL(service,' ')||' '||NVL(email,' ')) LIKE :q`); binds.q = '%' + f.q.toUpperCase() + '%'; }
  if (f.type === 'utilisateur') w.push('nb > 0');
  if (f.type === 'simple') w.push('nb = 0');
  if (f.admin) w.push(`gest='O' AND ordon='O' AND compta='O'`);
  if (f.actif === 'actif') w.push("sign = 'O'");
  if (f.actif === 'inactif') w.push("(sign = 'N' OR sign IS NULL)");
  if (f.service) { w.push('sserv = :service'); binds.service = f.service; }
  if (f.role) { w.push("INSTR(roleapp, :role) > 0"); binds.role = f.role; }
  return w.length ? 'WHERE ' + w.join(' AND ') : '';
}
async function listAgents(f) {
  const binds = {};
  const where = agentWhere(f, binds);
  const pageSize = int(f.pageSize, 25, 100);
  const page = int(f.page, 1, 100000);
  const offset = (page - 1) * pageSize;
  const rows = await exec(`SELECT * FROM (${AGENT_BASE}) ${where}
    ORDER BY nom NULLS LAST, matricule OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY`, binds);
  const [{ total }] = await exec(`SELECT COUNT(*) AS total FROM (${AGENT_BASE}) ${where}`, binds, 1);
  return { rows, total: Number(total), page, pageSize };
}
async function agentsStats() {
  const [g] = await exec(`SELECT COUNT(*) total,
      SUM(CASE WHEN nb>0 THEN 1 ELSE 0 END) utilisateurs,
      SUM(CASE WHEN nb>0 THEN 0 ELSE 1 END) simples,
      SUM(CASE WHEN sign='O' THEN 1 ELSE 0 END) actifs,
      SUM(CASE WHEN sign='N' OR sign IS NULL THEN 1 ELSE 0 END) inactifs,
      SUM(CASE WHEN datinvalid IS NOT NULL THEN 1 ELSE 0 END) invalides
    FROM (${AGENT_BASE})`);
  const [a] = await exec(`SELECT COUNT(*) admins FROM (${AGENT_BASE}) WHERE gest='O' AND ordon='O' AND compta='O'`);
  const par_service = await exec(`SELECT NVL(service,'(non renseigné)') AS service, COUNT(*) AS n, SUM(CASE WHEN nb>0 THEN 1 ELSE 0 END) AS droits
    FROM (${AGENT_BASE}) GROUP BY service ORDER BY n DESC FETCH FIRST 40 ROWS ONLY`);
  const par_role = await exec(`SELECT roleapp, COUNT(*) AS n FROM (${AGENT_BASE})
    WHERE roleapp IS NOT NULL GROUP BY roleapp ORDER BY n DESC FETCH FIRST 40 ROWS ONLY`);
  return {
    total: Number(g.total), utilisateurs: Number(g.utilisateurs || 0), agents_simples: Number(g.simples || 0),
    actifs: Number(g.actifs || 0), inactifs: Number(g.inactifs || 0),
    admins: Number(a.admins || 0), invalides: Number(g.invalides || 0), par_service, par_role,
  };
}
async function getAgent(matricule) {
  const [compte] = await exec(`SELECT USR_ID AS usr_id, USR_NAME AS matricule, USR_DETAIL AS nom, USR_DEM AS dem,
      TO_CHAR(USR_DATINVALID,'DD/MM/YYYY') AS datinvalid, TO_CHAR(USR_MAJ,'DD/MM/YYYY HH24:MI') AS maj,
      TO_CHAR(USR_DATMAJPWD,'DD/MM/YYYY') AS majpwd
    FROM SBCG_USERS WHERE USR_NAME = :m`, { m: matricule });
  if (!compte) return null;
  const [demandeur] = await exec(`SELECT TRIM(SDEM_ROLEAPP) AS roleapp, SDEM_DES AS des, SDEM_SSERV AS sserv,
      SDEM_EMAIL AS email, SDEM_AUTHSYS AS authsys, SDEM_ROLEGEST AS gest, SDEM_ROLEORDON AS ordon,
      SDEM_ROLECOMPTA AS compta, SDEM_SIGN AS sign
    FROM DEMANDEUR WHERE SDEM_COD = :m`, { m: matricule });
  const droits = await exec(`SELECT p.MNU_ID AS mnu_id, m.MNU_MOD AS module, TRIM(ml.MLG_LIB) AS libelle,
      p.USRP_AUTH AS auth, p.USRP_MNUTAB AS onglet, p.USRP_SOC AS soc,
      TO_CHAR(p.USRP_MAJ,'DD/MM/YYYY') AS maj
    FROM SBCG_USERPROFIL p
    LEFT JOIN SBCG_MENUS m ON m.MNU_ID = p.MNU_ID
    LEFT JOIN SBCG_MLANGUE ml ON ml.MLG_ID = m.MNU_IDML AND ml.MLG_LANGID = 1036
    WHERE p.USR_ID = :id ORDER BY p.MNU_ID FETCH FIRST 5000 ROWS ONLY`, { id: compte.usr_id });
  const groupes = await exec(`SELECT gd.GRUD_GRP AS code, gu.GRU_DES AS des
    FROM GROUPEUTILDETAIL gd LEFT JOIN GROUPEUTIL gu ON gu.GRU_COD = gd.GRUD_GRP
    WHERE gd.GRUD_DEM = :m ORDER BY gd.GRUD_GRP`, { m: matricule });
  const [auth] = await exec(`SELECT
      (SELECT COUNT(*) FROM DEMANDEURAUTH WHERE DEMA_DEMCOD = :m) AS n_auth,
      (SELECT COUNT(*) FROM DEMANDEURAUTHP WHERE DEMAP_DEMCOD = :m) AS n_authp
    FROM DUAL`, { m: matricule });
  const demandes = await exec(`SELECT SGESDEM_NUM AS num, TO_CHAR(SGESDEM_DAT,'DD/MM/YYYY') AS dat,
      SGESDEM_NDT AS ndt, SGESDEM_LIBELLE AS libelle
    FROM DEMANDES WHERE SGESDEM_DEM = :m ORDER BY SGESDEM_DAT DESC NULLS LAST FETCH FIRST 200 ROWS ONLY`, { m: matricule });
  return { compte, demandeur, droits, groupes, autorisations: auth || { n_auth: 0, n_authp: 0 }, demandes };
}
async function listServices(term) {
  return exec(`SELECT SSER_COD AS code, SSER_NOM AS nom, SSER_NOMLONG AS nom_long, SSER_ACTIF AS actif
    FROM SERVICE WHERE UPPER(NVL(SSER_NOM,' ')||' '||NVL(SSER_NOMLONG,' ')||' '||NVL(SSER_COD,' ')) LIKE :q
    ORDER BY SSER_NOM FETCH FIRST ${LIMIT} ROWS ONLY`, { q: '%' + term.toUpperCase() + '%' });
}
async function listGroupes(term) {
  return exec(`SELECT gu.GRU_COD AS code, gu.GRU_DES AS des, COUNT(gd.GRUD_DEM) AS nb_membres
    FROM GROUPEUTIL gu LEFT JOIN GROUPEUTILDETAIL gd ON gd.GRUD_GRP = gu.GRU_COD
    WHERE UPPER(NVL(gu.GRU_COD,' ')||' '||NVL(gu.GRU_DES,' ')) LIKE :q
    GROUP BY gu.GRU_COD, gu.GRU_DES ORDER BY gu.GRU_DES`, { q: '%' + term.toUpperCase() + '%' });
}
async function listRoles() {
  const [c] = await exec(`SELECT
    (SELECT COUNT(*) FROM DEMANDEUR WHERE INSTR(sdem_roleapp,'U')>0) AS u,
    (SELECT COUNT(*) FROM DEMANDEUR WHERE INSTR(sdem_roleapp,'D')>0) AS d,
    (SELECT COUNT(*) FROM DEMANDEUR WHERE INSTR(sdem_roleapp,'R')>0) AS r,
    (SELECT COUNT(*) FROM DEMANDEUR WHERE INSTR(sdem_roleapp,'I')>0) AS i,
    (SELECT COUNT(*) FROM DEMANDEUR WHERE INSTR(sdem_roleapp,'C')>0) AS c,
    (SELECT COUNT(*) FROM DEMANDEUR WHERE INSTR(sdem_roleapp,'A')>0) AS a,
    (SELECT COUNT(*) FROM DEMANDEUR WHERE INSTR(sdem_roleapp,'S')>0) AS s
    FROM DUAL`);
  const lib = { U: 'Utilisateur', D: 'Demandeur', R: 'Affectataire', I: 'Intervenant', C: 'Conducteur', A: 'Usager', S: 'ATT' };
  return Object.keys(lib).map(k => ({ lettre: k, libelle: lib[k], nb: Number(c[k.toLowerCase()] || 0) }));
}

// ─── Synchro RH (source Studio-RH non branchée) ──────────────────────────────
async function syncPreview() {
  const agents = await exec(`SELECT * FROM (${AGENT_BASE}) WHERE nb > 0 ORDER BY nom NULLS LAST FETCH FIRST 500 ROWS ONLY`);
  const stats = await agentsStats();
  return {
    configured: STUDIO_RH.configured,
    source: STUDIO_RH.url || 'Studio-RH',
    message: STUDIO_RH.configured
      ? 'Source Studio-RH configurée.'
      : "La source Studio-RH n'est pas encore branchée (renseigner STUDIO_RH_API_URL et STUDIO_RH_API_KEY). Seuls les comptes ASTECH sont affichés ; la confrontation des matricules n'est pas disponible.",
    stats: { comptes_actifs: stats.actifs, utilisateurs: stats.utilisateurs, agents_simples: stats.agents_simples },
    concordants: [], orphelins_astech: [], orphelins_rh: [], agents,
  };
}

// ─── Synchro RH : appel API Studio-RH ────────────────────────────────────────
function httpGetJson(targetUrl, headers, { insecure, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const opts = { method: 'GET', headers, timeout: timeoutMs };
    if (u.protocol === 'https:' && insecure) opts.agent = new lib.Agent({ rejectUnauthorized: false });
    const req = lib.request(targetUrl, opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) { const idx = i++; if (idx >= items.length) return; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}
async function studioRhFindByMatricule(matricule) {
  const base = STUDIO_RH.url.replace(/\/+$/, '');
  const url = `${base}/api/agents/search?q=${encodeURIComponent(matricule)}`;
  const r = await httpGetJson(url, { 'x-api-key': STUDIO_RH.key, accept: 'application/json' }, { insecure: STUDIO_RH.insecure });
  if (r.status !== 200) return { ok: false, status: r.status };
  let j; try { j = JSON.parse(r.body); } catch { return { ok: false, status: 200 }; }
  const norm = (s) => String(s == null ? '' : s).replace(/\s/g, '');
  const hit = (j.data || []).find((a) => norm(a.matricule) === norm(matricule));
  return { ok: true, found: !!hit, agent: hit || null };
}

const syncCache = { at: 0, scope: '', result: null };
const syncCondition = (scope) => scope === 'actifs' ? "sign = 'O'" : 'nb > 0';
async function syncAgents(scope) {
  // maxRows explicite : toute la base (le défaut LIMIT=300 tronquerait la liste).
  return exec(`SELECT * FROM (${AGENT_BASE}) WHERE ${syncCondition(scope)} ORDER BY nom NULLS LAST, matricule FETCH FIRST 10000 ROWS ONLY`, {}, 10000);
}
async function studioRhFetchAgents() {
  const base = STUDIO_RH.url.replace(/\/+$/, '');
  const r = await httpGetJson(`${base}/api/agents/list`, { 'x-api-key': STUDIO_RH.key, accept: 'application/json' }, { insecure: STUDIO_RH.insecure, timeoutMs: 60000 });
  if (r.status !== 200) throw new Error('API /api/agents/list -> HTTP ' + r.status);
  const j = JSON.parse(r.body);
  if (!Array.isArray(j.data)) throw new Error('Réponse inattendue de /api/agents/list');
  return j.data;
}
async function syncCompute(agents, scope, onProgress) {
  const started = Date.now();
  const norm = (s) => String(s == null ? '' : s).replace(/\s/g, '');
  const concordants = [], orphelins_astech = [], erreurs = [];
  let orphelins_rh = [], rh_mode = 'list', rh_total = 0;

  let rhList = null;
  try { rhList = await studioRhFetchAgents(); }
  catch (e) { rh_mode = 'search'; }

  if (rh_mode === 'list') {
    rh_total = rhList.length;
    const rhMap = new Map();
    rhList.forEach(a => { const k = norm(a.matricule); if (k) rhMap.set(k, a); });
    if (onProgress) { try { onProgress(agents.length, agents.length); } catch { /* client parti */ } }
    for (const a of agents) {
      const hit = rhMap.get(norm(a.matricule));
      if (hit) concordants.push({ matricule: a.matricule, nom: a.nom, service: a.service, nb: a.nb, roleapp: a.roleapp,
        rh_nom: [hit.prenom, hit.nom].filter(Boolean).join(' '), rh_service: hit.service, rh_email: hit.email });
      else orphelins_astech.push({ matricule: a.matricule, nom: a.nom, service: a.service, sserv: a.sserv, nb: a.nb,
        roleapp: a.roleapp, gest: a.gest, ordon: a.ordon, compta: a.compta, email: a.email, maj: a.maj });
    }
    const ast = await exec(`SELECT USR_NAME AS matricule FROM SBCG_USERS`, {}, 20000);
    const astSet = new Set(ast.map(x => norm(x.matricule)));
    orphelins_rh = rhList
      .filter(a => { const k = norm(a.matricule); return k && !astSet.has(k); })
      .map(a => ({ matricule: a.matricule, nom: [a.prenom, a.nom].filter(Boolean).join(' '), service: a.service,
        direction: a.direction, email: a.email, fonction: a.fonction, rh_id: a.id }));
  } else {
    let done = 0;
    const results = await mapLimit(agents, 10, async (a) => {
      let r;
      try { r = await studioRhFindByMatricule(a.matricule); } catch (e) { r = { ok: false, error: e.message }; }
      done++;
      if (onProgress && (done % 3 === 0 || done === agents.length)) { try { onProgress(done, agents.length); } catch { /* client parti */ } }
      return { a, ...r };
    });
    for (const r of results) {
      const a = r.a;
      if (!r.ok) { erreurs.push({ matricule: a.matricule, nom: a.nom, service: a.service, detail: r.error || ('HTTP ' + r.status) }); continue; }
      if (r.found) concordants.push({ matricule: a.matricule, nom: a.nom, service: a.service, nb: a.nb, roleapp: a.roleapp,
        rh_nom: [r.agent.prenom, r.agent.nom].filter(Boolean).join(' '), rh_service: r.agent.service, rh_email: r.agent.email });
      else orphelins_astech.push({ matricule: a.matricule, nom: a.nom, service: a.service, sserv: a.sserv, nb: a.nb,
        roleapp: a.roleapp, gest: a.gest, ordon: a.ordon, compta: a.compta, email: a.email, maj: a.maj });
    }
  }

  return {
    configured: true, scope, rh_mode, rh_total, at: new Date().toISOString(), duree_ms: Date.now() - started,
    stats: { verifies: agents.length, concordants: concordants.length, orphelins_astech: orphelins_astech.length, orphelins_rh: orphelins_rh.length, erreurs: erreurs.length },
    concordants, orphelins_astech, orphelins_rh, erreurs,
    note_rh: rh_mode === 'list'
      ? `Confrontation complète : ${rh_total} agents RH actifs comparés aux comptes ASTECH.`
      : "Liste RH complète indisponible (/api/agents/list) : confrontation par recherche matricule ; la liste « à créer » n'est pas calculée. Déployez l'endpoint /api/agents/list côté Studio-RH.",
  };
}
async function syncRun(scope, force) {
  if (!STUDIO_RH.configured) return { configured: false, error: "La source Studio-RH n'est pas configurée (STUDIO_RH_API_URL / STUDIO_RH_API_KEY)." };
  scope = scope === 'actifs' ? 'actifs' : 'droits';
  const now = Date.now();
  if (!force && syncCache.result && syncCache.scope === scope && (now - syncCache.at) < 10 * 60 * 1000) {
    return { ...syncCache.result, cached: true };
  }
  const agents = await syncAgents(scope);
  const result = await syncCompute(agents, scope, null);
  syncCache.at = now; syncCache.scope = scope; syncCache.result = result;
  return result;
}
// Flux SSE : progression puis résultat final.
async function syncStream(res, scope) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch { /* client parti */ } };
  if (!STUDIO_RH.configured) { send({ type: 'error', error: "La source Studio-RH n'est pas configurée." }); return res.end(); }
  scope = scope === 'actifs' ? 'actifs' : 'droits';
  let closed = false; res.on('close', () => { closed = true; });
  try {
    const agents = await syncAgents(scope);
    send({ type: 'start', total: agents.length, scope });
    const result = await syncCompute(agents, scope, (done, total) => { if (!closed) send({ type: 'progress', done, total }); });
    syncCache.at = Date.now(); syncCache.scope = scope; syncCache.result = result;
    send({ type: 'done', result });
  } catch (e) {
    send({ type: 'error', error: e.message });
  }
  res.end();
}

// ─── Synchro RH : désactivation contrôlée des comptes ASTECH ─────────────────
const RH_JOURNAL_FILE = process.env.ASTECH_RH_JOURNAL_FILE || path.join(__dirname, 'data', 'rh-journal.jsonl');
function rhJournalPush(entry) {
  try {
    fs.mkdirSync(path.dirname(RH_JOURNAL_FILE), { recursive: true });
    fs.appendFileSync(RH_JOURNAL_FILE, JSON.stringify(entry) + '\n');
    return RH_JOURNAL_FILE;
  } catch { return null; }
}
function readRhJournal(limit = 100) {
  try {
    if (!fs.existsSync(RH_JOURNAL_FILE)) return [];
    return fs.readFileSync(RH_JOURNAL_FILE, 'utf8').split(/\r?\n/).filter(Boolean)
      .slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean).reverse();
  } catch { return []; }
}
// Désactive des comptes ASTECH : USR_DATINVALID sur SBCG_USERS + SDEM_SIGN='N'
// sur DEMANDEUR. Simulation (dry-run) par défaut, confirmation explicite en
// production, journal d'audit. Aligné sur le workflow des indices.
async function desactiverComptes(req, res) {
  if (!WRITE_ENABLED) return sendJson(res, 403, { error: "Écriture désactivée : définir ASTECH_ALLOW_WRITES=1 côté serveur." });
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  const env = currentDbEnv();
  const dryRun = body.dryRun !== false;
  const matricules = Array.isArray(body.matricules)
    ? [...new Set(body.matricules.map((m) => String(m == null ? '' : m).trim()).filter(Boolean))]
    : [];
  if (!matricules.length) return sendJson(res, 400, { error: 'Aucun matricule sélectionné.' });
  if (matricules.length > 2000) return sendJson(res, 400, { error: 'Trop de comptes en une seule opération (max 2000).' });
  if (!dryRun && env === 'prod' && body.confirm !== 'PROD') {
    return sendJson(res, 428, { error: "Confirmation requise pour écrire en PRODUCTION (champ « confirm » = \"PROD\")." });
  }

  const binds = {};
  const inList = matricules.map((m, i) => { binds['m' + i] = m; return ':m' + i; }).join(',');
  const rows = await exec(`SELECT u.USR_NAME AS matricule, u.USR_ID AS usr_id, u.USR_DETAIL AS nom,
      TO_CHAR(u.USR_DATINVALID,'DD/MM/YYYY') AS datinvalid, d.SDEM_SIGN AS sign
    FROM SBCG_USERS u LEFT JOIN DEMANDEUR d ON d.SDEM_USR = u.USR_ID
    WHERE u.USR_NAME IN (${inList})`, binds, matricules.length + 10);
  const byMat = new Map(rows.map((r) => [String(r.matricule), r]));
  const plan = matricules.map((m) => {
    const r = byMat.get(m);
    return { matricule: m, nom: r ? r.nom : null, found: !!r, deja_invalide: !!(r && r.datinvalid), sign: r ? r.sign : null };
  });

  if (dryRun) {
    return sendJson(res, 200, {
      dryRun: true, env, requested: matricules.length,
      plan, introuvables: plan.filter((p) => !p.found).map((p) => p.matricule),
    });
  }

  const applied = [], errors = [];
  await execTx(async (conn) => {
    for (const p of plan) {
      if (!p.found) { errors.push({ matricule: p.matricule, error: 'Compte introuvable dans SBCG_USERS' }); continue; }
      try {
        const r1 = await conn.execute(`UPDATE SBCG_USERS SET USR_DATINVALID = TRUNC(SYSDATE) WHERE USR_NAME = :m AND USR_DATINVALID IS NULL`, { m: p.matricule });
        const r2 = await conn.execute(`UPDATE DEMANDEUR SET SDEM_SIGN = 'N' WHERE SDEM_COD = :m`, { m: p.matricule });
        applied.push({ matricule: p.matricule, nom: p.nom, usr_rows: r1.rowsAffected, dem_rows: r2.rowsAffected });
      } catch (e) { errors.push({ matricule: p.matricule, error: e.message }); }
    }
  });
  syncCache.at = 0; syncCache.result = null; // forcer un nouveau calcul après écriture
  const journalFile = rhJournalPush({
    at: new Date().toISOString(), type: 'desactivation_astech', env,
    requested: matricules.length, applied, errors,
  });
  return sendJson(res, 200, { dryRun: false, env, requested: matricules.length, applied: applied.length, applied_rows: applied, errors, journalFile });
}

// Crée des comptes ASTECH à partir d'agents Studio-RH absents de SBCG_USERS.
// Comptes créés INACTIFS (USR_DATINVALID non nul, SDEM_SIGN='N') : aucun mot de
// passe ni profil de droits. Simulation (dry-run) par défaut, confirmation en
// production, journal d'audit.
async function creerComptes(req, res) {
  if (!WRITE_ENABLED) return sendJson(res, 403, { error: "Écriture désactivée : définir ASTECH_ALLOW_WRITES=1 côté serveur." });
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  const env = currentDbEnv();
  const dryRun = body.dryRun !== false;
  const inAgents = Array.isArray(body.agents) ? body.agents : [];
  const norm = (s) => String(s == null ? '' : s).replace(/\s/g, '').toUpperCase();
  const agents = [];
  const seen = new Set();
  for (const a of inAgents) {
    const m = String((a && a.matricule) || '').trim();
    if (!m) continue;
    const k = norm(m); if (seen.has(k)) continue; seen.add(k);
    agents.push({ matricule: m, nom: (a && a.nom) || '', service: (a && a.service) || '', email: (a && a.email) || '', fonction: (a && a.fonction) || '' });
  }
  if (!agents.length) return sendJson(res, 400, { error: 'Aucun agent sélectionné.' });
  if (agents.length > 2000) return sendJson(res, 400, { error: 'Trop de comptes en une seule opération (max 2000).' });
  if (!dryRun && env === 'prod' && body.confirm !== 'PROD') {
    return sendJson(res, 428, { error: "Confirmation requise pour écrire en PRODUCTION (champ « confirm » = \"PROD\")." });
  }

  const binds = {};
  const inList = agents.map((a, i) => { binds['m' + i] = a.matricule; return ':m' + i; }).join(',');
  const existing = await exec(`SELECT USR_NAME AS matricule FROM SBCG_USERS WHERE USR_NAME IN (${inList})`, binds, agents.length + 10);
  const existingSet = new Set(existing.map((r) => norm(r.matricule)));
  // USR_ID : PK (aucune séquence) -> MAX+1 (comme pour INDICEINSEE).
  const [maxRow] = await exec(`SELECT NVL(MAX(USR_ID),0) AS maxid FROM SBCG_USERS`, {}, 1);
  const maxUsrId = Number(maxRow && maxRow.maxid) || 0;

  const deja_existants = [];
  const aValider = [];
  let nextId = maxUsrId;
  for (const a of agents) {
    if (existingSet.has(norm(a.matricule))) { deja_existants.push(a.matricule); continue; }
    nextId += 1;
    aValider.push({ ...a, usr_id: nextId });
  }

  if (dryRun) {
    return sendJson(res, 200, { dryRun: true, env, requested: agents.length, a_creer: aValider, deja_existants, next_usr_id: nextId });
  }

  const created = [], errors = [];
  await execTx(async (conn) => {
    for (const a of aValider) {
      try {
        await conn.execute(`INSERT INTO SBCG_USERS (USR_ID, USR_NAME, USR_DETAIL, USR_DATINVALID, USR_MAJ)
          VALUES (:id, :name, :detail, TRUNC(SYSDATE), SYSDATE)`, { id: a.usr_id, name: a.matricule, detail: (a.nom || a.matricule).slice(0, 60) });
        try {
          await conn.execute(`INSERT INTO DEMANDEUR (SDEM_COD, SDEM_USR, SDEM_DES, SDEM_SIGN, SDEM_EMAIL)
            VALUES (:cod, :usr, :des, 'N', :email)`, { cod: a.matricule, usr: a.usr_id, des: (a.nom || a.matricule).slice(0, 60), email: (a.email || null) });
        } catch (e2) { errors.push({ matricule: a.matricule, error: 'Compte créé mais DEMANDEUR non inséré : ' + e2.message }); }
        created.push({ matricule: a.matricule, nom: a.nom, usr_id: a.usr_id });
      } catch (e) { errors.push({ matricule: a.matricule, error: e.message }); }
    }
  });
  syncCache.at = 0; syncCache.result = null;
  const journalFile = rhJournalPush({
    at: new Date().toISOString(), type: 'creation_astech', env,
    requested: agents.length, created, deja_existants, errors,
  });
  return sendJson(res, 200, { dryRun: false, env, requested: agents.length, created: created.length, created_rows: created, deja_existants, errors, journalFile });
}

// ─── Référentiels ────────────────────────────────────────────────────────────
// Définition unique par référentiel : SELECT (sans WHERE ni ORDER BY), clause de
// recherche/filtres, tri et colonne d'identifiant. Réutilisée par l'UI interne
// (/api/referentiels) et par l'API publique versionnée (/api/v1, protégée par clé).
const BIEN_SELECT_STD = `
  SELECT A.ARB_ID AS id, A.ARB_CODE AS code, A.ARB_DES AS des, A.ARB_NOMC AS nom_court,
         TRIM(NVL(ADR.ARBA_ADR1,' ')||' '||NVL(ADR.ARBA_CP,' ')||' '||NVL(ADR.ARBA_VILLE,' ')) AS adresse,
         CAT.SCAT_DES AS categorie, SCAT.SSCAT_DES AS sous_cat, PG.SGEN_DES AS genre,
         S.SSER_NOM AS service
  FROM ARBO A
  LEFT JOIN PATRIGENE PG ON PG.SGEN_COD = A.ARB_GENRE
  LEFT JOIN ARBO_ADR ADR ON ADR.ARBA_ID = A.ARB_ID
  LEFT JOIN CATEGORIE CAT ON CAT.SCAT_COD = A.ARB_CAT
  LEFT JOIN SOUSCATEGORIE SCAT ON SCAT.SSCAT_COD = A.ARB_SCAT
  LEFT JOIN SERVICE S ON S.SSER_COD = A.ARB_SSERV`;

const REF_DEFS = {
  biens: {
    label: 'Biens & Patrimoine (ARBO)',
    select: BIEN_SELECT_STD,
    order: 'ORDER BY A.ARB_DES',
    idCol: 'A.ARB_ID',
    where: (term, opts = {}) => {
      const binds = { q: '%' + term.toUpperCase() + '%' };
      const w = [`UPPER(NVL(A.ARB_CODE,' ')||' '||NVL(A.ARB_DES,' ')||' '||NVL(ADR.ARBA_ADR1,' ')||' '||NVL(ADR.ARBA_VILLE,' ')) LIKE :q`];
      if (opts.genre) { w.push('A.ARB_GENRE = :genre'); binds.genre = opts.genre; }
      return { clause: 'WHERE ' + w.join(' AND '), binds };
    },
  },
  vehicules: {
    label: 'Véhicules & Parc Roulant (PARC)',
    select: `SELECT ID_BIEN AS id, DES_BIEN AS des, IMMAT AS immat, MARQUE AS marque, MODELE AS modele,
        CATEGORIE AS categorie, SERVICE AS service, ANNEE AS annee, COMPTEUR AS compteur, NO_INVENTAIRE AS no_inventaire
      FROM V_PARC_COMSMA`,
    order: 'ORDER BY DES_BIEN',
    idCol: 'ID_BIEN',
    where: (term, opts = {}) => {
      const binds = { q: '%' + term.toUpperCase() + '%', categorie: opts.categorie || 'GVEH' };
      const w = [`CATEGORIE = :categorie`,
        `UPPER(NVL(DES_BIEN,' ')||' '||NVL(IMMAT,' ')||' '||NVL(MARQUE,' ')||' '||NVL(MODELE,' ')) LIKE :q`];
      return { clause: 'WHERE ' + w.join(' AND '), binds };
    },
  },
  materiel: {
    label: 'Matériel & Stocks (STOCK)',
    select: `SELECT SREF_COD AS id, SREF_COD AS code, SREF_DES AS des, SREF_FAM AS fam, SREF_SOUFAM AS soufam,
        SREF_UNIT AS unit, SREF_QTERES AS qte, SREF_QTEMIN AS qte_min, SREF_QTEMAX AS qte_max,
        SREF_PUMP AS pamp, SREF_MARQUE AS marque, SREF_SSERV AS sserv
      FROM STOCK`,
    order: 'ORDER BY SREF_DES',
    idCol: 'SREF_COD',
    where: (term) => ({
      clause: `WHERE UPPER(NVL(SREF_COD,' ')||' '||NVL(SREF_DES,' ')||' '||NVL(SREF_MARQUE,' ')) LIKE :q`,
      binds: { q: '%' + term.toUpperCase() + '%' },
    }),
  },
  tiers: {
    label: 'Tiers & Fournisseurs (FOURNISSEUR)',
    select: `SELECT SFOU_COD AS id, SFOU_COD AS code, SFOU_NOM AS nom, SFOU_VILLE AS ville, SFOU_SIRET AS siret,
        SFOU_TEL1 AS tel, SFOU_EMAIL1 AS email, SFOU_ACTIF AS actif
      FROM FOURNISSEUR`,
    order: 'ORDER BY SFOU_NOM',
    idCol: 'SFOU_COD',
    where: (term) => ({
      clause: `WHERE UPPER(NVL(SFOU_NOM,' ')||' '||NVL(SFOU_COD,' ')||' '||NVL(SFOU_VILLE,' ')) LIKE :q`,
      binds: { q: '%' + term.toUpperCase() + '%' },
    }),
  },
  services: {
    label: 'Services & Structures (SERVICE)',
    select: `SELECT SSER_COD AS id, SSER_COD AS code, SSER_NOM AS nom, SSER_NOMLONG AS nom_long, SSER_ACTIF AS actif
      FROM SERVICE`,
    order: 'ORDER BY SSER_NOM',
    idCol: 'SSER_COD',
    where: (term) => ({
      clause: `WHERE UPPER(NVL(SSER_NOM,' ')||' '||NVL(SSER_NOMLONG,' ')||' '||NVL(SSER_COD,' ')) LIKE :q`,
      binds: { q: '%' + term.toUpperCase() + '%' },
    }),
  },
  groupes: {
    label: 'Groupes applicatifs (GROUPEUTIL)',
    select: `SELECT gu.GRU_COD AS id, gu.GRU_COD AS code, gu.GRU_DES AS des, COUNT(gd.GRUD_DEM) AS nb_membres
      FROM GROUPEUTIL gu LEFT JOIN GROUPEUTILDETAIL gd ON gd.GRUD_GRP = gu.GRU_COD`,
    order: 'GROUP BY gu.GRU_COD, gu.GRU_DES ORDER BY gu.GRU_DES',
    idCol: 'gu.GRU_COD',
    where: (term) => ({
      clause: `WHERE UPPER(NVL(gu.GRU_COD,' ')||' '||NVL(gu.GRU_DES,' ')) LIKE :q`,
      binds: { q: '%' + term.toUpperCase() + '%' },
    }),
  },
};
const REF_KEYS = Object.keys(REF_DEFS);

// Liste paginée d'un référentiel (OFFSET/FETCH côté Oracle).
async function refList(type, { q = '', genre = '', categorie = '', limit, offset = 0, max = LIMIT } = {}) {
  const def = REF_DEFS[type];
  if (!def) { const e = new Error('Référentiel inconnu : ' + type); e.status = 404; throw e; }
  const lim = int(limit, max, max);
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  const { clause, binds } = def.where(q, { genre, categorie });
  return exec(`${def.select} ${clause} ${def.order} OFFSET ${off} ROWS FETCH NEXT ${lim} ROWS ONLY`, binds, lim);
}

// Fiche unique par identifiant.
async function refById(type, id) {
  const def = REF_DEFS[type];
  if (!def) { const e = new Error('Référentiel inconnu : ' + type); e.status = 404; throw e; }
  const bind = /^\d+$/.test(String(id)) ? Number(id) : String(id);
  const rows = await exec(`${def.select} WHERE ${def.idCol} = :id ${def.order} FETCH FIRST 1 ROWS ONLY`, { id: bind }, 1);
  return rows[0] || null;
}

// Total (comptage) pour un jeu de filtres donné.
async function refTotal(type, { q = '', genre = '', categorie = '' } = {}) {
  const def = REF_DEFS[type];
  if (!def) return 0;
  const { clause, binds } = def.where(q, { genre, categorie });
  const [r] = await exec(`SELECT COUNT(*) AS total FROM (${def.select} ${clause})`, binds, 1);
  return Number(r.total);
}

async function listGenres() {
  return exec(`SELECT A.ARB_GENRE AS code, NVL(PG.SGEN_DES,'(non classé)') AS genre, COUNT(*) AS n
    FROM ARBO A LEFT JOIN PATRIGENE PG ON PG.SGEN_COD = A.ARB_GENRE
    GROUP BY A.ARB_GENRE, PG.SGEN_DES ORDER BY n DESC`, {}, 5000);
}
async function refCounts() {
  const [r] = await exec(`SELECT
    (SELECT COUNT(*) FROM ARBO) AS biens,
    (SELECT COUNT(*) FROM V_PARC_COMSMA WHERE CATEGORIE='GVEH') AS vehicules,
    (SELECT COUNT(*) FROM STOCK) AS materiel,
    (SELECT COUNT(*) FROM FOURNISSEUR) AS tiers,
    (SELECT COUNT(*) FROM SERVICE) AS services,
    (SELECT COUNT(*) FROM GROUPEUTIL) AS groupes FROM DUAL`);
  return r;
}

// ─── Parc automobile ─────────────────────────────────────────────────────────
// Les véhicules sont des ARBO de genre GVEH (immatriculation = ARB_REF,
// n° de série = ARB_SERIE). Données d'atelier, états, certificat, CT et
// propriétaire proviennent de la vue V_PARC_COMSMA (pivot sur ARBO_MATE,
// ARBO_NRJ (compteurs), ARBO_AFFP (affectation), PATRI_FORM (formulaire parc)).
const PARC_TABLE = `V_PARC_COMSMA`;
const PARC_FILTER = `CATEGORIE='GVEH'`;

async function listParc(f = {}) {
  const binds = {};
  const w = ["CATEGORIE='GVEH'"];
  if (f.q) { binds.q = '%' + f.q.toUpperCase() + '%'; w.push(`UPPER(NVL(DES_BIEN,' ')||' '||NVL(IMMAT,' ')||' '||NVL(NO_SERIE,' ')||' '||NVL(MARQUE,' ')||' '||NVL(MODELE,' ')||' '||NVL(SERVICE,' ')) LIKE :q`); }
  if (f.service) { w.push('SERVICE = :service'); binds.service = f.service; }
  if (f.etat) { w.push('ETAT_GENERAL = :etat'); binds.etat = f.etat; }
  const pageSize = int(f.pageSize, 50, 200);
  const page = int(f.page, 1, 100000);
  const offset = (page - 1) * pageSize;
  const where = 'WHERE ' + w.join(' AND ');
  const rows = await exec(`SELECT ID_BIEN AS id, DES_BIEN AS des, IMMAT AS immat, MARQUE AS marque, MODELE AS modele,
      ANNEE AS annee, SERVICE AS service, COMPTEUR AS compteur, NO_SERIE AS no_serie, NO_INVENTAIRE AS no_inventaire,
      ETAT_GENERAL AS etat_general, VALEUR_COMPTABLE AS valeur_comptable, VALEUR_ESTIMEE AS valeur_estimee
    FROM ${PARC_TABLE} ${where} ORDER BY DES_BIEN OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY`, binds, pageSize);
  const [tot] = await exec(`SELECT COUNT(*) AS total FROM ${PARC_TABLE} ${where}`, binds, 1);
  return { rows, total: Number(tot.total), page, pageSize };
}

async function getParcVehicule(id) {
  const nid = Number(id);
  const [v] = await exec(`SELECT * FROM ${PARC_TABLE} WHERE ${PARC_FILTER} AND ID_BIEN = :id`, { id: nid }, 1);
  if (!v) return null;
  const [arbo] = await exec(`SELECT A.ARB_ID AS id, A.ARB_CODE AS code, A.ARB_DES AS des, A.ARB_REF AS immat,
      A.ARB_SERIE AS no_serie, A.ARB_SCAT AS sous_cat, SS.SSCAT_DES AS sous_cat_des, A.ARB_SSERV AS sserv,
      A.ARB_DAT1 AS date1, A.ARB_REFORME AS reforme
    FROM ARBO A LEFT JOIN SOUSCATEGORIE SS ON SS.SSCAT_COD = A.ARB_SCAT
    WHERE A.ARB_ID = :id`, { id: nid }, 1);
  const mate = await exec(`SELECT M.ARBMA_DATGAR AS date_garantie, M.ARBMA_DISPO AS dispo, M.ARBMA_INDISPODEB AS indispo_deb,
      M.ARBMA_INDISPOFIN AS indispo_fin, M.ARBMA_ALERTE AS alerte, M.ARBMA_DATALERTE AS date_alerte,
      M.ARBMA_SSERV AS sserv_affect, M.ARBMA_FOURN AS fournisseur
    FROM ARBO_MATE M WHERE M.ARBMA_ARBID = :id`, { id: nid }, 1);
  const [nrj] = await exec(`SELECT ARBN_CPTTYP1 AS type1, ARBN_CPTCARB1 AS carburant1, ARBN_CPTACT1 AS compteur1,
      ARBN_CPTDAT1 AS date_releve1, ARBN_CONSO1 AS conso1, ARBN_CPTTYP2 AS type2, ARBN_CPTACT2 AS compteur2,
      ARBN_CPTDAT2 AS date_releve2, ARBN_CONSO2 AS conso2
    FROM ARBO_NRJ WHERE ARBN_ID = :id`, { id: nid }, 1);
  const affectation = await exec(`SELECT AF.ARBFP_SOCCOD AS soc, D.PSOC_DES AS structure, AF.ARBFP_PARC AS parc,
      TO_CHAR(AF.ARBFP_DATDEB,'DD/MM/YYYY') AS depuis
    FROM ARBO_AFFP AF LEFT JOIN DETAIL D ON D.PSOC_COD = AF.ARBFP_SOCCOD WHERE AF.ARBFP_ID = :id`, { id: nid });
  const certifs = await exec(`SELECT VCI_RUBID AS rubrique, VCI_VAL AS valeur FROM VEH_CERTIF WHERE VCI_ARBOID = :id AND VCI_VAL IS NOT NULL AND VCI_VAL <> '0' ORDER BY VCI_RUBID`, { id: nid });
  const interventions = await exec(`SELECT X.num, X.dat, X.typ, X.ndt, X.etat
    FROM (${INTERV_UNION}) X WHERE X.arbo = :ids ORDER BY X.dat_ts DESC NULLS LAST FETCH FIRST 25 ROWS ONLY`, { ids: String(nid) });
  return { vehicule: v, arbo: arbo || null, materiel: mate[0] || null, compteurs: nrj || null, affectation, certificats: certifs, interventions };
}

async function parcStats() {
  const [r] = await exec(`SELECT COUNT(*) AS total,
      COUNT(COMPTEUR) AS avec_compteur, COUNT(MARQUE) AS avec_marque, COUNT(SERVICE) AS avec_service
    FROM ${PARC_TABLE} WHERE ${PARC_FILTER}`, {}, 1);
  const par_service = await exec(`SELECT NVL(SERVICE,'(non affecté)') AS service, COUNT(*) AS n FROM ${PARC_TABLE}
    WHERE ${PARC_FILTER} GROUP BY SERVICE ORDER BY n DESC FETCH FIRST 20 ROWS ONLY`, {}, 50);
  const par_marque = await exec(`SELECT NVL(MARQUE,'(non renseigné)') AS marque, COUNT(*) AS n FROM ${PARC_TABLE}
    WHERE ${PARC_FILTER} GROUP BY MARQUE ORDER BY n DESC FETCH FIRST 20 ROWS ONLY`, {}, 50);
  const par_annee = await exec(`SELECT ANNEE AS annee, COUNT(*) AS n FROM ${PARC_TABLE}
    WHERE ${PARC_FILTER} AND ANNEE IS NOT NULL GROUP BY ANNEE ORDER BY ANNEE DESC FETCH FIRST 30 ROWS ONLY`, {}, 50);
  const par_etat = await exec(`SELECT NVL(ETAT_GENERAL,'(non évalué)') AS etat, COUNT(*) AS n FROM ${PARC_TABLE}
    WHERE ${PARC_FILTER} GROUP BY ETAT_GENERAL ORDER BY n DESC FETCH FIRST 20 ROWS ONLY`, {}, 50);
  const services = await exec(`SELECT DISTINCT SERVICE FROM ${PARC_TABLE} WHERE ${PARC_FILTER} AND SERVICE IS NOT NULL ORDER BY SERVICE`, {}, 200);
  return {
    total: Number(r.total), avec_compteur: Number(r.avec_compteur || 0),
    avec_marque: Number(r.avec_marque || 0), avec_service: Number(r.avec_service || 0),
    par_service, par_marque, par_annee, par_etat,
    services: services.map((x) => x.service),
  };
}

async function listPermis() {
  const droits = await exec(`SELECT PC.SPERM_CON AS conducteur, D.SDEM_DES AS nom, PC.SPERM_CAT AS categorie,
      P.SPERM_DES AS libelle, TO_CHAR(PC.SPERM_DATCAT,'DD/MM/YYYY') AS date_cat,
      TO_CHAR(PC.SPERM_DATVAL,'DD/MM/YYYY') AS date_validite
    FROM PERMISCONDUCTEUR PC LEFT JOIN DEMANDEUR D ON D.SDEM_COD = PC.SPERM_CON
    LEFT JOIN PERMIS P ON P.SPERM_CAT = PC.SPERM_CAT
    ORDER BY D.SDEM_DES NULLS LAST, PC.SPERM_CON, PC.SPERM_CAT FETCH FIRST 2000 ROWS ONLY`, {}, 2000);
  const conducteurs = await exec(`SELECT COUNT(DISTINCT SPERM_CON) AS n FROM PERMISCONDUCTEUR`, {}, 1);
  return { rows: droits, nb_conducteurs: Number((conducteurs[0] || {}).n || 0) };
}

// ─── Procédures stockées (dictionnaire Oracle) ───────────────────────────────
// Classement par groupe à partir du préfixe du nom + mots-clés, avec une
// description générique déduite du nom (les commentaires source Oracle sont
// rarement renseignés). Lecture seule : ALL_OBJECTS / ALL_SOURCE.
const PROC_GROUPS = [
  { key: 'rapports', label: 'Rapports & éditions', re: /^(RPT|RAPPORT|ETAT|IMP)/i, desc: "Rapport / édition (génération d'état imprimable ou export)." },
  { key: 'triggers_api', label: 'API & triggers applicatifs', re: /^(TRIGGERS_API|API_)/i, desc: 'API applicative (package) ou déclencheur associé.' },
  { key: 'arbo', label: 'Patrimoine (ARBO)', re: /^(ARBO|BIEN|PATRI|IMMO|LOC)/i, desc: "Traitement sur le patrimoine / les biens (ARBO)." },
  { key: 'interventions', label: 'Interventions & GMAO', re: /^(INTERV|AFFECTERINTERV|CREATIONINTERV|SP_.*INTERV|DEMANDE)/i, desc: "Traitement sur les interventions / demandes (GMAO)." },
  { key: 'contrats', label: 'Contrats & locatif', re: /^(CONTR|CONT|LOYER|QUITT|REVIS|LOCATIF|CLOT)/i, desc: 'Traitement contractuel ou locatif (contrats, loyers, quittances, révisions).' },
  { key: 'comptabilite', label: 'Comptabilité & facturation', re: /^(FACT|COMPTA|OPCOMPTA|BUDGET|BUDG|L_FACT|RECAP|TRESOR|MANDAT)/i, desc: 'Traitement comptable ou de facturation.' },
  { key: 'agents', label: 'Agents, droits & RH', re: /^(UTIL|AGENT|DEMANDEUR|DROIT|ROLE|GROUPE|MAJ_UTIL|SP_VERIF)/i, desc: 'Gestion des agents, des droits ou des groupes.' },
  { key: 'stock', label: 'Stocks & magasins', re: /^(STOCK|STO|MAGASIN|SORTIE|ENTREE|INVENTAIRE)/i, desc: 'Traitement de stock / magasin.' },
  { key: 'parc', label: 'Parc automobile', re: /^(VEH|PARC|CARBUR|NRJ_|SINISTRE|REMPLACVEH)/i, desc: 'Traitement sur le parc automobile.' },
  { key: 'fluides', label: 'Fluides & énergie', re: /^(FLUID|NRJ|RELEVE|CONSO|ENERGIE)/i, desc: 'Traitement sur les fluides / relevés de compteurs.' },
  { key: 'systeme', label: 'Système, outils & BDD', re: /^(BDD|MAJ_|MAJDATATYPES|GETNEXTVALUE|GETPARAMETER|ADDTIMETODATE|ARCHIV|TRACAB|EXPORT|EXP_)/i, desc: 'Utilitaire technique ou maintenance de base.' },
  { key: 'calculs', label: 'Calculs & contrôles', re: /^(CALC|CAL|VERIF|VER|CONTROLE|CTRL|ANO_)/i, desc: 'Calcul métier ou contrôle de cohérence.' },
  { key: 'divers', label: 'Autres', re: /./, desc: 'Traitement métier (regroupement générique).' },
];
// Verbes de description à partir du préfixe du nom.
const PROC_VERBS = [
  [/^(CRE|CON|INS|ADD)/i, 'Création'],
  [/^(UPD|MAJ|MOD|AFFI_MAJ)/i, 'Mise à jour'],
  [/^(DEL|SUP|REMOV)/i, 'Suppression'],
  [/^(GET|F_GET|FIND|SEARCH)/i, 'Lecture / recherche'],
  [/^(VER|VERIF|CTRL|CONTROLE)/i, 'Vérification / contrôle'],
  [/^(CAL|CALC)/i, 'Calcul'],
  [/^(VER)/i, 'Validation'],
];
function procGroup(name, type) {
  if (type === 'PACKAGE' || type === 'PACKAGE BODY') return 'triggers_api';
  for (const g of PROC_GROUPS) { if (g.re.test(name)) return g.key; }
  return 'divers';
}
function procVerb(name) {
  for (const [re, v] of PROC_VERBS) { if (re.test(name)) return v; }
  return null;
}
function procDescribe(name, type, group) {
  const g = PROC_GROUPS.find((x) => x.key === group) || { desc: 'Traitement métier.', label: 'Autres' };
  const verb = procVerb(name);
  const kind = type === 'FUNCTION' ? 'Fonction' : type === 'PACKAGE' || type === 'PACKAGE BODY' ? 'Package' : 'Procédure';
  return `${kind}. ${verb ? verb + ' — ' : ''}${g.desc}`;
}
async function listProcedures(f = {}) {
  const typeFilter = (f.type || '').toUpperCase();
  const binds = {};
  const w = [`o.owner='ASTECHIVR'`, `o.object_type IN ('PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY')`];
  if (typeFilter && ['PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE BODY'].includes(typeFilter)) { w.push('o.object_type = :typ'); binds.typ = typeFilter; }
  if (f.q) { binds.q = '%' + f.q.toUpperCase() + '%'; w.push('UPPER(o.object_name) LIKE :q'); }
  if (f.group) { w.push(`(CASE ${PROC_GROUPS.map((g, i) => `WHEN REGEXP_LIKE(o.object_name, '${g.re.source.replace(/^\^/, '^')}', 'i') THEN '${g.key}'`).join(' ')} ELSE 'divers' END) = :grp`); binds.grp = f.group; }
  const rows = await exec(`SELECT o.object_name AS name, o.object_type AS type, o.status, TO_CHAR(o.last_ddl_time,'DD/MM/YYYY') AS maj,
      NVL((SELECT COUNT(*) FROM all_source s WHERE s.owner=o.owner AND s.name=o.object_name AND s.type=o.object_type),0) AS lignes
    FROM all_objects o WHERE ${w.join(' AND ')} ORDER BY o.object_name FETCH FIRST 4100 ROWS ONLY`, binds, 4100);
  const items = rows.map((r) => {
    const group = procGroup(r.name, r.type);
    return { name: r.name, type: r.type, status: r.status, maj: r.maj, lignes: Number(r.lignes), group, description: procDescribe(r.name, r.type, group) };
  });
  const byGroup = {};
  for (const it of items) byGroup[it.group] = (byGroup[it.group] || 0) + 1;
  const groups = PROC_GROUPS.map((g) => ({ key: g.key, label: g.label, desc: g.desc, count: byGroup[g.key] || 0 })).filter((g) => g.count > 0);
  return { total: items.length, groups, rows: items };
}
async function getProcedureSource(name, type) {
  const t = (type || 'PROCEDURE').toUpperCase();
  const rows = await exec(`SELECT line, text FROM all_source WHERE owner='ASTECHIVR' AND name=:name AND type=:type ORDER BY type, line FETCH FIRST 4000 ROWS ONLY`, { name: String(name), type: t }, 4000);
  const src = rows.map((r) => r.text).join('');
  const group = procGroup(name, t);
  return { name, type: t, group, description: procDescribe(name, t, group), lines: rows.length, source: src };
}

// ─── Magasins & stock ────────────────────────────────────────────────────────
// Un « magasin » est une structure (V_SOCIETES) ; les articles sont dans STOCK
// via STOCK.SREF_SOC = V_SOCIETES.COD.
async function listMagasins() {
  return exec(`SELECT S.SREF_SOC AS code, NVL(SO.NOM, S.SREF_SOC) AS nom,
      COUNT(*) AS nb_articles,
      SUM(CASE WHEN NVL(S.SREF_NSTOCK,0) > 0 THEN 1 ELSE 0 END) AS nb_en_stock,
      NVL(SUM(S.SREF_NSTOCK),0) AS qte
    FROM STOCK S
    LEFT JOIN V_SOCIETES SO ON SO.COD = S.SREF_SOC
    GROUP BY S.SREF_SOC, SO.NOM
    ORDER BY SO.NOM NULLS LAST, S.SREF_SOC`, {}, 1000);
}
async function magasinArticles(code, { q = '', enStock = true, limit, offset = 0 } = {}) {
  const binds = { code: String(code) };
  const w = ['S.SREF_SOC = :code'];
  if (q) { binds.q = '%' + q.toUpperCase() + '%'; w.push(`UPPER(NVL(S.SREF_COD,' ')||' '||NVL(S.SREF_DES,' ')||' '||NVL(S.SREF_MARQUE,' ')) LIKE :q`); }
  if (enStock) w.push('NVL(S.SREF_NSTOCK,0) > 0');
  const where = 'WHERE ' + w.join(' AND ');
  const lim = int(limit, 100, 1000);
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  const rows = await exec(`SELECT S.SREF_COD AS code, S.SREF_DES AS des, S.SREF_FAM AS fam, S.SREF_SOUFAM AS soufam,
      S.SREF_UNIT AS unit, S.SREF_NSTOCK AS qte, S.SREF_PUMP AS pamp, S.SREF_MARQUE AS marque,
      S.SREF_ALL AS allee, S.SREF_TRAV AS travee, S.SREF_CASIER AS casier, S.SREF_POS AS pos
    FROM STOCK S ${where}
    ORDER BY S.SREF_DES OFFSET ${off} ROWS FETCH NEXT ${lim} ROWS ONLY`, binds, lim);
  const [tot] = await exec(`SELECT COUNT(*) AS total FROM STOCK S ${where}`, binds, 1);
  const [info] = await exec(`SELECT COD AS code, NOM AS nom FROM V_SOCIETES WHERE COD = :code`, { code: String(code) }, 1);
  return { magasin: info || { code: String(code), nom: String(code) }, total: Number(tot.total), rows };
}

// ─── Demandes d'intervention : listes de référence ───────────────────────────
// Options des listes déroulantes du formulaire de demande (lecture seule).
async function demandesOptions() {
  const [natures, degres, catloc, sscatloc, services] = await Promise.all([
    exec(`SELECT STYP_COD AS code, STYP_DES AS des FROM TYPE ORDER BY STYP_DES`, {}, 500),
    exec(`SELECT PDEG_COD AS code, PDEG_DES AS des FROM DEGRE ORDER BY PDEG_COD`, {}, 100),
    exec(`SELECT SCATL_COD AS code, SCATL_DES AS des FROM CATEGORIE_LOC ORDER BY SCATL_DES`, {}, 200),
    exec(`SELECT SSCATL_COD AS code, SSCATL_DES AS des, SSCATL_ID AS id FROM SOUSCATEGORIE_LOC ORDER BY SSCATL_DES`, {}, 500),
    exec(`SELECT SSSER_COD AS code, SSSER_NOM AS nom, SSSER_NOMLONG AS nom_long, SSSER_ACTIF AS actif
      FROM SOUSSERVICE ORDER BY SSSER_NOM`, {}, 2000),
  ]);
  return {
    natures, degres, categories: catloc, sous_categories: sscatloc,
    services: services.map((s) => ({ code: s.code, nom: s.nom, nom_long: s.nom_long, actif: s.actif })),
    types_demande: [
      { code: 0, des: 'Standard' }, { code: 1, des: 'Devis' }, { code: 2, des: 'Intervention' },
      { code: 3, des: 'Enlèvement' }, { code: 4, des: 'Prêt' },
    ],
    urgences: [{ code: 'O', des: 'Urgent' }, { code: 'N', des: 'Non urgent' }],
    moments: [{ code: 'M', des: 'Matin' }, { code: 'A', des: 'Après-midi' }, { code: 'J', des: 'Journée' }],
  };
}

// ─── Interventions ───────────────────────────────────────────────────────────
const INTERV_UNION = `
  SELECT 'En cours' AS etat, E.SSIG_NUM AS num, E.SSIG_TYP AS typ, E.SSIG_DAT AS dat_ts,
         TO_CHAR(E.SSIG_DAT,'DD/MM/YYYY HH24:MI') AS dat, E.SSIG_NDT AS ndt,
         E.SSIG_LIBELLE AS libelle, E.SSIG_ARBO AS arbo, E.SSIG_SSERV AS sserv,
         E.SSIG_DEG AS deg, E.SSIG_AFF AS aff, E.SSIG_TACHTERMINE AS term,
         TO_CHAR(E.SSIG_DEBPER,'DD/MM/YYYY') AS deb, TO_CHAR(E.SSIG_FINPER,'DD/MM/YYYY') AS fin,
         E.SSIG_CODDEM AS coddem, E.SSIG_NUMDEM AS numdem
  FROM INTERVENTIONS E
  UNION ALL
  SELECT 'Clôturée', E.SSIG_NUM, E.SSIG_TYP, E.SSIG_DAT,
         TO_CHAR(E.SSIG_DAT,'DD/MM/YYYY HH24:MI'), E.SSIG_NDT,
         E.SSIG_LIBELLE, E.SSIG_ARBO, E.SSIG_SSERV,
         E.SSIG_DEG, E.SSIG_AFF, E.SSIG_TACHTERMINE,
         TO_CHAR(E.SSIG_DEBPER,'DD/MM/YYYY'), TO_CHAR(E.SSIG_FINPER,'DD/MM/YYYY'),
         E.SSIG_CODDEM, E.SSIG_NUMDEM
  FROM INTERVENTIONSTERMINEES E`;

const INTERV_SELECT = `
  SELECT X.*, A.ARB_CODE AS code_bien, A.ARB_DES AS bien, S.SSER_NOM AS service
  FROM (${INTERV_UNION}) X
  LEFT JOIN ARBO A ON A.ARB_ID = X.arbo
  LEFT JOIN SERVICE S ON S.SSER_COD = X.sserv`;

function intervWhere(f, binds) {
  const w = [];
  if (f.q) { w.push(`UPPER(NVL(X.num,' ')||' '||NVL(X.ndt,' ')||' '||NVL(X.libelle,' ')||' '||NVL(X.coddem,' ')||' '||NVL(A.ARB_DES,' ')) LIKE :q`); binds.q = '%' + f.q.toUpperCase() + '%'; }
  if (f.type) { w.push('X.typ = :typ'); binds.typ = f.type; }
  if (f.etat === 'encours') w.push("X.etat = 'En cours'");
  if (f.etat === 'cloturee') w.push("X.etat = 'Clôturée'");
  if (f.du) { w.push(`X.dat_ts >= TO_DATE(:du,'YYYY-MM-DD')`); binds.du = f.du; }
  if (f.au) { w.push(`X.dat_ts < TO_DATE(:au,'YYYY-MM-DD') + 1`); binds.au = f.au; }
  if (!f.du && !f.au && !f.tout) w.push(`X.dat_ts >= ADD_MONTHS(TRUNC(SYSDATE),-12)`);
  return w.length ? 'WHERE ' + w.join(' AND ') : '';
}
async function listInterventions(f) {
  const binds = {};
  const where = intervWhere(f, binds);
  const pageSize = int(f.pageSize, 50, 200);
  const page = int(f.page, 1, 100000);
  const offset = (page - 1) * pageSize;
  const rows = await exec(`${INTERV_SELECT} ${where}
    ORDER BY X.dat_ts DESC NULLS LAST OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY`, binds, pageSize);
  const [{ total }] = await exec(`SELECT COUNT(*) AS total FROM (${INTERV_SELECT} ${where})`, binds, 1);
  return { rows, total: Number(total), page, pageSize };
}
async function getIntervention(num) {
  const [row] = await exec(`${INTERV_SELECT} WHERE X.num = :num ORDER BY CASE WHEN X.etat='En cours' THEN 0 ELSE 1 END FETCH FIRST 1 ROWS ONLY`, { num });
  if (!row) return null;
  const demandes = await exec(`SELECT SGESDEM_NUM AS num, TO_CHAR(SGESDEM_DAT,'DD/MM/YYYY') AS dat,
      SGESDEM_NDT AS ndt, SGESDEM_LIBELLE AS libelle, SGESDEM_URGENT AS urgent
    FROM DEMANDES WHERE SGESDEM_NUM = :nd OR SGESDEM_DEM = :cd ORDER BY SGESDEM_DAT DESC NULLS LAST FETCH FIRST 20 ROWS ONLY`,
    { nd: row.numdem || null, cd: row.coddem || null });
  return { intervention: row, demandes };
}
async function intervStats() {
  const [r] = await exec(`SELECT
    (SELECT COUNT(*) FROM INTERVENTIONS) AS en_cours,
    (SELECT COUNT(*) FROM DEMANDES) AS demandes,
    (SELECT COUNT(*) FROM INTERVENTIONSTERMINEES) AS cloturees FROM DUAL`);
  const par_type = await exec(`SELECT SSIG_TYP AS typ, COUNT(*) AS n FROM INTERVENTIONS GROUP BY SSIG_TYP ORDER BY n DESC FETCH FIRST 12 ROWS ONLY`);
  return { en_cours: Number(r.en_cours), demandes: Number(r.demandes), cloturees: Number(r.cloturees), par_type };
}

// Indicateurs d'intervention agrégés pour le tableau de bord (toutes
// interventions : en cours + clôturées), par type, site (bien), service et demandeur.
async function intervKpis() {
  const [tot] = await exec(`SELECT
    (SELECT COUNT(*) FROM INTERVENTIONS) AS en_cours,
    (SELECT COUNT(*) FROM INTERVENTIONSTERMINEES) AS cloturees FROM DUAL`);
  const by_type = await exec(`
    SELECT NVL(X.typ,'(non défini)') AS typ, COUNT(*) AS n,
           SUM(CASE WHEN X.etat='En cours' THEN 1 ELSE 0 END) AS en_cours
    FROM (${INTERV_UNION}) X
    GROUP BY NVL(X.typ,'(non défini)') ORDER BY n DESC FETCH FIRST 15 ROWS ONLY`);
  // « Site » = patrimoine bâti : codes ARBO de type SXXX (on exclut les véhicules/parc roulant).
  const by_site = await exec(`
    SELECT NVL(code_bien,'(non localisé)') AS code, NVL(bien, NVL(code_bien,'(non localisé)')) AS site, COUNT(*) AS n
    FROM (${INTERV_SELECT})
    WHERE code_bien LIKE 'S%'
    GROUP BY NVL(code_bien,'(non localisé)'), NVL(bien, NVL(code_bien,'(non localisé)'))
    ORDER BY n DESC FETCH FIRST 12 ROWS ONLY`);
  const by_service = await exec(`
    SELECT NVL(service,'(non affecté)') AS service, COUNT(*) AS n
    FROM (${INTERV_SELECT})
    GROUP BY NVL(service,'(non affecté)') ORDER BY n DESC FETCH FIRST 12 ROWS ONLY`);
  const by_demandeur = await exec(`
    SELECT NVL(X.coddem,'(non renseigné)') AS coddem,
           NVL(MAX(D.SDEM_DES), NVL(X.coddem,'(non renseigné)')) AS demandeur, COUNT(*) AS n
    FROM (${INTERV_UNION}) X
    LEFT JOIN DEMANDEUR D ON D.SDEM_COD = X.coddem
    GROUP BY NVL(X.coddem,'(non renseigné)') ORDER BY n DESC FETCH FIRST 12 ROWS ONLY`);
  return {
    totals: { en_cours: Number(tot.en_cours || 0), cloturees: Number(tot.cloturees || 0) },
    by_type, by_site, by_service, by_demandeur,
  };
}

// ─── Indices ─────────────────────────────────────────────────────────────────
async function listIndices(f) {
  const binds = {};
  const w = [];
  if (f.type) { w.push('INSEE_TYP = :typ'); binds.typ = Number(f.type); }
  if (f.annee) { w.push('INSEE_AN = :an'); binds.an = Number(f.annee); }
  return exec(`SELECT INSEE_ID AS id, INSEE_AN AS an, INSEE_COD AS cod, INSEE_DES AS des, INSEE_TYP AS typ,
      INSEE_TRIM AS trim, TO_CHAR(INSEE_DATP,'DD/MM/YYYY') AS datp, INSEE_TAUX AS taux, INSEE_TAUXMOYEN AS taux_moyen
    FROM INDICEINSEE ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
    ORDER BY INSEE_AN DESC, INSEE_TRIM DESC, INSEE_TYP FETCH FIRST ${LIMIT} ROWS ONLY`, binds);
}
async function indicesResume() {
  return exec(`SELECT * FROM (
      SELECT INSEE_TYP AS typ, INSEE_AN AS an, INSEE_TRIM AS trim, INSEE_COD AS cod, INSEE_DES AS des,
             INSEE_TAUX AS taux, TO_CHAR(INSEE_DATP,'DD/MM/YYYY') AS datp,
             ROW_NUMBER() OVER (PARTITION BY INSEE_TYP ORDER BY INSEE_AN DESC, INSEE_TRIM DESC) AS rn
      FROM INDICEINSEE)
    WHERE rn = 1 ORDER BY typ`);
}
// Correspondance type ASTECH (INDICEINSEE.INSEE_TYP) -> série INSEE BDM (idbank).
// Récupérable directement sur https://bdm.insee.fr (sans clé).
const INSEE_SERIES = {
  1: { idbank: '001515333', label: 'IRL', des: "Indice de référence des loyers" },
  2: { idbank: '000008630', label: 'ICC', des: "Indice du coût de la construction" },
  5: { idbank: '001532540', label: 'ILC', des: "Indice des loyers commerciaux" },
  6: { idbank: '001617112', label: 'ILAT', des: "Indice des loyers des activités tertiaires" },
};
async function fetchInseeObs(idbank, lastN = 12) {
  const url = `https://bdm.insee.fr/series/sdmx/data/SERIES_BDM/${idbank}?lastNObservations=${int(lastN, 12, 60)}`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await httpGetJson(url, { 'User-Agent': 'ASTECH-Explorer/3.0', accept: 'application/xml' }, { insecure: false, timeoutMs: 20000 });
      if (r.status !== 200 || !r.body) throw new Error('HTTP ' + r.status);
      const obs = [];
      const re = /<Obs TIME_PERIOD="(\d{4})-Q([1-4])" OBS_VALUE="([^"]+)"/g;
      let m;
      while ((m = re.exec(r.body)) !== null) obs.push({ an: Number(m[1]), trim: Number(m[2]), val: Number(m[3]) });
      const title = (r.body.match(/TITLE_FR="([^"]+)"/) || [])[1] || '';
      if (!obs.length) throw new Error('aucune observation trimestrielle');
      return { obs, title };
    } catch (e) { lastErr = e; await new Promise((res) => setTimeout(res, 600)); }
  }
  throw lastErr;
}
let inseeCache = { at: 0, result: null };
async function verifierIndices(force) {
  if (!force && inseeCache.result && (Date.now() - inseeCache.at) < 60 * 60 * 1000) return { ...inseeCache.result, cached: true };
  const types = Object.keys(INSEE_SERIES).map(Number);
  const fetched = {}, errors = [];
  for (const t of types) {
    try { fetched[t] = await fetchInseeObs(INSEE_SERIES[t].idbank, 12); }
    catch (e) { errors.push({ typ: t, label: INSEE_SERIES[t].label, error: e.message }); }
  }
  const ast = await exec(`SELECT INSEE_ID AS id, INSEE_AN AS an, INSEE_TYP AS typ, INSEE_TRIM AS trim, INSEE_TAUX AS taux,
      INSEE_COD AS cod, INSEE_DES AS des, TO_CHAR(INSEE_DATP,'DD/MM/YYYY') AS datp
    FROM INDICEINSEE WHERE INSEE_TYP IN (1,2,5,6)`, {}, 10000);
  const astechMap = new Map();
  for (const r of ast) astechMap.set(r.typ + ':' + r.an + ':' + String(r.trim), r);
  const srcMap = new Map();
  for (const t of types) if (fetched[t]) for (const o of fetched[t].obs) srcMap.set(t + ':' + o.an + ':' + o.trim, o.val);
  const keys = new Set([...astechMap.keys(), ...srcMap.keys()]);
  const rows = [];
  for (const k of keys.values()) {
    const [ts, ans, trims] = k.split(':');
    const typ = Number(ts), an = Number(ans), trim = Number(trims);
    const a = astechMap.get(k), s = srcMap.has(k) ? srcMap.get(k) : null;
    let statut, ecart = null;
    if (a && s !== null) { const diff = s - a.taux; ecart = Number(diff.toFixed(6)); statut = diff === 0 ? 'ok' : 'ecart'; }
    else if (!a && s !== null) statut = 'manquant';
    else statut = 'source_absente';
    rows.push({
      id: a ? a.id : null, typ, label: INSEE_SERIES[typ].label, an, trim,
      cod: a ? a.cod : null, des: a ? a.des : (INSEE_SERIES[typ].des + ' ' + an + ' T' + trim),
      astech: a ? a.taux : null, source: s, ecart, statut, datp: a ? a.datp : null,
    });
  }
  rows.sort((x, y) => (y.an - x.an) || (y.trim - x.trim) || (x.typ - y.typ));
  const count = (st) => rows.filter((r) => r.statut === st).length;
  const result = {
    source: 'INSEE BDM (bdm.insee.fr)', at: new Date().toISOString(),
    series: INSEE_SERIES,
    stats: { ok: count('ok'), ecart: count('ecart'), manquant: count('manquant'), source_absente: count('source_absente') },
    rows, errors,
  };
  inseeCache = { at: Date.now(), result };
  return result;
}

// ─── Pousser les indices dans ASTECH ─────────────────────────────────────────
// Codes/labels ASTECH par type (ISNEE_COD = lettre + AA + TT, ex. L2601).
const INSEE_TYP_INFO = {
  1: { prefix: 'L', des: 'IRL' },
  2: { prefix: 'C', des: 'CONST' },
  5: { prefix: 'B', des: 'LOY COMM' },
  6: { prefix: 'I', des: 'ILAT' },
};
const indiceCod = (typ, an, trim) => {
  const info = INSEE_TYP_INFO[typ] || { prefix: 'X', des: 'INDICE' };
  return info.prefix + String(an % 100).padStart(2, '0') + String(trim).padStart(2, '0');
};
const indiceDes = (typ, an, trim) => {
  const info = INSEE_TYP_INFO[typ] || { prefix: 'X', des: 'INDICE' };
  return `${info.des} ${an} TRIM 0${trim}`;
};
const JOURNAL_FILE = process.env.ASTECH_JOURNAL_FILE || path.join(__dirname, 'data', 'indices-journal.jsonl');
function journalPush(entry) {
  try {
    fs.mkdirSync(path.dirname(JOURNAL_FILE), { recursive: true });
    fs.appendFileSync(JOURNAL_FILE, JSON.stringify(entry) + '\n');
    return JOURNAL_FILE;
  } catch { return null; }
}
let indiceSeqReady = false;
async function ensureIndiceSequence(conn) {
  if (indiceSeqReady) return;
  try {
    const r = await conn.execute(`SELECT NVL(MAX(INSEE_ID),0)+1 AS start FROM INDICEINSEE`, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    const start = Number((r.rows[0] && r.rows[0].START) || 1);
    await conn.execute(`CREATE SEQUENCE SEQ_INDICEINSEE START WITH ${start} NOCACHE`);
  } catch (e) {
    if (!/ORA-00955/.test(e.message)) console.warn('Séquence SEQ_INDICEINSEE non créée (' + e.message + '), repli sur MAX+1.');
  }
  indiceSeqReady = true;
}
async function nextIndiceId(conn) {
  try {
    const r = await conn.execute(`SELECT SEQ_INDICEINSEE.NEXTVAL AS id FROM DUAL`, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return r.rows[0].ID;
  } catch {
    const r = await conn.execute(`SELECT NVL(MAX(INSEE_ID),0)+1 AS id FROM INDICEINSEE`, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return r.rows[0].ID;
  }
}

async function pousserIndices(req, res) {
  if (!WRITE_ENABLED) return sendJson(res, 403, { error: "Écriture désactivée : définir ASTECH_ALLOW_WRITES=1 côté serveur." });
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  const env = currentDbEnv();
  const dryRun = body.dryRun !== false; // simulation par défaut
  const scope = ['manquants', 'ecarts', 'les_deux'].includes(body.scope) ? body.scope : 'manquants';
  if (!dryRun && env === 'prod' && body.confirm !== 'PROD') {
    return sendJson(res, 428, { error: "Confirmation requise pour écrire en PRODUCTION (champ « confirm » = \"PROD\")." });
  }

  const verif = await verifierIndices(true);
  const rows = verif.rows || [];
  const match = (r) => scope === 'manquants' ? r.statut === 'manquant'
    : scope === 'ecarts' ? r.statut === 'ecart'
      : (r.statut === 'manquant' || r.statut === 'ecart');
  const cibles = rows.filter((r) => match(r) && r.source !== null && r.source !== undefined);

  // Doublons ASTECH (typ,an,trim) : signalés, jamais corrigés automatiquement.
  const dupMap = new Map();
  for (const r of rows) if (r.id != null) { const k = r.typ + ':' + r.an + ':' + r.trim; dupMap.set(k, (dupMap.get(k) || 0) + 1); }
  const warnings = [];
  for (const [k, n] of dupMap) if (n > 1) warnings.push(`Doublon ASTECH sur ${k} (${n} lignes) : non corrigé automatiquement.`);

  const plan = cibles.map((r) => ({
    action: r.statut === 'manquant' ? 'INSERT' : 'UPDATE',
    id: r.id || null, typ: r.typ, label: r.label, an: r.an, trim: r.trim,
    cod: r.statut === 'manquant' ? indiceCod(r.typ, r.an, r.trim) : r.cod,
    old: r.astech, new: r.source,
  }));

  if (dryRun) {
    return sendJson(res, 200, {
      dryRun: true, env, scope, writeEnabled: WRITE_ENABLED, requested: plan.length,
      plan, warnings, source: verif.source, at: verif.at,
    });
  }

  const applied = [], errors = [];
  await execTx(async (conn) => {
    await ensureIndiceSequence(conn);
    for (const it of plan) {
      try {
        if (it.action === 'UPDATE') {
          const r = await conn.execute(`UPDATE INDICEINSEE SET INSEE_TAUX = :taux WHERE INSEE_ID = :id`, { taux: it.new, id: it.id });
          applied.push({ ...it, rowsAffected: r.rowsAffected });
        } else {
          const id = await nextIndiceId(conn);
          const cod = indiceCod(it.typ, it.an, it.trim);
          const des = indiceDes(it.typ, it.an, it.trim);
          await conn.execute(
            `INSERT INTO INDICEINSEE (INSEE_ID, INSEE_AN, INSEE_COD, INSEE_DES, INSEE_TYP, INSEE_TRIM, INSEE_DATP, INSEE_TAUX, INSEE_TAUXMOYEN, INSEE_MOIS)
             VALUES (:id, :an, :cod, :des, :typ, :trim, TRUNC(SYSDATE), :taux, 0, 0)`,
            { id, an: it.an, cod, des, typ: it.typ, trim: String(it.trim), taux: it.new });
          applied.push({ ...it, id, cod, des, rowsAffected: 1 });
        }
      } catch (e) { errors.push({ ...it, error: e.message }); }
    }
  });
  inseeCache = { at: 0, result: null }; // forcer un nouveau contrôle après écriture
  const journalFile = journalPush({ at: new Date().toISOString(), env, scope, applied, errors, warnings });
  return sendJson(res, 200, { dryRun: false, env, scope, requested: plan.length, applied: applied.length, applied_rows: applied, errors, warnings, journalFile });
}

// ─── HTTP ────────────────────────────────────────────────────────────────────
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const empty = (v) => (v === null || v === undefined || v === '') ? undefined : v;

// ─── API publique v1 (référentiels, lecture seule, protégée par clé) ──────────
const API_MAX_LIMIT = Number(process.env.ASTECH_API_MAX_LIMIT || 1000);
const API_DEFAULT_LIMIT = Number(process.env.ASTECH_API_DEFAULT_LIMIT || 100);

// Extrait la clé d'API de l'en-tête X-API-Key ou Authorization: Bearer.
function readApiKey(req) {
  const h = req.headers['x-api-key'];
  if (h) return String(h).trim();
  const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
  return m ? m[1].trim() : '';
}

async function handleReferentielsApi(req, res, p, sp) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return sendJson(res, 405, { error: 'API en lecture seule : seules les méthodes GET/HEAD sont autorisées.' });
  }
  if (p === '/api/v1' || p === '/api/v1/') {
    return sendJson(res, 200, {
      name: 'ASTECH — API Référentiels', version: '1.0', readOnly: true,
      auth: "En-tête « X-API-Key: <clé> » (ou « Authorization: Bearer <clé> »).",
      referentiels: REF_KEYS.map((t) => ({ type: t, label: REF_DEFS[t].label })),
      endpoints: [
        'GET /api/v1/referentiels',
        'GET /api/v1/referentiels/biens/genres',
        'GET /api/v1/referentiels/:type?q=&limit=&offset=[&genre=][&categorie=][&total=1]',
        'GET /api/v1/referentiels/:type/:id',
      ],
    });
  }

  const rec = apikeys.verify(readApiKey(req));
  if (!rec) return sendJson(res, 401, { error: 'Clé API manquante ou invalide.' });
  if (!apikeys.hasScope(rec, 'referentiels')) return sendJson(res, 403, { error: 'Clé sans le droit « referentiels ».' });

  if (p === '/api/v1/referentiels') {
    const counts = await refCounts();
    const items = REF_KEYS.map((t) => ({ type: t, label: REF_DEFS[t].label, count: Number((counts && counts[t]) || 0) }));
    return sendJson(res, 200, { count: items.length, items });
  }
  if (p === '/api/v1/referentiels/biens/genres') {
    return sendJson(res, 200, { rows: await listGenres() });
  }
  let m = /^\/api\/v1\/referentiels\/([a-z]+)$/.exec(p);
  if (m) {
    const type = m[1];
    if (!REF_DEFS[type]) return sendJson(res, 404, { error: 'Référentiel inconnu : ' + type, available: REF_KEYS });
    const limit = int(sp.get('limit'), API_DEFAULT_LIMIT, API_MAX_LIMIT);
    const offset = Math.max(0, Math.floor(Number(sp.get('offset')) || 0));
    const q = sp.get('q') || '', genre = sp.get('genre') || '', categorie = sp.get('categorie') || '';
    const rows = await refList(type, { q, genre, categorie, limit, offset, max: API_MAX_LIMIT });
    const payload = { type, label: REF_DEFS[type].label, q, limit, offset, count: rows.length, hasMore: rows.length === limit, rows };
    if (sp.get('total') === '1') payload.total = await refTotal(type, { q, genre, categorie });
    return sendJson(res, 200, payload);
  }
  m = /^\/api\/v1\/referentiels\/([a-z]+)\/(.+)$/.exec(p);
  if (m) {
    const type = m[1];
    if (!REF_DEFS[type]) return sendJson(res, 404, { error: 'Référentiel inconnu : ' + type, available: REF_KEYS });
    const row = await refById(type, decodeURIComponent(m[2]));
    return row ? sendJson(res, 200, { type, row }) : sendJson(res, 404, { error: 'Entrée introuvable' });
  }
  return sendJson(res, 404, { error: 'Not found' });
}

// ─── Gestion des clés d'API (accessible depuis l'UI locale, sans jeton) ──────
function readJsonBody(req, maxBytes = 100000) {
  return new Promise((resolve, reject) => {
    let data = '', size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('Corps de requête trop volumineux')); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('JSON invalide')); }
    });
    req.on('error', reject);
  });
}
async function handleAdminKeys(req, res, p) {
  if (p === '/api/admin/keys') {
    if (req.method === 'GET') { const keys = apikeys.list(); return sendJson(res, 200, { count: keys.length, keys }); }
    if (req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      const name = String(body.name || '').trim();
      if (!name) return sendJson(res, 400, { error: 'Champ « name » obligatoire.' });
      const scopes = Array.isArray(body.scopes) && body.scopes.length ? body.scopes.map(String) : [apikeys.DEFAULT_SCOPE];
      const created = apikeys.create({ name, scopes, createdBy: 'http' });
      return sendJson(res, 201, { ...created, warning: "La clé en clair n'est affichée qu'une seule fois. Conservez-la en lieu sûr." });
    }
    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { error: 'Méthode non autorisée' });
  }
  const m = /^\/api\/admin\/keys\/([A-Za-z0-9]+)$/.exec(p);
  if (m) {
    if (req.method === 'DELETE' || req.method === 'POST') {
      try {
        const r = apikeys.revoke(m[1]);
        return r ? sendJson(res, 200, { revoked: true, key: r }) : sendJson(res, 404, { error: 'Clé introuvable' });
      } catch (e) { return sendJson(res, 409, { error: e.message }); }
    }
    res.setHeader('Allow', 'DELETE, POST');
    return sendJson(res, 405, { error: 'Méthode non autorisée' });
  }
  return sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  const sp = u.searchParams;
  const reqEnv = normEnv(req.headers['x-astech-env'] || sp.get('env'));
  const env = DB_PROFILES[reqEnv] ? reqEnv : ACTIVE_ENV;
  DB_ENV.run({ env }, () => handleRequest(req, res, p, sp));
});

async function handleRequest(req, res, p, sp) {
  const term = (sp.get('q') || '').trim();
  try {
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate' });
      return res.end(html);
    }
    if (p === '/api/config') {
      return sendJson(res, 200, { connectInfo: dbConnectInfo(), readOnly: !WRITE_ENABLED, writeEnabled: WRITE_ENABLED, dbEnv: currentDbEnv(), dbEnvs: dbEnvList(), limit: LIMIT, studioRh: STUDIO_RH.configured, studioRhUrl: STUDIO_RH.url || null, version: '3.0.0', publicApi: '/api/v1', apiKeysEnabled: true });
    }
    if (p === '/api/env') return sendJson(res, 200, { active: currentDbEnv(), writeEnabled: WRITE_ENABLED, available: dbEnvList() });
    // API publique versionnée (référentiels) + gestion des clés
    if (p === '/api/v1' || p.startsWith('/api/v1/')) return handleReferentielsApi(req, res, p, sp);
    if (p === '/api/admin/keys' || p.startsWith('/api/admin/keys/')) return handleAdminKeys(req, res, p);
    if (p === '/api/dashboard') return sendJson(res, 200, await getDashboard());
    if (p === '/api/referentiels-compteurs') return sendJson(res, 200, { counts: await refCounts() });

    // Magasins & stock
    if (p === '/api/magasins') return sendJson(res, 200, { rows: await listMagasins() });
    let mm = p.match(/^\/api\/magasin\/([^/]+)$/);
    if (mm) return sendJson(res, 200, await magasinArticles(decodeURIComponent(mm[1]), { q: term, enStock: sp.get('enStock') !== '0', limit: sp.get('limit'), offset: sp.get('offset') }));

    // Locatif
    if (p === '/api/biens') return sendJson(res, 200, { rows: await listBiens(term) });
    let m = p.match(/^\/api\/bien\/(\d+)$/);
    if (m) { const d = await getBien(m[1]); return d ? sendJson(res, 200, d) : sendJson(res, 404, { error: 'Bien introuvable' }); }
    if (p === '/api/locataires') return sendJson(res, 200, { rows: await listLocataires(term) });
    if (p === '/api/locataire') { const name = sp.get('name') || ''; return sendJson(res, 200, await getLocataire(name)); }
    if (p === '/api/contrats') return sendJson(res, 200, { rows: await listContrats(term) });
    m = p.match(/^\/api\/contrat\/(\d+)\/revisions$/);
    if (m) return sendJson(res, 200, { rows: await getContratRevisions(m[1]) });
    m = p.match(/^\/api\/contrat\/(\d+)$/);
    if (m) { const d = await getContrat(m[1]); return d ? sendJson(res, 200, d) : sendJson(res, 404, { error: 'Contrat introuvable' }); }
    if (p === '/api/quittances') return sendJson(res, 200, await listQuittances(term));
    if (p === '/api/revisions') return sendJson(res, 200, { rows: await listRevisions(term) });

    // Agents
    if (p === '/api/agents') return sendJson(res, 200, await listAgents({ q: term, type: sp.get('type') || '', actif: sp.get('actif') || '', service: sp.get('service') || '', role: sp.get('role') || '', admin: sp.get('admin') === '1', page: sp.get('page'), pageSize: sp.get('pageSize') }));
    if (p === '/api/agents/stats') return sendJson(res, 200, await agentsStats());
    if (p === '/api/services') return sendJson(res, 200, { rows: await listServices(term) });
    if (p === '/api/groupes') return sendJson(res, 200, { rows: await listGroupes(term) });
    if (p === '/api/roles') return sendJson(res, 200, await listRoles());
    m = p.match(/^\/api\/agent\/([^/]+)$/);
    if (m) { const d = await getAgent(decodeURIComponent(m[1])); return d ? sendJson(res, 200, d) : sendJson(res, 404, { error: 'Agent introuvable' }); }

    // Synchronisation RH
    if (p === '/api/sync/rh/preview') return sendJson(res, 200, await syncPreview());
    if (p === '/api/sync/rh/run') return sendJson(res, 200, await syncRun(sp.get('scope'), sp.get('force') === '1'));
    if (p === '/api/sync/rh/stream') return syncStream(res, sp.get('scope'));
    if (p === '/api/sync/rh/desactiver') {
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return sendJson(res, 405, { error: 'Méthode POST requise.' }); }
      return desactiverComptes(req, res);
    }
    if (p === '/api/sync/rh/creer') {
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return sendJson(res, 405, { error: 'Méthode POST requise.' }); }
      return creerComptes(req, res);
    }
    if (p === '/api/sync/rh/journal') return sendJson(res, 200, { rows: readRhJournal(Number(sp.get('limit')) || 100) });

    // Référentiels (UI interne)
    if (p === '/api/referentiels/biens/genres') return sendJson(res, 200, { rows: await listGenres() });
    m = p.match(/^\/api\/referentiels\/([a-z]+)$/);
    if (m && REF_DEFS[m[1]]) return sendJson(res, 200, { type: m[1], label: REF_DEFS[m[1]].label, rows: await refList(m[1], { q: term, genre: sp.get('genre') || '', categorie: sp.get('categorie') || '', limit: LIMIT, offset: 0 }) });
    m = p.match(/^\/api\/referentiels\/([a-z]+)\/(.+)$/);
    if (m && REF_DEFS[m[1]]) {
      const row = await refById(m[1], decodeURIComponent(m[2]));
      return row ? sendJson(res, 200, { type: m[1], row }) : sendJson(res, 404, { error: 'Entrée introuvable' });
    }

    // Procédures stockées
    if (p === '/api/procedures') return sendJson(res, 200, await listProcedures({ q: term, type: sp.get('type') || '', group: sp.get('group') || '' }));
    m = p.match(/^\/api\/procedure\/([^/]+)$/);
    if (m) { const d = await getProcedureSource(decodeURIComponent(m[1]), sp.get('type') || 'PROCEDURE'); return d ? sendJson(res, 200, d) : sendJson(res, 404, { error: 'Objet introuvable' }); }

    // Parc automobile
    if (p === '/api/parc') return sendJson(res, 200, await listParc({ q: term, service: sp.get('service') || '', etat: sp.get('etat') || '', page: sp.get('page'), pageSize: sp.get('pageSize') }));
    if (p === '/api/parc/stats') return sendJson(res, 200, await parcStats());
    if (p === '/api/parc/permis') return sendJson(res, 200, await listPermis());
    m = p.match(/^\/api\/parc\/vehicule\/(\d+)$/);
    if (m) { const d = await getParcVehicule(m[1]); return d ? sendJson(res, 200, d) : sendJson(res, 404, { error: 'Véhicule introuvable' }); }

    // Demandes d'intervention
    if (p === '/api/demandes/options') return sendJson(res, 200, await demandesOptions());

    // Interventions
    if (p === '/api/interventions') return sendJson(res, 200, await listInterventions({ q: term, type: sp.get('type') || '', etat: sp.get('etat') || '', du: sp.get('du') || '', au: sp.get('au') || '', tout: sp.get('tout') === '1', page: sp.get('page'), pageSize: sp.get('pageSize') }));
    if (p === '/api/interventions/stats') return sendJson(res, 200, await intervStats());
    m = p.match(/^\/api\/intervention\/([^/]+)$/);
    if (m) { const d = await getIntervention(decodeURIComponent(m[1])); return d ? sendJson(res, 200, d) : sendJson(res, 404, { error: 'Intervention introuvable' }); }

    // Indices
    if (p === '/api/indices') return sendJson(res, 200, { rows: await listIndices({ type: sp.get('type'), annee: sp.get('annee') }), resume: await indicesResume() });
    if (p === '/api/indices/verifier') return sendJson(res, 200, await verifierIndices(sp.get('force') === '1'));
    if (p === '/api/indices/pousser') {
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return sendJson(res, 405, { error: 'Méthode POST requise.' }); }
      return pousserIndices(req, res);
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

loadDbConfigs()
  .then(async (profiles) => {
    Object.assign(DB_PROFILES, profiles);
    const wanted = normEnv(process.env.ASTECH_ENV);
    ACTIVE_ENV = DB_PROFILES[wanted] ? wanted : (DB_PROFILES.prod ? 'prod' : Object.keys(DB_PROFILES)[0]);
    connectInfo = (DB_PROFILES[ACTIVE_ENV] || {}).connectString || '';
    loadStudioRh();
    await getPool(ACTIVE_ENV); // échec rapide si la base active est injoignable
    const envs = Object.keys(DB_PROFILES).map((id) => `${id}=${DB_PROFILES[id].connectString}`).join(' | ');
    server.listen(PORT, () => console.log(`ASTECH Explorer -> http://localhost:${PORT} [${envs}] (actif: ${ACTIVE_ENV}) [lecture seule${WRITE_ENABLED ? ' + ecriture indices' : ''}] | Studio-RH ${STUDIO_RH.configured ? 'configuré' : 'non configuré'}`));
  })
  .catch((e) => { console.error('Erreur démarrage:', e.message); process.exit(1); });
