/**
 * ASTECH Explorer — diagnostic POSTE004 (GED).
 *
 * Identifie qui/quoi a déposé des documents dans \\POSTE004\C$\TEMP :
 * comptes déposants, période, sous-dossiers, extensions, thèmes, échantillon.
 * Permet de retrouver le poste de travail et l'origine des photos (PHDI/PHINT).
 *
 * Lecture seule. Lancement :
 *   node diag-poste004.js              (profil ASTECH_ENV ou prod)
 *   node diag-poste004.js --env test
 *   node diag-poste004.js --like "\\POSTE004\%"   (autre préfixe de chemin)
 *
 * Connexion : mêmes règles que server.js (env ORACLE_ASTECH_*, puis
 * config.json, puis SQLite AppDSI « oracle_settings » type=ASTECH).
 */
'use strict';
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

const IC = process.env.ORACLE_CLIENT_LIB_DIR || path.join(__dirname, 'instantclient', 'instantclient_21_23');
try { oracledb.initOracleClient({ libDir: IC }); }
catch (e) { if (!/already initialized/i.test(e.message)) { console.error('Instant Client :', e.message); process.exit(1); } }

const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const WANT_ENV = (argVal('--env') || process.env.ASTECH_ENV || 'prod').toLowerCase();
const LIKE = argVal('--like') || '\\\\POSTE004\\%';

