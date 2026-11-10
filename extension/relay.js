// Relaie vers le service worker les adresses apprises par learn.js.
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.ns !== 'flipdar-learn') return;
  try {
    if (e.data.kind === 'survey') chrome.runtime.sendMessage({ type: 'survey', e: e.data.e });
    else chrome.runtime.sendMessage({ type: 'learn', kind: e.data.kind, url: String(e.data.url) });
  } catch { /* extension rechargée */ }
});
