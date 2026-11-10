// Service worker Flipdar : appelle Vinted avec la session (cookies) de l'utilisateur.
//  - search      : recherche catalogue (lecture seule, tout site Flipdar)
//  - itemStatus  : état d'une annonce (en ligne / vendue / supprimée) + prix (lecture seule)
//  - autobuy     : achat automatique, UNIQUEMENT depuis un site autorisé dans le popup,
//                  et dans les limites (prix max, budget/jour, nombre/jour) gérées ici.

const DOMAIN_RE = /^vinted\.(fr|be|es|it|de|nl|pl|pt|lu|at|co\.uk|cz|lt|sk|se|fi|dk|hu|ro|hr|gr|ie|com)$/;
const refreshing = new Map();
let lastRaw = null; // dernier échantillon brut reçu de Vinted (diagnostic)
function trimForDebug(v, depth = 0) {
  if (v == null || typeof v !== 'object') return typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v;
  if (depth > 3) return Array.isArray(v) ? `[${v.length}]` : '{…}';
  if (Array.isArray(v)) return v.slice(0, 2).map((x) => trimForDebug(x, depth + 1));
  const o = {}; for (const k of Object.keys(v).slice(0, 60)) o[k] = trimForDebug(v[k], depth + 1); return o;
}

/* ------------------------------------------------------------------ Limiteur global anti-blocage
   TOUTES les requêtes vers Vinted passent ici, quel que soit le nombre d'onglets Flipdar :
   écart minimum, plafond par minute, et pause générale (10 min, puis 20, 40, 60) dès que
   Vinted répond « rate limited ». */
const RL = { last: 0, times: [], until: 0, strikes: 0, lastTrip: 0, cap: 15 };
const MIN_SPACING = 2000;   // ms entre deux requêtes
const CAP_MAX = 15, CAP_MIN = 6; // requêtes / minute, tout compris (le plafond baisse après un blocage)
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
chrome.storage.local.get('rl').then(({ rl }) => {
  if (!rl) return;
  if (rl.until > Date.now()) RL.until = rl.until;
  Object.assign(RL, { strikes: rl.strikes || 0, lastTrip: rl.lastTrip || 0, cap: rl.cap || CAP_MAX });
});
// Plafond adaptatif : +1 requête/min toutes les 20 min sans blocage, jusqu'à CAP_MAX.
const capNow = () => Math.min(CAP_MAX, RL.cap + Math.floor(Math.max(0, Date.now() - Math.max(RL.lastTrip, RL.until)) / (20 * 60000)));

function tripRateLimit() {
  const now = Date.now();
  if (now - RL.lastTrip > 2 * 3600000) RL.strikes = 0;
  RL.strikes++; RL.lastTrip = now;
  RL.until = Math.max(RL.until, now + Math.min(10 * 60000 * 2 ** (RL.strikes - 1), 60 * 60000));
  RL.cap = Math.max(CAP_MIN, Math.floor(capNow() * 0.6)); // Vinted tolère moins : on baisse le plafond
  chrome.storage.local.set({ rl: { until: RL.until, strikes: RL.strikes, lastTrip: RL.lastTrip, cap: RL.cap } });
}
const cooldownLeft = () => Math.max(0, RL.until - Date.now());
const limitedResponse = (url) => ({ ok: false, status: 429, url, headers: { get: (h) => (/retry-after/i.test(h) ? String(Math.ceil(cooldownLeft() / 1000)) : '') }, text: async () => '', json: async () => ({}) });

async function gate() {
  for (;;) {
    const now = Date.now();
    if (RL.until > now) return false;
    RL.times = RL.times.filter((t) => now - t < 60000);
    const wait = Math.max(RL.last + MIN_SPACING - now, RL.times.length >= capNow() ? RL.times[0] + 60000 - now : 0);
    if (wait <= 0) { RL.last = now; RL.times.push(now); return true; }
    await sleepMs(Math.min(wait, 1000));
  }
}

async function vfetch(url, opts = {}) {
  if (!(await gate())) return limitedResponse(url);
  const r = await fetch(url, opts);
  if (r.status === 429) { tripRateLimit(); return limitedResponse(url); }
  if (r.status === 403 || /text\/html/.test(r.headers.get('content-type') || '')) {
    const peek = await r.clone().text().catch(() => '');
    const head = peek.slice(0, 30000);
    if (/you are rate limited|too many requests|access to this site is blocked/i.test(head)) { tripRateLimit(); return limitedResponse(url); }
    // Vérification anti-robot (DataDome) : il faut la passer une fois dans un onglet Vinted.
    if (/captcha-delivery\.com|geo\.captcha|datadome|dd_cookie_test|please enable js and disable any ad blocker/i.test(head) && head.length < 25000) {
      RL.captchaAt = Date.now(); RL.until = Math.max(RL.until, Date.now() + 2 * 60000);
      return { ...limitedResponse(url), status: 403, captcha: true };
    }
  }
  return r;
}

