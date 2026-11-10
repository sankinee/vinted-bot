'use strict';
/* Affiche toute erreur à l'écran au lieu d'échouer en silence. */
window.addEventListener('error', (e) => showFatal(e.message));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason && (e.reason.message || e.reason)));
function showFatal(msg) {
  try { const t = document.getElementById('toast'); t.textContent = `Erreur : ${msg} — fais Ctrl+Maj+R ; si ça persiste, envoie une capture.`; t.hidden = false; } catch { /* rien */ }
}
/* Page et script de versions différentes (cache) : on recharge une fois sans cache. */
(() => {
  const want = document.querySelector('meta[name="flipdar-version"]');
  const page = want ? want.content : '';
  if (page !== '4.2' && !sessionStorage.getItem('flipdar-reloaded')) {
    try { sessionStorage.setItem('flipdar-reloaded', '1'); } catch { /* rien */ }
    location.replace(location.pathname + '?r=' + Date.now());
  }
})();
/* Flipdar — moniteur Vinted temps réel, base de prix vendus et achat automatique.
   Aucune dépendance : tout tourne dans le navigateur (GitHub Pages + extension Flipdar Bridge). */

const $ = (s, r = document) => r.querySelector(s);
const on = (sel, ev, fn) => { const e = document.querySelector(sel); if (e) e.addEventListener(ev, fn); else console.warn('Flipdar : élément manquant', sel); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get(k, d) { try { const v = localStorage.getItem('flipdar:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('flipdar:' + k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};

const DEFAULTS = {
  interval: 6, minGap: 2500, shipping: 3.5, maxShipping: 7, highlight: 25, checksPerMin: 2, webhook: '',
  sound: true, notify: false, demo: false, autobuy: false, dryRun: true, requireSold: false, freshMin: 120,
};
const APP_VERSION = '4.2';
const EXT_MIN = '4.2.0';
const MAX_FEED = 300;
const MIN_SAMPLES = 8;
const MIN_SOLD = 5;
const MAX_DB = 30000;
// Moments où l'on revérifie une annonce suivie (depuis sa première détection).
const CHECKS = [30, 120, 360, 720, 1440, 2880, 5760, 10080, 20160].map((m) => m * 60000);
// Coefficient de prix selon l'état de l'article.
const CONDITION = [
  [/neuf avec|new with tags|nuevo con|nuovo con|neu mit/i, 1.15],
  [/neuf sans|new without|nuevo sin|nuovo senza|neu ohne/i, 1.05],
  [/très bon|very good|muy bueno|ottime|sehr gut/i, 1.0],
  [/bon état|good|bueno|buone|gut/i, 0.85],
  [/satisfaisant|satisfactory|satisfactorio|discret|zufrieden/i, 0.65],
];
const STOP = new Set('les des une pour avec sans dans sur par taille homme femme enfant fille garcon mixte neuf neuve tres bon bonne etat porte portee jamais tbe the and for with size new very good men women kids unisex'.split(' '));

// Réglages : passage aux valeurs prudentes (anti-blocage) pour les anciennes installations.
function loadSettings() {
  const s = { ...DEFAULTS, ...store.get('settings', {}) };
  if (!s.rl42) { s.interval = Math.max(Number(s.interval) || 6, 6); s.minGap = Math.max(Number(s.minGap) || 2500, 2500); s.checksPerMin = Math.min(Number(s.checksPerMin) || 2, 2); s.rl42 = true; store.set('settings', s); }
  if (!s.age41) { if (!s.freshMin || s.freshMin <= 60) s.freshMin = 120; s.age41 = true; store.set('settings', s); }
  if (!s.est32) { s.requireSold = false; s.freshMin = s.freshMin || 10; s.est32 = true; store.set('settings', s); }
  if (!s.safe27) { s.interval = Math.max(s.interval, 6); s.minGap = Math.max(s.minGap, 1500); s.checksPerMin = Math.min(s.checksPerMin, 4); s.safe27 = true; store.set('settings', s); }
  return s;
}
const S = {
  settings: loadSettings(),
  filters: store.get('filters', []),
  rt: new Map(),
  items: new Map(),
  running: true,
  bridge: false,
  ext: null,          // config achat auto renvoyée par l'extension
  lastReq: 0,
  lastCheck: 0,
  view: 'all',
  monView: '',
  leader: false,     // un seul onglet Flipdar interroge Vinted
  cooldown: 0,       // pause imposée par Vinted (ms restantes, vue par l'extension)
  stats: { found: 0, reqTimes: [], lat: [] },
};

/* ================================================================== Bridge extension */
const Bridge = {
  pending: new Map(), seq: 0,
  init() {
    window.addEventListener('message', (e) => {
      if (e.source !== window || !e.data || e.data.ns !== 'flipdar') return;
      const d = e.data;
      if (d.dir === 'hello') { if (!S.bridge) { S.bridge = true; updateSource(); refreshExt(); } }
      else if (d.dir === 'res') { const p = this.pending.get(d.id); if (p) { this.pending.delete(d.id); p(d.res); } }
      else if (d.dir === 'event' && d.ev && d.ev.type === 'abProgress') abProgress(d.ev);
    });
    window.postMessage({ ns: 'flipdar', dir: 'ping' }, location.origin);
  },
  call(payload, timeout = 15000) {
    return new Promise((resolve) => {
      const id = ++this.seq;
      const t = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, status: 0, error: 'timeout' }); }, timeout);
      this.pending.set(id, (r) => { clearTimeout(t); resolve(r || { ok: false, status: 0 }); });
      window.postMessage({ ns: 'flipdar', dir: 'req', id, payload }, location.origin);
    });
  },
};

const Live = {
  search: (domain, query) => Bridge.call({ type: 'search', domain, query }),
  itemStatus: (domain, id, wantTs) => Bridge.call({ type: 'itemStatus', domain, id, wantTs: !!wantTs }),
  autobuy: (p) => Bridge.call({ type: 'autobuy', ...p }, 70000),
};

/* Données fictives : permet de tester toute l'interface sans extension. */
const Demo = {
  id: 5_000_000_000,
  brands: ['Nike', 'Ralph Lauren', 'Carhartt'],
  kinds: ['Pull', 'Veste', 'Sweat'],
  states: ['Neuf avec étiquette', 'Neuf sans étiquette', 'Très bon état', 'Bon état', 'Satisfaisant'],
  sizes: ['XS', 'S', 'M', 'L', 'XL', '42', '43'],
  async search(domain, query) {
    await sleep(80 + Math.random() * 120);
    const p = new URLSearchParams(query);
    const live = p.get('order') === 'newest_first';
    if (!this.pool) this.pool = Array.from({ length: 48 }, () => this.make(domain, Date.now() - Math.random() * 3.6e6));
    if (live) { const n = Math.random() < 0.45 ? 1 + (Math.random() * 2 | 0) : 0; for (let i = 0; i < n; i++) this.pool.unshift(this.make(domain, Date.now())); }
    this.pool.length = Math.min(this.pool.length, 200);
    return { ok: true, status: 200, ms: 120, items: this.pool.slice(0, live ? 48 : 96) };
  },
  async itemStatus(domain, id) {
    await sleep(60);
    const it = this.pool && this.pool.find((x) => x.id === id);
    const r = Math.random();
    if (r < 0.3) return { ok: true, state: 'sold', price: it ? Math.round(it.price * (0.8 + Math.random() * 0.25)) : 20 };
    if (r < 0.38) return { ok: true, state: 'gone', price: null };
    return { ok: true, state: 'live', price: it ? it.price : null };
  },
  async autobuy({ itemId, maxTotal, dryRun }) {
    const total = +(maxTotal - 2 - Math.random() * 3).toFixed(2), t0 = Date.now();
    const steps = [['item'], ['buy'], ['checkout'], ['delivery'], ['total', `Total vérifié : ${total.toFixed(2)} €`]].concat(dryRun ? [] : [['pay'], ['3ds']]);
    for (const [step, detail] of steps) { await sleep(250 + Math.random() * 350); abProgress({ itemId, step, detail, ms: Date.now() - t0 }); }
    return Math.random() < 0.15 ? { ok: false, status: 'unavailable', reason: 'Article vendu juste avant toi' }
      : { ok: true, status: dryRun ? 'dry' : 'bought', total, ms: 1300, reason: dryRun ? 'Simulation : tout est prêt, aucun paiement effectué' : '' };
  },
  make(domain, ts) {
    const pick = (a) => a[Math.random() * a.length | 0];
    const brand = pick(this.brands), kind = pick(this.kinds);
    const base = 18 + (brand.length * 3) % 40;
    const price = Math.max(3, Math.round(base * (0.35 + Math.random() * 1.1)));
    const id = ++this.id, hue = id * 47 % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,38%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},50%,18%)"/></linearGradient></defs><rect width="300" height="400" fill="url(#g)"/><text x="150" y="210" font-family="sans-serif" font-size="34" font-weight="700" fill="rgba(255,255,255,.85)" text-anchor="middle">${kind}</text></svg>`;
    return {
      id, title: `${kind} ${brand}`, price, currency: 'EUR', total: +(price * 1.05 + 0.7).toFixed(2), fee: +(price * 0.05 + 0.7).toFixed(2),
      brand, size: pick(this.sizes), status: pick(this.states), url: `https://www.${domain}/items/${id}`, user: 'demo_user',
      photo: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), ts, favs: Math.random() * 20 | 0, views: 0,
    };
  },
};

const source = () => (S.settings.demo ? Demo : S.bridge ? Live : null);

