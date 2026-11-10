// Test de bout en bout : vraie extension + site + faux Vinted.
//   sudo node test/mock-vinted.js &   (port 443, certificat /tmp/mock-vinted.{key,crt})
//   (cd site && python3 -m http.server 8766) &
//   node test/e2e.js
'use strict';
const { launch, authorize, mockState, fetchInsecure } = require('./harness');
const assert = (c, m) => { if (!c) throw new Error('ÉCHEC : ' + m); console.log('  ✓ ' + m); };

(async () => {
  const { ctx, extId } = await launch();
  await authorize(ctx, extId);
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  p.on('dialog', (d) => d.accept());
  await p.goto('http://localhost:8766/');
  await p.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('flipdar'); });
  await p.reload(); await p.waitForTimeout(1500);

  console.log('1. Recherche');
  assert(/Connecté/.test(await p.textContent('#srcLabel')), 'extension connectée');
  await p.fill('input[name=url]', 'https://www.vinted.fr/catalog?search_text=ralph%20lauren&order=newest_first');
  await p.click('#addForm button[type=submit]');
  await p.waitForSelector('.card', { timeout: 20000 });
  await p.waitForTimeout(4000);
  const titles = await p.$$eval('.card .title', (t) => t.map((x) => x.textContent));
  assert(titles.length >= 8 && titles.every((t) => /Ralph Lauren/.test(t)), `résultats pertinents (${titles.length} annonces Ralph Lauren)`);
  assert(/flux rapide|page/.test(await p.textContent('.mon .s')), 'source : page Vinted (pas une API non vérifiée)');

  const buyAndWait = async (id, re, timeout = 60000) => {
    await p.click(`.card[data-id="${id}"] .buy`);
    await p.waitForFunction((r) => new RegExp(r).test(document.querySelector('#abpMsg').textContent), re, { timeout });
    return p.textContent('#abpMsg');
  };
  const ids = await p.$$eval('.card', (c) => c.map((x) => x.dataset.id));

  console.log('2. Achat en simulation');
  let msg = await buyAndWait(ids[0], 'Simulation OK|Indisponible|Action|Erreur|Refusé');
  console.log('    ', msg);
  assert(/Simulation OK/.test(msg), 'simulation jusqu’au total vérifié');
  assert(!(await mockState()).paid.includes(Number(ids[0])), 'aucun paiement en simulation');

  console.log('3. Achat réel (faux Vinted)');
  await p.uncheck('#abForm input[name=dryRun]');
  msg = await buyAndWait(ids[1], 'Acheté|Indisponible|Action|Erreur|Refusé');
  console.log('    ', msg);
  assert(/Acheté/.test(msg), 'achat réel confirmé');
  await p.waitForTimeout(500);
  assert((await mockState()).paid.includes(Number(ids[1])), 'le faux Vinted a bien reçu le paiement');

  console.log('4. Article vendu entre-temps');
  await fetchInsecure('https://www.vinted.fr/__mock/sell?id=' + ids[2]);
  msg = await buyAndWait(ids[2], 'Acheté|Indisponible|Action|Erreur|Refusé');
  console.log('    ', msg);
  assert(/Indisponible/.test(msg), 'article vendu détecté, rien payé');
  await p.check('#abForm input[name=dryRun]');

  console.log('5. Âges et estimations');
  await p.waitForTimeout(45000);
  const ages = await p.$$eval('.card .age', (a) => a.map((x) => x.textContent));
  assert(ages.filter((x) => /^~?\d/.test(x)).length >= ages.length * 0.8, `âges affichés (${ages.slice(0, 5).join(', ')})`);
  const ests = await p.$$eval('.card .est', (a) => a.map((x) => x.textContent));
  assert(ests.filter((x) => /Revente ~\d+/.test(x)).length >= ests.length * 0.8, `estimations présentes (${ests[0]})`);

  console.log('6. Blocage Vinted (rate limited)');
  await fetchInsecure('https://www.vinted.fr/__mock/ratelimit?on=1');
  await p.waitForFunction(() => /Pause Vinted/.test(document.querySelector('#srcLabel').textContent), null, { timeout: 40000 });
  assert(true, 'pause automatique affichée : ' + (await p.textContent('#srcLabel')));
  const before = (await mockState()).requests.length;
  await p.waitForTimeout(15000);
  const after = (await mockState()).requests.length;
  assert(after - before <= 1, `plus aucune requête pendant la pause (${after - before})`);
  await fetchInsecure('https://www.vinted.fr/__mock/ratelimit?on=0');

  assert(errs.length === 0, 'aucune erreur JavaScript' + (errs.length ? ' : ' + errs.join(' | ') : ''));
  console.log('\nTOUS LES TESTS PASSENT');
  await ctx.close();
})().catch(async (e) => { console.error('\n' + e.message); process.exit(1); });
