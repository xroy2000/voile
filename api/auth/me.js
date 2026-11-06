import { route, method, json, readSession } from '../_lib/http.js';

// Qui suis-je ? Lit seulement le cookie signé, sans toucher à la base.
export default route(async (req, res) => {
  if (!method(req, res, 'GET')) return;
  const s = readSession(req);
  json(res, 200, { user: s ? { id: s.uid, pseudo: s.pseudo } : null });
});
