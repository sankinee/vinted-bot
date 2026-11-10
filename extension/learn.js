// Injecté dans les pages Vinted (monde de la page) uniquement tant que l'extension
// n'a pas encore appris où Vinted charge ses annonces. Observe les réponses JSON
// du site et signale l'adresse qui contient une liste d'annonces ou un article.
(() => {
  if (window.__flipdarLearn) return;
  window.__flipdarLearn = true;
  const post = (kind, url) => window.postMessage({ ns: 'flipdar-learn', kind, url }, location.origin);
  // Relevé pour le diagnostic : chemin (numéros masqués), noms des paramètres et des champs.
  const survey = (url, d) => {
    try {
      const u = new URL(url, location.href);
      const arr = Array.isArray(d.items) ? d.items : null;
      const first = arr && arr[0] && typeof arr[0] === 'object' ? arr[0] : null;
      window.postMessage({ ns: 'flipdar-learn', kind: 'survey', e: {
        host: u.host, path: u.pathname.replace(/\d{4,}/g, '{n}'), params: [...new Set([...u.searchParams.keys()])].slice(0, 20),
        keys: Object.keys(d).slice(0, 20), items: arr ? arr.length : null, itemKeys: first ? Object.keys(first).slice(0, 60) : null,
        photoKeys: first && first.photo && typeof first.photo === 'object' ? Object.keys(first.photo).slice(0, 30) : null,
      } }, location.origin);
    } catch { /* rien */ }
  };
  const inspect = (url, d) => {
    if (!d || typeof d !== 'object') return;
    survey(url, d);
    const arr = Array.isArray(d.items) ? d.items : null;
    if (arr && arr.length && arr[0] && 'id' in arr[0] && 'title' in arr[0] && 'price' in arr[0]) return post('search', url);
    const it = d.item;
    if (it && it.id && 'title' in it && ('is_closed' in it || 'item_closing_action' in it || 'is_reserved' in it)) post('item', url);
  };
  const of = window.fetch;
  window.fetch = function (...a) {
    const p = of.apply(this, a);
    p.then((r) => {
      if (/json/.test(r.headers.get('content-type') || '')) r.clone().json().then((d) => inspect(r.url, d)).catch(() => {});
    }).catch(() => {});
    return p;
  };
  const oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    this.addEventListener('load', () => {
      try {
        const url = new URL(u, location.href).href;
        if (this.responseType === 'json') inspect(url, this.response);
        else if (!this.responseType || this.responseType === 'text') inspect(url, JSON.parse(this.responseText));
      } catch { /* pas du JSON */ }
    });
    return oo.call(this, m, u, ...rest);
  };
})();
