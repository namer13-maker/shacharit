/* שחרית — service worker */
var CACHE='shacharit-v2';
var SHELL=['./','./index.html','./app.js','./firebase-config.js','./manifest.json','./icon-192.png','./icon-512.png','./icon-maskable.png'];
self.addEventListener('install',function(e){e.waitUntil(caches.open(CACHE).then(function(c){return Promise.all(SHELL.map(function(u){return c.add(u).catch(function(){});}));}).then(function(){return self.skipWaiting();}));});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(keys){return Promise.all(keys.map(function(k){return k===CACHE?null:caches.delete(k);}));}).then(function(){return self.clients.claim();}));});
self.addEventListener('fetch',function(e){
  var req=e.request;if(req.method!=='GET')return;var url=new URL(req.url);
  // Firebase ואתרים חיצוניים — תמיד מהרשת, בלי לגעת במטמון
  if(url.origin!==self.location.origin)return;
  if(req.mode==='navigate'||url.pathname.endsWith('/')||url.pathname.endsWith('index.html')){
    e.respondWith(fetch(req).then(function(res){var copy=res.clone();caches.open(CACHE).then(function(c){c.put('./index.html',copy);});return res;}).catch(function(){return caches.match('./index.html').then(function(r){return r||caches.match('./');});}));return;
  }
  // app.js וקבצי מעטפת — רשת קודם כדי לקבל עדכונים, מטמון כגיבוי
  if(url.pathname.endsWith('app.js')||url.pathname.endsWith('firebase-config.js')){
    e.respondWith(fetch(req).then(function(res){var copy=res.clone();caches.open(CACHE).then(function(c){c.put(req,copy);});return res;}).catch(function(){return caches.match(req);}));return;
  }
  e.respondWith(caches.match(req).then(function(hit){return hit||fetch(req).then(function(res){var copy=res.clone();caches.open(CACHE).then(function(c){c.put(req,copy);});return res;});}));
});
