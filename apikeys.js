/**
 * ASTECH Explorer — gestion des clés d'API (accès lecture seule).
 *
 * Les clés sont stockées HACHÉES (SHA-256) : la valeur en clair n'est affichée
 * qu'une seule fois, à la création. Deux sources :
 *   1) variables d'environnement ASTECH_API_KEYS (durables, recommandé en Docker) :
 *      format "nom:cle,nom2:cle2" (ou juste "cle" pour un nom générique).
 *   2) fichier JSON (ASTECH_KEYS_FILE, défaut ./api-keys.json) : clés générées
 *      dynamiquement via l'API d'admin ou le CLI apikey.js.
 *
 * Aucune dépendance externe.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.ASTECH_KEYS_FILE || path.join(__dirname, 'api-keys.json');
const PREFIX = 'ast_';
const DEFAULT_SCOPE = 'referentiels';

const hash = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');
const genRaw = () => PREFIX + crypto.randomBytes(24).toString('base64url');
const genId = () => crypto.randomBytes(6).toString('hex');

let store = { version: 1, keys: [] };
let byHash = new Map();
let loaded = false;

function normalize(rec) {
  const scopes = Array.isArray(rec.scopes) && rec.scopes.length ? rec.scopes.map(String) : [DEFAULT_SCOPE];
  return {
    id: rec.id || genId(),
    name: String(rec.name || 'sans nom'),
    prefix: rec.prefix || '',
    hash: rec.hash,
    scopes,
    readOnly: rec.readOnly !== false,
    source: rec.source === 'env' ? 'env' : 'file',
    createdAt: rec.createdAt || new Date().toISOString(),
    createdBy: rec.createdBy || null,
    lastUsedAt: rec.lastUsedAt || null,
    revokedAt: rec.revokedAt || null,
  };
}

function load() {
  if (loaded) return store;
  try {
    if (fs.existsSync(FILE)) {
      const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      store = { version: 1, keys: (j.keys || []).map(normalize) };
    }
  } catch { store = { version: 1, keys: [] }; } // fichier absent/corrompu : on repart d'une base vide

  const seed = (process.env.ASTECH_API_KEYS || '').trim();
  if (seed) {
    for (const part of seed.split(',').map((s) => s.trim()).filter(Boolean)) {
      const i = part.indexOf(':');
      const name = i > 0 ? part.slice(0, i) : 'env';
      const raw = i > 0 ? part.slice(i + 1) : part;
      const h = hash(raw);
      if (!store.keys.some((k) => k.hash === h)) {
        store.keys.push(normalize({ name, prefix: raw.slice(0, 8), hash: h, scopes: [DEFAULT_SCOPE], source: 'env', createdBy: 'env' }));
      }
    }
  }
  reindex();
  loaded = true;
  return store;
}

function reindex() { byHash = new Map(store.keys.map((k) => [k.hash, k])); }

function persist() {
  const remote = store.keys.filter((k) => k.source !== 'env');
  const dir = path.dirname(FILE);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, keys: remote }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function publicView(rec) {
  return {
    id: rec.id, name: rec.name, prefix: rec.prefix + '…', scopes: rec.scopes,
    readOnly: rec.readOnly, source: rec.source,
    createdAt: rec.createdAt, createdBy: rec.createdBy,
    lastUsedAt: rec.lastUsedAt, revokedAt: rec.revokedAt,
  };
}

function create({ name, scopes, readOnly, createdBy } = {}) {
  load();
  const raw = genRaw();
  const rec = normalize({
    name: name || 'sans nom', scopes, readOnly, createdBy: createdBy || 'admin',
    prefix: raw.slice(0, 8), hash: hash(raw), source: 'file',
  });
  store.keys.push(rec);
  byHash.set(rec.hash, rec);
  persist();
  return { ...publicView(rec), key: raw };
}

function verify(raw) {
  load();
  if (!raw) return null;
  const rec = byHash.get(hash(raw));
  if (!rec || rec.revokedAt) return null;
  rec.lastUsedAt = new Date().toISOString();
  return rec;
}

function get(id) { load(); return store.keys.find((k) => k.id === id) || null; }

function list() { load(); return store.keys.map(publicView); }

function revoke(id) {
  load();
  const rec = get(id);
  if (!rec) return null;
  if (rec.source === 'env') {
    const e = new Error("Clé fournie par ASTECH_API_KEYS : retirez-la de la variable d'environnement pour la révoquer.");
    e.code = 'ENV_KEY';
    throw e;
  }
  if (!rec.revokedAt) { rec.revokedAt = new Date().toISOString(); persist(); }
  return publicView(rec);
}

function hasScope(rec, scope) {
  if (!rec) return false;
  return rec.scopes.includes('*') || rec.scopes.includes(scope);
}

module.exports = { load, create, verify, get, list, revoke, hasScope, file: FILE, DEFAULT_SCOPE };
