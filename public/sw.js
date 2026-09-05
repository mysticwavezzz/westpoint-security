// Westpoint Security Service Worker - Push Notifications
self.addEventListener('push', function(event) {
  let data = { title: 'Westpoint Security Portal', body: 'New department update.' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body || 'Operational notification',
    icon: '/assets/logo.png',
    badge: '/assets/logo.png',
    data: data.url || '/employee/dashboard',
    vibrate: [100, 50, 100]
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Westpoint Security', options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const targetUrl = event.notification.data || '/employee/dashboard';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (let i = 0; i < clientList.length; i++) {
        const client = clientList[i];
        if (client.url.includes('/employee') && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
