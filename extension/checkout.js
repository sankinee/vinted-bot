// S'exécute sur les pages Vinted, mais n'agit QUE dans un onglet ouvert par un achat auto Flipdar.
// Parcourt le vrai tunnel de paiement comme un humain : vérifie le total, attend un peu, clique « Payer ».
(async () => {
  const ask = (m) => new Promise((r) => { try { chrome.runtime.sendMessage(m, r); } catch { r(null); } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ITEM_PAGE = /\/items\/\d+/;
  const BUY_RE = /^(acheter|buy now|buy|comprar|compra|compra ora|kaufen|jetzt kaufen|kopen|nu kopen|kup teraz|kup|cumpără|koupit|kúpiť|osta|ostaa|köp|køb|vásárlás|kupi|αγορά)$/i;
  const visibleBtn = (el) => el && el.offsetParent !== null && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  const findBuy = () => [...document.querySelectorAll('button, [role="button"], a')].find((b) => visibleBtn(b)
    && (BUY_RE.test((b.innerText || '').trim()) || /^item-buy-button$|buy-button/i.test(b.getAttribute('data-testid') || '')));
  const waitFor = async (fn, ms) => { for (let t = 0; t < ms; t += 150) { const v = fn(); if (v) return v; await sleep(150); } return null; };

  const job = await ask({ type: 'job?' });
  if (!job) {
    // Bouton « ⚡ Acheter » de Flipdar : ouvre l'article puis clique « Acheter » pour arriver au paiement.
    if (location.hash === '#flipdar-buy' && ITEM_PAGE.test(location.pathname)) {
      history.replaceState(null, '', location.pathname + location.search);
      const b = await waitFor(findBuy, 10000);
      if (b) b.click();
    }
    return;
  }

  const rand = (a, b) => a + Math.random() * (b - a);
  const report = (status, extra = {}) => ask({ type: 'jobResult', status, url: location.href, ...extra });
  const text = () => (document.body ? document.body.innerText : '');

  const PAY_RE = /^(payer|pay|pay now|payer maintenant|pagar|paga|paga ora|bezahlen|jetzt bezahlen|betalen|nu betalen|zapłać|plătește|zaplatit|zaplatiť|maksa|betala|betal|fizetés|plati|πληρωμή)\b/i;
  const SUCCESS_RE = /(merci pour (ton|votre) achat|paiement (réussi|effectué|confirmé)|commande (confirmée|passée)|thank you for your purchase|payment (successful|complete)|purchase (successful|complete))/i;
  const UNAVAILABLE_RE = /(déjà (été )?vendu|n'est plus disponible|already sold|no longer available|est réservé|is reserved|ya se ha vendido|non è più disponibile|nicht mehr verfügbar)/i;
  const SUCCESS_URL = /\/(inbox|transactions?\/\d+|orders?)\b|success|purchase_complete/i;

  const visible = (el) => el && el.offsetParent !== null && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  function findPay() {
    const btns = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')];
    return btns.find((b) => visible(b) && PAY_RE.test((b.innerText || b.value || '').trim()))
      || btns.find((b) => visible(b) && /pay|purchase|checkout-submit/i.test(b.getAttribute('data-testid') || ''));
  }
  function amounts(s) {
    const out = [];
    for (const m of s.matchAll(/(\d{1,5}(?:[ . ]\d{3})*[.,]\d{2})\s?(?:€|EUR|£|zł|Kč)|(?:€|£)\s?(\d{1,5}(?:[.,]\d{3})*[.,]\d{2})/g)) {
      const raw = (m[1] || m[2]).replace(/[  ]/g, '');
      const n = parseFloat(raw.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
      if (Number.isFinite(n)) out.push(n);
    }
    return out;
  }
  function readTotal() {
    // 1) ligne « Total » ; 2) sinon le plus gros montant de la page (le total est toujours le plus élevé).
    const labels = [...document.querySelectorAll('span, div, p, h2, h3, dt, td')].filter((e) => /^(total|total à payer|total to pay|importe total|totale|gesamt|summe)\s*:?$/i.test(e.textContent.trim()));
    for (const l of labels) {
      let row = l.parentElement;
      for (let i = 0; i < 3 && row; i++, row = row.parentElement) { const a = amounts(row.innerText || ''); if (a.length) return Math.max(...a); }
    }
    const all = amounts(text());
    return all.length ? Math.max(...all) : null;
  }

  // Phase 2 : on revient sur une page après le clic -> détecter le succès.
  if (job.phase === 'clicked') {
    for (let i = 0; i < 30; i++) {
      if (SUCCESS_URL.test(location.pathname + location.search) || SUCCESS_RE.test(text())) return report(job.dryRun ? 'dry' : 'bought');
      if (document.querySelector('iframe[src*="3ds"], iframe[src*="challenge"], iframe[name*="challenge"]')) return report('action', { reason: 'Validation 3-D Secure demandée par ta banque' });
      await sleep(500);
    }
    return; // le service worker conclura au délai
  }

  // Phase 1 : page de l'article -> clic sur « Acheter ».
  if (job.phase === 'open' && ITEM_PAGE.test(location.pathname)) {
    let buy = null;
    for (let i = 0; i < 70 && !buy; i++) {
      buy = findBuy();
      if (!buy) { if (i > 20 && UNAVAILABLE_RE.test(text())) return report('unavailable', { reason: 'Article vendu ou réservé' }); await sleep(150); }
    }
    if (!buy) return report('unavailable', { reason: 'Bouton « Acheter » absent : article vendu, réservé ou page modifiée' });
    if (job.delay) await sleep(rand(150, 400));
    await ask({ type: 'jobPhase', phase: 'checkout' });
    buy.click();
  }

  // Phase 2 : page de paiement (même onglet, après navigation).
  let pay = null;
  for (let i = 0; i < 100 && !pay; i++) {
    if (i > 10 && UNAVAILABLE_RE.test(text())) return report('unavailable', { reason: 'Article déjà vendu ou réservé' });
    pay = findPay();
    if (!pay) await sleep(200);
  }
  if (!pay) return report('action', { reason: 'Bouton « Payer » introuvable (adresse, point relais ou moyen de paiement à choisir ?)' });

  await sleep(400); // laisse le récapitulatif se calculer
  const total = readTotal();
  await ask({ type: 'jobPhase', phase: 'ready', total });
  if (total == null) return report('action', { reason: 'Total illisible : achat annulé par sécurité' });
  if (total > job.maxTotal + 0.001) return report('too_expensive', { total, reason: `Total ${total.toFixed(2)} € > max ${job.maxTotal.toFixed(2)} €` });

  if (job.dryRun) return report('dry', { total, reason: 'Simulation : tout est prêt, aucun paiement effectué' });

  // Comportement humain : petite pause, défilement, survol, puis clic.
  if (job.delay) await sleep(rand(350, 900));
  pay.scrollIntoView({ block: 'center' });
  pay.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await sleep(rand(60, 180));
  if (!visible(pay)) pay = findPay();
  if (!pay) return report('action', { reason: 'Le bouton « Payer » a disparu' });
  await ask({ type: 'jobPhase', phase: 'clicked', total });
  pay.click();

  // Si la page ne change pas d'URL, on surveille ici le résultat.
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (SUCCESS_URL.test(location.pathname + location.search) || SUCCESS_RE.test(text())) return report('bought', { total });
    if (document.querySelector('iframe[src*="3ds"], iframe[src*="challenge"], iframe[name*="challenge"]')) return report('action', { total, reason: 'Validation 3-D Secure demandée par ta banque' });
    if (UNAVAILABLE_RE.test(text())) return report('unavailable', { reason: 'Article vendu juste avant toi' });
  }
})();
