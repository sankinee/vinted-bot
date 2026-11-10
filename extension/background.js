// Service worker Flipdar : appelle Vinted avec la session (cookies) de l'utilisateur.
//  - search      : recherche catalogue (lecture seule, tout site Flipdar)
//  - itemStatus  : état d'une annonce (en ligne / vendue / supprimée) + prix (lecture seule)
//  - autobuy     : achat automatique, UNIQUEMENT depuis un site autorisé dans le popup,
//                  et dans les limites (prix max, budget/jour, nombre/jour) gérées ici.

const DOMAIN_RE = /^vinted\.(fr|be|es|it|de|nl|pl|pt|lu|at|co\.uk|cz|lt|sk|se|fi|dk|hu|ro|hr|gr|ie|com)$/;
const refreshing = new Map();

/* ------------------------------------------------------------------ Adresses Vinted
   Vinted change régulièrement ses adresses internes. Ordre d'essai :
   1) adresse apprise en observant le site Vinted (learn.js), 2) adresses connues,
   3) lecture des annonces directement dans la page HTML de recherche. */
const DOM_IN_HOST = /vinted\.[a-z.]+$/;
let EP = { search: null, item: null };
const dead = new Set();
const epReady = chrome.storage.local.get('ep').then(({ ep }) => { if (ep) EP = { ...EP, ...ep }; syncLearner(); });

const SEARCH_CANDIDATES = [
  'https://www.{d}/api/v2/catalog/items',
  'https://api.{d}/api/v2/catalog/items',
  'https://api.{d}/catalog/v2/items',
  'https://api.{d}/catalog/items',
  'https://api.{d}/v2/catalog/items',
];
const ITEM_CANDIDATES = ['https://www.{d}/api/v2/items/{id}', 'https://api.{d}/api/v2/items/{id}', 'https://api.{d}/items/v2/{id}'];

function toTemplate(url, kind) {
  const u = new URL(url);
  let path = u.pathname;
  if (kind === 'item') path = path.replace(/\/\d{5,}(?=\/|$)/, '/{id}');
  return `${u.protocol}//${u.host.replace(DOM_IN_HOST, '{d}')}${path}` + (kind === 'search' ? u.search : '');
}

async function learn(kind, url, senderUrl) {
  try { if (!DOM_IN_HOST.test(new URL(senderUrl).hostname)) return; } catch { return; }
  if (kind !== 'search' && kind !== 'item') return;
  const tpl = toTemplate(url, kind);
  if (kind === 'item' && !tpl.includes('{id}')) return;
  if (EP[kind] === tpl) return;
  EP[kind] = tpl;
  await chrome.storage.local.set({ ep: EP });
  syncLearner();
}

// learn.js n'est injecté dans Vinted que tant qu'il reste quelque chose à apprendre.
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
  const base = tpl.replace(/\{d\}/g, domain);
  const u = new URL(base);
  const ours = new URLSearchParams(query);
  const FILTER = /search_text|price|brand|size|catalog|status|color|material|page|order|time|session|search_id/;
  const out = new URLSearchParams();
  for (const [k, v] of u.searchParams) if (!ours.has(k) && !FILTER.test(k)) out.append(k, v);
  for (const [k, v] of ours) out.append(k, v);
  u.search = out.toString();
  return u.href;
}

