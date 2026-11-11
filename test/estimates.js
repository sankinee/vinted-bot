// Banc de mesure des estimations : recherches avec prix max (comme en vrai), puis comparaison
// de chaque estimation à la valeur de marché connue du faux Vinted.
'use strict';
const { launch, authorize, fetchInsecure } = require('./harness');
(async () => {
  const { ctx, extId } = await launch();
  await authorize(ctx, extId);
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8766/');
  await p.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('flipdar'); }); await p.reload(); await p.waitForTimeout(1500);
  for (const [q, max] of [['ralph%20lauren', 30], ['carhartt', 60], ['nike', 50], ['levis', 25]]) {
    await p.fill('input[name=url]', `https://www.vinted.fr/catalog?search_text=${q}&price_to=${max}&order=newest_first`);
    await p.click('#addForm button[type=submit]');
  }
  await p.waitForTimeout(Number(process.env.DUR || 240000));
  console.log('état :', JSON.stringify(await p.evaluate(() => ({ recs: DB.recs.size, unbiased: [...DB.recs.values()].filter((x) => x.pf === false).length, done: Object.keys(Comps.done).length, queue: Comps.queue.length, extra: (S.stats.extraTimes || []).length, cards: S.items.size, withEst: [...S.items.values()].filter((r) => r.a).length }))));
  // Annonces à estimer : toutes celles vues (cartes + base), estimées comme une nouvelle annonce.
  const rows = await p.evaluate(() => {
    const f = S.filters[0];
    const out = [];
    for (const x of DB.recs.values()) {
      if (x.state === 'sold') continue;
      const item = { id: x.id, title: x.t, brand: x.b, size: x.sz, status: x.st, price: x.p, url: '' };
      const fx = S.filters.find((g) => new URLSearchParams(g.params).get('search_text') && x.t.toLowerCase().includes(new URLSearchParams(g.params).get('search_text').split(' ')[0])) || f;
      const a = analyse(item, fx);
      if (a) out.push({ id: x.id, t: x.t, sz: x.sz, st: x.st, est: a.resale, quick: a.quick ?? null, conf: a.conf, n: a.n });
    }
    return out;
  });
  const fair = {};
  for (let i = 0; i < rows.length; i += 150) Object.assign(fair, JSON.parse(await fetchInsecure('https://www.vinted.fr/__mock/fair?ids=' + rows.slice(i, i + 150).map((r) => r.id).join(','))));
  console.log('annonces estimées :', rows.length, '· valeurs connues :', Object.keys(fair).length);
  const ev = rows.filter((r) => fair[r.id]).map((r) => ({ ...r, fair: fair[r.id], err: (r.est - fair[r.id]) / fair[r.id] }));
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const report = (label, list) => {
    if (!list.length) return console.log(`${label.padEnd(28)} —`);
    const ape = list.map((r) => Math.abs(r.err));
    console.log(`${label.padEnd(28)} n=${String(list.length).padStart(4)}  erreur médiane ${(med(ape) * 100).toFixed(0).padStart(3)} %  biais ${(med(list.map((r) => r.err)) * 100).toFixed(0).padStart(4)} %  à ±20 % : ${(list.filter((r) => Math.abs(r.err) <= 0.2).length / list.length * 100).toFixed(0)} %`);
  };
  report('TOUT', ev);
  report('confiance haute', ev.filter((r) => r.conf === 'haute'));
  report('tailles enfant', ev.filter((r) => /ans/.test(r.sz)));
  report('cachemire', ev.filter((r) => /cachemire/.test(r.t)));
  report('Carhartt Detroit', ev.filter((r) => /Detroit/.test(r.t)));
  report('Nike TN', ev.filter((r) => /TN/.test(r.t)));
  report('Levi\'s 501', ev.filter((r) => /501/.test(r.t)));
  const sample = ev.filter((r) => /Detroit|cachemire|ans/.test(r.t + r.sz)).slice(0, 6);
  for (const r of sample) console.log(`   ${r.t} [${r.sz}, ${r.st}] → estimé ${r.est} € / vraie valeur ${r.fair} €`);
  console.log('errs', errs.length);
  await ctx.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
