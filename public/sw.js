/* global self, clients */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Show incoming push messages
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = data.title || 'New booking message';
  const body  = data.body || 'You have a new message.';
  const url   = data.url  || '/';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/public/icon-192.png',
      badge: '/public/icon-192.png',
      data: { url }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type:'window', includeUncontrolled:true }).then(list => {
      const client = list.find(c => c.url.includes(self.origin));
      if (client) { client.focus(); client.navigate(url); return; }
      return clients.openWindow(url);
    })
  );
});