async function getJson(url, retry = true) {
  const t0 = Date.now();
  const r = await fetch(url, { credentials: 'include', headers: { accept: 'application/json, text/plain, */*' }, cache: 'no-store' });
  if ((r.status === 401 || r.status === 403) && retry) {
    await refreshSession(new URL(url).hostname.replace(/^(www|api)\./, ''));
    return getJson(url, false);
  }
  if (!r.ok) return { ok: false, status: r.status, retryAfter: Number(r.headers.get('retry-after')) || 0 };
  if (!/json/.test(r.headers.get('content-type') || '')) return { ok: false, status: 415 };
  return { ok: true, status: r.status, ms: Date.now() - t0, data: await r.json() };
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

async function searchHtml(domain, query) {
  const p = new URLSearchParams(query);
  for (const v of p.getAll('catalog_ids[]')) p.append('catalog[]', v);
  p.delete('per_page');
  const t0 = Date.now();
  const r = await fetch(`https://www.${domain}/catalog?${p}`, { credentials: 'include', cache: 'no-store' });
  if (!r.ok) return { ok: false, status: r.status, retryAfter: Number(r.headers.get('retry-after')) || 0 };
  const items = extractObjects(pageCorpus(await r.text()), looksLikeItem).sort((a, b) => b.id - a.id);
  if (!items.length) return { ok: false, status: 0, error: 'aucune annonce lisible dans la page' };
  return { ok: true, status: r.status, ms: Date.now() - t0, data: { items }, via: 'page' };
}

async function search(domain, query) {
  await epReady;
  const tries = [];
  if (EP.search) tries.push(EP.search);
  for (const c of SEARCH_CANDIDATES) if (!dead.has(c) && !tries.includes(c)) tries.push(c);
  let last = null;
  for (const tpl of tries) {
    const res = await getJson(searchUrl(tpl, domain, query));
    if (res.ok && Array.isArray(res.data && res.data.items)) {
      if (EP.search !== tpl) { EP.search = tpl; chrome.storage.local.set({ ep: EP }); syncLearner(); }
      return { ...res, via: 'api' };
    }
    if (res.status === 429) return res;           // limité : ne pas insister
    if (res.status === 404 || res.status === 415 || res.ok) {
      dead.add(tpl);
      if (tpl === EP.search) { EP.search = null; chrome.storage.local.set({ ep: EP }); syncLearner(); }
    }
    last = res;
  }
  const html = await searchHtml(domain, query);
  return html.ok ? html : { ...html, error: html.error || (last && `api ${last.status}`) };
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

const txt = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? String(v.title || v.name || '') : '');

function slim(i, domain) {
  const ph = i.photo || (Array.isArray(i.photos) && i.photos[0]) || {};
  const thumb = (ph.thumbnails || []).find((t) => t.type === 'thumb310x430') || (ph.thumbnails || [])[0];
  const ts = ph.high_resolution && ph.high_resolution.timestamp;
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
    ts: ts ? ts * 1000 : null,
    user: (i.user && i.user.login) || '',
    favs: i.favourite_count || 0,
    views: i.view_count || 0,
    promoted: !!i.promoted,
  };
}

