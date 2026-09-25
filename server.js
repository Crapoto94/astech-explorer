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
const crypto = require('crypto');
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

let pool = null;
let connectInfo = '';

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
  const conn = await pool.getConnection();
  try {
    const r = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows });
    return normalizeRows(r.rows);
  } finally { await conn.close(); }
}
async function one(sql, binds = {}) { const r = await exec(sql, binds, 1); return r[0] || null; }
const int = (v, def, max) => { const n = Math.max(0, Math.floor(Number(v))); return Number.isFinite(n) && n > 0 ? Math.min(n, max || 1000000) : def; };

async function loadConfig() {
  if (process.env.ORACLE_ASTECH_HOST) {
    return {
      user: process.env.ORACLE_ASTECH_USER,
      password: process.env.ORACLE_ASTECH_PASSWORD,
      connectString: `${process.env.ORACLE_ASTECH_HOST}:${process.env.ORACLE_ASTECH_PORT || 1521}/${process.env.ORACLE_ASTECH_SERVICE}`,
    };
  }
  const cfgPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(cfgPath)) {
    const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return { user: c.username, password: c.password, connectString: `${c.host}:${c.port}/${c.service_name || c.service}` };
  }
  const { setupDb, getSqlite } = require(APPDSI + '/shared/database');
  await setupDb();
  const s = await getSqlite().get("SELECT host, port, service_name, username, password FROM oracle_settings WHERE type='ASTECH'");
  if (!s || !s.host) throw new Error('Paramètres ASTECH introuvables (config.json, env ou oracle_settings).');
  return { user: s.username, password: s.password, connectString: `${s.host}:${s.port}/${s.service_name}` };
}

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
  return {
    kpi: { ...kpi, admins: admins ? admins.n : 0, total_agents: agents ? Number(agents.total) : 0,
      agents_actifs: agents ? Number(agents.actifs) : 0, agents_inactifs: agents ? Number(agents.inactifs) : 0,
      agents_utilisateurs: agents ? Number(agents.utilisateurs) : 0, agents_simples: agents ? Number(agents.simples) : 0 },
    prochainesEcheances, dernieresQuittances, derniersContrats, indices,
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
  const ast = await exec(`SELECT INSEE_AN AS an, INSEE_TYP AS typ, INSEE_TRIM AS trim, INSEE_TAUX AS taux,
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
    if (a && s !== null) { ecart = Number((s - a.taux).toFixed(3)); statut = Math.abs(ecart) < 0.005 ? 'ok' : 'ecart'; }
    else if (!a && s !== null) statut = 'manquant';
    else statut = 'source_absente';
    rows.push({
      typ, label: INSEE_SERIES[typ].label, an, trim,
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

// ─── Gestion des clés (admin) — protégée par ASTECH_ADMIN_TOKEN ──────────────
const ADMIN_TOKEN = process.env.ASTECH_ADMIN_TOKEN || '';
function adminAuthorized(req) {
  if (!ADMIN_TOKEN) return false;
  const header = String(req.headers['x-admin-token'] || '');
  const auth = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
  const cand = header || (auth ? auth[1].trim() : '');
  if (!cand || cand.length !== ADMIN_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(cand), Buffer.from(ADMIN_TOKEN));
}
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
  if (!ADMIN_TOKEN) return sendJson(res, 503, { error: 'Gestion des clés désactivée : définissez ASTECH_ADMIN_TOKEN (fichier .env).' });
  if (!adminAuthorized(req)) return sendJson(res, 401, { error: 'Jeton administrateur manquant ou invalide (en-tête « X-Admin-Token »).' });

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

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  const sp = u.searchParams;
  const term = (sp.get('q') || '').trim();
  try {
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate' });
      return res.end(html);
    }
    if (p === '/api/config') {
      return sendJson(res, 200, { connectInfo, readOnly: true, limit: LIMIT, studioRh: STUDIO_RH.configured, studioRhUrl: STUDIO_RH.url || null, version: '3.0.0', publicApi: '/api/v1', apiKeysEnabled: !!ADMIN_TOKEN });
    }
    // API publique versionnée (référentiels) + gestion des clés
    if (p === '/api/v1' || p.startsWith('/api/v1/')) return handleReferentielsApi(req, res, p, sp);
    if (p === '/api/admin/keys' || p.startsWith('/api/admin/keys/')) return handleAdminKeys(req, res, p);
    if (p === '/api/dashboard') return sendJson(res, 200, await getDashboard());
    if (p === '/api/referentiels-compteurs') return sendJson(res, 200, { counts: await refCounts() });

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

    // Référentiels (UI interne)
    if (p === '/api/referentiels/biens/genres') return sendJson(res, 200, { rows: await listGenres() });
    m = p.match(/^\/api\/referentiels\/([a-z]+)$/);
    if (m && REF_DEFS[m[1]]) return sendJson(res, 200, { type: m[1], label: REF_DEFS[m[1]].label, rows: await refList(m[1], { q: term, genre: sp.get('genre') || '', categorie: sp.get('categorie') || '', limit: LIMIT, offset: 0 }) });
    m = p.match(/^\/api\/referentiels\/([a-z]+)\/(.+)$/);
    if (m && REF_DEFS[m[1]]) {
      const row = await refById(m[1], decodeURIComponent(m[2]));
      return row ? sendJson(res, 200, { type: m[1], row }) : sendJson(res, 404, { error: 'Entrée introuvable' });
    }

    // Interventions
    if (p === '/api/interventions') return sendJson(res, 200, await listInterventions({ q: term, type: sp.get('type') || '', etat: sp.get('etat') || '', du: sp.get('du') || '', au: sp.get('au') || '', tout: sp.get('tout') === '1', page: sp.get('page'), pageSize: sp.get('pageSize') }));
    if (p === '/api/interventions/stats') return sendJson(res, 200, await intervStats());
    m = p.match(/^\/api\/intervention\/([^/]+)$/);
    if (m) { const d = await getIntervention(decodeURIComponent(m[1])); return d ? sendJson(res, 200, d) : sendJson(res, 404, { error: 'Intervention introuvable' }); }

    // Indices
    if (p === '/api/indices') return sendJson(res, 200, { rows: await listIndices({ type: sp.get('type'), annee: sp.get('annee') }), resume: await indicesResume() });
    if (p === '/api/indices/verifier') return sendJson(res, 200, await verifierIndices(sp.get('force') === '1'));

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

loadConfig()
  .then(async (cfg) => {
    connectInfo = cfg.connectString;
    loadStudioRh();
    pool = await oracledb.createPool({ ...cfg, poolMin: 1, poolMax: 4, poolIncrement: 1, poolPingInterval: 30 });
    server.listen(PORT, () => console.log(`ASTECH Explorer -> http://localhost:${PORT} (${connectInfo}) [lecture seule] | Studio-RH ${STUDIO_RH.configured ? 'configuré' : 'non configuré'}`));
  })
  .catch((e) => { console.error('Erreur démarrage:', e.message); process.exit(1); });
