export function offlineAssets(names: string[]) {
  return [
    "/",
    ...names
      .filter((p) => /\.(js|css)$/.test(p) && p !== "sw.js")
      .sort()
      .map((p) => "/" + p),
  ];
}
export function offlineShell(version: string, assets: string[]) {
  return `
const CACHE = ${JSON.stringify(version)};
const ASSETS = ${JSON.stringify(assets)};
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(Promise.all([self.clients.claim(), caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('risk-lab-') && k !== CACHE).map(k => caches.delete(k))))])));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate' && url.pathname === '/') {
    event.respondWith(fetch(event.request).then(response => { if (!response.ok) throw new Error('offline'); return response; }).catch(() => caches.open(CACHE).then(c => c.match('/'))));
    return;
  }
  if (ASSETS.includes(url.pathname)) event.respondWith(caches.open(CACHE).then(async c => (await c.match(event.request)) || fetch(event.request)));
});`;
}
