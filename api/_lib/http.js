// Utilitaires communs : réponses JSON, mots de passe (scrypt), session signée, contrôle administrateur.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;

export function json(res, status, payload, headers = {}) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(payload));
}

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Corps JSON d'une requête qui modifie quelque chose : on exige application/json (protège des envois depuis un autre site). */
export function body(req) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.includes('application/json')) throw fail(415, 'Content-Type application/json requis');
  return req.body && typeof req.body === 'object' ? req.body : {};
}

export function method(req, res, ...allowed) {
  if (allowed.includes(req.method)) return true;
  res.setHeader('allow', allowed.join(', '));
  json(res, 405, { error: 'Méthode non autorisée' });
  return false;
}

/** Enveloppe un handler : erreurs → JSON propre, sans fuite de détails internes. */
export function route(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      json(res, status, { error: status >= 500 ? 'Erreur du serveur' : e.message });
    }
  };
}

// ---- mots de passe
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const N = 16384;
  const key = await scrypt(pw, salt, 64, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  const [alg, N, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = await scrypt(pw, Buffer.from(salt, 'base64'), 64, { N: +N, r: 8, p: 1 });
  const want = Buffer.from(hash, 'base64');
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}

// ---- session : cookie « session = charge.signature » (HMAC-SHA256)
function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('SESSION_SECRET manquant ou trop court');
  return s;
}
const sign = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

export function makeSession(user) {
  const payload = Buffer.from(JSON.stringify({ uid: user.id, pseudo: user.pseudo, exp: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
export function readSession(req) {
  const m = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  const good = Buffer.from(sign(payload)), got = Buffer.from(sig);
  if (good.length !== got.length || !crypto.timingSafeEqual(good, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}
const secureFlag = (req) => (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');
export function setSessionCookie(req, res, user) {
  res.setHeader('set-cookie', `session=${makeSession(user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secureFlag(req)}`);
}
export function clearSessionCookie(req, res) {
  res.setHeader('set-cookie', `session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag(req)}`);
}

// ---- administrateur : code secret dans l'en-tête x-admin-secret (variable d'environnement ADMIN_SECRET)
export function requireAdmin(req) {
  const want = process.env.ADMIN_SECRET;
  const got = String(req.headers['x-admin-secret'] || '');
  const h = (v) => crypto.createHash('sha256').update(v).digest();
  if (!want || want.length < 12 || !crypto.timingSafeEqual(h(got), h(want))) throw fail(401, 'Accès administrateur refusé');
}

// ---- divers
export const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
export const newToken = () => crypto.randomBytes(24).toString('base64url');
export const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?').split(',')[0].trim();
export function origin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}
export function checkPseudo(p) {
  const v = String(p ?? '').trim();
  if (!/^[\p{L}\p{N}_ -]{3,20}$/u.test(v)) throw fail(400, 'Pseudo : 3 à 20 caractères (lettres, chiffres, espace, - et _)');
  return v;
}
export function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 200) throw fail(400, 'Mot de passe : 8 caractères minimum');
  return pw;
}
export { fail };