/* ------------------------------------------------------------------ Adresses Vinted
   La recherche se lit dans la page Vinted (fiable). Une adresse d'API n'est utilisée que si elle a
   été VÉRIFIÉE : ses résultats doivent correspondre à la recherche et être triés du plus récent au
   plus ancien. (Une ancienne version avait adopté par erreur l'adresse du « dressing » d'un vendeur.) */
const DOM_IN_HOST = /vinted\.[a-z.]+$/;
const EP_VERSION = 4;
let EP = { v: EP_VERSION, search: null, item: null, cand: [], lastDiscover: 0 };
const dead = new Set();
const saveEP = () => chrome.storage.local.set({ ep: EP });
const saveDead = () => chrome.storage.local.set({ dead4: { at: Date.now(), list: [...dead] } });
const epReady = chrome.storage.local.get(['ep', 'dead4']).then(({ ep, dead4 }) => {
  if (ep && ep.v === EP_VERSION) EP = { ...EP, ...ep };
  else { chrome.storage.local.remove(['ep', 'dead']); saveEP(); } // efface les adresses apprises par les anciennes versions
  if (dead4 && Date.now() - dead4.at < 86400000) dead4.list.forEach((u) => dead.add(u));
  syncLearner();
});

const SEARCH_CANDIDATES = [
  'https://www.{d}/api/v2/catalog/items',
  'https://api.{d}/api/v2/catalog/items',
  'https://api.{d}/catalog/v2/items',
  'https://api.{d}/catalog/items',
];
const ITEM_CANDIDATES = ['https://www.{d}/api/v2/items/{id}', 'https://api.{d}/api/v2/items/{id}'];

function toTemplate(url, kind) {
  const u = new URL(url);
  let path = u.pathname;
  if (kind === 'item') path = path.replace(/\/\d{5,}(?=\/|$)/, '/{id}');
  return `${u.protocol}//${u.host.replace(DOM_IN_HOST, '{d}')}${path}`;
}

// Adresse repérée sur le site Vinted : seulement une CANDIDATE, vérifiée avant toute utilisation.
async function learn(kind, url, senderUrl) {
  try { if (!DOM_IN_HOST.test(new URL(senderUrl).hostname)) return; } catch { return; }
  let u; try { u = new URL(url); } catch { return; }
  if (!DOM_IN_HOST.test(u.hostname)) return;
  if (kind === 'search') {
    if (!/catalog/i.test(u.pathname) || !u.searchParams.has('search_text')) return; // pas une recherche catalogue
    const tpl = toTemplate(url, 'search');
    if (!EP.cand.includes(tpl) && !dead.has(tpl)) { EP.cand = [tpl, ...EP.cand].slice(0, 3); EP.lastDiscover = 0; saveEP(); }
  } else if (kind === 'item') {
    const tpl = toTemplate(url, 'item');
    if (tpl.includes('{id}') && !EP.item) { EP.item = tpl; saveEP(); }
  }
}

// learn.js n'est injecté dans Vinted que tant qu'aucune adresse de recherche n'est validée.
async function syncLearner() {
  try {
    const need = !EP.search;
    const reg = await chrome.scripting.getRegisteredContentScripts({ ids: ['flipdar-learn'] });
    if (need && !reg.length) {
      const m = chrome.runtime.getManifest();
      await chrome.scripting.registerContentScripts([{ id: 'flipdar-learn', js: ['learn.js'], matches: m.host_permissions, runAt: 'document_start', world: 'MAIN', persistAcrossSessions: true }]);
    } else if (!need && reg.length) {
      await chrome.scripting.unregisterContentScripts({ ids: ['flipdar-learn'] });
    }
  } catch (e) { /* navigateur sans world MAIN : on se contente des autres méthodes */ }
}

function searchUrl(tpl, domain, query) {
  const u = new URL(tpl.replace(/\{d\}/g, domain));
  u.search = new URLSearchParams(query).toString();
  return u.href;
}

