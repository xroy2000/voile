import { query, ensureSchema } from '../_lib/db.js';
import { route, method, body, json, sha256, hashPassword, checkPseudo, checkPassword, setSessionCookie, fail } from '../_lib/http.js';

// Le joueur invité choisit son pseudo et son mot de passe. Le lien ne sert qu'une fois.
export default route(async (req, res) => {
  if (!method(req, res, 'POST')) return;
  const { token, pseudo, password } = body(req);
  if (typeof token !== 'string' || !token) throw fail(400, 'Lien incomplet');
  checkPassword(password);
  await ensureSchema();

  const [inv] = await query('select id, user_id from invites where token_hash = $1', [sha256(token)]);
  if (!inv) throw fail(404, 'Invitation inconnue');
  const cleanPseudo = inv.user_id ? null : checkPseudo(pseudo); // validé avant de consommer le lien
  const passHash = await hashPassword(password);

  // Consommation atomique : une seule requête peut gagner, même si le lien est ouvert deux fois en même temps.
  const claimed = await query(
    `update invites set used_at = now()
      where id = $1 and used_at is null and not revoked and expires_at > now()
      returning id`,
    [inv.id]
  );
  if (!claimed.length) throw fail(410, 'Invitation expirée, annulée ou déjà utilisée');

  let user;
  if (inv.user_id) {
    [user] = await query('update users set pass_hash = $1, last_login = now() where id = $2 returning id, pseudo', [passHash, inv.user_id]);
  } else {
    [user] = await query(
      `insert into users (pseudo, pseudo_lc, pass_hash, last_login) values ($1, $2, $3, now())
       on conflict (pseudo_lc) do nothing returning id, pseudo`,
      [cleanPseudo, cleanPseudo.toLowerCase(), passHash]
    );
    if (!user) {
      await query('update invites set used_at = null where id = $1', [inv.id]); // le lien reste utilisable avec un autre pseudo
      throw fail(409, 'Ce pseudo est déjà pris, choisis-en un autre');
    }
  }
  await query('update invites set used_by = $1 where id = $2', [user.id, inv.id]);
  setSessionCookie(req, res, user);
  json(res, 200, { user: { id: Number(user.id), pseudo: user.pseudo } });
});
