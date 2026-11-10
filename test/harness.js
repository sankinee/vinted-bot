// Lance Chromium avec la vraie extension Flipdar, le site sur http://localhost:8766 et le faux Vinted.
'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const EXT = path.resolve(__dirname, '../extension');

async function launch({ headless = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipdar-e2e-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless, channel: 'chromium', viewport: { width: 1400, height: 900 },
    args: [
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      '--host-resolver-rules=MAP www.vinted.fr 127.0.0.1, MAP api.vinted.fr 127.0.0.1',
      '--ignore-certificate-errors', '--no-proxy-server',
    ],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  return { ctx, sw, extId };
}

// Autorise le site dans l'extension, comme un clic sur « Autoriser et activer l'achat ».
async function authorize(ctx, extId, origin = 'http://localhost:8766') {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/popup.html?origin=${encodeURIComponent(origin)}`);
  await p.click('#askYes');
  await p.waitForEvent('close', { timeout: 3000 }).catch(() => {}); // la fenêtre se ferme toute seule
  if (!p.isClosed()) await p.close();
}

async function mockState() {
  const r = await fetchInsecure('https://www.vinted.fr/__mock/state');
  return JSON.parse(r);
}
function fetchInsecure(url) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ host: '127.0.0.1', port: 443, path: u.pathname + u.search, headers: { host: u.host }, rejectUnauthorized: false }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

module.exports = { launch, authorize, mockState, fetchInsecure };