// Les résultats correspondent-ils à la recherche ? (mots de la recherche dans les titres, tri récent)
const normTxt = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function fitsQuery(items, query, strict = false) {
  if (!Array.isArray(items)) return false;
  if (items.length < 4) return !strict; // trop peu pour juger (une recherche pointue peut être vide)
  const p = new URLSearchParams(query);
  const words = normTxt(p.get('search_text')).split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
  if (words.length) {
    const hit = items.filter((i) => { const t = normTxt(`${i.title || ''} ${i.brand_title || ''} ${(i.brand && i.brand.title) || ''}`); return words.some((w) => t.includes(w)); }).length;
    if (hit / items.length < (strict ? 0.8 : 0.5)) return false;
  }
  if (p.get('order') === 'newest_first') {
    const ids = items.map((i) => Number(i.id)).filter(Boolean).slice(2); // les 2 premiers peuvent être sponsorisés
    let desc = 0; for (let j = 1; j < ids.length; j++) if (ids[j] < ids[j - 1]) desc++;
    if (ids.length > 3 && desc / (ids.length - 1) < 0.7) return false;
  }
  return true;
}

// Cherche (au plus toutes les 6 h, en tâche de fond) une adresse d'API qui respecte vraiment la recherche.
let discovering = false;
async function maybeDiscover(domain) {
  if (discovering || EP.search || Date.now() - EP.lastDiscover < 6 * 3600000) return;
  discovering = true; EP.lastDiscover = Date.now(); saveEP();
  try {
    for (const tpl of [...EP.cand, ...SEARCH_CANDIDATES]) {
      if (dead.has(tpl)) continue;
      let ok = true;
      for (const probe of ['nike', 'zara']) {
        const q = `search_text=${probe}&order=newest_first&per_page=24&page=1`;
        const res = await getJson(searchUrl(tpl, domain, q));
        if (res.status === 429 || res.captcha) return;
        if (!(res.ok && fitsQuery(res.data && res.data.items, q, true))) { ok = false; break; }
      }
      if (ok) { EP.search = tpl; saveEP(); syncLearner(); return; }
      dead.add(tpl); saveDead();
    }
  } finally { discovering = false; }
}

async function getJson(url, retry = true) {
  const t0 = Date.now();
  const r = await vfetch(url, { credentials: 'include', headers: { accept: 'application/json, text/plain, */*' }, cache: 'no-store' });
  if (r.captcha) return { ok: false, status: 403, captcha: true };
  if ((r.status === 401 || r.status === 403) && retry) {
    await refreshSession(new URL(url).hostname.replace(/^(www|api)\./, ''));
    return getJson(url, false);
  }
  if (!r.ok) return { ok: false, status: r.status, retryAfter: Number(r.headers.get('retry-after')) || 0 };
  if (!/json/.test(r.headers.get('content-type') || '')) return { ok: false, status: 415 };
  try { return { ok: true, status: r.status, ms: Date.now() - t0, data: await r.json() }; } catch { return { ok: false, status: 415 }; }
}

