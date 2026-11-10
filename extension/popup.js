const D = { enabled: false, trusted: [], maxPerItem: 60, dailyBudget: 200, maxPerDay: 5, day: '', spent: 0, count: 0 };
const $ = (id) => document.getElementById(id);
let cfg, origin = '';

async function load() {
  const { ab } = await chrome.storage.local.get('ab');
  cfg = { ...D, ...(ab || {}) };
  if (cfg.day !== new Date().toISOString().slice(0, 10)) { cfg.spent = 0; cfg.count = 0; }
  // Ouvert par l'extension elle-même après un clic « ⚡ Acheter » (page non accessible aux sites web).
  const ask = new URLSearchParams(location.search).get('origin');
  if (ask) { origin = ask; document.body.classList.add('ask'); $('askOrigin').textContent = ask; }
  else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try { const u = new URL(tab.url); if (/^https?:$/.test(u.protocol) && !/vinted\./.test(u.hostname)) origin = u.origin; } catch { /* onglet interne */ }
  }
  render();
}

function render() {
  $('enabled').checked = cfg.enabled;
  for (const k of ['maxPerItem', 'dailyBudget', 'maxPerDay']) $(k).value = cfg[k];
  $('today').textContent = `Aujourd'hui : ${cfg.count} achat(s), ${cfg.spent.toFixed(2)} € dépensés.`;
  const ul = $('trusted'); ul.replaceChildren();
  if (!cfg.trusted.length) { const li = document.createElement('li'); li.className = 'muted'; li.textContent = 'aucun'; ul.append(li); }
  for (const o of cfg.trusted) {
    const li = document.createElement('li'); const s = document.createElement('span'); s.textContent = o;
    const a = document.createElement('a'); a.textContent = '✕'; a.title = 'Retirer';
    a.onclick = () => { cfg.trusted = cfg.trusted.filter((x) => x !== o); save(); };
    li.append(s, a); ul.append(li);
  }
  $('trust').hidden = !origin || cfg.trusted.includes(origin);
  $('cur').textContent = origin ? (cfg.trusted.includes(origin) ? `${origin} est autorisé.` : `Onglet actuel : ${origin}`) : 'Ouvre ce popup depuis ton site Flipdar pour l’autoriser.';
}

function save() { chrome.storage.local.set({ ab: cfg }); render(); }

$('enabled').onchange = (e) => { cfg.enabled = e.target.checked; save(); };
for (const k of ['maxPerItem', 'dailyBudget', 'maxPerDay']) $(k).onchange = (e) => { cfg[k] = Math.max(1, Number(e.target.value) || D[k]); save(); };
$('trust').onclick = () => { if (origin && !cfg.trusted.includes(origin)) cfg.trusted.push(origin); cfg.enabled = true; save(); };
$('askYes').onclick = async () => {
  const { ab } = await chrome.storage.local.get('ab'); // relit pour ne pas écraser les compteurs du jour
  cfg = { ...D, ...(ab || {}), ...{ maxPerItem: cfg.maxPerItem, dailyBudget: cfg.dailyBudget, maxPerDay: cfg.maxPerDay } };
  cfg.enabled = true;
  if (origin && !cfg.trusted.includes(origin)) cfg.trusted.push(origin);
  await chrome.storage.local.set({ ab: cfg });
  $('askYes').textContent = 'Autorisé ✓';
  setTimeout(() => window.close(), 600);
};
$('askNo').onclick = () => window.close();
load();