function refreshSession(domain) {
  if (!refreshing.has(domain)) {
    const p = fetch(`https://www.${domain}/`, { credentials: 'include' })
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

async function itemStatus(domain, id) {
  await epReady;
  const tries = [];
  if (EP.item) tries.push(EP.item);
  for (const c of ITEM_CANDIDATES) if (!dead.has(c) && !tries.includes(c)) tries.push(c);
  for (const tpl of tries) {
    const res = await getJson(tpl.replace(/\{d\}/g, domain).replace('{id}', id));
    if (res.ok && res.data && res.data.item) {
      if (EP.item !== tpl) { EP.item = tpl; chrome.storage.local.set({ ep: EP }); }
      return { ok: true, via: 'api', ...statusFromJson(res.data.item) };
    }
    if (res.status === 429) return res;
    // 404 ici = adresse d'API disparue OU article supprimé : impossible de savoir, on passe à la page.
    if (res.status === 415 || (res.ok && !res.data.item)) dead.add(tpl);
    if (res.status === 404 && tpl !== EP.item) dead.add(tpl);
  }
  // Page de l'article (comme dans le navigateur) : une annonce vendue y reste visible avec son prix.
  const r = await fetch(`https://www.${domain}/items/${id}`, { credentials: 'include', cache: 'no-store' });
  if (r.status === 404 || r.status === 410) return { ok: true, state: 'gone', price: null, via: 'page' };
  if (!r.ok) return { ok: false, status: r.status };
  if (!new RegExp(`/items/${id}`).test(r.url)) return { ok: true, state: 'gone', price: null, via: 'page' }; // redirigé ailleurs
  const html = await r.text();
  const objs = extractObjects(pageCorpus(html), (o) => o && o.id === id);
  if (objs.length) return { ok: true, via: 'page', ...statusFromJson(objs[0]) };
  return { ok: true, via: 'page', ...statusFromHtml(html) };
}

/* ------------------------------------------------------------------ Achat automatique */
const jobs = new Map(); // tabId -> job
let buying = false;

function finish(job, result) {
  if (job.done) return;
  job.done = true;
  clearTimeout(job.timer);
  jobs.delete(job.tabId);
  buying = false;
  job.resolve(result);
  const keepOpen = result.status === 'action' || (result.status === 'bought' && !job.dryRun);
  if (result.status === 'action') chrome.tabs.update(job.tabId, { active: true }).catch(() => {});
  if (!keepOpen) setTimeout(() => chrome.tabs.remove(job.tabId).catch(() => {}), job.dryRun ? 800 : 0);
}

async function autobuy(msg, origin) {
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
  if (buying) return { ok: false, status: 'busy', reason: 'Un achat est déjà en cours' };
  buying = true;

  const url = `https://www.${msg.domain}/transaction/buy/new?source_screen=item&transaction%5Bitem_id%5D=${id}`;
  let tab;
  try { tab = await chrome.tabs.create({ url, active: false }); } catch (e) { buying = false; return { ok: false, status: 'error', reason: String(e) }; }

  const result = await new Promise((resolve) => {
    const job = { tabId: tab.id, itemId: id, maxTotal: cap, dryRun: !!msg.dryRun, delay: msg.humanDelay !== false, phase: 'open', resolve, t0: Date.now() };
    jobs.set(tab.id, job);
    job.timer = setTimeout(() => finish(job, job.phase === 'clicked'
      ? { ok: true, status: 'bought', reason: 'Paiement envoyé, confirmation non détectée : vérifie dans tes commandes' }
      : { ok: false, status: 'action', reason: 'Délai dépassé sur la page de paiement' }), 40000);
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
    send(job && !job.done ? { itemId: job.itemId, maxTotal: job.maxTotal, dryRun: job.dryRun, delay: job.delay, phase: job.phase } : null);
    return;
  }
  if (!job) return send(null);
  if (msg.type === 'jobPhase') { job.phase = msg.phase; if (msg.total) job.total = msg.total; return send(true); }
  if (msg.type === 'jobResult') {
    finish(job, { ok: msg.status === 'bought' || msg.status === 'dry', ms: Date.now() - job.t0, total: msg.total || job.total, ...msg, type: undefined });
    return send(true);
  }
}

/* ------------------------------------------------------------------ Routage */
async function handle(msg, sender) {
  if (!msg || typeof msg !== 'object') return { ok: false, status: 0, error: 'bad message' };
  const origin = sender.url ? new URL(sender.url).origin : '';
  if (msg.type === 'version') { await epReady; return { ok: true, version: chrome.runtime.getManifest().version, endpoints: EP }; }
  if (msg.type === 'abConfig') {
    const c = await abConfig();
    const trusted = c.trusted.includes(origin);
    return { ok: true, enabled: c.enabled, trusted, ...(trusted ? { maxPerItem: c.maxPerItem, dailyBudget: c.dailyBudget, maxPerDay: c.maxPerDay, spent: c.spent, count: c.count } : {}) };
  }

  const domain = String(msg.domain || '');
  if (!DOMAIN_RE.test(domain)) return { ok: false, status: 0, error: 'domaine non autorisé' };

  if (msg.type === 'warmup') { await refreshSession(domain); return { ok: true }; }
  if (msg.type === 'search') {
    const res = await search(domain, new URLSearchParams(String(msg.query || '')).toString());
    if (!res.ok) return res;
    return { ok: true, status: res.status, ms: res.ms, via: res.via, items: (res.data.items || []).map((i) => slim(i, domain)) };
  }
  if (msg.type === 'itemStatus') return itemStatus(domain, Number(msg.id));
  if (msg.type === 'autobuy') return autobuy(msg, origin);
  return { ok: false, status: 0, error: 'type inconnu' };
}

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (msg && ['job?', 'jobPhase', 'jobResult'].includes(msg.type)) { onCheckoutMessage(msg, sender, send); return false; }
  if (msg && msg.type === 'learn') { learn(msg.kind, msg.url, sender.url || ''); return false; }
  handle(msg, sender).then(send, (e) => send({ ok: false, status: 0, error: String((e && e.message) || e) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const job = jobs.get(tabId);
  if (job) finish(job, { ok: false, status: 'error', reason: 'Onglet de paiement fermé' });
});
