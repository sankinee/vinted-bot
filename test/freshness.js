// Scénarios de fraîcheur : lancer le faux Vinted avec MOCK_STALE_EXT=1800000 (requêtes extérieures figées)
// ou MOCK_STALE_RSC=1 (flux rapide figé), puis : DUR=150000 node test/freshness.js lauren
const { launch, authorize, mockState } = require('./harness');
(async () => {
  const { ctx, extId } = await launch();
  await authorize(ctx, extId);
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8766/');
  await p.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('flipdar'); }); await p.reload(); await p.waitForTimeout(1500);
  await p.check('#settings input[name=sniper]');
  for (const q of process.argv.slice(2)) {
    await p.evaluate(() => { S.filters = []; saveFilters(); renderMonitors(); });
    await p.fill('input[name=url]', `https://www.vinted.fr/catalog?search_text=${q}&order=newest_first`);
    await p.click('#addForm button[type=submit]');
    const t0 = Date.now(); await p.waitForTimeout(Number(process.env.DUR || 32000));
    const st = await mockState();
    const cat = st.requests.filter((r) => r.t > t0 && r.path === '/catalog');
    console.log(`« ${q} » : ${await p.textContent('.mon .s')} | requêtes catalogue : ${cat.length} (rsc ${cat.filter((r) => r.rsc).length}, page ${cat.filter((r) => !r.rsc).length})`);
  }
  console.log('onglets ouverts par l’extension :', ctx.pages().filter((pg) => /vinted/.test(pg.url())).map((pg) => pg.url()));
  console.log('errs', errs); await ctx.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
