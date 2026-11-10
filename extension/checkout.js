// S'exécute sur les pages Vinted, mais n'agit QUE dans un onglet ouvert par un achat Flipdar
// (ou sur un article ouvert avec #flipdar-buy). Parcourt le vrai tunnel d'achat comme un humain :
// article -> « Acheter » -> récapitulatif -> livraison -> total vérifié -> « Payer » -> 3-D Secure -> confirmation.
// Chaque étape est envoyée en direct à Flipdar (fenêtre de progression).
(async () => {
  const ask = (m) => new Promise((r) => { try { chrome.runtime.sendMessage(m, r); } catch { r(null); } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const text = () => (document.body ? document.body.innerText : '');
  const ITEM_PAGE = /\/items\/\d+/;

  const BUY_RE = /^(acheter|acheter maintenant|buy now|buy|comprar|compra|compra ora|kaufen|jetzt kaufen|kopen|nu kopen|kup teraz|kup|cumpără|koupit|kúpiť|ostaa|köp|køb|vásárlás|kupi|αγορά)$/i;
  const PAY_RE = /^(payer|payer maintenant|confirmer et payer|pay|pay now|confirm and pay|pagar|paga|paga ora|bezahlen|jetzt bezahlen|betalen|nu betalen|zapłać|plătește|zaplatit|zaplatiť|maksa|betala|betal|fizetés|plati|πληρωμή)\b/i;
  const SUCCESS_RE = /(merci pour (ton|votre) (achat|commande)|paiement (réussi|effectué|confirmé|accepté)|commande (confirmée|passée)|achat (confirmé|effectué)|thank you for your (purchase|order)|payment (successful|complete)|purchase (successful|complete))/i;
  const UNAVAILABLE_RE = /(déjà (été )?vendu|n'est plus disponible|already sold|no longer available|est réservé|is reserved|ya se ha vendido|non è più disponibile|nicht mehr verfügbar)/i;
  const SUCCESS_URL = /\/(inbox\/\d+|transactions?\/\d+|orders?\/\d+)|purchase_complete|payment_success/i;
  const HOME_DELIVERY_RE = /(livraison à domicile|à domicile|home delivery|to your home|a domicilio|nach hause|thuisbezorging)/i;
  const THREEDS_SEL = 'iframe[src*="3ds" i], iframe[src*="challenge" i], iframe[name*="challenge" i], iframe[src*="acs" i], iframe[title*="3D" i], iframe[src*="adyen" i]';

  const usable = (el) => el && el.offsetParent !== null && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  // Ignore tout ce qui est dans l'en-tête, le menu, le pied de page ou un lien d'aide.
  const inChrome = (el) => !!el.closest('header, nav, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [role="menu"]');
  const labelOf = (b) => (b.innerText || b.value || b.getAttribute('aria-label') || '').trim();

  function findBuy() {
    const byId = [...document.querySelectorAll('[data-testid*="buy" i]')].map((e) => e.closest('button, [role="button"]') || e).find((b) => usable(b) && !inChrome(b));
    if (byId) return byId;
    return [...document.querySelectorAll('button, [role="button"]')].find((b) => usable(b) && !inChrome(b) && BUY_RE.test(labelOf(b)));
  }
  function findPay() {
    const btns = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')].filter((b) => !inChrome(b));
    return btns.find((b) => usable(b) && PAY_RE.test(labelOf(b)))
      || btns.find((b) => usable(b) && /pay|purchase|checkout.*(submit|confirm)/i.test(b.getAttribute('data-testid') || ''));
  }
  const payPresentButDisabled = () => [...document.querySelectorAll('button, [role="button"]')].some((b) => !inChrome(b) && b.offsetParent !== null && PAY_RE.test(labelOf(b)) && !usable(b));
  const waitFor = async (fn, ms) => { for (let t = 0; t < ms; t += 150) { const v = fn(); if (v) return v; await sleep(150); } return null; };

  function amounts(s) {
    const out = [];
    for (const m of s.matchAll(/(\d{1,5}(?:[ .  ]\d{3})*[.,]\d{2})\s?(?:€|EUR|£|zł|Kč)|(?:€|£)\s?(\d{1,5}(?:[.,]\d{3})*[.,]\d{2})/g)) {
      const raw = (m[1] || m[2]).replace(/[   ]/g, '');
      const n = parseFloat(raw.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
      if (Number.isFinite(n)) out.push(n);
    }
    return out;
  }
  function readTotal() {
    const labels = [...document.querySelectorAll('span, div, p, h2, h3, h4, dt, td')].filter((e) => /^(total|total à payer|montant total|total to pay|importe total|totale|gesamt|summe)\s*:?$/i.test(e.textContent.trim()));
    for (const l of labels) {
      let row = l.parentElement;
      for (let i = 0; i < 3 && row; i++, row = row.parentElement) { const a = amounts(row.innerText || ''); if (a.length) return Math.max(...a); }
    }
    const all = amounts(text());
    return all.length ? Math.max(...all) : null;
  }

  // Si la livraison n'est pas présélectionnée, choisit la livraison à domicile (ou la 1re option proposée).
  async function chooseDelivery() {
    const radios = [...document.querySelectorAll('input[type="radio"]')].filter((r) => !inChrome(r));
    if (radios.some((r) => r.checked)) return false;
    const opts = [...document.querySelectorAll('label, [role="radio"], [data-testid*="shipping" i], [data-testid*="delivery" i]')].filter((e) => e.offsetParent !== null && !inChrome(e));
    const pick = opts.find((e) => HOME_DELIVERY_RE.test(e.innerText || '')) || opts.find((e) => e.matches('[role="radio"], label') && /livraison|delivery|envío|consegna|lieferung|point relais|pickup/i.test(e.innerText || ''));
    if (!pick) return false;
    pick.click();
    await sleep(rand(500, 900));
    return true;
  }

  const job = await ask({ type: 'job?' });

  /* ---------------- Mode manuel : bouton « ⚡ Acheter » de Flipdar ---------------- */
  if (!job) {
    if (location.hash === '#flipdar-buy' && ITEM_PAGE.test(location.pathname)) {
      history.replaceState(null, '', location.pathname + location.search);
      const b = await waitFor(findBuy, 10000);
      if (b) b.click();
    }
    return;
  }

  /* ---------------- Mode achat auto ---------------- */
  const step = (s, detail, extra = {}) => ask({ type: 'jobPhase', phase: extra.phase || job.phase, step: s, detail, ...extra });
  const report = (status, extra = {}) => ask({ type: 'jobResult', status, url: location.href, ...extra });

  async function awaitOutcome(total) {
    let announced3ds = false;
    for (let i = 0; i < 600; i++) { // jusqu'à 5 min pour laisser le temps de valider le 3-D Secure
      if (SUCCESS_URL.test(location.pathname + location.search) || SUCCESS_RE.test(text())) return report(job.dryRun ? 'dry' : 'bought', { total });
      if (UNAVAILABLE_RE.test(text()) && !announced3ds) return report('unavailable', { reason: 'Article vendu juste avant toi' });
      if (!announced3ds && document.querySelector(THREEDS_SEL)) { announced3ds = true; await step('3ds', 'Valide le paiement sur ton appli bancaire', { phase: 'clicked' }); }
      await sleep(500);
    }
    return report('action', { total, reason: 'Pas de confirmation après 5 min : vérifie dans tes commandes Vinted' });
  }

  // Retour sur une nouvelle page après le clic « Payer » (redirection banque / confirmation).
  if (job.phase === 'clicked') return awaitOutcome(job.total);

  // Étape 1 : page de l'article -> « Acheter ».
  if (job.phase === 'open' && ITEM_PAGE.test(location.pathname)) {
    await step('item', "Page de l'article ouverte");
    let buy = null;
    for (let i = 0; i < 70 && !buy; i++) {
      buy = findBuy();
      if (!buy) { if (i > 20 && UNAVAILABLE_RE.test(text())) return report('unavailable', { reason: 'Article vendu ou réservé' }); await sleep(150); }
    }
    if (!buy) return report('unavailable', { reason: 'Bouton « Acheter » absent : article vendu, réservé ou page modifiée' });
    if (job.delay) await sleep(rand(150, 400));
    await step('buy', 'Clic sur « Acheter »', { phase: 'checkout' });
    job.phase = 'checkout';
    buy.click();
  }

  // Étape 2 : récapitulatif / paiement (même onglet, après navigation).
  let pay = null, triedDelivery = false;
  for (let i = 0; i < 110 && !pay; i++) {
    if (i > 10 && UNAVAILABLE_RE.test(text())) return report('unavailable', { reason: 'Article déjà vendu ou réservé' });
    if (i === 6) await step('checkout', 'Récapitulatif de commande');
    pay = findPay();
    if (!pay && !triedDelivery && (payPresentButDisabled() || i === 25)) {
      triedDelivery = true;
      if (await chooseDelivery()) await step('delivery', 'Mode de livraison sélectionné');
    }
    if (!pay) await sleep(200);
  }
  if (!pay) return report('action', { reason: 'Bouton « Payer » indisponible : complète adresse / livraison / carte dans l’onglet Vinted' });
  if (!triedDelivery) await step('delivery', 'Adresse et livraison OK');

  await sleep(400); // laisse le récapitulatif se calculer
  const total = readTotal();
  if (total == null) return report('action', { reason: 'Total illisible : achat annulé par sécurité' });
  if (total > job.maxTotal + 0.001) return report('too_expensive', { total, reason: `Total ${total.toFixed(2)} € > max ${job.maxTotal.toFixed(2)} €` });
  await step('total', `Total vérifié : ${total.toFixed(2)} €`, { total });

  if (job.dryRun) return report('dry', { total, reason: 'Simulation : tout est prêt, aucun paiement effectué' });

  // Comportement humain : petite pause, défilement, survol, puis clic.
  if (job.delay) await sleep(rand(300, 800));
  pay.scrollIntoView({ block: 'center' });
  pay.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await sleep(rand(60, 180));
  if (!usable(pay)) pay = findPay();
  if (!pay) return report('action', { reason: 'Le bouton « Payer » a disparu' });
  await step('pay', 'Paiement envoyé', { phase: 'clicked', total });
  pay.click();
  return awaitOutcome(total);
})();
