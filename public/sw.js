// public/sw.js
// Minimal service worker for Booking Hub:
// - Handles real Web Push ("push" event)
// - Mirrors page-posted notifications while app is open (message event)
// - Focuses or opens the app on click

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Show notification from Web Push payload
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = data.title || 'Booking Hub';
  const body  = data.body  || '';
  const url   = data.url   || '/';
  const icon  = '/public/icon-192.png';
  const badge = '/public/icon-192.png';

  event.waitUntil(self.registration.showNotification(title, {
    body, icon, badge, data: { url },
  }));
});

// Mirror page notifications when tab is backgrounded
self.addEventListener('message', (e) => {
  const { title='Booking Hub', body='', url='/' } = e.data || {};
  self.registration.showNotification(title, {
    body, icon: '/public/icon-192.png', badge: '/public/icon-192.png', data: { url }
  });
});

// Focus an existing window or open one
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || '/';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) {
      try {
        if (c.url && c.url.includes(self.registration.scope)) {
          await c.focus();
          if ('navigate' in c) { await c.navigate(url); }
          return;
        }
      } catch {}
    }
    await self.clients.openWindow(url);
  })());
});

// Attempt auto-resubscribe hook (best-effort; actual resubscribe still happens in page code)
self.addEventListener('pushsubscriptionchange', async () => {
  // No-op here; page will handle re-subscribe.
});
