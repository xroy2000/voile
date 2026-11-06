import { query, ensureSchema } from '../_lib/db.js';
import { route, method, body, json, requireAdmin, newToken, sha256, origin, fail } from '../_lib/http.js';

// Administration des invitations (en-tête x-admin-secret).
//   GET    → liste
//   POST   → crée un lien { label?, ttlDays? (1–30, 7 par défaut), pseudo? } ; avec « pseudo », le lien sert à réinitialiser le mot de passe de ce joueur
//   DELETE → annule ?id=
export default route(async (req, res) => {
  if (!method(req, res, 'GET', 'POST', 'DELETE')) return;
  requireAdmin(req);
  await ensureSchema();

  if (req.method === 'GET') {
    const rows = await query(
      `select i.id, i.label, i.created_at, i.expires_at, i.used_at, i.revoked,
              t.pseudo as reset_for, w.pseudo as used_by_pseudo
         from invites i
         left join users t on t.id = i.user_id
         left join users w on w.id = i.used_by
        order by i.created_at desc limit 200`
    );
    return json(res, 200, {
      invites: rows.map((r) => ({
        id: Number(r.id), label: r.label, resetFor: r.reset_for, createdAt: r.created_at, expiresAt: r.expires_at,
        usedAt: r.used_at, usedBy: r.used_by_pseudo, revoked: r.revoked,
        status: r.revoked ? 'annulée' : r.used_at ? 'utilisée' : new Date(r.expires_at) < new Date() ? 'expirée' : 'en attente',
      })),
    });
  }

  if (req.method === 'POST') {
    const b = body(req);
    const ttl = Math.min(30, Math.max(1, Math.floor(Number(b.ttlDays) || 7)));
    const label = typeof b.label === 'string' ? b.label.trim().slice(0, 80) : '';
    let userId = null;
    if (b.pseudo) {
      const [u] = await query('select id from users where pseudo_lc = $1', [String(b.pseudo).trim().toLowerCase()]);
      if (!u) throw fail(404, 'Aucun joueur avec ce pseudo');
      userId = u.id;
    }
    const token = newToken();
    const [inv] = await query(
      `insert into invites (token_hash, label, user_id, expires_at)
       values ($1, $2, $3, now() + ($4 || ' days')::interval) returning id, expires_at`,
      [sha256(token), label || null, userId, String(ttl)]
    );
    // Le lien n'est montré qu'ici : seul son hash est conservé.
    return json(res, 201, { id: Number(inv.id), expiresAt: inv.expires_at, url: `${origin(req)}/join.html?token=${token}` });
  }

  const id = Number(new URL(req.url, 'http://x').searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) throw fail(400, 'id invalide');
  const done = await query('update invites set revoked = true where id = $1 and used_at is null returning id', [id]);
  if (!done.length) throw fail(404, 'Invitation introuvable ou déjà utilisée');
  json(res, 200, { ok: true });
});
