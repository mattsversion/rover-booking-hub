// public/sw.js
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => self.clients.claim());

// Show notifications sent from the page (fallback while the tab is open)
self.addEventListener('message', (e) => {
  const { title = 'Notification', body = '', url = '/', icon = '/public/icon-192.png', badge = '/public/icon-192.png' } = e.data || {};
  self.registration.showNotification(title, { body, icon, badge, data: { url } });
});

// TRUE Web Push: display notifications when a push payload arrives
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch {}
  const title = payload.title || '📩 Booking Hub';
  const body  = payload.body  || 'New message';
  const url   = payload.url   || '/';
  const icon  = payload.icon  || '/public/icon-192.png';
  const badge = payload.badge || '/public/icon-192.png';

  event.waitUntil(
    self.registration.showNotification(title, { body, icon, badge, data: { url } })
  );
});

// Focus/open app on notification click
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification?.data?.url || '/';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) {
      try { await c.focus(); } catch {}
      // navigate if possible (not all UAs support navigate)
      if ('navigate' in c) { try { await c.navigate(target); return; } catch {} }
      return;
    }
    await self.clients.openWindow(target);
  })());
});
