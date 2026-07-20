// Service worker minimal — TIDAK mencegat request (biar tidak memperlambat)
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
// sengaja TANPA fetch handler → semua koneksi langsung ke internet, tak ada lapisan lambat