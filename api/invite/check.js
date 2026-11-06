import { query, ensureSchema } from '../_lib/db.js';
import { route, method, json, sha256, fail } from '../_lib/http.js';

// La page d'invitation demande d'abord si le lien est valable, et s'il s'agit d'une création ou d'une réinitialisation.
export default route(async (req, res) => {
  if (!method(req, res, 'GET')) return;
  const token = new URL(req.url, 'http://x').searchParams.get('token') || '';
  if (!token) throw fail(400, 'Lien incomplet');
  await ensureSchema();
  const [inv] = await query(
    `select i.used_at, i.revoked, i.expires_at < now() as expired, u.pseudo as reset_pseudo
       from invites i left join users u on u.id = i.user_id
      where i.token_hash = $1`,
    [sha256(token)]
  );
  if (!inv) throw fail(404, 'Invitation inconnue');
  if (inv.revoked) throw fail(410, 'Invitation annulée');
  if (inv.used_at) throw fail(410, 'Invitation déjà utilisée');
  if (inv.expired) throw fail(410, 'Invitation expirée');
  json(res, 200, { valid: true, reset: !!inv.reset_pseudo, pseudo: inv.reset_pseudo || null });
});