// Extrait les annonces du JSON embarqué dans une page (Next.js : __NEXT_DATA__ ou flux RSC).
function balancedFrom(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < s.length && j < start + 30000; j++) {
    const c = s[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(start, j + 1);
  }
  return null;
}
function openBraceBefore(s, i) {
  let depth = 0;
  for (let j = i; j >= 0 && j > i - 30000; j--) {
    const c = s[j];
    if (c === '}') depth++;
    else if (c === '{') { if (depth === 0) return j; depth--; }
  }
  return -1;
}
function pageCorpus(html) {
  let corpus = '';
  const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nd) corpus += nd[1] + '\n';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) { try { corpus += JSON.parse('"' + m[1] + '"'); } catch { /* fragment illisible */ } }
  for (const m of html.matchAll(/<script[^>]*type="application\/(?:json|ld\+json)"[^>]*>([\s\S]*?)<\/script>/g)) corpus += m[1] + '\n';
  return corpus;
}
function extractObjects(corpus, accept) {
  const out = new Map(), seenStart = new Set();
  for (const m of corpus.matchAll(/"title":"/g)) {
    const st = openBraceBefore(corpus, m.index);
    if (st < 0 || seenStart.has(st)) continue;
    seenStart.add(st);
    const txt = balancedFrom(corpus, st);
    if (!txt) continue;
    try { const o = JSON.parse(txt); if (accept(o) && !out.has(o.id)) out.set(o.id, o); } catch { /* objet incomplet */ }
  }
  return [...out.values()];
}
const looksLikeItem = (o) => o && typeof o.id === 'number' && o.id > 99999 && typeof o.title === 'string' && o.price != null;

// Demande le flux de données Next.js (en-tête RSC) : beaucoup plus léger que la page HTML complète.
let rscOff = false;
const fetchPage = (url) => vfetch(url, { credentials: 'include', cache: 'no-store', headers: rscOff ? {} : { RSC: '1' } });
async function readPage(r) {
  const text = await r.text();
  const rsc = /x-component/.test(r.headers.get('content-type') || '');
  return { corpus: rsc ? text : pageCorpus(text), rsc, html: rsc ? '' : text };
}

async function searchHtml(domain, query) {
  const p = new URLSearchParams(query);
  for (const v of p.getAll('catalog_ids[]')) p.append('catalog[]', v);
  p.delete('per_page');
  p.set('time', String(Math.floor(Date.now() / 1000))); // évite une page de résultats mise en cache par Vinted
  const t0 = Date.now();
  const r = await fetchPage(`https://www.${domain}/catalog?${p}`);
  if (!r.ok) return { ok: false, status: r.status, retryAfter: Number(r.headers.get('retry-after')) || 0, captcha: !!r.captcha };
  const { corpus, rsc } = await readPage(r);
  const items = extractObjects(corpus, looksLikeItem).sort((a, b) => b.id - a.id);
  if (!items.length) {
    if (rsc && !rscOff) { rscOff = true; setTimeout(() => { rscOff = false; }, 10 * 60000); return searchHtml(domain, query); } // repli sur la page complète
    return { ok: false, status: 0, error: corpus.length < 5000 ? 'page Vinted vide (vérification anti-robot ?) : ouvre vinted.fr dans un onglet' : 'aucune annonce lisible dans la page' };
  }
  return { ok: true, status: r.status, ms: Date.now() - t0, data: { items }, via: rsc ? 'rsc' : 'page' };
}

async function search(domain, query) {
  await epReady;
  if (EP.search) {
    const res = await getJson(searchUrl(EP.search, domain, query));
    if (res.status === 429 || res.captcha) return res;
    if (res.ok && fitsQuery(res.data && res.data.items, query)) return { ...res, via: 'api' };
    // L'adresse ne respecte plus la recherche (ou a disparu) : on l'oublie et on lit la page.
    dead.add(EP.search); saveDead(); EP.search = null; saveEP(); syncLearner();
  }
  maybeDiscover(domain); // non bloquant
  return searchHtml(domain, query);
}

/* ------------------------------------------------------------------ Config achat auto */
const AB_DEFAULTS = { enabled: false, trusted: [], maxPerItem: 60, dailyBudget: 200, maxPerDay: 5, day: '', spent: 0, count: 0 };
const today = () => new Date().toISOString().slice(0, 10);
async function abConfig() {
  const { ab } = await chrome.storage.local.get('ab');
  const c = { ...AB_DEFAULTS, ...(ab || {}) };
  if (c.day !== today()) { c.day = today(); c.spent = 0; c.count = 0; }
  return c;
}
const saveAb = (c) => chrome.storage.local.set({ ab: c });

/* ------------------------------------------------------------------ Utilitaires */
function money(v) {
  if (v == null) return null;
  const n = parseFloat(typeof v === 'object' ? v.amount : v);
  return Number.isFinite(n) ? n : null;
}

// Date de publication : Vinted l'expose sous différents noms selon les pages.
function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
  if (typeof v === 'string') { if (/^\d{10,13}$/.test(v)) return toMs(Number(v)); const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}
// 1) champs connus, 2) sinon tout champ de date au premier niveau de l'annonce ou de sa photo
//    (jamais dans les objets vendeur/marque, dont les dates ne disent rien de l'annonce).
const TS_KEY = /(^|_)(created|published|listed|uploaded|timestamp|ts)(_|$)|_at$/i;
const TS_SKIP = /push|updated|login|loged|seen|promoted|expire|bump|until|last_/i;
function tsOf(i, ph) {
  const now = Date.now(), ok = (t) => t && t > now - 5 * 365 * 86400000 && t < now + 3600000;
  const known = [
    ph && ph.high_resolution && ph.high_resolution.timestamp,
    i.created_at_ts, i.created_at, i.item_created_at, i.published_at, i.listed_at,
    Array.isArray(i.photos) && i.photos[0] && i.photos[0].high_resolution && i.photos[0].high_resolution.timestamp,
  ];
  for (const c of known) { const t = toMs(c); if (ok(t)) return t; }
  let best = null;
  const scan = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (!TS_KEY.test(k) || TS_SKIP.test(k)) continue;
      const t = toMs(v); if (ok(t) && (best == null || t < best)) best = t;
    }
  };
  scan(i); scan(ph); scan(ph && ph.high_resolution);
  return best;
}
// « Ajouté il y a 17 minutes » (page article) -> horodatage approximatif.
const AGE_UNITS = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5, mo: 2592e6, y: 31536e6 };
const unitOf = (u) => {
  u = u.toLowerCase();
  if (/^(seconde|second|segundo|secondo|sekunde|seconde)/.test(u)) return 's';
  if (/^(minute|minuto|minuut|minut|min)/.test(u)) return 'm';
  if (/^(heure|hour|hora|ora|stunde|uur|godzin)/.test(u)) return 'h';
  if (/^(jour|day|día|dia|giorn|tag|dag|dni|dzie)/.test(u)) return 'd';
  if (/^(semaine|week|semana|settiman|woche|tydz)/.test(u)) return 'w';
  if (/^(mois|month|mes|mese|monat|maand|miesi)/.test(u)) return 'mo';
  if (/^(an|year|año|anno|jahr|jaar|rok|lat)/.test(u)) return 'y';
  return null;
};
function tsFromText(html) {
  const t = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|\s+/g, ' ');
  const at = t.search(/ajouté|added|subido|aggiunto|hinzugefügt|toegevoegd|dodane|uploaded/i);
  const zone = at >= 0 ? t.slice(at, at + 80) : t;
  const num = (x) => (/^\d+$/.test(x) ? Number(x) : 1); // « une heure », « an hour »…
  const pats = [
    /il y a\s+(\d+|une?|un)\s+([a-zé]+)/i, /(\d+|an?|one)\s+([a-z]+)\s+ago/i, /hace\s+(\d+|una?|un)\s+([a-zí]+)/i,
    /(\d+|una?|un)\s+([a-z]+)\s+fa\b/i, /vor\s+(\d+|einer?|einem)\s+([a-zä]+)/i, /(\d+)\s+([a-z]+)\s+geleden/i, /(\d+)\s+([a-zó]+)\s+temu/i,
  ];
  for (const re of pats) {
    const m = zone.match(re); if (!m) continue;
    const u = unitOf(m[2]); if (!u) continue;
    return Date.now() - num(m[1]) * AGE_UNITS[u];
  }
  return null;
}

