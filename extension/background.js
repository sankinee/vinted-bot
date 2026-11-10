// Service worker Flipdar : appelle Vinted avec la session (cookies) de l'utilisateur.
//  - search      : recherche catalogue (lecture seule, tout site Flipdar)
//  - itemStatus  : état d'une annonce (en ligne / vendue / supprimée) + prix (lecture seule)
//  - autobuy     : achat automatique, UNIQUEMENT depuis un site autorisé dans le popup,
//                  et dans les limites (prix max, budget/jour, nombre/jour) gérées ici.

const DOMAIN_RE = /^vinted\.(fr|be|es|it|de|nl|pl|pt|lu|at|co\.uk|cz|lt|sk|se|fi|dk|hu|ro|hr|gr|ie|com)$/;
const refreshing = new Map();

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

function slim(i, domain) {
  const ph = i.photo || {};
  const thumb = (ph.thumbnails || []).find((t) => t.type === 'thumb310x430') || (ph.thumbnails || [])[0];
  const ts = ph.high_resolution && ph.high_resolution.timestamp;
  return {
    id: i.id,
    title: i.title || '',
    price: money(i.price),
    currency: (i.price && i.price.currency_code) || i.currency || 'EUR',
    total: money(i.total_item_price),
    fee: money(i.service_fee),
    brand: i.brand_title || '',
    size: i.size_title || '',
    status: i.status || '',
    url: i.url || `https://www.${domain}/items/${i.id}`,
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

async function vget(domain, path, { retry = true, as = 'json' } = {}) {
  const t0 = Date.now();
  const r = await fetch(`https://www.${domain}${path}`, {
    credentials: 'include',
    headers: { accept: as === 'json' ? 'application/json, text/plain, */*' : 'text/html,*/*' },
    cache: 'no-store',
  });
  if ((r.status === 401 || r.status === 403) && retry && as === 'json') {
    await refreshSession(domain);
    return vget(domain, path, { retry: false, as });
  }
  if (!r.ok) return { ok: false, status: r.status, retryAfter: Number(r.headers.get('retry-after')) || 0 };
  const data = as === 'json' ? await r.json() : await r.text();
  return { ok: true, status: r.status, ms: Date.now() - t0, data };
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
  let res = await vget(domain, `/api/v2/items/${id}`);
  if (res.ok && res.data && res.data.item) return { ok: true, ...statusFromJson(res.data.item) };
  if (res.status === 404) return { ok: true, state: 'gone', price: null };
  if (res.status === 429) return res;
  // Repli : page HTML de l'annonce (comme on la verrait dans le navigateur).
  res = await vget(domain, `/items/${id}`, { as: 'html' });
  if (res.status === 404 || res.status === 410) return { ok: true, state: 'gone', price: null };
  if (!res.ok) return res;
  return { ok: true, ...statusFromHtml(res.data) };
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
  if (msg.type === 'version') return { ok: true, version: chrome.runtime.getManifest().version };
  if (msg.type === 'abConfig') {
    const c = await abConfig();
    const trusted = c.trusted.includes(origin);
    return { ok: true, enabled: c.enabled, trusted, ...(trusted ? { maxPerItem: c.maxPerItem, dailyBudget: c.dailyBudget, maxPerDay: c.maxPerDay, spent: c.spent, count: c.count } : {}) };
  }

  const domain = String(msg.domain || '');
  if (!DOMAIN_RE.test(domain)) return { ok: false, status: 0, error: 'domaine non autorisé' };

  if (msg.type === 'warmup') { await refreshSession(domain); return { ok: true }; }
  if (msg.type === 'search') {
    const q = new URLSearchParams(String(msg.query || '')).toString();
    const res = await vget(domain, `/api/v2/catalog/items?${q}`);
    if (!res.ok) return res;
    return { ok: true, status: res.status, ms: res.ms, items: (res.data.items || []).map((i) => slim(i, domain)) };
  }
  if (msg.type === 'itemStatus') return itemStatus(domain, Number(msg.id));
  if (msg.type === 'autobuy') return autobuy(msg, origin);
  return { ok: false, status: 0, error: 'type inconnu' };
}

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (msg && ['job?', 'jobPhase', 'jobResult'].includes(msg.type)) { onCheckoutMessage(msg, sender, send); return false; }
  handle(msg, sender).then(send, (e) => send({ ok: false, status: 0, error: String((e && e.message) || e) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const job = jobs.get(tabId);
  if (job) finish(job, { ok: false, status: 'error', reason: 'Onglet de paiement fermé' });
});