/* ================================================================== Texte / stats */
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const brandKey = (b) => norm(b).replace(/[^a-z0-9]/g, '');
function tokens(title, brand) {
  const bw = new Set(norm(brand).split(/[^a-z0-9]+/));
  return [...new Set(norm(title).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w) && !bw.has(w) && !/^\d+$/.test(w)))].slice(0, 8);
}
// Type d'article (multilingue) : un « maglione », un « sweater » et un « pull » sont comparables.
const TYPE_WORDS = {
  ensemble: 'ensemble survetement tracksuit tuta chandal trainingsanzug',
  doudoune: 'doudoune puffer piumino plumifero daunenjacke nuptse',
  sweat: 'sweat sweatshirt hoodie hoody felpa sudadera capuche',
  cardigan: 'cardigan gilet',
  pull: 'pull pullover sweater jumper maglione maglia jersey trui pulli strickpullover tricot knit',
  tshirt: 'tshirt teeshirt tee maglietta camiseta debardeur',
  polo: 'polo',
  chemise: 'chemise chemisier shirt camicia camisa hemd overhemd blouse',
  manteau: 'manteau coat cappotto abrigo mantel trench parka caban',
  veste: 'veste jacket giacca chaqueta jacke jas blouson bomber windbreaker softshell polaire fleece',
  jean: 'jean jeans denim vaquero vaqueros',
  pantalon: 'pantalon pants trousers pantaloni pantalones chino chinos cargo jogging jogger joggers legging leggings hose broek',
  short: 'short shorts bermuda',
  robe: 'robe dress vestito vestido kleid jurk',
  jupe: 'jupe skirt gonna falda rock rok',
  baskets: 'baskets basket sneakers sneaker trainers tennis runners requin airmax dunk af1',
  bottes: 'bottes bottines boots boot stivali botas stiefel chelsea rangers',
  chaussures: 'chaussures chaussure shoes scarpe zapatos schuhe mocassins mocassin derby derbies richelieu escarpins sandales sandals ballerines loafers',
  sac: 'sac bag borsa bolso tasche sacoche tote pochette banane cabas backpack',
  casquette: 'casquette cap cappello gorra bonnet beanie chapeau hat bob',
  echarpe: 'echarpe scarf sciarpa bufanda schal',
  ceinture: 'ceinture belt cintura cinturon',
  montre: 'montre watch orologio reloj uhr',
};
const TYPE_OF = new Map(); for (const [t, ws] of Object.entries(TYPE_WORDS)) for (const w of ws.split(' ')) if (!TYPE_OF.has(w)) TYPE_OF.set(w, t);
function itemType(title, brand) {
  const bw = new Set(norm(brand).split(/[^a-z0-9]+/));
  const t = norm(title).replace(/t[\s-]?shirt|tee[\s-]shirt/g, 'tshirt').replace(/sweat[\s-]shirt/g, 'sweatshirt').replace(/air[\s-]max/g, 'airmax').replace(/air[\s-]force/g, 'af1');
  for (const w of t.split(/[^a-z0-9]+/)) { if (bw.has(w) && w !== 'polo') continue; const ty = TYPE_OF.get(w); if (ty) return ty; }
  return '';
}
// Variantes d'une même marque (« Polo Ralph Lauren » = « Ralph Lauren »…).
const BRAND_ALIAS = [[/ralphlauren|poloralph/, 'ralphlauren'], [/northface/, 'thenorthface'], [/^levis/, 'levis'], [/tommyhilfiger|tommyjeans/, 'tommyhilfiger'], [/^nike/, 'nike'], [/^adidas/, 'adidas']];
const brandKeyOf = (b) => { const k = norm(b).replace(/[^a-z0-9]/g, ''); for (const [re, v] of BRAND_ALIAS) if (re.test(k)) return v; return k; };

const quantile = (sorted, q) => {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};
function robustStats(values) {
  const s = values.filter((p) => p > 0).sort((a, b) => a - b);
  if (s.length < 4) return { n: s.length, p25: quantile(s, 0.25), med: quantile(s, 0.5), p75: quantile(s, 0.75), sorted: s };
  const q1 = quantile(s, 0.25), q3 = quantile(s, 0.75), iqr = q3 - q1;
  const t = s.filter((p) => p >= q1 - 1.5 * iqr && p <= q3 + 1.5 * iqr);
  return { n: t.length, p25: quantile(t, 0.25), med: quantile(t, 0.5), p75: quantile(t, 0.75), sorted: t };
}
const condFactor = (status) => { for (const [re, k] of CONDITION) if (re.test(status || '')) return k; return 0.9; };
const buyerTotal = (i) => i.total ?? (i.fee != null ? i.price + i.fee : +(i.price * 1.05 + 0.7).toFixed(2));
const catOf = (f) => (f ? new URLSearchParams(f.params).get('catalog_ids[]') || '' : '');

/* ================================================================== Base des ventes
   Comme les outils pros : chaque annonce vue est suivie, puis sa page est revérifiée
   plus tard. Si elle est passée « vendue », on enregistre le prix de vente réel et le délai.
   Stockage local (IndexedDB) dans ton navigateur, exportable. */
const DB = {
  db: null, recs: new Map(), soldByBrand: new Map(), allByBrand: new Map(), dirty: new Set(), checks: { done: 0, sold: 0, gone: 0, live: 0, unknown: 0 },
  name: () => (S.settings.demo ? 'flipdar-demo' : 'flipdar'),
  async open() {
    await new Promise((res) => {
      let r;
      try { r = indexedDB.open(this.name(), 1); } catch { return res(); }
      r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath: 'id' });
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => res();
    });
    if (!this.db) return;
    await new Promise((res) => {
      const q = this.db.transaction('items').objectStore('items').getAll();
      q.onsuccess = () => { for (const x of q.result) this.put(x, false); res(); };
      q.onerror = () => res();
    });
  },
  put(x, dirty = true) {
    if (x.ty === undefined) { x.ty = itemType(x.t, x.b); x.bk = brandKeyOf(x.b); }
    if (!this.recs.has(x.id)) { let all = this.allByBrand.get(x.bk); if (!all) this.allByBrand.set(x.bk, (all = [])); all.push(x); }
    this.recs.set(x.id, x);
    if (x.state === 'sold') {
      let a = this.soldByBrand.get(x.bk);
      if (!a) this.soldByBrand.set(x.bk, (a = []));
      if (!a.includes(x)) a.push(x);
    }
    if (dirty) { this.dirty.add(x.id); clearTimeout(this.ft); this.ft = setTimeout(() => this.flush(), 1500); }
  },
  remove(x) {
    this.recs.delete(x.id); this.dirty.add(x.id);
    const all = this.allByBrand.get(x.bk); if (all) { const j = all.indexOf(x); if (j >= 0) all.splice(j, 1); }
    const a = this.soldByBrand.get(x.bk); if (a) { const i = a.indexOf(x); if (i >= 0) a.splice(i, 1); }
  },
  flush() {
    if (!this.db || !this.dirty.size) return;
    const st = this.db.transaction('items', 'readwrite').objectStore('items');
    for (const id of this.dirty) { const x = this.recs.get(id); x ? st.put(x) : st.delete(id); }
    this.dirty.clear();
  },
  track(item, f) {
    if (this.recs.has(item.id) || item.price == null) return;
    const now = Date.now();
    this.put({
      id: item.id, d: itemDomain(item), t: item.title, b: item.brand, bk: brandKeyOf(item.brand), ty: itemType(item.title, item.brand), tok: tokens(item.title, item.brand),
      sz: item.size, st: item.status, cat: catOf(f), p: item.price, ls: item.ts || now, fs: now, lc: now, k: 0,
      nc: now + CHECKS[0] * (S.settings.demo ? 1 / 300 : 1), state: 'live',
    });
    if (this.recs.size > MAX_DB) this.prune();
  },
  prune() {
    const rank = { gone: 0, expired: 1, live: 2, reserved: 2, sold: 3 };
    const all = [...this.recs.values()].sort((a, b) => rank[a.state] - rank[b.state] || a.fs - b.fs);
    for (const x of all.slice(0, this.recs.size - MAX_DB * 0.9)) this.remove(x);
    this.flush();
  },
  nextDue(now) {
    let best = null;
    for (const x of this.recs.values()) if ((x.state === 'live' || x.state === 'reserved') && x.nc <= now && (!best || x.nc < best.nc)) best = x;
    return best;
  },
  apply(x, res) {
    const now = Date.now(), scale = S.settings.demo ? 1 / 300 : 1;
    this.checks.done++; this.checks[res.ok ? res.state : 'unknown'] = (this.checks[res.ok ? res.state : 'unknown'] || 0) + 1;
    if (!res.ok || res.state === 'unknown') { x.nc = now + 3600000 * scale; this.put(x); return; }
    if (res.state === 'sold') {
      x.state = 'sold'; x.sp = res.price ?? x.p; x.sa = Math.round((x.lc + now) / 2);
    } else if (res.state === 'gone') {
      x.state = 'gone'; x.ga = now;
    } else {
      if (res.price != null) x.p = res.price;
      x.lc = now; x.k++;
      if (res.state === 'reserved') { x.state = 'reserved'; x.nc = now + 3600000 * scale; }
      else if (x.k >= CHECKS.length) x.state = 'expired';
      else { x.state = 'live'; x.nc = x.fs + CHECKS[x.k] * scale; }
    }
    this.put(x);
  },
  // Comparables : même marque ET même type d'article (pull, veste…) ; à défaut, mots du titre en commun.
  comps(item, f, limit = 60, index = this.soldByBrand) {
    const bk = brandKeyOf(item.brand), ty = itemType(item.title, item.brand), tok = new Set(tokens(item.title, item.brand)), cat = catOf(f);
    if (!bk) return [];
    const pool = index.get(bk) || [];
    const scored = [];
    for (const x of pool) {
      if (x.id === item.id) continue;
      let s;
      if (ty) { if (x.ty !== ty) continue; s = 1; }
      else { const shared = x.tok.filter((t) => tok.has(t)).length; if (!shared) continue; s = shared / Math.max(1, Math.min(tok.size, x.tok.length)); }
      if (cat && x.cat === cat) s += 0.2;
      if (x.sz && x.sz === item.size) s += 0.05;
      scored.push([s, x]);
    }
    scored.sort((a, b) => b[0] - a[0] || (b[1].sa || b[1].fs) - (a[1].sa || a[1].fs));
    return scored.slice(0, limit).map((e) => e[1]);
  },
  counts() {
    let sold = 0, live = 0;
    for (const x of this.recs.values()) { if (x.state === 'sold') sold++; else if (x.state === 'live' || x.state === 'reserved') live++; }
    return { sold, live, total: this.recs.size };
  },
};

