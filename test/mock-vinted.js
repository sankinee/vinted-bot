// Faux Vinted pour les tests de bout en bout (HTTPS, port 443 par défaut).
// Reproduit ce qu'on observe sur le vrai site : recherche rendue dans la page (Next.js / flux RSC),
// annonces SANS date de publication, ancienne API 404, une API « dressing » qui ignore la recherche,
// bouton « Acheter » actif seulement après chargement, page de paiement avec « Payer ».
'use strict';
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

const PORT = Number(process.env.MOCK_PORT || 443);
const WITH_TS = process.env.MOCK_TS === '1';
const PHOTO_TS = process.env.MOCK_PHOTO_TS === '1'; // date dans l'adresse de la photo, comme sur Vinted     // inclure photo.high_resolution.timestamp
const INDEX_LAG = Number(process.env.MOCK_LAG || 20000); // délai d'indexation dans la recherche (ms)
const RATE = 12 / 1000;
const ADDED_OFFSET = Number(process.env.MOCK_ADDED_OFFSET || 0); // « Ajouté il y a » plus ancien que le numéro (ms)                          // ids Vinted par ms (≈ 12 annonces / s sur toute la plateforme)

const BRANDS = ['Ralph Lauren', 'Nike', 'Lacoste', 'Carhartt', 'Levi\'s', 'Zara'];
// Variantes réalistes : chaque annonce a une VALEUR DE MARCHÉ (prix auquel elle se vend vraiment)
// qui dépend de la marque, du type, du modèle, de la matière, de la taille (enfant) et de l'état.
// Le prix demandé = valeur × bruit (vendeurs trop gourmands ou pressés).
const VARIANTS = {
  'Ralph Lauren': [['Pull', '', 35], ['Pull', 'en laine', 48], ['Pull', 'cachemire', 85], ['Polo', '', 25], ['Chemise', '', 22], ['Sweat', '', 30]],
  Nike: [['Baskets', '', 40], ['Baskets', 'TN', 75], ['Baskets', 'Air Max 90', 55], ['Sweat', '', 28], ['Veste', '', 40]],
  Lacoste: [['Polo', '', 22], ['Pull', '', 35]],
  Carhartt: [['Veste', '', 50], ['Veste', 'Detroit', 115], ['Pantalon', '', 30]],
  'Levi\'s': [['Jean', '501', 28], ['Jean', '', 18]],
  Zara: [['Robe', '', 14], ['Manteau', '', 38]],
};
const CAT_IDS = { Pull: 1904, Polo: 1905, Chemise: 1906, Sweat: 1907, Baskets: 1242, Veste: 1908, Pantalon: 1909, Jean: 1910, Robe: 1911, Manteau: 1912 };
const STATES = ['Neuf avec étiquette', 'Neuf sans étiquette', 'Très bon état', 'Bon état', 'Satisfaisant'];
const COND = { 'Neuf avec étiquette': 1.15, 'Neuf sans étiquette': 1.05, 'Très bon état': 1, 'Bon état': 0.85, 'Satisfaisant': 0.65 };
const rnd = (n) => { let t = (n * 0x6D2B79F5 + 0x9E3779B9) >>> 0; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; // mulberry32

const items = new Map();
const t0 = Date.now();
let idAt0 = 10748000000;
const idAt = (t) => Math.round(idAt0 + (t - t0) * RATE);
let seq = 0;
function makeItem(createdAt, extra = {}) {
  const brand = BRANDS[seq % BRANDS.length];
  const vs = VARIANTS[brand];
  const [type, variant, base] = vs[Math.floor(seq / BRANDS.length) % vs.length];
  const status = STATES[Math.floor(rnd(seq + 7) * STATES.length)];
  const kids = type !== 'Baskets' && rnd(seq + 3) < 0.18; // ~18 % de tailles enfant
  const size = kids ? `${[4, 6, 8, 10, 12][Math.floor(rnd(seq + 5) * 5)]} ans` : type === 'Baskets' ? String(38 + Math.floor(rnd(seq + 5) * 8)) : ['S', 'M', 'L', 'XL'][Math.floor(rnd(seq + 5) * 4)];
  const fair = Math.round(base * COND[status] * (kids ? 0.45 : 1) * 100) / 100;
  // Prix demandé : de -30 % (vendeur pressé) à +60 % (trop gourmand), plus souvent au-dessus.
  const price = Math.max(3, Math.round(fair * (0.7 + 0.9 * rnd(seq + 11) ** 1.6)));
  const id = idAt(createdAt) + (seq % 7);
  seq++;
  const color = ['bleu', 'marine', 'gris', 'rouge'][seq % 4];
  const title = `${type} ${brand}${variant ? ' ' + variant : ''} ${color}${kids ? ' enfant' : ''}`;
  const it = { id, createdAt, brand, type, status, price, fair, size, sold: false, title, ...extra };
  items.set(id, it);
  return it;
}
// Historique : 3 jours d'annonces.
for (let t = t0 - 3 * 86400000; t < t0 - 60000; t += 60000) makeItem(t);
// Une partie des anciennes annonces est vendue (pour le suivi des ventes).
for (const it of items.values()) { if (it.createdAt < t0 - 3600000 && ((it.id * 2654435761) >>> 0) % 100 < 25) { it.sold = true; it.soldPrice = Math.round(it.fair * (0.88 + 0.12 * rnd(it.id))); } }
// Nouvelles annonces en continu.
setInterval(() => { makeItem(Date.now()); if (Math.random() < 0.5) makeItem(Date.now()); }, 4000);

const STATE = { rateLimited: false, requests: [] };
const STALE = new Map();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const slug = (it) => `${it.id}-${it.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
function apiItem(it, host) {
  const o = {
    id: it.id, title: it.title, price: { amount: it.price.toFixed(1), currency_code: 'EUR' },
    total_item_price: { amount: (it.price * 1.05 + 0.7).toFixed(2), currency_code: 'EUR' }, service_fee: { amount: (it.price * 0.05 + 0.7).toFixed(2) },
    ...(process.env.MOCK_NO_BRAND === '1' ? {} : { brand_title: it.brand }), size_title: it.size, status: it.status, url: `/items/${slug(it)}`, promoted: false,
    photo: PHOTO_TS
      ? { id: it.id + 1, url: `https://${host}/__img/t/03_${it.id}/f800/${Math.floor(it.createdAt / 1000)}.jpeg?s=ab12`, thumbnails: [{ type: 'thumb310x430', url: `https://${host}/__img/t/03_${it.id}/310x430/${Math.floor(it.createdAt / 1000)}.webp?s=cd34` }] }
      : { id: it.id + 1, url: `https://${host}/__img/${it.id}.svg`, thumbnails: [{ type: 'thumb310x430', url: `https://${host}/__img/${it.id}.svg` }] },
    user: { id: 555000 + (it.id % 1000), login: `vendeur${it.id % 1000}`, last_loged_on_ts: new Date().toISOString() },
    favourite_count: it.id % 20, view_count: 0, catalog_id: CAT_IDS[it.type] + (/ans$/.test(it.size) ? 1000 : 0),
  };
  if (WITH_TS) o.photo.high_resolution = { timestamp: Math.floor(it.createdAt / 1000) };
  return o;
}
function searchItems(p) {
  const q = (p.get('search_text') || '').toLowerCase().split(/\s+/).filter(Boolean);
  const max = Number(p.get('price_to')) || Infinity;
  const now = Date.now();
  let list = [...items.values()].filter((it) => !it.sold && now - it.createdAt > INDEX_LAG && it.price <= max
    && q.every((w) => `${it.title} ${it.brand}`.toLowerCase().includes(w)));
  if (p.get('order') === 'newest_first') list.sort((a, b) => b.id - a.id);
  else list.sort((a, b) => (a.id % 97) - (b.id % 97));
  return list.slice(0, 96);
}
function flight(obj) { return `0:["$","$L1",null,{}]\n5:["$","div",null,${JSON.stringify(obj)}]\n`; }
function htmlWithFlight(obj, body = '') {
  const f = flight(obj);
  const parts = [f.slice(0, 80), f.slice(80)];
  return `<!doctype html><html><head><meta charset="utf-8"><title>Vinted</title></head><body>${body}`
    + parts.map((x) => `<script>self.__next_f.push([1,${JSON.stringify(x)}])</script>`).join('') + '</body></html>';
}
const svg = (id) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400"><rect width="300" height="400" fill="hsl(${id % 360},40%,40%)"/><text x="150" y="200" fill="#fff" font-size="28" text-anchor="middle">${id % 100000}</text></svg>`;

