/**
 * ASTECH Explorer — gestion des utilisateurs & rôles (accès applicatif).
 *
 * Rôles :
 *   - 'admin' : accès complet + administration (utilisateurs, clés API, env).
 *   - 'user'  : accès à l'application (lecture, éventuellement écritures).
 *   - 'none'  : accès refusé (compte connu mais désactivé).
 *
 * Persistance JSON (ASTECH_USERS_FILE, défaut ./data/users.json). Un admin
 * « racine » peut aussi être forcé par ASTECH_ADMIN_USERS (liste de logins).
 *
 * Aucune dépendance externe. La session (HMAC) porte le rôle à l'authentification.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = process.env.ASTECH_USERS_FILE || path.join(__dirname, 'data', 'users.json');
const ADMIN_USERS = (process.env.ASTECH_ADMIN_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const VALID_ROLES = ['none', 'user', 'admin'];

let store = { version: 1, users: [] };
let byLogin = new Map();
let loaded = false;

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

function normalize(rec) {
  return {
    login: norm(rec.login),
    display: rec.display || rec.login || '',
    role: VALID_ROLES.includes(rec.role) ? rec.role : 'none',
    email: rec.email || null,
    source: rec.source === 'env' ? 'env' : 'file',
    createdAt: rec.createdAt || new Date().toISOString(),
    createdBy: rec.createdBy || null,
    updatedAt: rec.updatedAt || null,
    lastLoginAt: rec.lastLoginAt || null,
  };
}

function reindex() { byLogin = new Map(store.users.map((u) => [u.login, u])); }

function load() {
  if (loaded) return store;
  try {
    if (fs.existsSync(FILE)) {
      const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      store = { version: 1, users: (j.users || []).map(normalize) };
    }
  } catch { store = { version: 1, users: [] }; }
  // Admins forcés par l'environnement (source 'env', non modifiables ici).
  for (const login of ADMIN_USERS) {
    const existing = store.users.find((u) => u.login === login);
    if (!existing) store.users.push(normalize({ login, display: login, role: 'admin', source: 'env', createdBy: 'env' }));
    else { existing.role = 'admin'; existing.source = 'env'; }
  }
  reindex();
  loaded = true;
  return store;
}

function persist() {
  const remote = store.users.filter((u) => u.source !== 'env');
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); } catch { /* ignore */ }
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, users: remote }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function publicView(u) {
  return { login: u.login, display: u.display, role: u.role, email: u.email, source: u.source,
    createdAt: u.createdAt, createdBy: u.createdBy, updatedAt: u.updatedAt, lastLoginAt: u.lastLoginAt };
}

function list() { load(); return store.users.map(publicView).sort((a, b) => a.login.localeCompare(b.login)); }
function get(login) { load(); return byLogin.get(norm(login)) || null; }
function roleOf(login) { const u = get(login); return u ? u.role : 'none'; }
function isAdmin(login) { return roleOf(login) === 'admin'; }

function upsert({ login, display, role, email, createdBy }) {
  load();
  const l = norm(login);
  if (!l) { const e = new Error('Login obligatoire.'); e.status = 400; throw e; }
  if (!VALID_ROLES.includes(role)) { const e = new Error('Rôle invalide (none | user | admin).'); e.status = 400; throw e; }
  let u = byLogin.get(l);
  if (u) {
    if (u.source === 'env') {
      const e = new Error('Utilisateur administrateur forcé par ASTECH_ADMIN_USERS : non modifiable ici.');
      e.status = 409; throw e;
    }
    u.display = display || u.display; u.role = role; u.email = email !== undefined ? email : u.email;
    u.updatedAt = new Date().toISOString();
  } else {
    u = normalize({ login: l, display, role, email, source: 'file', createdBy: createdBy || 'admin' });
    store.users.push(u); byLogin.set(l, u);
  }
  persist();
  return publicView(u);
}

function remove(login) {
  load();
  const l = norm(login);
  const u = byLogin.get(l);
  if (!u) return null;
  if (u.source === 'env') { const e = new Error('Utilisateur administrateur forcé par ASTECH_ADMIN_USERS : non supprimable.'); e.status = 409; throw e; }
  store.users = store.users.filter((x) => x.login !== l);
  byLogin.delete(l);
  persist();
  return publicView(u);
}

function touchLogin(login) {
  const u = get(login);
  if (!u) return;
  u.lastLoginAt = new Date().toISOString();
  if (u.source !== 'env') persist();
}

module.exports = { load, list, get, roleOf, isAdmin, upsert, remove, touchLogin, VALID_ROLES, ADMIN_USERS, file: FILE };
