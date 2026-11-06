// Pastille de compte dans l'en-tête : « Se connecter » ou « pseudo · Déconnexion ».
// Si l'API n'existe pas (hébergement statique, test local sans serveur), la pastille reste simplement cachée.
(async () => {
  const box = document.getElementById('acct');
  if (!box) return;
  try {
    const r = await fetch('/api/auth/me', { headers: { accept: 'application/json' } });
    if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return;
    const { user } = await r.json();
    box.replaceChildren();
    if (user) {
      const name = document.createElement('span');
      name.textContent = '👤 ' + user.pseudo;
      const out = document.createElement('button');
      out.textContent = 'Déconnexion';
      out.onclick = async () => {
        try { await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); } catch {}
        location.reload();
      };
      box.append(name, out);
    } else {
      const a = document.createElement('a');
      a.href = '/login.html';
      a.textContent = 'Se connecter';
      box.append(a);
    }
    box.classList.remove('hidden');
  } catch { /* pas d'API : on ne montre rien */ }
})();
