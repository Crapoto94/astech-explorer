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
const LIMIT = Number(process.env.ASTECH_LIMIT || 300);
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

async function echeances(where, binds, limit = 300) {
  const futures = await exec(`${ECHEANCE_SELECT}
    WHERE ${where} AND X.date_echeance_ts >= TRUNC(SYSDATE)
    ORDER BY X.date_echeance_ts ASC FETCH FIRST ${int(limit, 300, 2000)} ROWS ONLY`, binds);
  const passees = await exec(`${ECHEANCE_SELECT}
    WHERE ${where} AND X.date_echeance_ts < TRUNC(SYSDATE) AND X.date_echeance_ts >= ${CUTOFF}
    ORDER BY X.date_echeance_ts DESC FETCH FIRST ${int(limit, 300, 2000)} ROWS ONLY`, binds);
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
  const echs = await echeances(`CAF.CONTAF_ARBID = :id AND CAF.CONTAF_PRINC='O'`, { id }, 100);
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
  const echs = await echeances(`UPPER(CL.CONTL_CONTRACTANT) = UPPER(:name)`, { name }, 200);
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
  const echs = await echeances(`X.contrat_id = :id`, { id }, 300);
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
    WHERE R.CONTRV_CONTID = :id ORDER BY R.CONTRV_DAT DESC NULLS LAST FETCH FIRST 100 ROWS ONLY`, { id });
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
    WHERE p.USR_ID = :id ORDER BY p.MNU_ID FETCH FIRST 400 ROWS ONLY`, { id: compte.usr_id });
  const groupes = await exec(`SELECT gd.GRUD_GRP AS code, gu.GRU_DES AS des
    FROM GROUPEUTILDETAIL gd LEFT JOIN GROUPEUTIL gu ON gu.GRU_COD = gd.GRUD_GRP
    WHERE gd.GRUD_DEM = :m ORDER BY gd.GRUD_GRP`, { m: matricule });
  const [auth] = await exec(`SELECT
      (SELECT COUNT(*) FROM DEMANDEURAUTH WHERE DEMA_DEMCOD = :m) AS n_auth,
      (SELECT COUNT(*) FROM DEMANDEURAUTHP WHERE DEMAP_DEMCOD = :m) AS n_authp
    FROM DUAL`, { m: matricule });
  const demandes = await exec(`SELECT SGESDEM_NUM AS num, TO_CHAR(SGESDEM_DAT,'DD/MM/YYYY') AS dat,
      SGESDEM_NDT AS ndt, SGESDEM_LIBELLE AS libelle
    FROM DEMANDES WHERE SGESDEM_DEM = :m ORDER BY SGESDEM_DAT DESC NULLS LAST FETCH FIRST 10 ROWS ONLY`, { m: matricule });
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
async function syncRun(scope, force) {
  if (!STUDIO_RH.configured) return { configured: false, error: "La source Studio-RH n'est pas configurée (STUDIO_RH_API_URL / STUDIO_RH_API_KEY)." };
  scope = scope === 'actifs' ? 'actifs' : 'droits';
  const now = Date.now();
  if (!force && syncCache.result && syncCache.scope === scope && (now - syncCache.at) < 10 * 60 * 1000) {
    return { ...syncCache.result, cached: true };
  }
  const cond = scope === 'actifs' ? "sign = 'O'" : 'nb > 0';
  const agents = await exec(`SELECT * FROM (${AGENT_BASE}) WHERE ${cond} ORDER BY nom NULLS LAST, matricule FETCH FIRST 4000 ROWS ONLY`);
  const started = Date.now();
  const results = await mapLimit(agents, 10, async (a) => {
    try { const r = await studioRhFindByMatricule(a.matricule); return { a, ...r }; }
    catch (e) { return { a, ok: false, error: e.message }; }
  });
  const concordants = [], orphelins_astech = [], erreurs = [];
  for (const r of results) {
    const a = r.a;
    if (!r.ok) { erreurs.push({ matricule: a.matricule, nom: a.nom, service: a.service, detail: r.error || ('HTTP ' + r.status) }); continue; }
    if (r.found) concordants.push({ matricule: a.matricule, nom: a.nom, service: a.service, nb: a.nb, roleapp: a.roleapp,
      rh_nom: [r.agent.prenom, r.agent.nom].filter(Boolean).join(' '), rh_service: r.agent.service, rh_email: r.agent.email });
    else orphelins_astech.push({ matricule: a.matricule, nom: a.nom, service: a.service, sserv: a.sserv, nb: a.nb,
      roleapp: a.roleapp, gest: a.gest, ordon: a.ordon, compta: a.compta, email: a.email, maj: a.maj });
  }
  const result = {
    configured: true, scope, at: new Date().toISOString(), duree_ms: Date.now() - started,
    stats: { verifies: agents.length, concordants: concordants.length, orphelins_astech: orphelins_astech.length, erreurs: erreurs.length },
    concordants, orphelins_astech, orphelins_rh: [], erreurs,
    note_rh: "La liste « agents Studio-RH actifs absents d'ASTECH » nécessite l'accès à la liste complète RH, non exposée par l'API (seule /api/agents/search est accessible par clé).",
  };
  syncCache.at = now; syncCache.scope = scope; syncCache.result = result;
  return result;
}