/* ================================================================== Horloge Vinted
   Vinted ne fournit pas toujours la date de publication. Mais les numéros d'annonce augmentent
   avec le temps : en relevant régulièrement le numéro de la dernière annonce publiée sur tout Vinted,
   on connaît la vitesse (annonces / seconde) et donc l'âge de n'importe quelle annonce.
   Les vraies dates, quand Vinted en donne, servent à recaler l'horloge. */
const Clock = {
  samples: store.get(S.settings.demo ? 'clock-demo' : 'clock', []).filter((s) => Date.now() - s.t < 6 * 3600000),
  known: [],
  nextProbe: 0,
  _fit: undefined,
  addSample(id) {
    const now = Date.now();
    const last = this.samples[this.samples.length - 1];
    if (last && id < last.id) return; // numéro plus petit que le précédent : relevé incohérent
    this.samples.push({ t: now, id });
    this.samples = this.samples.filter((s) => now - s.t < 6 * 3600000).slice(-60);
    store.set(S.settings.demo ? 'clock-demo' : 'clock', this.samples);
    this._fit = undefined;
  },
  addKnown(id, ts) {
    if (!id || !ts) return;
    this.known = this.known.filter((p) => p.id !== id);
    this.known.push({ id, ts, at: Date.now() });
    if (this.known.length > 400) this.known.splice(0, this.known.length - 300);
    this._fit = undefined;
  },
  // Pente robuste (Theil-Sen) : médiane des pentes entre toutes les paires de relevés
  // → un relevé faussé (page Vinted en retard) ne déforme plus l'horloge.
  robust(pts, minDt) { // pts = [[temps, numéro]]
    const slopes = [];
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const dt = pts[j][0] - pts[i][0]; if (Math.abs(dt) >= minDt) slopes.push((pts[j][1] - pts[i][1]) / dt);
    }
    if (slopes.length < 2) return null;
    slopes.sort((x, y) => x - y);
    const rate = slopes[Math.floor(slopes.length / 2)];
    const b = pts.map(([t, id]) => id - rate * t).sort((x, y) => x - y)[Math.floor(pts.length / 2)];
    return { rate, b };
  },
  fit() {
    if (this._fit !== undefined) return this._fit;
    let f = null;
    const s = this.samples, now = Date.now();
    const known = this.known.filter((p) => now - p.at < 3 * 3600000);
    // 1) relevés de la dernière annonce Vinted sur au moins 4 minutes
    if (s.length >= 3 && s[s.length - 1].t - s[0].t >= 240000) f = this.robust(s.map((p) => [p.t, p.id]), 30000);
    // 2) sinon, dates lues sur les pages Vinted (« Ajouté il y a… »), sur au moins 30 minutes
    if (!f && known.length >= 6 && Math.max(...known.map((p) => p.ts)) - Math.min(...known.map((p) => p.ts)) > 30 * 60000) f = this.robust(known.map((p) => [p.ts, p.id]), 5 * 60000);
    if (f && !(f.rate > 0.0003 && f.rate < 0.5)) f = null; // entre 0,3 et 500 annonces / s : sinon incohérent
    if (f && known.length >= 2) {
      // Recalage sur ce qu'affiche Vinted : écart médian entre l'horloge et les dates réelles.
      const d = known.slice(-40).map((p) => p.ts - (p.id - f.b) / f.rate).sort((x, y) => x - y);
      f.offset = d[Math.floor(d.length / 2)];
      const dev = d.map((x) => Math.abs(x - f.offset)).sort((x, y) => x - y)[Math.floor(d.length / 2)];
      if (known.length >= 4 && dev > 15 * 60000) f = null; // l'horloge et Vinted ne concordent pas : on n'affiche rien plutôt que faux
    }
    this._fit = f;
    return f;
  },
  est(id) {
    const f = this.fit(); if (!f) return null;
    return Math.min(Date.now(), (id - f.b) / f.rate + (f.offset || 0));
  },
  ready() { return !!this.fit(); },
};

// Donne une date (réelle ou estimée) à chaque annonce.
function dateItems(items) {
  for (const i of items) {
    if (i.ts && !i.tsEst) Clock.addKnown(i.id, i.ts);
  }
  for (const i of items) {
    if (!i.ts) { const e = Clock.est(i.id); if (e) { i.ts = e; i.tsEst = true; } }
  }
}

/* ================================================================== Estimation
   Ordre : 1) ventes réelles relevées (même marque + même type), 2) annonces similaires vues
   (40e percentile : un prix auquel ça part vraiment), 3) sinon recherche automatique de comparables. */
const MIN_ASK = 6;
function confidence(n, st, sold) {
  const cv = st && st.med ? (st.p75 - st.p25) / st.med : 1;
  if (sold) return n >= 8 ? 'haute' : 'moyenne';
  if (n >= 15 && cv < 0.7) return 'haute';
  if (n >= 8) return 'moyenne';
  return 'faible';
}
function soldEstimate(item, f) {
  const comps = DB.comps(item, f, 40, DB.soldByBrand);
  if (comps.length < MIN_SOLD) return { n: comps.length, comps };
  // Prix ramenés à un état « très bon » puis réajustés à l'état de l'article.
  const st = robustStats(comps.map((x) => x.sp / condFactor(x.st)));
  const days = robustStats(comps.map((x) => (x.sa - x.ls) / 86400000).filter((d) => d > 0));
  return { n: st.n, base: st.med, p25: st.p25, p75: st.p75, days: days.med, comps, conf: confidence(st.n, st, true) };
}
function askEstimate(item, f) {
  const comps = DB.comps(item, f, 80, DB.allByBrand).filter((x) => x.state !== 'sold');
  if (comps.length < MIN_ASK) return { n: comps.length, comps };
  const st = robustStats(comps.map((x) => x.p / condFactor(x.st)));
  return { n: st.n, base: quantile(st.sorted, 0.4), p25: st.p25, p75: st.p75, comps, conf: confidence(st.n, st, false) };
}

function analyse(item, f) {
  const se = soldEstimate(item, f);
  let est, src;
  if (se.base) { est = se; src = 'sold'; }
  else { const ae = askEstimate(item, f); if (ae.base) { est = ae; src = 'ask'; } }
  if (!est) { Comps.want(item, f); return null; } // pas assez de comparables : on va en chercher
  if (src === 'ask' && est.conf === 'faible') Comps.want(item, f);
  const resale = Math.max(1, Math.round(est.base * condFactor(item.status)));
  const cost = buyerTotal(item) + Number(S.settings.shipping || 0);
  return { resale, profit: resale - cost, deal: Math.round((1 - item.price / resale) * 100), src, n: est.n, conf: est.conf, days: se.days };
}

/* Recherche automatique de comparables (« Ralph Lauren pull »…) : une requête au plus toutes les
   15 s, dans les temps morts, et chaque recherche est gardée 12 h. */
const Comps = {
  queue: [], next: 0,
  done: (() => { const d = store.get('compsDone', {}); const now = Date.now(); for (const k of Object.keys(d)) if (now - d[k] > 12 * 3600000) delete d[k]; return d; })(),
  keyOf(item, f) { return [f ? f.domain : itemDomain(item), brandKeyOf(item.brand), itemType(item.title, item.brand) || tokens(item.title, item.brand)[0] || '', catOf(f)].join('|'); },
  want(item, f) {
    if (!item.brand) return;
    const key = this.keyOf(item, f);
    if (this.done[key] || this.queue.some((q) => q.key === key)) return;
    const ty = itemType(item.title, item.brand);
    const word = ty ? (norm(item.title).split(/[^a-z0-9]+/).find((w) => TYPE_OF.get(w) === ty) || ty) : (tokens(item.title, item.brand)[0] || '');
    this.queue.push({ key, f, domain: f ? f.domain : itemDomain(item), text: `${item.brand} ${word}`.trim(), cat: catOf(f) });
    if (this.queue.length > 30) this.queue.shift();
  },
  async run(src) {
    const job = this.queue.shift(); if (!job) return;
    this.done[job.key] = Date.now(); store.set('compsDone', this.done);
    const p = new URLSearchParams({ search_text: job.text, order: 'relevance', per_page: '96', page: '1' });
    if (job.cat) p.append('catalog_ids[]', job.cat);
    let res; try { res = await src.search(job.domain, p.toString()); } catch { res = { ok: false }; }
    S.stats.reqTimes.push(Date.now());
    if (!res.ok) { delete this.done[job.key]; return; }
    dateItems(res.items || []);
    for (const i of res.items || []) DB.track(i, job.f);
    refreshEstimates(job.key);
  },
};
// Recalcule les estimations des cartes concernées (et relance l'achat auto pour les annonces récentes).
function refreshEstimates(key) {
  const win = Math.max(1, Number(S.settings.freshMin) || 120) * 60000;
  for (const rec of S.items.values()) {
    const f = S.filters.find((x) => x.id === rec.filterId);
    if (key && Comps.keyOf(rec.item, f) !== key) continue;
    rec.a = analyse(rec.item, f); paintEst(rec);
    if (rec.isNew && !rec.abTried && f && (!rec.item.ts || Date.now() - rec.item.ts < win) && abCheck(rec, f)) { rec.abTried = true; abEnqueue(rec, f); }
  }
}

function statsFor(f) {
  if (!f) return null;
  const r = rt(f);
  if (r.prices.length < MIN_SAMPLES) return null;
  if (!r.cache || r.cacheN !== r.prices.length) { r.cache = robustStats(r.prices); r.cacheN = r.prices.length; }
  return r.cache;
}

function learnPrices(r, items) {
  for (const i of items) {
    if (i.price == null || r.priceIds.has(i.id)) continue;
    r.priceIds.add(i.id); r.prices.push(i.price);
  }
  if (r.prices.length > 400) r.prices.splice(0, r.prices.length - 400);
  if (r.priceIds.size > 4000) r.priceIds = new Set([...r.priceIds].slice(-2000));
}

