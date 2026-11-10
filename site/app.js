'use strict';
/* Flipdar — moniteur Vinted temps réel, base de prix vendus et achat automatique.
   Aucune dépendance : tout tourne dans le navigateur (GitHub Pages + extension Flipdar Bridge). */

const $ = (s, r = document) => r.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get(k, d) { try { const v = localStorage.getItem('flipdar:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('flipdar:' + k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};

const DEFAULTS = {
  interval: 4, minGap: 600, shipping: 3.5, maxShipping: 7, highlight: 25, checksPerMin: 12, webhook: '',
  sound: true, notify: false, demo: false, autobuy: false, dryRun: true, requireSold: true,
};
const APP_VERSION = '2.3';
const EXT_MIN = '2.3.0';
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

const S = {
  settings: { ...DEFAULTS, ...store.get('settings', {}) },
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
  itemStatus: (domain, id) => Bridge.call({ type: 'itemStatus', domain, id }),
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
  async autobuy({ maxTotal, dryRun }) {
    await sleep(900 + Math.random() * 700);
    const total = +(maxTotal - 2 - Math.random() * 3).toFixed(2);
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
  db: null, recs: new Map(), soldByBrand: new Map(), dirty: new Set(),
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
      id: item.id, d: itemDomain(item), t: item.title, b: item.brand, bk: brandKey(item.brand), tok: tokens(item.title, item.brand),
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
  // Articles vendus comparables : même marque + mots du titre en commun (+ bonus taille / catégorie).
  comps(item, f, limit = 40) {
    const bk = brandKey(item.brand), tok = new Set(tokens(item.title, item.brand)), cat = catOf(f);
    const pool = bk ? this.soldByBrand.get(bk) || [] : [...this.soldByBrand.values()].flat();
    const scored = [];
    for (const x of pool) {
      if (x.id === item.id) continue;
      const shared = x.tok.filter((t) => tok.has(t)).length;
      if (!bk && shared < 2) continue;
      let s = tok.size ? shared / Math.min(tok.size, Math.max(1, x.tok.length)) : 0.5;
      if (cat && x.cat === cat) s += 0.3;
      if (x.sz && x.sz === item.size) s += 0.1;
      if (s >= 0.34) scored.push([s, x]);
    }
    scored.sort((a, b) => b[0] - a[0] || b[1].sa - a[1].sa);
    return scored.slice(0, limit).map((e) => e[1]);
  },
  counts() {
    let sold = 0, live = 0;
    for (const x of this.recs.values()) { if (x.state === 'sold') sold++; else if (x.state === 'live' || x.state === 'reserved') live++; }
    return { sold, live, total: this.recs.size };
  },
};

/* ================================================================== Estimation */
function soldEstimate(item, f) {
  const comps = DB.comps(item, f);
  if (comps.length < MIN_SOLD) return { n: comps.length, comps };
  // Prix ramenés à un état « très bon » puis réajustés à l'état de l'article.
  const st = robustStats(comps.map((x) => x.sp / condFactor(x.st)));
  const days = robustStats(comps.map((x) => (x.sa - x.ls) / 86400000).filter((d) => d > 0));
  return { n: st.n, base: st.med, p25: st.p25, p75: st.p75, days: days.med, comps };
}

function analyse(item, f) {
  const se = soldEstimate(item, f);
  let base, src, n;
  if (se.base) { base = se.base * condFactor(item.status); src = 'sold'; n = se.n; }
  else {
    const st = statsFor(f);
    if (!st) return null;
    base = st.med * 0.9; src = 'ask'; n = st.n; // prix demandés > prix vendus
  }
  const resale = Math.max(1, Math.round(base));
  const cost = buyerTotal(item) + Number(S.settings.shipping || 0);
  return { resale, profit: resale - cost, deal: Math.round((1 - item.price / resale) * 100), src, n, days: se.days };
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
    if (!S.running || !src) { await sleep(250); continue; }
    const now = Date.now();
    const gapLeft = S.lastReq + S.settings.minGap - now;
    let next = null;
    for (const f of S.filters) { if (!f.enabled) continue; const r = rt(f); if (!r.busy && (!next || r.nextAt < rt(next).nextAt)) next = f; }
    const monWait = next ? rt(next).nextAt - now : Infinity;

    if (gapLeft <= 0 && monWait <= 0) { S.lastReq = now; poll(next, src); continue; }
    // Temps mort : vérifie une annonce suivie (vendue ?) si le prochain moniteur n'est pas imminent.
    const perMin = Number(S.settings.checksPerMin) || 0;
    if (gapLeft <= 0 && perMin > 0 && monWait > S.settings.minGap && now - S.lastCheck >= 60000 / perMin) {
      const x = DB.nextDue(now);
      if (x) { S.lastReq = S.lastCheck = now; checkItem(x, src); continue; }
      S.lastCheck = now - 60000 / perMin + 2000; // rien à vérifier : réessaie dans 2 s
    }
    await sleep(Math.max(15, Math.min(Math.max(gapLeft, monWait), 200)));
  }
}

async function checkItem(x, src) {
  x.nc = Date.now() + 60000; // évite une double vérification pendant la requête
  let res;
  try { res = await src.itemStatus(x.d, x.id); } catch (e) { res = { ok: false, status: 0 }; }
  S.stats.reqTimes.push(Date.now());
  if (!res.ok && (res.status === 429 || res.status === 403)) { S.lastCheck = Date.now() + 120000; x.nc = Date.now() + 600000; return; }
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
    r.backoff = Math.min(Math.max(r.backoff * 2, limited ? 15000 : 3000), 180000);
    if (res.retryAfter) r.backoff = Math.max(r.backoff, res.retryAfter * 1000);
    r.err = limited ? `Limité par Vinted (${res.status}), pause ${Math.round(r.backoff / 1000)} s`
      : res.status === 401 ? 'Non connecté à Vinted' : res.error === 'reload' ? 'Extension rechargée : recharge la page' : `Erreur ${[res.status || '', res.error || ''].join(' ').trim()}`;
    r.nextAt = Date.now() + r.backoff;
    return;
  }
  r.backoff = 0; r.err = ''; r.via = res.via || '';
  S.stats.lat.push(res.ms || ms); if (S.stats.lat.length > 30) S.stats.lat.shift();

  const items = res.items || [];
  learnPrices(r, items);
  for (const i of items) DB.track(i, f);
  if (!r.seeded) {
    r.seeded = true;
    r.maxId = items.reduce((m, i) => Math.max(m, i.id), 0);
    items.slice(0, 12).reverse().forEach((i) => addItem(i, f, false));
  } else {
    // Les IDs Vinted sont croissants : ID > max = vraie nouvelle annonce (ignore remontées et boosts).
    const fresh = items.filter((i) => i.id > r.maxId).sort((a, b) => a.id - b.id);
    if (fresh.length) { r.maxId = fresh[fresh.length - 1].id; fresh.forEach((i) => addItem(i, f, true)); }
  }
  r.nextAt = Date.now() + Math.max(1, S.settings.interval) * 1000 * (0.8 + Math.random() * 0.4);
}

/* ================================================================== Achat automatique */
const AB = { queue: [], busy: false, log: store.get(S.settings.demo ? 'ablog-demo' : 'ablog', []) };
const AB_LABEL = {
  run: ['En cours…', 'run'], dry: ['Simulation OK', 'ok'], bought: ['Acheté ✓', 'ok'], action: ['Action requise', 'warn'],
  unavailable: ['Déjà vendu', 'bad'], too_expensive: ['Trop cher', 'bad'], refused: ['Refusé', 'bad'], busy: ['Occupé', 'warn'], error: ['Erreur', 'bad'],
};

function abCheck(rec, f) {
  const r = f.ab, { item, a } = rec;
  if (!S.settings.autobuy || !r || !r.on) return null;
  if (!(r.maxPrice > 0) || item.price > r.maxPrice) return null;
  if (S.settings.requireSold && (!a || a.src !== 'sold')) return null;
  if (r.minProfit != null && r.minProfit !== '' && (!a || a.profit < Number(r.minProfit))) return null;
  if (r.minDeal && (!a || a.deal < Number(r.minDeal))) return null;
  if (item.ts && Date.now() - item.ts > 15 * 60000) return null; // annonce trop ancienne (remontée)
  return true;
}

function abEnqueue(rec, f) {
  if (AB.queue.some((q) => q.rec === rec) || AB.queue.length >= 3) return;
  AB.queue.push({ rec, f });
  abRun();
}

async function abRun() {
  if (AB.busy || !AB.queue.length) return;
  AB.busy = true;
  const { rec, f } = AB.queue.shift();
  const { item } = rec;
  const entry = { ts: Date.now(), id: item.id, title: item.title, price: item.price, url: item.url, monitor: f.name, status: 'run', dry: S.settings.dryRun };
  AB.log.unshift(entry); AB.log.length = Math.min(AB.log.length, 60);
  renderAbLog();
  const src = source();
  const maxTotal = +(buyerTotal(item) + Number(S.settings.maxShipping || 0)).toFixed(2);
  const res = src ? await src.autobuy({ domain: itemDomain(item), itemId: item.id, maxTotal, dryRun: S.settings.dryRun, humanDelay: true })
    : { ok: false, status: 'error', reason: 'Extension non connectée' };
  Object.assign(entry, { status: res.status || 'error', reason: res.reason || res.error || '', total: res.total, ms: res.ms });
  store.set(S.settings.demo ? 'ablog-demo' : 'ablog', AB.log);
  renderAbLog();
  if (res.status === 'bought') { rec.el.classList.add('bought'); beep(true); beep(true, 0.15); }
  toast(`${AB_LABEL[entry.status]?.[0] || entry.status} · ${item.title}${entry.reason ? ' — ' + entry.reason : ''}`);
  AB.busy = false;
  if (res.status === 'refused') AB.queue.length = 0;
  abRun();
}

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
  const rec = { item, filterId: f.id, isNew, a: analyse(item, f) };
  const c = tpl.cloneNode(true);
  rec.el = c;
  c.dataset.id = item.id;
  c.dataset.f = f.id;
  if (isNew) c.classList.add('new', 'fresh');
  c.querySelector('.thumb').href = safeUrl(item.url);
  const img = c.querySelector('img');
  img.src = safeUrl(item.photo);
  if (isNew) img.loading = 'eager';
  c.querySelector('.age').dataset.ts = item.ts || Date.now();
  c.querySelector('.price').textContent = eur(item.price);
  c.querySelector('.total').textContent = `${eur(buyerTotal(item))} TTC`;
  const t = c.querySelector('.title'); t.textContent = item.title; t.title = item.title;
  c.querySelector('.meta').textContent = [item.brand, item.size, item.status].filter(Boolean).join(' · ');
  if (S.monView && S.monView !== f.id) c.classList.add('hidden');
  paintEst(rec);
  S.items.set(item.id, rec);
  feed.prepend(c);
  paintAge(c.querySelector('.age'));
  while (S.items.size > MAX_FEED) { const [oldId, old] = S.items.entries().next().value; old.el.remove(); S.items.delete(oldId); }
  $('#empty').hidden = true;

  if (isNew) {
    S.stats.found++; rt(f).found++;
    if (abCheck(rec, f)) abEnqueue(rec, f);
    alertNew(rec, f);
  }
}

function paintEst(rec) {
  const { a, el: c } = rec, e = c.querySelector('.est'), b = c.querySelector('.badge');
  e.replaceChildren(); b.textContent = '';
  c.classList.remove('deal');
  if (!a) { e.textContent = 'Estimation : échantillon en cours…'; return; }
  e.append(`Revente ~${eur(a.resale, 0)} · `, el('span', a.profit >= 0 ? 'p' : 'm', (a.profit >= 0 ? '+' : '') + eur(a.profit, 0)),
    el('span', 'src', a.src === 'sold' ? ` · ${a.n} vendus` : ' · annonces'));
  if (a.deal >= S.settings.highlight && a.profit > 0) { c.classList.add('deal'); b.textContent = `-${a.deal} %`; }
}

function paintAge(e) {
  const s = Math.max(0, (Date.now() - Number(e.dataset.ts)) / 1000);
  e.textContent = s < 60 ? `${s | 0} s` : s < 3600 ? `${(s / 60) | 0} min` : s < 86400 ? `${(s / 3600) | 0} h` : `${(s / 86400) | 0} j`;
}

function buy(id) {
  const rec = S.items.get(id); if (!rec) return;
  window.open(S.settings.demo ? rec.item.url : buyUrl(itemDomain(rec.item), rec.item.id), '_blank', 'noopener');
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
  let ask = null, qtext = '';
  if (src) {
    const base = new URLSearchParams(f ? f.params : '');
    const p = new URLSearchParams();
    qtext = [item.brand, ...tokens(item.title, item.brand).slice(0, 2)].filter(Boolean).join(' ') || item.title;
    p.set('search_text', qtext);
    base.getAll('catalog_ids[]').forEach((v) => p.append('catalog_ids[]', v));
    p.set('order', 'relevance'); p.set('per_page', '96'); p.set('page', '1');
    const res = await src.search(f ? f.domain : itemDomain(item), p.toString());
    if (res.ok) {
      const comps = (res.items || []).filter((i) => i.id !== item.id && i.price != null);
      comps.forEach((i) => DB.track(i, f)); // enrichit la base : on saura plus tard lesquels se vendent
      ask = robustStats(comps.map((i) => i.price));
    }
  }
  if (!dlg.open) return;
  rec.a = analyse(item, f); paintEst(rec);
  const se = soldEstimate(item, f), a = rec.a;

  body.replaceChildren();
  const kpis = el('div', 'kpis');
  const k = (label, val, cls) => { const d = el('div', 'kpi'); d.append(el('span', '', label), el('b', cls || '', val)); kpis.append(d); };
  k('Prix payé (total)', eur(buyerTotal(item)));
  k('Revente conseillée', a ? eur(a.resale) : '–');
  k('Profit estimé', a ? (a.profit >= 0 ? '+' : '') + eur(a.profit) : '–', a && a.profit >= 0 ? 'p' : 'm');
  k('Médiane VENDUE', se.base ? eur(se.base * condFactor(item.status)) : `${se.n}/${MIN_SOLD} ventes`);
  k('Délai de vente', Number.isFinite(se.days) ? `${se.days < 1 ? '< 1' : Math.round(se.days)} j` : '–');
  k('Médiane annonces', ask && ask.n >= 4 ? eur(ask.med) : '–');
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
  }
  body.append(el('p', 'note',
    (a && a.src === 'sold'
      ? `Estimation basée sur ${a.n} ventes réelles relevées par Flipdar (prix final constaté sur la page de l'article vendu). `
      : `Pas encore assez de ventes connues pour cet article (${se.n}/${MIN_SOLD}) : estimation provisoire à partir des prix demandés (−10 %). Les ${ask ? ask.n : 0} annonces comparables viennent d'être ajoutées au suivi. `) +
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
$('#ruleDlg').addEventListener('close', () => {
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
$('#addForm').addEventListener('submit', (e) => {
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

$('#monitors').addEventListener('click', (e) => {
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

$('#view').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.view = b.dataset.v;
  for (const x of $('#view').children) x.classList.toggle('on', x === b);
  feed.className = 'feed' + (S.view === 'all' ? '' : ` v-${S.view}`);
});

$('#monFilter').addEventListener('change', (e) => {
  S.monView = e.target.value;
  for (const { el: c } of S.items.values()) c.classList.toggle('hidden', !!S.monView && c.dataset.f !== S.monView);
});

function setRunning(v) {
  S.running = v;
  $('#runBtn').textContent = v ? '⏸ Pause' : '▶ Reprendre';
  document.body.classList.toggle('paused', !v);
}
$('#runBtn').addEventListener('click', () => setRunning(!S.running));
$('#clearBtn').addEventListener('click', () => { for (const { el: c } of S.items.values()) c.remove(); S.items.clear(); $('#empty').hidden = false; });

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

// Base de ventes : export / import
$('#dbExport').addEventListener('click', () => {
  const data = JSON.stringify({ v: 1, exported: new Date().toISOString(), items: [...DB.recs.values()] });
  const a = el('a'); a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = `flipdar-ventes-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('#dbImport').addEventListener('change', async (e) => {
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
    $('#dbInfo').textContent = `${c.sold} ventes réelles connues, ${c.live} annonces en cours de suivi (${c.total} au total). Les données restent dans ton navigateur : exporte-les de temps en temps.`;
  }
  if (tick % 20 === 0) refreshExt();
}, 1000);
addEventListener('beforeunload', () => DB.flush());

/* ================================================================== Démarrage */
(async () => {
  Bridge.init();
  renderMonitors();
  updateSource();
  renderAbLog();
  renderAbState();
  await DB.open();
  setTimeout(() => { if (!S.bridge && !S.settings.demo) toast('Extension Flipdar Bridge non détectée : installe-la ou active le mode démo.'); }, 1500);
  scheduler();
})();