function normEnv(v) {
  const s = String(v || '').toLowerCase().trim();
  if (['test', 'recette', 'preprod', 'dev'].includes(s)) return 'test';
  if (['prod', 'production'].includes(s)) return 'prod';
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
async function loadDbConfigs() {
  let cfg = null;
  try { const p = path.join(__dirname, 'config.json'); if (fs.existsSync(p)) cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* ignore */ }
  let prod = envFromPrefix('ORACLE_ASTECH');
  if (!prod && cfg && (cfg.host || cfg.username)) prod = { user: cfg.username, password: cfg.password, connectString: `${cfg.host}:${cfg.port}/${cfg.service_name || cfg.service}` };
  if (!prod) {
    try {
      const { setupDb, getSqlite } = require(APPDSI + '/shared/database');
      await setupDb();
      const s = await getSqlite().get("SELECT host, port, service_name, username, password FROM oracle_settings WHERE type='ASTECH'");
      if (s && s.host) prod = { user: s.username, password: s.password, connectString: `${s.host}:${s.port}/${s.service_name}` };
    } catch { /* ignore */ }
  }
  let test = envFromPrefix('ORACLE_ASTECH_TEST');
  if (!test && cfg) {
    const t = cfg.oracle_test || cfg.test;
    if (t && t.host) test = { user: t.username || t.user, password: t.password, connectString: `${t.host}:${t.port || 1521}/${t.service_name || t.service}` };
  }
  const profiles = {};
  if (prod) profiles.prod = { ...prod, label: 'Production' };
  if (test) profiles.test = { ...test, label: 'Test / Recette' };
  if (!Object.keys(profiles).length) throw new Error('Paramètres ASTECH introuvables.');
  return profiles;
}

function pad(s, n) { s = String(s == null ? '' : s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function table(rows, cols) {
  if (!rows.length) { console.log('  (aucune ligne)'); return; }
  const widths = cols.map((c) => Math.max(c.label.length, ...rows.map((r) => String(r[c.key] == null ? '' : r[c.key]).length)));
  console.log('  ' + cols.map((c, i) => pad(c.label, widths[i])).join('  '));
  console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log('  ' + cols.map((c, i) => pad(r[c.key], widths[i])).join('  '));
}
function section(t) { console.log('\n' + t + '\n' + '='.repeat(t.length)); }

async function main() {
  const profiles = await loadDbConfigs();
  const env = profiles[WANT_ENV] ? WANT_ENV : (profiles.prod ? 'prod' : Object.keys(profiles)[0]);
  const profile = profiles[env];
  console.log(`POSTE004 — diagnostic GED`);
  console.log(`Base : ${env} (${profile.connectString}) | filtre : ${LIKE}`);
  if (args.includes('--dry')) { console.log('(--dry) configuration résolue, pas de connexion.'); return; }
  const pool = await oracledb.createPool({ ...profile, poolMin: 1, poolMax: 2 });
  const exec = async (sql, binds = {}, maxRows = 5000) => {
    const c = await pool.getConnection();
    try { const r = await c.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows }); return r.rows || []; }
    finally { await c.close(); }
  };
  const one = async (sql, binds) => (await exec(sql, binds))[0] || {};

  const W = `UPPER(NVL(DOC_FOLDER,' ')) LIKE :pat`;
  const bind = { pat: LIKE };

  const total = await one(`SELECT COUNT(*) AS N FROM DOC`);
  const poste = await one(`SELECT COUNT(*) AS RECORDS, COUNT(DISTINCT NVL(DOC_FOLDER,' ')||'|'||NVL(DOC_FILE,' ')) AS FICHIERS FROM DOC WHERE ${W}`, bind);
  const fp = (a, b) => b ? Math.round((a / b) * 1000) / 10 : 0;
  section('1. Volumétrie');
  console.log(`  DOC total          : ${total.N} enregistrements`);
  console.log(`  dont POSTE004      : ${poste.RECORDS} enregistrements (${fp(poste.RECORDS, total.N)} %) / ${poste.FICHIERS} fichiers uniques`);

  section('2. Comptes déposants (qui ?)');
  const users = await exec(`SELECT COLUMN_NAME FROM ALL_TAB_COLUMNS WHERE TABLE_NAME='SBCG_USERS' AND COLUMN_NAME IN ('USR_ID','USR_NAME','USR_DETAIL')`);
  const hasUsers = users.length >= 3;
  const userJoin = hasUsers
    ? `LEFT JOIN SBCG_USERS u ON u.USR_ID = d.DOC_CUSER`
    : '';
  const userCols = hasUsers
    ? `MAX(u.USR_NAME) AS MATRICULE, MAX(u.USR_DETAIL) AS NOM,`
    : `'''' AS MATRICULE, '' AS NOM,`;
  table(await exec(`SELECT d.DOC_CUSER AS ID, ${userCols} COUNT(*) AS N,
      TO_CHAR(MIN(d.DOC_CDATE),'DD/MM/YYYY') AS DU, TO_CHAR(MAX(d.DOC_CDATE),'DD/MM/YYYY') AS AU
    FROM DOC d ${userJoin}
    WHERE UPPER(NVL(d.DOC_FOLDER,' ')) LIKE :pat GROUP BY d.DOC_CUSER ORDER BY N DESC`, bind, 60),
    [{ key: 'ID', label: 'ID' }, { key: 'MATRICULE', label: 'Matricule' }, { key: 'NOM', label: 'Nom' }, { key: 'N', label: 'Lignes' }, { key: 'DU', label: 'Du' }, { key: 'AU', label: 'Au' }]);

  section('3. Dossiers exacts (sous-chemins ?)');
  table(await exec(`SELECT TRIM(DOC_FOLDER) AS DOSSIER, COUNT(*) AS N, COUNT(DISTINCT DOC_FILE) AS FICHIERS
    FROM DOC WHERE ${W} GROUP BY DOC_FOLDER ORDER BY N DESC`, bind, 200),
    [{ key: 'DOSSIER', label: 'Dossier' }, { key: 'N', label: 'Lignes' }, { key: 'FICHIERS', label: 'Fichiers' }]);

  section('4. Thèmes GED');
  table(await exec(`SELECT NVL(t.THM_COD,'(sans thème)') AS THEME, t.THM_NOM AS LIBELLE, COUNT(*) AS N
    FROM DOC d LEFT JOIN DOC_THEME t ON t.THM_ID = d.DOC_THEME
    WHERE UPPER(NVL(d.DOC_FOLDER,' ')) LIKE :pat GROUP BY t.THM_COD, t.THM_NOM ORDER BY N DESC`, bind, 100),
    [{ key: 'THEME', label: 'Code' }, { key: 'LIBELLE', label: 'Libellé' }, { key: 'N', label: 'Lignes' }]);

  section('5. Extensions de fichiers');
  table(await exec(`SELECT NVL(REGEXP_SUBSTR(UPPER(DOC_FILE),'\\.[A-Z0-9]+$'),'(sans ext)') AS EXT, COUNT(*) AS N
    FROM DOC WHERE ${W} GROUP BY REGEXP_SUBSTR(UPPER(DOC_FILE),'\\.[A-Z0-9]+$') ORDER BY N DESC`, bind, 100),
    [{ key: 'EXT', label: 'Extension' }, { key: 'N', label: 'Lignes' }]);

  section('6. Échantillon des 20 derniers dépôts');
  table(await exec(`SELECT * FROM (
      SELECT DOC_ID AS ID, DOC_FILE AS FICHIER, NVL(DOC_TITRE,' ') AS TITRE, DOC_CUSER AS PAR,
        TO_CHAR(DOC_CDATE,'DD/MM/YYYY HH24:MI') AS DEPOSE
      FROM DOC WHERE ${W} ORDER BY DOC_CDATE DESC) WHERE ROWNUM <= 20`, bind, 20),
    [{ key: 'ID', label: 'ID' }, { key: 'FICHIER', label: 'Fichier' }, { key: 'TITRE', label: 'Titre' }, { key: 'PAR', label: 'Par' }, { key: 'DEPOSE', label: 'Déposé le' }]);

  await pool.close();
  console.log('\nDiagnostic terminé.');
}

main().catch((e) => { console.error('\nErreur :', e.message); process.exit(1); });
