// Onglet « moteur de recherche » de Flipdar (fenêtre Vinted réduite).
// N'agit QUE dans l'onglet désigné par l'extension. Les recherches partent de cette page Vinted,
// exactement comme celles du site lui-même (même origine, mêmes cookies, mêmes en-têtes).
(async () => {
  const ask = (m) => new Promise((r) => { try { chrome.runtime.sendMessage(m, r); } catch { r(null); } });
  if (!(await ask({ type: 'worker?' }))) return;

  chrome.runtime.onMessage.addListener((m, _s, send) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'wfetch') {
      // Requête de recherche depuis la page Vinted (même origine que le site).
      const headers = m.rsc ? { RSC: '1' } : { accept: 'text/html,application/xhtml+xml,*/*' };
      fetch(m.url, { headers, credentials: 'include', cache: 'no-store' })
        .then(async (r) => send({ ok: r.ok, status: r.status, ct: r.headers.get('content-type') || '', url: r.url, retryAfter: Number(r.headers.get('retry-after')) || 0, text: await r.text() }))
        .catch((e) => send({ ok: false, status: 0, error: String((e && e.message) || e) }));
      return true;
    }
    if (m.type === 'wsnapshot') {
      // Page réellement chargée (comme un F5) : son HTML contient les annonces affichées.
      send({ ok: true, url: location.href, html: document.documentElement.outerHTML });
      return false;
    }
    if (m.type === 'wnav') {
      // Rechargement lancé par la page elle-même (comme un F5 ou un clic sur Vinted).
      send({ ok: true });
      setTimeout(() => { location.href = m.url; }, 0);
      return false;
    }
    if (m.type === 'wping') { send({ ok: true, url: location.href, state: document.readyState }); return false; }
  });

  const hello = () => ask({ type: 'workerReady', url: location.href });
  if (document.readyState === 'complete') hello(); else addEventListener('load', hello, { once: true });
})();
