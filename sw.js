const site = new URL(self.registration.scope);
const cacheName = "yinu-web-static-6";
const shareCache = "yinu-web-incoming";
const resources = ["./", "./app.js?v=6", "./app.css?v=5", "./sync.js?v=6",
  "./tools.js", "./backup.js", "./docx.js", "./icon.png", "./manifest.webmanifest"];
const assetUrls = new Set(resources.map(path => new URL(path, site).href));

self.addEventListener("install", event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(resources)).then(() => self.skipWaiting()));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const recordId = event.notification.data?.recordId;
  if (!recordId) return;
  const address = new URL("./", site);
  address.searchParams.set("locate", recordId);
  event.waitUntil(self.clients.matchAll({ type: "window" }).then(async windows => {
    const client = windows.find(window => window.url.startsWith(site.href));
    if (client) {
      client.postMessage({ recordId });
      return client.focus();
    }
    return self.clients.openWindow(address);
  }));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key =>
    key.startsWith("yinu-web-static-") && key !== cacheName).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

async function receiveShare(request) {
  const rejected = Response.redirect(new URL("./?share-error=1", site), 303);
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 52_000_000) return rejected;
    const input = await request.formData();
    const files = input.getAll("files").filter(file => file instanceof File);
    if (files.length > 20 || files.reduce((sum, file) => sum + file.size, 0) > 50_000_000) return rejected;
    const form = new FormData();
    for (const key of ["title", "text", "url"]) {
      const text = input.get(key);
      if (typeof text === "string") form.set(key, text.slice(0, 12000));
    }
    for (const file of files) form.append("files", file);
    const id = crypto.randomUUID();
    const cache = await caches.open(shareCache);
    for (const key of await cache.keys()) {
      const created = Number(new URL(key.url).searchParams.get("at"));
      if (Date.now() - created > 60 * 60 * 1000) await cache.delete(key);
    }
    const at = Date.now();
    await cache.put(new URL(`./receive-share?share=${id}&at=${at}`, site), new Response(form));
    return Response.redirect(new URL(`./?share=${id}&at=${at}`, site), 303);
  } catch {
    return rejected;
  }
}

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method === "POST" && request.mode === "navigate" && url.href === new URL("./receive-share", site).href) {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== "GET") return;
  if (request.mode === "navigate" && (url.pathname === site.pathname || url.pathname === new URL("./index.html", site).pathname)) {
    event.respondWith(fetch(request).catch(() => caches.open(cacheName).then(cache => cache.match(site.href))));
  } else if (assetUrls.has(url.href)) {
    event.respondWith(fetch(request).catch(() => caches.open(cacheName).then(cache => cache.match(url.href))));
  }
});