function itemPage(it, host) {
  const sold = it.sold;
  const body = `<header><nav><a href="/help">Acheter</a></nav></header>
<main><h1>${esc(it.title)}</h1><div class="details"><p>${it.price.toFixed(2).replace('.', ',')} €</p>
<dl><dt>Ajouté</dt><dd>il y a ${Math.max(1, Math.round((Date.now() - it.createdAt + ADDED_OFFSET) / 60000))} minutes</dd></dl>
${sold ? '<div data-testid="item-status--sold">Vendu</div>' : `<button data-testid="buy-bundle-banner-shop-button">Créer un lot</button>
<button id="buy" data-testid="item-buy-button">Acheter</button>
<button data-testid="item-buyer-offer-button">Faire une offre</button>`}
<button data-testid="buyer-protection-info-learn-more-button">En savoir plus sur ta protection</button></div>
<h2>Dressing du membre</h2><div id="wardrobe"></div></main>
<footer><a href="/help/buy">Acheter</a></footer>
<script>
// « Hydratation » : le bouton ne réagit qu'au bout de 1,5 s.
setTimeout(function(){ var b=document.getElementById('buy'); if(b) b.addEventListener('click', function(){ location.href='/checkout?purchase_id=' + ${it.id}; }); }, 1500);
// La page charge le dressing du vendeur (piège pour l'apprentissage d'adresse).
fetch('/api/v2/wardrobe/${555000 + (it.id % 1000)}/items?page=1&per_page=20').then(r=>r.json()).then(d=>{document.getElementById('wardrobe').textContent=d.items.length+' articles';});
</script>`;
  const obj = { item: { id: it.id, title: it.title, price: { amount: String(it.price) }, is_closed: sold, is_reserved: false, item_closing_action: sold ? 'sold' : null, status: it.status, brand_title: it.brand } };
  return htmlWithFlight(obj, body);
}
function checkoutPage(it) {
  const fee = +(it.price * 0.05 + 0.7).toFixed(2), ship = 4.27, total = (it.price + fee + ship).toFixed(2).replace('.', ',');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Paiement</title></head><body><header><nav><a href="/">Vinted</a></nav></header>
<main><h2>Livraison</h2><label><input type="radio" name="ship" checked> Vinted Go — 4,27 €</label><label><input type="radio" name="ship"> Envoi à domicile — 20,89 €</label>
<h2>Prix</h2><div><span>Commande</span><span>${it.price.toFixed(2).replace('.', ',')} €</span></div><div><span>Frais Vinted</span><span>${String(fee).replace('.', ',')} €</span></div>
<div><span>Frais de port</span><span>4,27 €</span></div><div><span>Total à payer</span><span>${total} €</span></div>
<button id="pay">Payer</button><div id="msg"></div></main>
<script>document.getElementById('pay').onclick=function(){fetch('/__mock/paid?id=${it.id}');setTimeout(function(){document.getElementById('msg').textContent='Merci pour ton achat !';},800);};</script></body></html>`;
}

function send(res, code, type, body, headers = {}) { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...headers }); res.end(body); }

const key = process.env.MOCK_KEY || '/tmp/mock-vinted.key', cert = process.env.MOCK_CERT || '/tmp/mock-vinted.crt';
https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
  const host = req.headers.host || 'www.vinted.fr';
  const u = new URL(req.url, `https://${host}`);
  if (u.pathname.startsWith('/__mock/')) {
    if (u.pathname === '/__mock/ratelimit') { STATE.rateLimited = u.searchParams.get('on') === '1'; return send(res, 200, 'text/plain', 'ok'); }
    if (u.pathname === '/__mock/sell') { const it = items.get(Number(u.searchParams.get('id'))); if (it) it.sold = true; return send(res, 200, 'text/plain', it ? 'ok' : 'no'); }
    if (u.pathname === '/__mock/paid') { const it = items.get(Number(u.searchParams.get('id'))); if (it) { it.sold = true; it.soldPrice = it.price; it.paid = true; } return send(res, 200, 'text/plain', 'ok'); }
    if (u.pathname === '/__mock/state') return send(res, 200, 'application/json', JSON.stringify({ requests: STATE.requests.slice(-400), paid: [...items.values()].filter((i) => i.paid).map((i) => i.id), newest: Math.max(...items.keys()) }));
    if (u.pathname === '/__mock/fair') { const out = {}; for (const id of (u.searchParams.get('ids') || '').split(',')) { const it = items.get(Number(id)); if (it) out[id] = it.fair; } return send(res, 200, 'application/json', JSON.stringify(out)); }
    if (u.pathname === '/__mock/ages') { const out = {}; for (const id of (u.searchParams.get('ids') || '').split(',')) { const it = items.get(Number(id)); if (it) out[id] = +((Date.now() - it.createdAt + ADDED_OFFSET) / 60000).toFixed(1); } return send(res, 200, 'application/json', JSON.stringify(out)); }
    if (u.pathname === '/__mock/item') { const it = [...items.values()].find((i) => !i.sold && i.createdAt < Date.now() - 60000 && i.brand === (u.searchParams.get('brand') || 'Ralph Lauren')); return send(res, 200, 'application/json', JSON.stringify(it)); }
  }
  STATE.requests.push({ t: Date.now(), host, path: u.pathname, rsc: req.headers.rsc === '1', site: req.headers['sec-fetch-site'] || '', dest: req.headers['sec-fetch-dest'] || '' });
  if (u.pathname.startsWith('/__img/')) return send(res, 200, 'image/svg+xml', svg(parseInt((u.pathname.match(/\d{6,}/) || ['0'])[0], 10)));
  if (STATE.rateLimited) return send(res, 429, 'text/html', '<h1>You are rate limited</h1><p>access to this site is blocked for this computer, due to too many requests.</p>');

  if (host.startsWith('api.')) {
    // API « dressing » qui répond à n'importe quelle recherche avec la même liste (doit être rejetée).
    if (u.pathname === '/api/v2/catalog/items') {
      const wardrobe = [...items.values()].filter((i) => i.brand === 'Zara').slice(0, 20).map((i) => apiItem(i, host.replace(/^api\./, 'www.')));
      return send(res, 200, 'application/json', JSON.stringify({ items: wardrobe }));
    }
    return send(res, 404, 'application/json', '{"code":404}');
  }
  if (u.pathname === '/') return send(res, 200, 'text/html', '<html><body>Vinted</body></html>', { 'set-cookie': 'access_token_web=mock; Path=/; Secure; SameSite=Lax' });
  if (u.pathname === '/robots.txt') return send(res, 200, 'text/plain', 'User-agent: *\nDisallow: /api/\n');
  // Hypothèse : l'API de recherche ne répond qu'aux appels faits depuis une page Vinted (même origine, JSON).
  if (u.pathname === '/api/v2/catalog/items' && process.env.MOCK_TAB_API === '1' && req.headers['sec-fetch-site'] === 'same-origin' && /json/.test(req.headers.accept || '')) {
    return send(res, 200, 'application/json', JSON.stringify({ items: searchItems(u.searchParams).map((i) => apiItem(i, host)) }));
  }
  if (u.pathname === '/api/v2/catalog/items' || u.pathname.startsWith('/api/v2/items/')) return send(res, 404, 'text/html', '<html><body>La page n\'existe pas</body></html>');
  if (u.pathname.startsWith('/api/v2/wardrobe/')) {
    const list = [...items.values()].filter((i) => i.brand === 'Zara').slice(0, 20).map((i) => apiItem(i, host));
    return send(res, 200, 'application/json', JSON.stringify({ items: list }));
  }
  if (u.pathname === '/catalog') {
    // Hypothèse testée : les requêtes qui ne viennent PAS d'une page Vinted (extension) reçoivent
    // des résultats mis en cache (figés) ; celles d'une page Vinted (same-origin) sont fraîches.
    const staleMs = Number(process.env.MOCK_STALE_EXT || 0);
    let found;
    const staleRsc = process.env.MOCK_STALE_RSC === '1' && req.headers.rsc === '1'; // flux rapide figé, page fraîche
    if ((staleMs && req.headers['sec-fetch-site'] !== 'same-origin') || staleRsc) {
      const k = [...u.searchParams].filter(([k]) => k !== 'time').map((e) => e.join('=')).sort().join('&');
      const c = STALE.get(k);
      if (c && Date.now() - c.at < (staleMs || 1800000)) found = c.list; else { found = searchItems(u.searchParams); STALE.set(k, { at: Date.now(), list: found }); }
    } else found = searchItems(u.searchParams);
    const list = found.map((i) => apiItem(i, host));
    if (req.headers.rsc === '1') return send(res, 200, 'text/x-component', flight(process.env.MOCK_RSC_BROKEN === '1' ? { banners: [] } : { items: list }));
    return send(res, 200, 'text/html; charset=utf-8', htmlWithFlight({ items: list }, '<main>Catalogue</main>'));
  }
  const m = u.pathname.match(/^\/items\/(\d+)/);
  if (m) {
    const it = items.get(Number(m[1]));
    if (!it) return send(res, 404, 'text/html', 'not found');
    if (req.headers.rsc === '1') return send(res, 200, 'text/x-component', flight({ item: { id: it.id, title: it.title, price: { amount: String(it.soldPrice || it.price) }, is_closed: it.sold, item_closing_action: it.sold ? 'sold' : null, is_reserved: false } }));
    return send(res, 200, 'text/html; charset=utf-8', itemPage(it, host));
  }
  if (u.pathname === '/checkout') {
    const it = items.get(Number(u.searchParams.get('purchase_id')));
    return it ? send(res, 200, 'text/html; charset=utf-8', checkoutPage(it)) : send(res, 404, 'text/html', 'no');
  }
  return send(res, 404, 'text/html', '<html><body>404</body></html>');
}).listen(PORT, () => console.log(`mock vinted sur ${PORT} (ts=${WITH_TS ? 'oui' : 'non'})`));