/* ================================================================== Moniteurs */
const STRIP = new Set(['page', 'time', 'search_id', 'order', 'per_page', 'search_by_image_uuid', 'disabled_personalization']);
function parseVintedUrl(raw) {
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  if (!/^vinted\.[a-z.]+$/.test(host)) return null;
  const p = new URLSearchParams();
  for (const [k, v] of u.searchParams) if (!STRIP.has(k) && v !== '') p.append(k, v);
  const m = u.pathname.match(/\/catalog\/(\d+)/);
  if (m && !p.has('catalog[]') && !p.has('catalog_ids[]')) p.append('catalog_ids[]', m[1]);
  for (const [from, to] of [['catalog[]', 'catalog_ids[]'], ['brand_id[]', 'brand_ids[]'], ['size_id[]', 'size_ids[]'], ['status[]', 'status_ids[]'], ['color[]', 'color_ids[]'], ['material[]', 'material_ids[]']]) {
    const vals = p.getAll(from);
    if (vals.length) { p.delete(from); vals.forEach((v) => p.append(to, v)); }
  }
  return { domain: host, params: p.toString(), name: p.get('search_text') || '' };
}

function addFilter({ name, domain, params }) {
  const f = { id: Math.random().toString(36).slice(2, 10), name: name || 'Recherche', domain, params, enabled: true, ab: { on: false } };
  S.filters.push(f);
  saveFilters();
  renderMonitors();
  return f;
}
const saveFilters = () => store.set('filters', S.filters.map(({ id, name, domain, params, enabled, ab }) => ({ id, name, domain, params, enabled, ab })));

function rt(f) {
  let r = S.rt.get(f.id);
  if (!r) { r = { seeded: false, maxId: 0, nextAt: 0, busy: false, backoff: 0, prices: [], priceIds: new Set(), found: 0, err: '' }; S.rt.set(f.id, r); }
  return r;
}

/* ================================================================== Ordonnanceur
   Une seule file pour toutes les requêtes : écart minimum global (anti-ban), jitter ±20 %,
   backoff automatique sur 429/403. Les vérifications de ventes passent dans les temps morts. */
async function scheduler() {
  for (;;) {
    const src = source();
    if (!S.running || !src || !S.leader || (S.cooldown > 0 && !S.settings.demo)) { await sleep(250); continue; }
    const now = Date.now();
    const gapLeft = S.lastReq + S.settings.minGap - now;
    let next = null;
    for (const f of S.filters) { if (!f.enabled) continue; const r = rt(f); if (!r.busy && (!next || r.nextAt < rt(next).nextAt)) next = f; }
    const monWait = next ? rt(next).nextAt - now : Infinity;

    if (gapLeft <= 0 && monWait <= 0) { S.lastReq = now; poll(next, src); continue; }
    // Tâches de fond (comparables, horloge, suivi des ventes) : seulement avec les requêtes qui restent
    // une fois les recherches servies, et pas dans les 5 min qui suivent une pause imposée par Vinted.
    const recent = S.stats.reqTimes.filter((t) => now - t < 60000).length;
    const extras = S.settings.demo || (recent < (S.extCap || 15) - 3 && now > (S.calmUntil || 0));
    // Recherche de comparables pour les estimations (1 / min au plus).
    if (extras && gapLeft <= 0 && Comps.queue.length && now >= Comps.next && monWait > S.settings.minGap) {
      S.lastReq = now; Comps.next = now + (S.settings.demo ? 15000 : 60000); Comps.run(src); continue;
    }
    // Relevé de l'horloge Vinted (dernière annonce publiée sur tout le site), dans les temps morts.
    if (extras && gapLeft <= 0 && now >= Clock.nextProbe && monWait > S.settings.minGap && S.filters.some((f) => f.enabled)) {
      S.lastReq = now; Clock.nextProbe = now + (Clock.ready() ? 180000 : 40000); probeClock(src); continue;
    }
    // Temps mort : vérifie une annonce suivie (vendue ?) si le prochain moniteur n'est pas imminent.
    const perMin = Number(S.settings.checksPerMin) || 0;
    if (extras && gapLeft <= 0 && perMin > 0 && monWait > S.settings.minGap && now - S.lastCheck >= 60000 / perMin) {
      const x = DB.nextDue(now);
      if (x) { S.lastReq = S.lastCheck = now; checkItem(x, src); continue; }
      S.lastCheck = now - 60000 / perMin + 2000; // rien à vérifier : réessaie dans 2 s
    }
    await sleep(Math.max(15, Math.min(Math.max(gapLeft, monWait), 200)));
  }
}

async function probeClock(src) {
  const f = S.filters.find((x) => x.enabled);
  let res;
  try { res = await src.search(f ? f.domain : 'vinted.fr', 'order=newest_first&per_page=48&page=1'); } catch { res = { ok: false }; }
  S.stats.reqTimes.push(Date.now());
  if (!res.ok || !res.items || !res.items.length) return;
  for (const i of res.items) if (i.ts) Clock.addKnown(i.id, i.ts);
  Clock.addSample(Math.max(...res.items.map((i) => i.id)));
  // Recalage : lit « Ajouté il y a… » sur la page d'une annonce (souvent au début, puis toutes les ~10 min).
  Clock.probes = (Clock.probes || 0) + 1;
  if (src.itemStatus && (Clock.known.length < 4 ? Clock.probes % 2 === 1 : Clock.probes % 10 === 0)) {
    const ids = res.items.map((i) => i.id).sort((x, y) => y - x);
    const pick = ids[(Clock.probes % 3) * Math.floor(ids.length / 3)] || ids[0];
    Clock.calib = (async () => {
      await sleep(Math.max(0, S.lastReq + S.settings.minGap - Date.now()));
      S.lastReq = Date.now();
      const st = await src.itemStatus(f ? f.domain : 'vinted.fr', pick, true).catch(() => null);
      S.stats.reqTimes.push(Date.now());
      if (st && st.ok && st.ts) Clock.addKnown(pick, st.ts);
    })();
    await Clock.calib;
  }
  // Les annonces déjà affichées sans date en reçoivent une dès que l'horloge est prête.
  for (const rec of S.items.values()) {
    if (!rec.item.ts || rec.item.tsEst) {
      const e = Clock.est(rec.item.id);
      const ag = rec.el.querySelector('.age');
      const pub = rec.el.querySelector('.pub');
      if (e) { rec.item.ts = e; rec.item.tsEst = true; ag.dataset.ts = e; ag.dataset.est = '1'; if (pub) { pub.dataset.ts = e; pub.dataset.est = '1'; } }
      else if (rec.item.tsEst) { rec.item.ts = null; ag.dataset.ts = ''; if (pub) pub.dataset.ts = ''; } // horloge peu fiable : on retire l'âge
      paintAge(ag);
    }
  }
}

async function checkItem(x, src) {
  x.nc = Date.now() + 60000; // évite une double vérification pendant la requête
  let res;
  try { res = await src.itemStatus(x.d, x.id); } catch (e) { res = { ok: false, status: 0 }; }
  S.stats.reqTimes.push(Date.now());
  if (!res.ok && (res.status === 429 || res.status === 403)) { S.lastCheck = Date.now() + 120000; x.nc = Date.now() + 600000; return; }
  if (res.ok && res.ts) Clock.addKnown(x.id, res.ts);
  DB.apply(x, res);
}

function query(f) {
  const p = new URLSearchParams(f.params);
  p.set('order', 'newest_first'); p.set('per_page', '48'); p.set('page', '1');
  return p.toString();
}

async function poll(f, src) {
  const r = rt(f);
  r.busy = true;
  const t0 = performance.now();
  let res;
  try { res = await src.search(f.domain, query(f)); } catch (e) { res = { ok: false, status: 0, error: String(e) }; }
  const ms = performance.now() - t0;
  r.busy = false;
  S.stats.reqTimes.push(Date.now());
  if (!S.filters.includes(f)) return;

  if (!res.ok) {
    const limited = res.status === 429 || res.status === 403;
    if (res.status === 429 && res.retryAfter > 60) { S.cooldown = res.retryAfter * 1000; S.cooldownAt = Date.now(); }
    r.backoff = Math.min(Math.max(r.backoff * 2, limited ? 15000 : 3000), 180000);
    if (res.retryAfter) r.backoff = Math.max(r.backoff, res.retryAfter * 1000);
    r.err = res.captcha ? 'Vérification anti-robot Vinted : ouvre vinted.fr dans un onglet et valide-la'
      : limited ? `Limité par Vinted (${res.status}), pause ${Math.round(r.backoff / 1000)} s`
      : res.status === 401 ? 'Non connecté à Vinted' : res.error === 'reload' ? 'Extension rechargée : recharge la page' : `Erreur ${[res.status || '', res.error || ''].join(' ').trim()}`;
    r.nextAt = Date.now() + r.backoff;
    return;
  }
  r.backoff = 0; r.err = ''; r.via = res.via || '';
  S.stats.lat.push(res.ms || ms); if (S.stats.lat.length > 30) S.stats.lat.shift();

  const items = res.items || [];
  dateItems(items);
  learnPrices(r, items);
  for (const i of items) DB.track(i, f);
  if (!r.seeded) {
    r.seeded = true;
    r.maxId = items.reduce((m, i) => Math.max(m, i.id), 0);
    items.slice(0, 12).reverse().forEach((i) => addItem(i, f, false));
  } else {
    // Les IDs Vinted sont croissants : ID > max = vraie nouvelle annonce (ignore remontées et boosts).
    // « Nouveau » seulement si publié récemment : une annonce indexée en retard par Vinted
    // s'affiche (grisée) mais ne déclenche ni alerte ni achat auto.
    const fresh = items.filter((i) => i.id > r.maxId).sort((a, b) => a.id - b.id);
    // Nouvelle = vient d'apparaître dans la recherche (numéro plus grand que tout ce qu'on a vu).
    // Vinted peut indexer une annonce avec du retard : on ne l'écarte que si elle est vraiment
    // ancienne (remise en ligne…), au-delà du réglage « freshMin » (2 h par défaut).
    const win = Math.max(1, Number(S.settings.freshMin) || 120) * 60000;
    if (fresh.length) { r.maxId = fresh[fresh.length - 1].id; fresh.forEach((i) => addItem(i, f, !i.ts || Date.now() - i.ts < win)); }
  }
  // Retard de Vinted : âge de l'annonce la plus récente renvoyée.
  const newest = items.reduce((m, i) => Math.max(m, i.ts || 0), 0);
  r.lag = newest ? Date.now() - newest : 0;
  r.nextAt = Date.now() + Math.max(1, S.settings.interval) * 1000 * (0.8 + Math.random() * 0.4);
}

