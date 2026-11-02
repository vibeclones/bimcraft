/* SPDX-License-Identifier: Apache-2.0 */
/**
 * clash-worker.js — runs clash.js off the page (0.4 B17). The page sends { clashUrl, A, B, tolerance } (element lists from
 * elementsOf, their triangle arrays transferred) and gets back { progress: [done, total] } messages, then { result } or
 * { error }. clash.js is imported by the URL the page resolved, so the build's version-busted copy (and the offline copy)
 * is used: workers do not see the page's import map.
 */
self.onmessage = async (e) => {
  const { clashUrl, A, B, tolerance } = e.data;
  try {
    const { clashes } = await import(clashUrl);
    let last = 0;
    const result = clashes(A, B, { tolerance, onProgress: (done, total) => { const now = Date.now(); if (now - last > 120 || done === total) { last = now; self.postMessage({ progress: [done, total] }); } } });
    self.postMessage({ result });
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });   // i18n-ignore: an engine failure, shown inside a translated sentence
  }
};
