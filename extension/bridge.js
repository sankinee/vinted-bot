// Content script : relaie les messages entre la page Flipdar et le service worker.
// Il n'expose que des requêtes en lecture seule (voir background.js).
(() => {
  const NS = 'flipdar';
  const VERSION = chrome.runtime.getManifest().version;
  const hello = () => window.postMessage({ ns: NS, dir: 'hello', version: VERSION }, location.origin);

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.ns !== NS) return;
    const d = e.data;
    if (d.dir === 'ping') return hello();
    if (d.dir !== 'req') return;
    try {
      chrome.runtime.sendMessage(d.payload, (res) => {
        const err = chrome.runtime.lastError;
        window.postMessage(
          { ns: NS, dir: 'res', id: d.id, res: err ? { ok: false, status: 0, error: err.message } : res },
          location.origin
        );
      });
    } catch (err) {
      // Extension rechargée : le contexte est invalidé, il faut recharger la page.
      window.postMessage({ ns: NS, dir: 'res', id: d.id, res: { ok: false, status: 0, error: 'reload' } }, location.origin);
    }
  });

  hello();
  document.addEventListener('DOMContentLoaded', hello);
})();