const txt = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? String(v.title || v.name || '') : '');

function slim(i, domain) {
  const ph = i.photo || (Array.isArray(i.photos) && i.photos[0]) || {};
  const thumb = (ph.thumbnails || []).find((t) => t.type === 'thumb310x430') || (ph.thumbnails || [])[0];
  const ts = tsOf(i, ph);
  return {
    id: i.id,
    title: txt(i.title),
    price: money(i.price) ?? money(i.price_numeric),
    currency: (i.price && i.price.currency_code) || i.currency || 'EUR',
    total: money(i.total_item_price),
    fee: money(i.service_fee),
    brand: txt(i.brand_title) || txt(i.brand),
    size: txt(i.size_title) || txt(i.size),
    status: txt(i.status),
    url: !i.url ? `https://www.${domain}/items/${i.id}` : i.url.startsWith('/') ? `https://www.${domain}${i.url}` : i.url,
    photo: (thumb && thumb.url) || ph.url || '',
    ts,
    user: (i.user && i.user.login) || '',
    favs: i.favourite_count || 0,
    views: i.view_count || 0,
    promoted: !!i.promoted,
  };
}

function refreshSession(domain) {
  if (!refreshing.has(domain)) {
    const p = vfetch(`https://www.${domain}/`, { credentials: 'include' })
      .catch(() => null)
      .finally(() => setTimeout(() => refreshing.delete(domain), 10000));
    refreshing.set(domain, p);
  }
  return refreshing.get(domain);
}

/* ------------------------------------------------------------------ État d'une annonce
   Une annonce vendue reste consultable : on y lit « vendu » et le prix final. */
function statusFromJson(it) {
  const sold = it.item_closing_action === 'sold' || it.is_sold === true || (it.is_closed && it.item_closing_action !== 'removed' && it.item_closing_action !== 'deleted');
  return {
    state: sold ? 'sold' : it.is_reserved ? 'reserved' : it.is_closed ? 'gone' : 'live',
    price: money(it.price),
    favs: it.favourite_count ?? null,
  };
}

