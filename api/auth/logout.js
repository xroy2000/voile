import { route, method, body, json, clearSessionCookie } from '../_lib/http.js';

export default route(async (req, res) => {
  if (!method(req, res, 'POST')) return;
  body(req);
  clearSessionCookie(req, res);
  json(res, 200, { ok: true });
});
