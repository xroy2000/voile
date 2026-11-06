import { query, ensureSchema } from '../_lib/db.js';
import { route, method, body, json, verifyPassword, setSessionCookie, clientIp, fail } from '../_lib/http.js';

const MAX_FAILS = 8;       // échecs tolérés…
const WINDOW_MIN = 15;     // …par fenêtre de 15 minutes, pour un couple IP + pseudo
// Faux hash : on le vérifie quand le pseudo n'existe pas, pour que la durée de réponse ne révèle rien.
const DUMMY = 'scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

export default route(async (req, res) => {
  if (!method(req, res, 'POST')) return;
  const { pseudo, password } = body(req);
  if (typeof pseudo !== 'string' || typeof password !== 'string' || !pseudo || !password) throw fail(400, 'Pseudo et mot de passe requis');
  await ensureSchema();

  const lc = pseudo.trim().toLowerCase();
  const key = `${clientIp(req)}|${lc}`.slice(0, 200);
  const [{ n }] = await query(
    `select count(*)::int as n from login_attempts where key = $1 and at > now() - ($2 || ' minutes')::interval`,
    [key, String(WINDOW_MIN)]
  );
  if (n >= MAX_FAILS) throw fail(429, 'Trop de tentatives, réessaie dans quelques minutes');

  const [user] = await query('select id, pseudo, pass_hash from users where pseudo_lc = $1', [lc]);
  const ok = await verifyPassword(password, user ? user.pass_hash : DUMMY);
  if (!user || !ok) {
    await query('insert into login_attempts (key) values ($1)', [key]);
    await query(`delete from login_attempts where at < now() - interval '1 day'`);
    throw fail(401, 'Pseudo ou mot de passe incorrect');
  }
  await query('delete from login_attempts where key = $1', [key]);
  await query('update users set last_login = now() where id = $1', [user.id]);
  setSessionCookie(req, res, user);
  json(res, 200, { user: { id: Number(user.id), pseudo: user.pseudo } });
});