function statusFromHtml(html) {
  // Les données de la page sont du JSON (parfois échappé) embarqué dans le HTML.
  const h = html.replace(/\\"/g, '"');
  const flag = (k) => { const m = h.match(new RegExp(`"${k}":\\s*(true|false|"[a-z_]+"|null)`)); return m ? m[1].replace(/"/g, '') : null; };
  const closing = flag('item_closing_action');
  const closed = flag('is_closed') === 'true';
  const reserved = flag('is_reserved') === 'true';
  const pm = h.match(/"price":\s*\{\s*"amount":\s*"?([\d.]+)/) || h.match(/"price":\s*"?([\d.]+)"?/);
  const soldBadge = /data-testid="[^"]*(item-status--sold|sold-badge)[^"]*"/.test(html);
  const sold = closing === 'sold' || soldBadge || (closed && closing !== 'removed' && closing !== 'deleted');
  if (!closing && !closed && !reserved && !soldBadge && !pm) return { state: 'unknown', price: null };
  return { state: sold ? 'sold' : reserved ? 'reserved' : closed ? 'gone' : 'live', price: pm ? parseFloat(pm[1]) : null };
}

async function itemStatus(domain, id, wantTs = false) {
  await epReady;
  const tries = [];
  if (EP.item) tries.push(EP.item);
  for (const c of ITEM_CANDIDATES) if (!dead.has(c) && !tries.includes(c)) tries.push(c);
  for (const tpl of tries) {
    const res = await getJson(tpl.replace(/\{d\}/g, domain).replace('{id}', id));
    const it = res.ok && res.data && res.data.item;
    if (it && Number(it.id) === id) {
      if (EP.item !== tpl) { EP.item = tpl; saveEP(); }
      return { ok: true, via: 'api', ts: tsOf(it, it.photo || (it.photos && it.photos[0])), ...statusFromJson(it) };
    }
    if (res.status === 429 || res.captcha) return res;
    // Réponse inattendue, ou 404 (adresse disparue OU article supprimé : impossible à dire) : on passe à la page.
    if (res.ok || res.status === 415 || res.status === 404) { dead.add(tpl); saveDead(); if (tpl === EP.item) { EP.item = null; saveEP(); } }
  }
  // Page de l'article (comme dans le navigateur) : une annonce vendue y reste visible avec son prix.
  const r = await fetchPage(`https://www.${domain}/items/${id}`);
  if (r.captcha) return { ok: false, status: 403, captcha: true };
  if (r.status === 404 || r.status === 410) return { ok: true, state: 'gone', price: null, via: 'page' };
  if (!r.ok) return { ok: false, status: r.status };
  if (r.url && !new RegExp(`/items/${id}`).test(r.url)) return { ok: true, state: 'gone', price: null, via: 'page' }; // redirigé ailleurs
  const { corpus, rsc, html } = await readPage(r);
  const objs = extractObjects(corpus, (o) => o && Number(o.id) === id);
  let ts = (objs[0] && tsOf(objs[0], objs[0].photo)) || (html ? tsFromText(html) : null);
  if (!ts && wantTs && rsc) {
    // Le flux de données ne contient pas la date : on lit le texte « Ajouté il y a… » de la page complète.
    const r2 = await vfetch(`https://www.${domain}/items/${id}`, { credentials: 'include', cache: 'no-store' });
    if (r2.ok) ts = tsFromText(await r2.text());
  }
  if (objs.length) return { ok: true, via: rsc ? 'rsc' : 'page', ts, ...statusFromJson(objs[0]) };
  return { ok: true, via: 'page', ts, ...statusFromHtml(html || corpus) };
}

/* ------------------------------------------------------------------ Achat automatique */
const jobs = new Map(); // tabId -> job
const manualTabs = new Map(); // tabId -> { itemId, until } : onglets « ⚡ Acheter » à faire passer au paiement
let buying = false;

function showJob(job) {
  if (job.winId != null) chrome.windows.update(job.winId, { state: 'normal', focused: true }).catch(() => {});
  else chrome.tabs.update(job.tabId, { active: true }).catch(() => {});
}
function closeJob(job) {
  if (job.winId != null) chrome.windows.remove(job.winId).catch(() => {});
  else chrome.tabs.remove(job.tabId).catch(() => {});
}

// Envoie l'avancement de l'achat à l'onglet Flipdar (fenêtre de progression).
function progress(job, step, detail, extra = {}) {
  if (job.siteTab == null) return;
  chrome.tabs.sendMessage(job.siteTab, { type: 'abProgress', itemId: job.itemId, step, detail, ms: Date.now() - job.t0, ...extra }).catch(() => {});
}
function armTimer(job, ms) {
  clearTimeout(job.timer);
  job.timer = setTimeout(() => finish(job, job.phase === 'clicked'
    ? { ok: true, status: 'bought', reason: 'Paiement envoyé, confirmation non détectée : vérifie dans tes commandes' }
    : { ok: false, status: 'action', reason: 'Délai dépassé sur la page de paiement' }), ms);
}

function finish(job, result) {
  if (job.done) return;
  job.done = true;
  clearTimeout(job.timer);
  jobs.delete(job.tabId);
  buying = false;
  clearTimeout(job.focusT);
  job.resolve(result);
  // Fenêtre cachée : fermée à la fin, sauf si une action manuelle est nécessaire (on la montre alors).
  if (result.status === 'action') showJob(job);
  else setTimeout(() => closeJob(job), result.status === 'bought' ? 1500 : 300);
}

async function autobuy(msg, origin, siteTab) {
  const c = await abConfig();
  if (!c.enabled) return { ok: false, status: 'refused', reason: "Achat auto désactivé dans l'extension" };
  if (!c.trusted.includes(origin)) return { ok: false, status: 'refused', reason: `Site non autorisé (${origin}) : ouvre le popup de l'extension sur ce site` };
  const id = Number(msg.itemId), maxTotal = Number(msg.maxTotal);
  if (!id || !Number.isFinite(maxTotal) || maxTotal <= 0) return { ok: false, status: 'refused', reason: 'paramètres invalides' };
  const cap = Math.min(maxTotal, c.maxPerItem);
  if (!msg.dryRun) {
    if (c.count >= c.maxPerDay) return { ok: false, status: 'refused', reason: `Limite de ${c.maxPerDay} achats/jour atteinte` };
    if (c.spent + cap > c.dailyBudget) return { ok: false, status: 'refused', reason: `Budget du jour dépassé (${c.spent.toFixed(2)} / ${c.dailyBudget} €)` };
  }
  if (cooldownLeft()) return { ok: false, status: 'refused', reason: `Vinted limite ton IP : pause encore ${Math.ceil(cooldownLeft() / 60000)} min` };
  if (buying) return { ok: false, status: 'busy', reason: 'Un achat est déjà en cours' };
  buying = true;

  const url = `https://www.${msg.domain}/items/${id}`; // page de l'article, puis clic « Acheter »
  let tab;
  let winId = null;
  try {
    // Petite fenêtre dans le coin de l'écran, sans prendre le focus. Elle doit être visible :
    // dans un onglet caché ou une fenêtre réduite, Vinted ne passe pas à la page de paiement.
    const W = 480, H = 760, sw = Number(msg.screenW) || 1920, sh = Number(msg.screenH) || 1040;
    const win = await chrome.windows.create({ url, type: 'popup', focused: false, width: W, height: H, left: Math.max(0, sw - W - 8), top: Math.max(0, sh - H - 8) });
    winId = win.id; tab = win.tabs[0];
    chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
  } catch {
    try { tab = await chrome.tabs.create({ url, active: true }); } catch (e) { buying = false; return { ok: false, status: 'error', reason: String(e) }; }
  }

  const result = await new Promise((resolve) => {
    const job = { tabId: tab.id, winId, siteTab, itemId: id, maxTotal: cap, dryRun: !!msg.dryRun, delay: msg.humanDelay !== false, phase: 'open', resolve, t0: Date.now() };
    jobs.set(tab.id, job);
    armTimer(job, 45000);
    progress(job, 'open', 'Ouverture de l’article');
  });

  if (result.status === 'bought' && !msg.dryRun) {
    const c2 = await abConfig();
    c2.count += 1; c2.spent += Number(result.total) || cap;
    await saveAb(c2);
  }
  return result;
}

// Messages venant de la page de paiement Vinted (checkout.js).
function onCheckoutMessage(msg, sender, send) {
  const job = sender.tab && jobs.get(sender.tab.id);
  if (msg.type === 'job?') {
    const m = sender.tab && manualTabs.get(sender.tab.id);
    if (!job && m && Date.now() < m.until) return send({ manual: true, itemId: m.itemId });
    send(job && !job.done ? { itemId: job.itemId, maxTotal: job.maxTotal, dryRun: job.dryRun, delay: job.delay, phase: job.phase } : null);
    return;
  }
  if (msg.type === 'manualDone') { if (sender.tab) manualTabs.delete(sender.tab.id); return send(true); }
  if (!job) return send(null);
  if (msg.type === 'jobPhase') {
    if (msg.phase) job.phase = msg.phase;
    if (msg.total) job.total = msg.total;
    if (msg.step) progress(job, msg.step, msg.detail, { total: msg.total });
    // 3-D Secure : on laisse jusqu'à 5 min et on montre l'onglet au bout de 10 s si besoin.
    // 3-D Secure : validation dans l'appli bancaire, la fenêtre reste cachée. Si rien au bout de 30 s
    // (banque qui demande un code sur la page), on l'affiche.
    if (msg.step === '3ds') { armTimer(job, 300000); job.focusT = setTimeout(() => showJob(job), 30000); }
    else armTimer(job, job.phase === 'clicked' ? 60000 : 45000);
    return send(true);
  }
  if (msg.type === 'jobResult') {
    finish(job, { ok: msg.status === 'bought' || msg.status === 'dry', ms: Date.now() - job.t0, total: msg.total || job.total, ...msg, type: undefined });
    return send(true);
  }
}

/* ------------------------------------------------------------------ Routage */
async function handle(msg, sender) {
  if (!msg || typeof msg !== 'object') return { ok: false, status: 0, error: 'bad message' };
  const origin = sender.url ? new URL(sender.url).origin : '';
  if (msg.type === 'debug') return { ok: true, version: chrome.runtime.getManifest().version, endpoints: EP, dead: [...dead], rl: { until: RL.until, strikes: RL.strikes, cap: capNow(), perMin: RL.times.length }, rscOff, lastRaw };
  if (msg.type === 'version') { await epReady; return { ok: true, version: chrome.runtime.getManifest().version, endpoints: EP, cooldown: cooldownLeft(), cap: capNow(), perMin: RL.times.filter((t) => Date.now() - t < 60000).length, captcha: RL.captchaAt && Date.now() - RL.captchaAt < 10 * 60000 }; }
  if (msg.type === 'abConfig') {
    const c = await abConfig();
    const trusted = c.trusted.includes(origin);
    return { ok: true, enabled: c.enabled, trusted, cooldown: cooldownLeft(), ...(trusted ? { maxPerItem: c.maxPerItem, dailyBudget: c.dailyBudget, maxPerDay: c.maxPerDay, spent: c.spent, count: c.count } : {}) };
  }

  const domain = String(msg.domain || '');
  if (!DOMAIN_RE.test(domain)) return { ok: false, status: 0, error: 'domaine non autorisé' };

  if (msg.type === 'warmup') { await refreshSession(domain); return { ok: true }; }
  if (msg.type === 'search') {
    const res = await search(domain, new URLSearchParams(String(msg.query || '')).toString());
    if (!res.ok) return res;
    // Échantillon brut pour le diagnostic (annonces publiques, sans l'objet vendeur).
    lastRaw = { at: Date.now(), via: res.via, count: (res.data.items || []).length,
      keys: Object.keys((res.data.items || [])[0] || {}),
      sample: (res.data.items || []).slice(0, 3).map((x) => { const { user, ...rest } = x; return trimForDebug(rest); }) };
    return { ok: true, status: res.status, ms: res.ms, via: res.via, items: (res.data.items || []).map((i) => slim(i, domain)) };
  }
  if (msg.type === 'itemStatus') return itemStatus(domain, Number(msg.id), !!msg.wantTs);
  if (msg.type === 'autobuy') return autobuy(msg, origin, sender.tab && sender.tab.id);
  if (msg.type === 'requestTrust') {
    // Fenêtre de l'extension : l'utilisateur autorise lui-même ce site (un site ne peut pas s'autoriser seul).
    if (!/^https:\/\/[a-z0-9-]+\.github\.io$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return { ok: false };
    await chrome.windows.create({ url: chrome.runtime.getURL('popup.html?origin=' + encodeURIComponent(origin)), type: 'popup', width: 340, height: 560, focused: true });
    return { ok: true };
  }
  if (msg.type === 'manualBuy') {
    // Ouvre l'article dans un nouvel onglet ; checkout.js y clique « Acheter » (sans payer).
    const id = Number(msg.itemId);
    if (!id) return { ok: false, error: 'id invalide' };
    const tab = await chrome.tabs.create({ url: `https://www.${domain}/items/${id}`, active: true, index: sender.tab ? sender.tab.index + 1 : undefined });
    manualTabs.set(tab.id, { itemId: id, until: Date.now() + 30000 });
    return { ok: true };
  }
  if (msg.type === 'abFocus') {
    for (const j of jobs.values()) if (j.siteTab === (sender.tab && sender.tab.id)) { showJob(j); return { ok: true }; }
    return { ok: false };
  }
  return { ok: false, status: 0, error: 'type inconnu' };
}

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (msg && ['job?', 'jobPhase', 'jobResult', 'manualDone'].includes(msg.type)) { onCheckoutMessage(msg, sender, send); return false; }
  if (msg && msg.type === 'learn') { learn(msg.kind, msg.url, sender.url || ''); return false; }
  handle(msg, sender).then(send, (e) => send({ ok: false, status: 0, error: String((e && e.message) || e) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  manualTabs.delete(tabId);
  const job = jobs.get(tabId);
  if (job) finish(job, { ok: false, status: 'error', reason: 'Onglet de paiement fermé' });
});
