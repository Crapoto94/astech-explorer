/**
 * ASTECH Explorer — compte administrateur LOCAL de secours.
 *
 * Permet de se connecter même si l'AD / l'APM est indisponible (dépannage).
 * Le mot de passe est stocké HACHÉ (scrypt). Il est surchargéable par les
 * variables d'environnement ASTECH_LOCAL_ADMIN_LOGIN et
 * ASTECH_LOCAL_ADMIN_PASSWORD_HASH (format « scrypt$salt$hash »).
 *
 * ⚠️ Compte de secours : à réserver aux administrateurs, en dernier recours.
 */
'use strict';
const crypto = require('crypto');

// admin / çflcBr32  (hash scrypt ; le mot de passe en clair n'apparaît pas ici).
const DEFAULT_LOGIN = 'admin';
const DEFAULT_HASH = 'scrypt$a12fd9f4b80ae62d77b7abba3de7f0dd$f9f894edebeb5d06ef1975a7bd4fd723cddb3ec3bd04b086d7e7f17326a57fe588be08e74024d8fcec455e0e74a99c452592a8cc6ee99dfa4f8c436e0ec5c81c';

const LOGIN = (process.env.ASTECH_LOCAL_ADMIN_LOGIN || DEFAULT_LOGIN).toLowerCase();
const HASH = process.env.ASTECH_LOCAL_ADMIN_PASSWORD_HASH || DEFAULT_HASH;

function parseHash(spec) {
  const parts = String(spec || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return null;
  return { salt: parts[1], hash: parts[2] };
}

function verify(login, password) {
  if (String(login || '').toLowerCase() !== LOGIN) return false;
  const spec = parseHash(HASH);
  if (!spec) return false;
  const calc = crypto.scryptSync(String(password || ''), spec.salt, 64).toString('hex');
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(spec.hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { login: LOGIN, verify };