/* ================================================================== Achat automatique */
const AB = { queue: [], busy: false, log: store.get(S.settings.demo ? 'ablog-demo' : 'ablog', []) };
const AB_LABEL = {
  run: ['En cours…', 'run'], dry: ['Simulation OK', 'ok'], bought: ['Acheté ✓', 'ok'], action: ['Action requise', 'warn'],
  unavailable: ['Indisponible', 'bad'], too_expensive: ['Trop cher', 'bad'], refused: ['Refusé', 'bad'], busy: ['Occupé', 'warn'], error: ['Erreur', 'bad'],
};

function abCheck(rec, f) {
  const r = f.ab, { item, a } = rec;
  if (!S.settings.autobuy || !r || !r.on) return null; // (le bouton ⚡ manuel ne passe pas par ces règles)
  if (!(r.maxPrice > 0) || item.price > r.maxPrice) return null;
  if (S.settings.requireSold && (!a || a.src !== 'sold')) return null;
  if (!a || a.conf === 'faible') return null; // jamais d'achat auto sur une estimation peu fiable
  if (r.minProfit != null && r.minProfit !== '' && (!a || a.profit < Number(r.minProfit))) return null;
  if (r.minDeal && (!a || a.deal < Number(r.minDeal))) return null;
  if (item.ts && Date.now() - item.ts > Math.max(1, Number(S.settings.freshMin) || 120) * 60000) return null; // annonce trop ancienne (remise en ligne…)
  return true;
}

function abEnqueue(rec, f, manual = false) {
  if (AB.queue.some((q) => q.rec === rec) || (AB.busy && AB.current === rec)) return;
  if (AB.queue.length >= 3) return manual && toast('3 achats déjà en attente.');
  if (manual) AB.queue.unshift({ rec, f, manual }); else AB.queue.push({ rec, f });
  abRun();
}

async function abRun() {
  if (AB.busy || !AB.queue.length) return;
  AB.busy = true;
  const { rec, f, manual } = AB.queue.shift();
  AB.current = rec;
  const { item } = rec;
  const entry = { ts: Date.now(), id: item.id, title: item.title, price: item.price, url: item.url, monitor: manual ? '⚡ manuel' : f.name, status: 'run', dry: S.settings.dryRun };
  AB.log.unshift(entry); AB.log.length = Math.min(AB.log.length, 60);
  renderAbLog();
  abPanelStart(item, S.settings.dryRun);
  const src = source();
  const maxTotal = +(buyerTotal(item) + Number(S.settings.maxShipping || 0)).toFixed(2);
  const res = src ? await src.autobuy({ domain: itemDomain(item), itemId: item.id, maxTotal, dryRun: S.settings.dryRun, humanDelay: true, screenW: screen.availWidth + (screen.availLeft || 0), screenH: screen.availHeight + (screen.availTop || 0) })
    : { ok: false, status: 'error', reason: 'Extension non connectée' };
  Object.assign(entry, { status: res.status || 'error', reason: res.reason || res.error || '', total: res.total, ms: res.ms });
  store.set(S.settings.demo ? 'ablog-demo' : 'ablog', AB.log);
  renderAbLog();
  abPanelEnd(entry);
  if (res.status === 'bought') { rec.el.classList.add('bought'); beep(true); beep(true, 0.15); }
  toast(`${AB_LABEL[entry.status]?.[0] || entry.status} · ${item.title}${entry.reason ? ' — ' + entry.reason : ''}`);
  AB.busy = false; AB.current = null;
  if (res.status === 'refused') AB.queue.length = 0;
  abRun();
}

/* Fenêtre de progression d'un achat (façon « checkout en direct ») */
const AB_STEPS = [
  ['open', "Ouverture de l'article"], ['buy', 'Acheter'], ['checkout', 'Récapitulatif'], ['delivery', 'Adresse et livraison'],
  ['total', 'Total vérifié'], ['pay', 'Paiement'], ['3ds', '3-D Secure'], ['done', 'Confirmé'],
];
const STEP_ALIAS = { item: 'open' };
let abp = null;
function abPanelStart(item, dry) {
  abp = { id: item.id, idx: -1, t0: Date.now(), dry };
  $('#abpTitle').textContent = dry ? 'Simulation d’achat' : 'Achat en cours';
  $('#abpImg').src = safeUrl(item.photo);
  $('#abpName').textContent = item.title;
  $('#abpPrice').textContent = `${eur(item.price)} · ${eur(buyerTotal(item))} TTC`;
  $('#abpSteps').replaceChildren(...AB_STEPS.filter(([k]) => !(dry && (k === 'pay' || k === '3ds'))).map(([k, l]) => { const li = el('li', '', l); li.dataset.k = k; return li; }));
  const m = $('#abpMsg'); m.textContent = ''; m.className = 'abp-msg';
  $('#abpFocus').hidden = S.settings.demo;
  $('#abPanel').hidden = false;
  abProgress({ itemId: item.id, step: 'open', ms: 0 });
}
function abProgress(ev) {
  if (!abp || ev.itemId !== abp.id) return;
  const k = STEP_ALIAS[ev.step] || ev.step;
  const lis = [...$('#abpSteps').children];
  const i = lis.findIndex((li) => li.dataset.k === k);
  if (i < 0) return;
  // Étape reçue = atteinte. Le 3-D Secure reste « en cours » tant que la banque n'a pas validé.
  lis.forEach((li, j) => { li.classList.toggle('done', j < i || (j === i && k !== '3ds')); li.classList.remove('cur'); });
  const next = lis.find((li) => !li.classList.contains('done')); if (next) next.classList.add('cur');
  const li = lis[i];
  if (ev.detail && k === 'total') li.firstChild.textContent = ev.detail;
  let s = li.querySelector('small'); if (!s) { s = el('small'); li.append(s); }
  s.textContent = `${((ev.ms || 0) / 1000).toFixed(1)} s`;
  if (k === '3ds') { const m = $('#abpMsg'); m.textContent = '🔐 Valide le paiement sur ton appli bancaire…'; m.className = 'abp-msg warn'; }
}
function abPanelEnd(entry) {
  if (!abp || entry.id !== abp.id) return;
  const lis = [...$('#abpSteps').children];
  const ok = entry.status === 'bought' || entry.status === 'dry';
  lis.forEach((li) => li.classList.remove('cur'));
  if (ok) lis.forEach((li) => li.classList.add('done'));
  else { const cur = lis.find((li) => !li.classList.contains('done')); if (cur) cur.classList.add('fail'); }
  const [label, cls] = AB_LABEL[entry.status] || [entry.status, 'warn'];
  const m = $('#abpMsg');
  m.textContent = `${label}${entry.total ? ` · ${eur(entry.total)}` : ''}${entry.ms ? ` en ${(entry.ms / 1000).toFixed(1)} s` : ''}${entry.reason ? ' — ' + entry.reason : ''}`;
  m.className = 'abp-msg ' + cls;
  $('#abpFocus').hidden = S.settings.demo || entry.status !== 'action';
  abp = null;
}
on('#abpClose', 'click', () => { $('#abPanel').hidden = true; });
on('#abpFocus', 'click', () => Bridge.call({ type: 'abFocus' }, 3000));

function renderAbLog() {
  const ul = $('#abLog');
  ul.replaceChildren(...AB.log.slice(0, 30).map((e) => {
    const li = el('li');
    const t = el('div', 't');
    const a = el('b'); const link = el('a', '', e.title); link.href = safeUrl(e.url); link.target = '_blank'; link.rel = 'noopener'; a.append(link);
    const [label, cls] = AB_LABEL[e.status] || [e.status, 'warn'];
    t.append(a, el('span', 'st ' + cls, label));
    const time = new Date(e.ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    li.append(t, el('div', 'r', `${time} · ${eur(e.price)}${e.total ? ` (total ${eur(e.total)})` : ''}${e.ms ? ` · ${(e.ms / 1000).toFixed(1)} s` : ''}${e.reason ? ' · ' + e.reason : ''}`));
    return li;
  }));
}

async function refreshExt() {
  if (S.settings.demo) S.ext = { enabled: true, trusted: true };
  else if (S.bridge) { const r = await Bridge.call({ type: 'abConfig' }, 3000); S.ext = r && r.ok ? r : null; }
  if (S.bridge) {
    const v = await Bridge.call({ type: 'version' }, 3000);
    if (v && v.ok) { if (S.cooldown && !v.cooldown) S.calmUntil = Date.now() + 5 * 60000; S.cooldown = v.cooldown || 0; S.cooldownAt = Date.now(); S.captcha = !!v.captcha; S.extCap = v.cap || 15; }
  }
  if (S.bridge && !S.extVersion) {
    const v = await Bridge.call({ type: 'version' }, 3000);
    S.extVersion = (v && v.version) || '?';
    const old = S.extVersion.localeCompare(EXT_MIN, undefined, { numeric: true }) < 0;
    const e = $('#ver'); e.textContent = `site ${APP_VERSION} · ext ${S.extVersion}${old ? ' (à mettre à jour)' : ''}`; e.classList.toggle('old', old);
    if (old) toast(`Extension ${S.extVersion} trop ancienne : retélécharge flipdar-extension.zip (≥ ${EXT_MIN}).`);
  }
  renderAbState();
}

function renderAbState() {
  const st = $('#abState'), info = $('#abExt');
  const on = S.settings.autobuy;
  st.className = 'ab-state' + (on ? (S.settings.dryRun ? ' dry' : ' on') : '');
  st.querySelector('b').textContent = on ? (S.settings.dryRun ? 'SIMULATION' : 'ON') : 'OFF';
  const e = S.ext;
  let msg = 'Règles par moniteur : bouton ⚡ dans la liste.';
  if (!S.settings.demo) {
    if (!e) msg += ' Extension non détectée.';
    else if (!e.enabled) msg += " ⚠ Achat auto désactivé dans l'extension (popup).";
    else if (!e.trusted) msg += " ⚠ Ce site n'est pas autorisé : ouvre le popup de l'extension ici et clique « Autoriser ce site ».";
    else msg += ` Extension : ${e.count}/${e.maxPerDay} achats, ${eur(e.spent)} / ${eur(e.dailyBudget, 0)} aujourd'hui, max ${eur(e.maxPerItem, 0)}/article.`;
  }
  info.textContent = msg;
}

/* ================================================================== Rendu */
const eur = (v, d = 2) => Number.isFinite(v) ? v.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: d, maximumFractionDigits: d }) : '–';
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
const safeUrl = (u) => (/^(https:\/\/|data:image\/svg\+xml)/.test(u || '') ? u : '');
// Ouvre l'article ; l'extension clique « Acheter » toute seule pour arriver directement au paiement.
const buyUrl = (domain, id) => `https://www.${domain}/items/${id}#flipdar-buy`;
function itemDomain(i) { try { return new URL(i.url).hostname.replace(/^www\./, ''); } catch { return 'vinted.fr'; } }