// ─── Référentiels ────────────────────────────────────────────────────────────
const REF_TYPES = {
  biens: {
    label: 'Biens & Patrimoine (ARBO)',
    list: (term) => exec(`${BIEN_SELECT_STD}
      WHERE UPPER(NVL(A.ARB_CODE,' ')||' '||NVL(A.ARB_DES,' ')||' '||NVL(ADR.ARBA_ADR1,' ')||' '||NVL(ADR.ARBA_VILLE,' ')) LIKE :q
      ORDER BY A.ARB_DES FETCH FIRST ${LIMIT} ROWS ONLY`, { q: '%' + term.toUpperCase() + '%' }),
  },
  vehicules: {
    label: 'Véhicules & Parc Roulant (PARC)',
    list: (term) => exec(`SELECT ID_BIEN AS id, DES_BIEN AS des, IMMAT AS immat, MARQUE AS marque, MODELE AS modele,
        CATEGORIE AS categorie, SERVICE AS service, ANNEE AS annee, COMPTEUR AS compteur, NO_INVENTAIRE AS no_inventaire
      FROM V_PARC_COMSMA
      WHERE CATEGORIE = 'GVEH' AND UPPER(NVL(DES_BIEN,' ')||' '||NVL(IMMAT,' ')||' '||NVL(MARQUE,' ')||' '||NVL(MODELE,' ')) LIKE :q
      ORDER BY DES_BIEN FETCH FIRST ${LIMIT} ROWS ONLY`, { q: '%' + term.toUpperCase() + '%' }),
  },
  materiel: {
    label: 'Matériel & Stocks (STOCK)',
    list: (term) => exec(`SELECT SREF_COD AS code, SREF_DES AS des, SREF_FAM AS fam, SREF_SOUFAM AS soufam,
        SREF_UNIT AS unit, SREF_QTERES AS qte, SREF_QTEMIN AS qte_min, SREF_QTEMAX AS qte_max,
        SREF_PUMP AS pamp, SREF_MARQUE AS marque, SREF_SSERV AS sserv
      FROM STOCK WHERE UPPER(NVL(SREF_COD,' ')||' '||NVL(SREF_DES,' ')||' '||NVL(SREF_MARQUE,' ')) LIKE :q
      ORDER BY SREF_DES FETCH FIRST ${LIMIT} ROWS ONLY`, { q: '%' + term.toUpperCase() + '%' }),
  },
  tiers: {
    label: 'Tiers & Fournisseurs (FOURNISSEUR)',
    list: (term) => exec(`SELECT SFOU_COD AS code, SFOU_NOM AS nom, SFOU_VILLE AS ville, SFOU_SIRET AS siret,
        SFOU_TEL1 AS tel, SFOU_EMAIL1 AS email, SFOU_ACTIF AS actif
      FROM FOURNISSEUR WHERE UPPER(NVL(SFOU_NOM,' ')||' '||NVL(SFOU_COD,' ')||' '||NVL(SFOU_VILLE,' ')) LIKE :q
      ORDER BY SFOU_NOM FETCH FIRST ${LIMIT} ROWS ONLY`, { q: '%' + term.toUpperCase() + '%' }),
  },
  services: {
    label: 'Services & Structures (SERVICE)',
    list: (term) => exec(`SELECT SSER_COD AS code, SSER_NOM AS nom, SSER_NOMLONG AS nom_long, SSER_ACTIF AS actif
      FROM SERVICE WHERE UPPER(NVL(SSER_NOM,' ')||' '||NVL(SSER_NOMLONG,' ')||' '||NVL(SSER_COD,' ')) LIKE :q
      ORDER BY SSER_NOM FETCH FIRST ${LIMIT} ROWS ONLY`, { q: '%' + term.toUpperCase() + '%' }),
  },
  groupes: {
    label: 'Groupes applicatifs (GROUPEUTIL)',
    list: (term) => listGroupes(term),
  },
};
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

// ─── HTTP ────────────────────────────────────────────────────────────────────
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const empty = (v) => (v === null || v === undefined || v === '') ? undefined : v;

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
      return sendJson(res, 200, { connectInfo, readOnly: true, limit: LIMIT, studioRh: STUDIO_RH.configured, studioRhUrl: STUDIO_RH.url || null, version: '3.0.0' });
    }
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

    // Référentiels
    m = p.match(/^\/api\/referentiels\/([a-z]+)$/);
    if (m && REF_TYPES[m[1]]) return sendJson(res, 200, { type: m[1], label: REF_TYPES[m[1]].label, rows: await REF_TYPES[m[1]].list(term) });
    m = p.match(/^\/api\/referentiels\/([a-z]+)\/(.+)$/);
    if (m && REF_TYPES[m[1]]) {
      const rows = await REF_TYPES[m[1]].list('');
      const id = decodeURIComponent(m[2]);
      const row = rows.find(r => String(r.id ?? r.code) === id);
      return row ? sendJson(res, 200, { type: m[1], row }) : sendJson(res, 404, { error: 'Entrée introuvable' });
    }

    // Interventions
    if (p === '/api/interventions') return sendJson(res, 200, await listInterventions({ q: term, type: sp.get('type') || '', etat: sp.get('etat') || '', du: sp.get('du') || '', au: sp.get('au') || '', tout: sp.get('tout') === '1', page: sp.get('page'), pageSize: sp.get('pageSize') }));
    if (p === '/api/interventions/stats') return sendJson(res, 200, await intervStats());
    m = p.match(/^\/api\/intervention\/([^/]+)$/);
    if (m) { const d = await getIntervention(decodeURIComponent(m[1])); return d ? sendJson(res, 200, d) : sendJson(res, 404, { error: 'Intervention introuvable' }); }

    // Indices
    if (p === '/api/indices') return sendJson(res, 200, { rows: await listIndices({ type: sp.get('type'), annee: sp.get('annee') }), resume: await indicesResume() });

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
