// Test de bout en bout des comptes : npm run test:auth (lance son propre serveur local avec base en mémoire).
import { spawn } from 'node:child_process';

const PORT = 8790;
const BASE = `http://localhost:${PORT}`;
const ADMIN = 'test-admin-secret-123';
const srv = spawn(process.execPath, ['scripts/dev-server.mjs'], {
  env: { ...process.env, PORT: String(PORT), ADMIN_SECRET: ADMIN, SESSION_SECRET: 'test-session-secret-123456' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((ok) => srv.stdout.on('data', (d) => String(d).includes('http://') && ok()));

let fails = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? '  ok ' : 'FAIL '} ${name}${cond ? '' : ' ' + extra}`); if (!cond) fails++; };
const J = { 'content-type': 'application/json' };
async function call(path, { method = 'GET', body, cookie, admin, headers = {} } = {}) {
  const r = await fetch(BASE + path, {
    method, headers: { ...(body !== undefined ? J : {}), ...(cookie ? { cookie } : {}), ...(admin ? { 'x-admin-secret': admin } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  const sc = r.headers.get('set-cookie');
  return { status: r.status, j, cookie: sc ? sc.split(';')[0] : null, setCookie: sc };
}
const tokenOf = (url) => new URL(url).searchParams.get('token');

try {
  console.log('Administration');
  check('sans code → 401', (await call('/api/admin/invites')).status === 401);
  check('mauvais code → 401', (await call('/api/admin/invites', { admin: 'faux-code-123456' })).status === 401);

  console.log('Invitation nouveau joueur');
  const inv = await call('/api/admin/invites', { method: 'POST', admin: ADMIN, body: { label: 'Marc' } });
  check('création 201', inv.status === 201 && /\/join\.html\?token=/.test(inv.j.url), JSON.stringify(inv));
  const tok = tokenOf(inv.j.url);
  const chk = await call('/api/invite/check?token=' + tok);
  check('lien valable, pas une réinitialisation', chk.status === 200 && chk.j.valid && !chk.j.reset);
  check('lien inconnu → 404', (await call('/api/invite/check?token=nimporte')).status === 404);
  check('pseudo trop court refusé', (await call('/api/invite/redeem', { method: 'POST', body: { token: tok, pseudo: 'ab', password: 'motdepasse1' } })).status === 400);
  check('mot de passe trop court refusé', (await call('/api/invite/redeem', { method: 'POST', body: { token: tok, pseudo: 'Marc', password: 'court' } })).status === 400);
  check('JSON exigé (anti-CSRF)', (await call('/api/invite/redeem', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: { token: tok } })).status === 415);
  const red = await call('/api/invite/redeem', { method: 'POST', body: { token: tok, pseudo: 'Marc', password: 'motdepasse1' } });
  check('inscription OK + cookie', red.status === 200 && red.j.user.pseudo === 'Marc' && !!red.cookie, JSON.stringify(red));
  check('cookie HttpOnly + SameSite', /HttpOnly/.test(red.setCookie) && /SameSite=Lax/.test(red.setCookie));
  check('lien à usage unique', (await call('/api/invite/redeem', { method: 'POST', body: { token: tok, pseudo: 'Autre', password: 'motdepasse1' } })).status === 410);
  check('lien utilisé → check 410', (await call('/api/invite/check?token=' + tok)).status === 410);

  console.log('Session');
  const me = await call('/api/auth/me', { cookie: red.cookie });
  check('me avec cookie', me.j.user?.pseudo === 'Marc');
  check('me sans cookie', (await call('/api/auth/me')).j.user === null);
  const forged = red.cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  check('cookie falsifié refusé', (await call('/api/auth/me', { cookie: forged })).j.user === null);
  const lo = await call('/api/auth/logout', { method: 'POST', body: {} });
  check('déconnexion efface le cookie', /Max-Age=0/.test(lo.setCookie));

  console.log('Connexion');
  const ok = await call('/api/auth/login', { method: 'POST', body: { pseudo: 'marc', password: 'motdepasse1' } });
  check('login insensible à la casse', ok.status === 200 && ok.j.user.pseudo === 'Marc');
  check('mauvais mot de passe → 401', (await call('/api/auth/login', { method: 'POST', body: { pseudo: 'Marc', password: 'mauvais-mdp-1' } })).status === 401);
  check('pseudo inconnu → même message', (await call('/api/auth/login', { method: 'POST', body: { pseudo: 'Fantome', password: 'mauvais-mdp-1' } })).j.error === 'Pseudo ou mot de passe incorrect');

  console.log('Pseudo déjà pris');
  const inv2 = await call('/api/admin/invites', { method: 'POST', admin: ADMIN, body: { label: 'Autre Marc' } });
  const tok2 = tokenOf(inv2.j.url);
  const dup = await call('/api/invite/redeem', { method: 'POST', body: { token: tok2, pseudo: 'MARC', password: 'motdepasse2' } });
  check('doublon (casse différente) → 409', dup.status === 409, JSON.stringify(dup));
  const again = await call('/api/invite/redeem', { method: 'POST', body: { token: tok2, pseudo: 'Julie', password: 'motdepasse2' } });
  check('le lien reste utilisable après un 409', again.status === 200 && again.j.user.pseudo === 'Julie', JSON.stringify(again));

  console.log('Réinitialisation du mot de passe');
  const rst = await call('/api/admin/invites', { method: 'POST', admin: ADMIN, body: { pseudo: 'marc' } });
  check('lien de réinitialisation 201', rst.status === 201, JSON.stringify(rst));
  const tok3 = tokenOf(rst.j.url);
  const c3 = await call('/api/invite/check?token=' + tok3);
  check('check indique réinitialisation de Marc', c3.j.reset === true && c3.j.pseudo === 'Marc');
  check('pseudo inexistant → 404', (await call('/api/admin/invites', { method: 'POST', admin: ADMIN, body: { pseudo: 'personne' } })).status === 404);
  const r3 = await call('/api/invite/redeem', { method: 'POST', body: { token: tok3, password: 'nouveaumdp99' } });
  check('nouveau mot de passe enregistré', r3.status === 200 && r3.j.user.pseudo === 'Marc');
  check('ancien mot de passe refusé', (await call('/api/auth/login', { method: 'POST', body: { pseudo: 'Marc', password: 'motdepasse1' } })).status === 401);
  check('nouveau mot de passe accepté', (await call('/api/auth/login', { method: 'POST', body: { pseudo: 'Marc', password: 'nouveaumdp99' } })).status === 200);

  console.log('Annulation et listes');
  const inv4 = await call('/api/admin/invites', { method: 'POST', admin: ADMIN, body: { label: 'À annuler' } });
  const tok4 = tokenOf(inv4.j.url);
  check('annulation', (await call('/api/admin/invites?id=' + inv4.j.id, { method: 'DELETE', admin: ADMIN })).status === 200);
  check('lien annulé → 410', (await call('/api/invite/check?token=' + tok4)).status === 410);
  const list = await call('/api/admin/invites', { admin: ADMIN });
  check('liste des invitations', list.j.invites.length === 4 && list.j.invites.some((i) => i.status === 'annulée') && !JSON.stringify(list.j).includes(tok), JSON.stringify(list.j).slice(0, 200));
  const users = await call('/api/admin/users', { admin: ADMIN });
  check('liste des joueurs sans hash', users.j.users.length === 2 && !JSON.stringify(users.j).includes('scrypt'));

  console.log('Limitation des essais');
  let last;
  for (let i = 0; i < 9; i++) last = await call('/api/auth/login', { method: 'POST', body: { pseudo: 'Julie', password: 'faux-mdp-' + i + '-xx' } });
  check('9e essai bloqué → 429', last.status === 429, String(last.status));
  check('même en donnant le bon mot de passe', (await call('/api/auth/login', { method: 'POST', body: { pseudo: 'Julie', password: 'motdepasse2' } })).status === 429);

  console.log('Suppression');
  const julie = users.j.users.find((u) => u.pseudo === 'Julie');
  check('suppression d’un joueur', (await call('/api/admin/users?id=' + julie.id, { method: 'DELETE', admin: ADMIN })).status === 200);
  check('/api/_lib non exposé', (await call('/api/_lib/db')).status === 404);
} catch (e) {
  console.error(e);
  fails++;
} finally {
  srv.kill();
}
console.log(fails ? `\n${fails} échec(s)` : '\nTout est vert');
process.exit(fails ? 1 : 0);