const tpl = $('#cardTpl').content.firstElementChild;
const feed = $('#feed');

function addItem(item, f, isNew) {
  if (S.items.has(item.id)) return;
  const rec = { item, filterId: f.id, isNew, seenAt: Date.now(), a: analyse(item, f) };
  const c = tpl.cloneNode(true);
  rec.el = c;
  c.dataset.id = item.id;
  c.dataset.f = f.id;
  if (isNew) c.classList.add('new', 'fresh');
  c.querySelector('.thumb').href = safeUrl(item.url);
  const img = c.querySelector('img');
  img.src = safeUrl(item.photo);
  if (isNew) img.loading = 'eager';
  c.querySelector('.age').dataset.ts = item.ts || '';
  if (item.tsEst) c.querySelector('.age').dataset.est = '1';
  c.querySelector('.price').textContent = eur(item.price);
  c.querySelector('.total').textContent = `${eur(buyerTotal(item))} TTC`;
  const t = c.querySelector('.title'); t.textContent = item.title; t.title = item.title;
  c.querySelector('.meta').textContent = [item.brand, item.size, item.status].filter(Boolean).join(' · ');
  // Badge : pour une nouvelle annonce, depuis quand elle est apparue dans la recherche ;
  // la date de publication Vinted (« ajouté il y a… ») est affichée à part.
  if (isNew) { const ag = c.querySelector('.age'); ag.dataset.seen = String(rec.seenAt); }
  const pub = el('div', 'pub'); pub.dataset.ts = item.ts || ''; if (item.tsEst) pub.dataset.est = '1';
  c.querySelector('.meta').after(pub);
  if (S.monView && S.monView !== f.id) c.classList.add('hidden');
  paintEst(rec);
  S.items.set(item.id, rec);
  feed.prepend(c);
  paintAge(c.querySelector('.age'));
  while (S.items.size > MAX_FEED) { const [oldId, old] = S.items.entries().next().value; old.el.remove(); S.items.delete(oldId); }
  $('#empty').hidden = true;

  if (isNew) {
    S.stats.found++; rt(f).found++;
    // Délai entre la publication et l'apparition dans la recherche (mesure du retard de Vinted).
    if (item.ts) { const r = rt(f); (r.delays ||= []).push(rec.seenAt - item.ts); if (r.delays.length > 30) r.delays.shift(); }
    if (abCheck(rec, f)) { rec.abTried = true; abEnqueue(rec, f); }
    alertNew(rec, f);
  }
}

function paintEst(rec) {
  const { a, el: c } = rec, e = c.querySelector('.est'), b = c.querySelector('.badge');
  e.replaceChildren(); b.textContent = '';
  c.classList.remove('deal');
  if (!a) { e.textContent = 'Estimation : recherche de comparables…'; e.title = ''; return; }
  const dot = el('i', `conf ${a.conf || 'faible'}`);
  e.title = `Confiance ${a.conf} — ${a.src === 'sold' ? `${a.n} ventes réelles` : `${a.n} annonces similaires (même marque et même type)`}`;
  e.append(dot, `Revente ~${eur(a.resale, 0)} · `, el('span', a.profit >= 0 ? 'p' : 'm', (a.profit >= 0 ? '+' : '') + eur(a.profit, 0)),
    el('span', 'src', a.src === 'sold' ? ` · ${a.n} vendus` : ` · ${a.n} similaires`));
  // « Bonne affaire » seulement si l'estimation est assez fiable.
  if (a.deal >= S.settings.highlight && a.profit > 0 && a.conf !== 'faible') { c.classList.add('deal'); b.textContent = `-${a.deal} %`; }
}

const fmtAge = (ms) => { const s = Math.max(0, ms / 1000); return s < 60 ? `${s | 0} s` : s < 3600 ? `${(s / 60) | 0} min` : s < 86400 ? `${(s / 3600) | 0} h` : `${(s / 86400) | 0} j`; };
function paintAge(e) {
  const now = Date.now();
  if (e.dataset.seen) { // nouvelle annonce : temps écoulé depuis son apparition dans la recherche
    e.textContent = `vu ${fmtAge(now - Number(e.dataset.seen))}`;
    e.title = 'Apparue dans la recherche Vinted il y a ' + fmtAge(now - Number(e.dataset.seen));
  } else if (!e.dataset.ts) { e.textContent = 'date…'; e.title = 'Âge en cours de calcul (horloge Vinted en calibrage, ~5 min la 1re fois)'; }
  else {
    e.title = e.dataset.est ? 'Âge estimé (horloge Vinted)' : 'Date de publication';
    e.textContent = (e.dataset.est ? '~' : '') + fmtAge(now - Number(e.dataset.ts));
  }
  const pub = e.closest('.card') && e.closest('.card').querySelector('.pub');
  if (pub) pub.textContent = pub.dataset.ts ? `ajouté il y a ${pub.dataset.est ? '~' : ''}${fmtAge(now - Number(pub.dataset.ts))}` : '';
}

const extAtLeast = (v) => !!S.extVersion && S.extVersion.localeCompare(v, undefined, { numeric: true }) >= 0;

// ⚡ Acheter : achat complet en arrière-plan (fenêtre Vinted cachée), suivi dans la fenêtre de progression.
// Affiche tout de suite la fenêtre d'achat avec un message (jamais de clic « sans effet »).
function abPanelNote(item, msg, cls = 'warn') {
  abPanelStart(item, S.settings.dryRun);
  abp = null;
  [...$('#abpSteps').children].forEach((li) => li.classList.remove('cur', 'done'));
  const m = $('#abpMsg'); m.textContent = msg; m.className = 'abp-msg ' + cls;
}

async function buy(id) {
  const rec = S.items.get(id); if (!rec) return;
  const { item } = rec;
  const f = S.filters.find((x) => x.id === rec.filterId) || { name: 'Achat manuel' };
  if (S.settings.demo) return abEnqueue(rec, f, true);
  if (!S.bridge) return abPanelNote(item, "Extension Flipdar Bridge non connectée : installe-la ou recharge la page.", 'bad');
  if (!extAtLeast('2.8.0')) return abPanelNote(item, `Extension ${S.extVersion || '?'} trop ancienne : mets-la à jour (${EXT_MIN}).`, 'bad');
  if (AB.busy || AB.queue.length) {
    abEnqueue(rec, f, true);
    return toast(`Achat ajouté à la file (${AB.queue.length} en attente).`);
  }
  abPanelNote(item, 'Préparation de l’achat…', 'run');
  await refreshExt();
  if (S.ext && S.ext.enabled && S.ext.trusted) return abEnqueue(rec, f, true);
  // Première fois : l'extension ouvre sa fenêtre « Autoriser Flipdar à acheter ? », puis l'achat part tout seul.
  await Bridge.call({ type: 'requestTrust' }, 5000);
  abPanelNote(item, S.ext && S.ext.trusted && !S.ext.enabled
    ? 'Achat désactivé dans l’extension : clique « Autoriser et activer l’achat » dans la fenêtre qui s’ouvre.'
    : 'Autorise Flipdar dans la fenêtre de l’extension : l’achat démarrera tout seul.', 'warn');
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    await refreshExt();
    if (S.ext && S.ext.enabled && S.ext.trusted) return abEnqueue(rec, f, true);
  }
  abPanelNote(item, 'Achat annulé : Flipdar n’a pas été autorisé dans l’extension.', 'bad');
}

