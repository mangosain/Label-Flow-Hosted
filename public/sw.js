"use strict";
const CACHE='labelflow-app-v3-3-script-isolation';
const ASSETS=['/','/index.html','/admin.html','/style.css?v=3.3','/beta-notice.js?v=3.3','/lines.js?v=3.3','/canvas.js?v=3.3','/admin.js?v=3.3','/local-backend.js?v=3.3','/image-worker.js','/import-worker.js','/export-worker.js','/browser-zip.js?v=3.3','/browser-exporter.js?v=3.3','/import-parsers.js?v=3.3','/manifest.webmanifest','/icon.svg'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>event.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))),self.clients.claim()])));
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET'||new URL(req.url).origin!==location.origin)return;
  event.respondWith(fetch(req).then(response=>{
    if(response.ok&&ASSETS.includes(new URL(req.url).pathname+new URL(req.url).search)){
      const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(req,copy)).catch(()=>{});
    }
    return response;
  }).catch(()=>caches.match(req)));
});
