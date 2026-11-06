import { query, ensureSchema } from '../_lib/db.js';
import { route, method, json, requireAdmin, fail } from '../_lib/http.js';

// Liste des joueurs, et suppression d'un compte (?id=).
export default route(async (req, res) => {
  if (!method(req, res, 'GET', 'DELETE')) return;
  requireAdmin(req);
  await ensureSchema();

  if (req.method === 'GET') {
    const rows = await query('select id, pseudo, created_at, last_login from users order by created_at');
    return json(res, 200, { users: rows.map((r) => ({ id: Number(r.id), pseudo: r.pseudo, createdAt: r.created_at, lastLogin: r.last_login })) });
  }

  const id = Number(new URL(req.url, 'http://x').searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) throw fail(400, 'id invalide');
  const done = await query('delete from users where id = $1 returning id', [id]);
  if (!done.length) throw fail(404, 'Joueur introuvable');
  json(res, 200, { ok: true });
});