async function deepEstimate(id) {
  const rec = S.items.get(id); if (!rec) return;
  const { item } = rec;
  const f = S.filters.find((x) => x.id === rec.filterId);
  const dlg = $('#estDlg'), body = $('#estBody');
  $('#estTitle').textContent = item.title;
  body.innerHTML = '<p class="note">Analyse des ventes et des annonces comparables…</p>';
  dlg.showModal();

  const src = source();
  let ask = null;
  if (src) {
    // Même recherche ciblée que l'estimation automatique (marque + type d'article).
    const key = Comps.keyOf(item, f);
    delete Comps.done[key]; Comps.queue = Comps.queue.filter((q) => q.key !== key);
    Comps.want(item, f);
    const job = Comps.queue.find((q) => q.key === key);
    if (job) {
      Comps.queue = Comps.queue.filter((q) => q !== job); Comps.queue.unshift(job);
      const before = new Set(DB.recs.keys());
      await Comps.run(src);
      const got = [...DB.recs.values()].filter((x) => !before.has(x.id) || x.cat === job.cat).filter((x) => x.bk === brandKeyOf(item.brand));
      ask = robustStats(got.map((x) => x.p));
    }
  }
  if (!dlg.open) return;
  rec.a = analyse(item, f); paintEst(rec);
  const se = soldEstimate(item, f), ae = askEstimate(item, f), a = rec.a;

  body.replaceChildren();
  const kpis = el('div', 'kpis');
  const k = (label, val, cls) => { const d = el('div', 'kpi'); d.append(el('span', '', label), el('b', cls || '', val)); kpis.append(d); };
  k('Prix payé (total)', eur(buyerTotal(item)));
  k('Revente conseillée', a ? eur(a.resale) : '–');
  k('Profit estimé', a ? (a.profit >= 0 ? '+' : '') + eur(a.profit) : '–', a && a.profit >= 0 ? 'p' : 'm');
  k('Médiane VENDUE', se.base ? eur(se.base * condFactor(item.status)) : `${se.n}/${MIN_SOLD} ventes`);
  k('Délai de vente', Number.isFinite(se.days) ? `${se.days < 1 ? '< 1' : Math.round(se.days)} j` : '–');
  k(`Prix réaliste (${ae.n} similaires)`, ae.base ? eur(ae.base * condFactor(item.status)) : '–');
  k('Confiance', a ? a.conf : '–', a && a.conf === 'haute' ? 'p' : a && a.conf === 'faible' ? 'm' : '');
  body.append(kpis);

  if (ask && ask.n >= 4) {
    const s = ask.sorted, lo = s[0], hi = s[s.length - 1], B = 16, w = (hi - lo) / B || 1;
    const bins = new Array(B).fill(0); s.forEach((v) => bins[Math.min(B - 1, Math.floor((v - lo) / w))]++);
    const max = Math.max(...bins), meBin = Math.min(B - 1, Math.max(0, Math.floor((item.price - lo) / w)));
    const hist = el('div', 'hist');
    bins.forEach((c, i) => { const b = el('div', i === meBin ? 'me' : ''); b.style.height = `${(c / max) * 100}%`; b.title = `${eur(lo + i * w, 0)} – ${eur(lo + (i + 1) * w, 0)} : ${c}`; hist.append(b); });
    const axis = el('div', 'axis'); axis.append(el('span', '', eur(lo, 0)), el('span', '', eur(hi, 0)));
    body.append(el('div', 'section-t', `Prix des annonces en ligne (${ask.n})`), hist, axis);
  }
  if (se.comps.length) {
    const ul = el('ul', 'comps');
    for (const x of se.comps.slice(0, 8)) {
      const li = el('li'); const d = (x.sa - x.ls) / 86400000;
      li.append(el('span', '', `${x.t} · ${x.st || ''}`), el('span', '', `${eur(x.sp, 0)} · ${d < 1 ? '< 1' : Math.round(d)} j`));
      ul.append(li);
    }
    body.append(el('div', 'section-t', `Articles similaires vendus (${se.comps.length})`), ul);
  } else if (ae.comps.length) {
    const ul = el('ul', 'comps');
    for (const x of ae.comps.slice(0, 8)) { const li = el('li'); li.append(el('span', '', `${x.t} · ${x.st || ''}`), el('span', '', eur(x.p, 0))); ul.append(li); }
    body.append(el('div', 'section-t', `Annonces les plus proches (${ae.comps.length})`), ul);
  }
  body.append(el('p', 'note',
    (a && a.src === 'sold'
      ? `Estimation basée sur ${a.n} ventes réelles relevées par Flipdar (prix final constaté sur la page de l'article vendu). `
      : a && a.src === 'ask'
        ? `Pas encore assez de ventes relevées (${se.n}/${MIN_SOLD}) : estimation à partir de ${a.n} annonces similaires (même marque et même type), au prix sous lequel se trouvent 40 % d'entre elles (prix réaliste pour vendre vite). Les ventes réelles prendront le relais. `
        : `Peu d'annonces similaires : estimation à partir de toute la recherche. `) +
    `Ajustée à l'état (${condFactor(item.status)}). Coût = total acheteur + ${eur(S.settings.shipping)} d'envoi.`));
}

/* Alertes */
let audioCtx;
function beep(deal, delay = 0) {
  try {
    audioCtx ||= new AudioContext();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime + delay;
    o.frequency.value = deal ? 1320 : 880; o.type = 'triangle';
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.15, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.2);
  } catch { /* audio indisponible */ }
}

function alertNew(rec, f) {
  const { item, a } = rec;
  const isDeal = !!(a && a.deal >= S.settings.highlight && a.profit > 0);
  if (S.settings.sound) beep(isDeal);
  if (S.settings.notify && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
    const n = new Notification(`${eur(item.price)} · ${item.title}`, { body: `${f.name}${a ? ` · revente ~${eur(a.resale, 0)}` : ''}`, icon: safeUrl(item.photo) || undefined, tag: String(item.id) });
    n.onclick = () => { window.focus(); buy(item.id); n.close(); };
  }
  if (isDeal && /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(S.settings.webhook) && !S.settings.demo) {
    fetch(S.settings.webhook, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [{
        title: `${eur(item.price)} · ${item.title}`.slice(0, 250), url: item.url, color: 0x00c2a8,
        description: `**${f.name}** · ${[item.brand, item.size, item.status].filter(Boolean).join(' · ')}\nRevente ~${eur(a.resale, 0)} (${a.src === 'sold' ? `${a.n} ventes` : 'annonces'}) · profit ${eur(a.profit, 0)} · -${a.deal} %\n[⚡ Acheter](${buyUrl(itemDomain(item), item.id)})`,
        thumbnail: item.photo.startsWith('https') ? { url: item.photo } : undefined,
      }] }),
    }).catch(() => {});
  }
}

/* Panneau moniteurs */
function renderMonitors() {
  const ul = $('#monitors');
  ul.replaceChildren();
  for (const f of S.filters) {
    f.ab ||= { on: false };
    const li = el('li', 'mon' + (f.enabled ? '' : ' off'));
    li.dataset.id = f.id;
    const h = el('div', 'h');
    const sw = el('input', 'switch'); sw.type = 'checkbox'; sw.checked = f.enabled; sw.dataset.act = 'toggle'; sw.title = 'Activer / désactiver';
    const n = el('span', 'n', f.name); n.title = `${f.domain} · ${decodeURIComponent(f.params)}`;
    const ab = el('button', f.ab.on ? 'ab-on' : '', '⚡'); ab.dataset.act = 'ab'; ab.title = f.ab.on ? `Achat auto ≤ ${f.ab.maxPrice} €` : 'Règles d’achat auto';
    const open = el('button', '', '↗'); open.dataset.act = 'open'; open.title = 'Ouvrir la recherche sur Vinted';
    const del = el('button', '', '✕'); del.dataset.act = 'del'; del.title = 'Supprimer';
    h.append(sw, n, ab, open, del);
    li.append(h, el('div', 's'));
    ul.append(li);
    renderMonitorStatus(f);
  }
  $('#monCount').textContent = S.filters.length;
  const sel = $('#monFilter'), cur = sel.value;
  sel.replaceChildren(new Option('Tous les moniteurs', ''), ...S.filters.map((f) => new Option(f.name, f.id)));
  sel.value = S.filters.some((f) => f.id === cur) ? cur : '';
}

function renderMonitorStatus(f) {
  const s = document.querySelector(`.mon[data-id="${f.id}"] .s`); if (!s) return;
  const r = rt(f), st = statsFor(f);
  s.replaceChildren(el('span', '', f.domain.replace('vinted.', '').toUpperCase()), el('span', '', `${r.found} trouvés`),
    el('span', '', st ? `médiane ${eur(st.med, 0)}` : `${r.prices.length}/${MIN_SAMPLES} prix`));
  if (f.ab && f.ab.on) s.append(el('span', '', `⚡ ≤ ${f.ab.maxPrice} €`));
  if (r.via) s.append(el('span', '', { page: 'via page', rsc: 'via flux rapide', api: 'via API' }[r.via] || r.via));
  if (r.delays && r.delays.length >= 3) {
    const d = [...r.delays].sort((x, y) => x - y)[Math.floor(r.delays.length / 2)];
    s.append(el('span', d > 5 * 60000 ? 'err' : '', `Vinted affiche les annonces ~${fmtAge(d)} après publication`));
  } else if (r.lag > 3 * 60000 && !r.err) s.append(el('span', 'err', `dernière annonce : il y a ${Math.round(r.lag / 60000)} min`));
  if (r.err) s.append(el('span', 'err', r.err));
}

let ruleFilter = null;
function openRules(f) {
  ruleFilter = f;
  const fm = $('#ruleForm');
  $('#ruleTitle').textContent = `Achat auto · ${f.name}`;
  fm.elements.on.checked = !!f.ab.on;
  fm.elements.maxPrice.value = f.ab.maxPrice ?? '';
  fm.elements.minProfit.value = f.ab.minProfit ?? 5;
  fm.elements.minDeal.value = f.ab.minDeal ?? 30;
  $('#ruleDlg').showModal();
}
on('#ruleDlg', 'close', () => {
  if ($('#ruleDlg').returnValue !== 'save' || !ruleFilter) return;
  const e = $('#ruleForm').elements;
  ruleFilter.ab = {
    on: e.on.checked, maxPrice: Number(e.maxPrice.value) || 0,
    minProfit: e.minProfit.value === '' ? null : Number(e.minProfit.value), minDeal: Number(e.minDeal.value) || 0,
  };
  if (ruleFilter.ab.on && !ruleFilter.ab.maxPrice) { ruleFilter.ab.on = false; toast('Indique un prix max pour activer l’achat auto.'); }
  saveFilters(); renderMonitors();
});

function updateSource() {
  const dot = $('#dot'), lbl = $('#srcLabel');
  dot.className = 'dot' + (S.settings.demo ? ' demo' : S.bridge ? ' on' : '');
  lbl.textContent = S.settings.demo ? 'Démo' : S.bridge ? 'Connecté' : 'Extension absente';
  $('#help').hidden = S.bridge && !S.settings.demo;
}

