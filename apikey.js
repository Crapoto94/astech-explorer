#!/usr/bin/env node
/**
 * CLI de gestion des clés d'API ASTECH (lecture seule).
 *
 * Usage :
 *   node apikey.js create --name "Studio-RH" [--scopes referentiels]
 *   node apikey.js list
 *   node apikey.js revoke <id>
 *
 * La clé en clair n'est affichée qu'à la création. Pour un déploiement Docker
 * durable, reportez-la dans ASTECH_API_KEYS (fichier .env) au format "nom:cle".
 */
'use strict';
const apikeys = require('./apikeys');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

try {
  if (cmd === 'create' || cmd === 'new' || cmd === 'gen') {
    if (!args.name) {
      console.error('Erreur : --name est obligatoire. Ex : node apikey.js create --name "Studio-RH"');
      process.exit(2);
    }
    const scopes = args.scopes ? String(args.scopes).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const created = apikeys.create({ name: String(args.name), scopes, createdBy: 'cli' });
    console.log('Clé créée (conservez la valeur en clair, elle ne sera plus jamais affichée) :\n');
    console.log('  id     : ' + created.id);
    console.log('  nom    : ' + created.name);
    console.log('  droits : ' + created.scopes.join(', '));
    console.log('  clé    : ' + created.key + '\n');
    console.log('Docker : ajoutez dans .env  ASTECH_API_KEYS=' + created.name.replace(/[,\s:]+/g, '-') + ':' + created.key);
    process.exit(0);
  }

  if (cmd === 'list' || cmd === 'ls') {
    const keys = apikeys.list();
    if (!keys.length) { console.log('Aucune clé.'); process.exit(0); }
    console.table(keys.map((k) => ({
      id: k.id, nom: k.name, clé: k.prefix, droits: k.scopes.join(','), source: k.source,
      créée: k.createdAt, dernierUsage: k.lastUsedAt || '—', révoquée: k.revokedAt || '—',
    })));
    process.exit(0);
  }

  if (cmd === 'revoke' || cmd === 'rm' || cmd === 'delete') {
    const id = args._[0];
    if (!id) { console.error('Erreur : précisez l\'id. Ex : node apikey.js revoke a1b2c3'); process.exit(2); }
    const r = apikeys.revoke(id);
    if (!r) { console.error('Clé introuvable : ' + id); process.exit(1); }
    console.log('Clé révoquée : ' + r.id + ' (' + r.name + ')');
    process.exit(0);
  }

  console.log('CLI clés d\'API ASTECH — commandes : create --name "…", list, revoke <id>');
  process.exit(cmd ? 2 : 0);
} catch (e) {
  console.error('Erreur : ' + e.message);
  process.exit(1);
}
