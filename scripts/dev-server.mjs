// Serveur local : fichiers statiques de web/ + les fonctions de api/ (comme sur Vercel), avec une base PGlite en mémoire.
//   npm run dev            → http://localhost:8767
// Les codes ci-dessous ne servent qu'en local ; en production ils viennent des variables d'environnement Vercel.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(root, 'web');
const port = Number(process.env.PORT || 8767);

process.env.PGLITE ??= '1';
process.env.SESSION_SECRET ??= 'dev-session-secret-not-for-production';
process.env.ADMIN_SECRET ??= 'dev-admin-secret-123';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.bin': 'application/octet-stream',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.gpx': 'application/gpx+xml',
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

async function handleApi(req, res, pathname) {
  // /api/auth/login → api/auth/login.js ; les dossiers _lib ne sont pas exposés
  const rel = pathname.replace(/^\/api\//, '');
  if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*$/i.test(rel)) { res.statusCode = 404; return res.end('{"error":"introuvable"}'); }
  const file = path.join(root, 'api', rel + '.js');
  if (!file.startsWith(path.join(root, 'api') + path.sep) || !fs.existsSync(file)) {
    res.statusCode = 404; res.setHeader('content-type', 'application/json'); return res.end('{"error":"introuvable"}');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') req.body = await readBody(req);
  const mod = await import(pathToFileURL(file).href);
  await mod.default(req, res);
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url.pathname);
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.normalize(path.join(webDir, p));
    if (!file.startsWith(webDir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404; return res.end('Introuvable');
    }
    res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.statusCode = 500;
    res.end('Erreur du serveur');
  }
}).listen(port, () => {
  console.log(`Offshore Racing → http://localhost:${port}`);
  console.log(`Administration  → http://localhost:${port}/admin.html   (code local : ${process.env.ADMIN_SECRET})`);
});