/* ================================================================== Événements */
on('#addForm', 'submit', (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  let spec;
  const url = String(fd.get('url') || '').trim();
  if (url) { spec = parseVintedUrl(url); if (!spec) return toast('Lien Vinted invalide.'); }
  else {
    const q = String(fd.get('q') || '').trim();
    if (!q) return toast('Colle un lien ou saisis des mots-clés.');
    const p = new URLSearchParams({ search_text: q });
    if (fd.get('min')) p.set('price_from', fd.get('min'));
    if (fd.get('max')) p.set('price_to', fd.get('max'));
    spec = { domain: String(fd.get('domain')), params: p.toString(), name: q };
  }
  spec.name = String(fd.get('name') || '').trim() || spec.name || 'Recherche';
  addFilter(spec);
  e.target.reset();
  toast(`Moniteur « ${spec.name} » ajouté.`);
});

on('#monitors', 'click', (e) => {
  const act = e.target.dataset.act; if (!act) return;
  const f = S.filters.find((x) => x.id === e.target.closest('.mon').dataset.id); if (!f) return;
  if (act === 'toggle') { f.enabled = e.target.checked; e.target.closest('.mon').classList.toggle('off', !f.enabled); if (f.enabled) rt(f).nextAt = 0; saveFilters(); }
  if (act === 'del') { S.filters = S.filters.filter((x) => x !== f); S.rt.delete(f.id); saveFilters(); renderMonitors(); }
  if (act === 'ab') openRules(f);
  if (act === 'open') window.open(`https://www.${f.domain}/catalog?${new URLSearchParams(f.params)}&order=newest_first`, '_blank', 'noopener');
});

feed.addEventListener('click', (e) => {
  const card = e.target.closest('.card'); if (!card) return;
  const id = Number(card.dataset.id);
  if (e.target.closest('.buy')) buy(id);
  else if (e.target.closest('.estBtn')) deepEstimate(id);
});

on('#view', 'click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.view = b.dataset.v;
  for (const x of $('#view').children) x.classList.toggle('on', x === b);
  feed.className = 'feed' + (S.view === 'all' ? '' : ` v-${S.view}`);
});

on('#monFilter', 'change', (e) => {
  S.monView = e.target.value;
  for (const { el: c } of S.items.values()) c.classList.toggle('hidden', !!S.monView && c.dataset.f !== S.monView);
});

function setRunning(v) {
  S.running = v;
  $('#runBtn').textContent = v ? '⏸ Pause' : '▶ Reprendre';
  document.body.classList.toggle('paused', !v);
}
on('#runBtn', 'click', () => setRunning(!S.running));
on('#clearBtn', 'click', () => { for (const { el: c } of S.items.values()) c.remove(); S.items.clear(); $('#empty').hidden = false; });

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
  if (e.code === 'Space') { e.preventDefault(); setRunning(!S.running); }
  if (e.key === 'b' || e.key === 'B') { const first = [...feed.children].find((c) => c.offsetParent !== null); if (first) buy(Number(first.dataset.id)); }
});

// Réglages (deux formulaires partagent le même objet settings)
for (const form of [$('#settings'), $('#abForm')]) {
  for (const [k, v] of Object.entries(S.settings)) { const i = form.elements[k]; if (i) i.type === 'checkbox' ? (i.checked = v) : (i.value = v); }
  form.addEventListener('change', async (e) => {
    const i = e.target, k = i.name;
    if (k === 'autobuy' && i.checked && !S.settings.dryRun && !confirm('Activer l’achat automatique RÉEL ? Des paiements seront effectués sans confirmation.')) { i.checked = false; return; }
    if (k === 'dryRun' && !i.checked && S.settings.autobuy && !confirm('Désactiver la simulation ? Les achats auto deviendront réels.')) { i.checked = true; return; }
    S.settings[k] = i.type === 'checkbox' ? i.checked : i.type === 'number' ? Math.max(Number(i.min) || 0, i.value === '' ? DEFAULTS[k] : Number(i.value)) : i.value.trim();
    if (k === 'notify' && i.checked && 'Notification' in window && Notification.permission !== 'granted') {
      if ((await Notification.requestPermission()) !== 'granted') { S.settings.notify = i.checked = false; toast('Notifications refusées par le navigateur.'); }
    }
    store.set('settings', S.settings);
    if (k === 'demo') { DB.flush(); location.reload(); return; }
    if (k === 'highlight' || k === 'shipping') for (const rec of S.items.values()) { rec.a = analyse(rec.item, S.filters.find((f) => f.id === rec.filterId)); paintEst(rec); }
    renderAbState();
  });
}

// Diagnostic : tout ce qu'il faut pour comprendre un problème (sans cookies ni données personnelles).
on('#diagExport', 'click', async () => {
  const ext = S.bridge ? await Bridge.call({ type: 'debug' }, 5000) : null;
  const { webhook, ...settings } = S.settings;
  const now = Date.now();
  const data = {
    v: APP_VERSION, at: new Date().toISOString(), ext, settings,
    monitors: S.filters.map((f) => { const r = rt(f); return { name: f.name, domain: f.domain, params: f.params, enabled: f.enabled, ab: f.ab, via: r.via, err: r.err, lagMin: r.lag ? +(r.lag / 60000).toFixed(1) : null, prices: r.prices.length, found: r.found, median: (statsFor(f) || {}).med }; }),
    feed: [...S.items.values()].slice(-40).map(({ item, isNew, seenAt, a }) => ({
      id: item.id, title: item.title, price: item.price, total: item.total, brand: item.brand, size: item.size, status: item.status,
      publishedMinAgo: item.ts ? +((now - item.ts) / 60000).toFixed(1) : null, seenMinAgo: +((now - seenAt) / 60000).toFixed(1), isNew,
      est: a && { src: a.src, n: a.n, resale: a.resale, profit: +a.profit.toFixed(2), deal: a.deal },
    })),
    db: { ...DB.counts(), checks: DB.checks },
    autobuyLog: AB.log.slice(0, 10).map(({ title, status, reason, total, ms }) => ({ title, status, reason, total, ms })),
  };
  const el2 = el('a'); el2.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  el2.download = `flipdar-diagnostic-${new Date().toISOString().slice(0, 16).replace(':', 'h')}.json`; el2.click();
  setTimeout(() => URL.revokeObjectURL(el2.href), 1000);
  toast('Diagnostic téléchargé : envoie ce fichier à Claude.');
});

// Base de ventes : export / import
on('#dbExport', 'click', () => {
  const data = JSON.stringify({ v: 1, exported: new Date().toISOString(), items: [...DB.recs.values()] });
  const a = el('a'); a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = `flipdar-ventes-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
on('#dbImport', 'change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const { items } = JSON.parse(await file.text());
    let n = 0;
    for (const x of items || []) {
      if (!x || typeof x.id !== 'number' || !Array.isArray(x.tok)) continue;
      const cur = DB.recs.get(x.id);
      if (!cur || (x.state === 'sold' && cur.state !== 'sold')) { DB.put(x); n++; }
    }
    DB.flush(); toast(`${n} articles importés.`);
  } catch { toast('Fichier invalide.'); }
  e.target.value = '';
});

let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3200); }

// Rafraîchissement de l'affichage (1×/s) et de l'état de l'extension (toutes les 20 s).
let tick = 0;
setInterval(() => {
  const now = Date.now();
  S.stats.reqTimes = S.stats.reqTimes.filter((t) => now - t < 60000);
  $('#rpm').textContent = S.stats.reqTimes.length;
  const l = S.stats.lat; $('#lat').textContent = l.length ? `${Math.round(l.reduce((a, b) => a + b, 0) / l.length)} ms` : '–';
  $('#found').textContent = S.stats.found;
  document.querySelectorAll('.card:not(.hidden) .age').forEach(paintAge);
  for (const f of S.filters) renderMonitorStatus(f);
  if (tick++ % 5 === 0) {
    const c = DB.counts();
    $('#soldN').textContent = c.sold; $('#trackN').textContent = c.live;
    const k = DB.checks;
    $('#dbInfo').textContent = `${c.total} annonces connues (servent aux estimations), ${c.sold} ventes réelles, ${c.live} en suivi. Vérifications cette session : ${k.done} (vendues ${k.sold || 0}, supprimées ${k.gone || 0}, en ligne ${k.live || 0}, illisibles ${k.unknown || 0}). Exporte la base de temps en temps.`;
  }
  if (tick % 20 === 0) refreshExt();
  renderCooldown();
}, 1000);
addEventListener('beforeunload', () => DB.flush());

/* Un seul onglet actif : les autres onglets Flipdar restent en attente (sinon les requêtes se cumulent). */
function acquireLeader() {
  if (!navigator.locks) { S.leader = true; return; }
  navigator.locks.request('flipdar-leader', { ifAvailable: true }, (lock) => {
    if (lock) { S.leader = true; renderCooldown(); return new Promise(() => {}); } // garde le verrou tant que l'onglet est ouvert
    S.leader = false; renderCooldown();
    toast('Flipdar est déjà ouvert dans un autre onglet : celui-ci reste en attente.');
    // prendra le relais quand l'autre onglet sera fermé
    navigator.locks.request('flipdar-leader', () => { S.leader = true; renderCooldown(); toast('Cet onglet prend le relais.'); return new Promise(() => {}); });
  });
}

function renderCooldown() {
  const lbl = $('#srcLabel'); if (!lbl || S.settings.demo) return;
  const left = S.cooldown ? S.cooldown - (Date.now() - (S.cooldownAt || 0)) : 0;
  if (S.captcha) { lbl.textContent = 'Vérification Vinted : ouvre vinted.fr'; $('#dot').className = 'dot demo'; }
  else if (left > 0) { lbl.textContent = `Pause Vinted ${Math.ceil(left / 60000)} min`; $('#dot').className = 'dot demo'; }
  else if (!S.leader) { lbl.textContent = 'En attente (autre onglet actif)'; $('#dot').className = 'dot demo'; }
  else if (S.bridge) { if (S.cooldown) S.cooldown = 0; lbl.textContent = 'Connecté'; $('#dot').className = 'dot on'; }
}

/* ================================================================== Démarrage */
(async () => {
  Bridge.init();
  renderMonitors();
  updateSource();
  renderAbLog();
  renderAbState();
  await DB.open();
  acquireLeader();
  setTimeout(() => { if (!S.bridge && !S.settings.demo) toast('Extension Flipdar Bridge non détectée : installe-la ou active le mode démo.'); }, 1500);
  scheduler();
})();
