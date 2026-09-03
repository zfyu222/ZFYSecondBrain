export function offlineAssets(names: string[]) {
  return [...new Set(names)]
    .filter(
      (p) =>
        (/\.(js|css)$/.test(p) && p !== "sw.js") ||
        /^offline-shell-[a-f0-9]{64}\.html$/.test(p),
    )
    .sort()
    .map((p) => "/" + p);
}
export function offlineShell(version: string, assets: string[]) {
  const shells = assets.filter((p) =>
    /^\/offline-shell-[a-f0-9]{64}\.html$/.test(p),
  );
  if (shells.length !== 1) throw new Error("离线构建必须包含唯一的版本化入口");
  return `
const CACHE = ${JSON.stringify(version)};
const ASSETS = ${JSON.stringify(assets)};
const SHELL = ${JSON.stringify(shells[0])};
// Keep the browser's waiting phase: never replace code under an open editor.
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('risk-lab-') && k !== CACHE).map(k => caches.delete(k))))));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate' && url.pathname === '/') {
    event.respondWith(caches.open(CACHE).then(async c => {
      const cached = await c.match(SHELL);
      if (cached) return cached;
      try { const response = await fetch(SHELL); if (response.ok) return response; } catch {}
      return new Response('当前版本的界面缓存已失效。请先在其他标签页保存或导出草稿，再关闭全部标签页并联网重开以检查更新。不要清除浏览器数据。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }));
    return;
  }
  if (ASSETS.includes(url.pathname)) event.respondWith(caches.open(CACHE).then(async c => (await c.match(event.request)) || fetch(event.request)));
});`;
}
