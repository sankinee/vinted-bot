// Relaie vers le service worker les adresses apprises par learn.js.
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.ns !== 'flipdar-learn') return;
  try { chrome.runtime.sendMessage({ type: 'learn', kind: e.data.kind, url: String(e.data.url) }); } catch { /* extension rechargée */ }
});
