/// <reference lib="webworker" />
import { build, files, version } from '$service-worker';

declare const self: ServiceWorkerGlobalScope;
const cacheName = `lamplit-shell-${version}`;
const shellFiles = new Set([...build.filter((path) => /\.(?:js|css)$/.test(path)), ...files.filter((path) => ['/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'].includes(path))]);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll([...shellFiles])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('lamplit-shell-') && key !== cacheName).map((key) => caches.delete(key)))),
    self.clients.claim(),
  ]));
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (shellFiles.has(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
    return;
  }
  if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/chat')) {
    event.respondWith(fetch(request).then(async (response) => {
      if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
        const cache = await caches.open(cacheName);
        await cache.put(url.pathname, response.clone());
      }
      return response;
    }).catch(async () => (await caches.match(url.pathname)) ?? new Response('Offline', { status: 503 })));
  }
});
