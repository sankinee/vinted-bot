// Plusieurs recherches en même temps : aucune erreur « timeout », chacune servie à son tour.
'use strict';
const { launch, authorize, mockState } = require('./harness');
(async () => {
  const { ctx, extId } = await launch();
  await authorize(ctx, extId);
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8766/');
  await p.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('flipdar'); }); await p.reload(); await p.waitForTimeout(1500);
  await p.check('#settings input[name=sniper]');
  for (const q of ['ralph%20lauren', 'nike', 'lacoste', 'carhartt']) {
    await p.fill('input[name=url]', `https://www.vinted.fr/catalog?search_text=${q}&order=newest_first`);
    await p.click('#addForm button[type=submit]');
  }
  const t0 = Date.now();
  await p.waitForTimeout(Number(process.env.DUR || 120000));
  const st = await p.$$eval('.mon', (m) => m.map((x) => x.querySelector('.n').textContent + ' → ' + x.querySelector('.s').textContent));
  console.log(st.join('\n'));
  const s = await mockState();
  const n = s.requests.filter((r) => r.t > t0 && r.path === '/catalog').length;
  console.log(`requêtes /catalog : ${n} en ${Math.round((Date.now() - t0) / 1000)} s ; erreurs affichées : ${st.filter((x) => /Erreur/.test(x)).length} ; errs JS : ${errs.length}`);
  await ctx.close();
  process.exit(st.some((x) => /Erreur/.test(x)) || errs.length ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
