/**
 * KaspaClash Service Worker
 * Provides offline caching and PWA functionality
 */

const CACHE_NAME = "kaspaclash-v1";
const STATIC_CACHE_NAME = "kaspaclash-static-v1";
const DYNAMIC_CACHE_NAME = "kaspaclash-dynamic-v1";

// Static assets to cache on install
const STATIC_ASSETS = [
  "/",
  "/matchmaking",
  "/practice",
  "/leaderboard",
  "/manifest.json",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png",
];

// Assets that should never be cached
const CACHE_BLACKLIST = [
  "/api/",
  "/m/",
  "supabase",
  "realtime",
];

// Install event - cache static assets
self.addEventListener("install", (event) => {
  console.log("[SW] Installing service worker...");
  
  event.waitUntil(
    caches.open(STATIC_CACHE_NAME).then((cache) => {
      console.log("[SW] Caching static assets");
      return cache.addAll(STATIC_ASSETS);
    })
  );
  
  // Activate immediately
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener("activate", (event) => {
  console.log("[SW] Activating service worker...");
  
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => {
            return (
              name.startsWith("kaspaclash-") &&
              name !== STATIC_CACHE_NAME &&
              name !== DYNAMIC_CACHE_NAME
            );
          })
          .map((name) => {
            console.log("[SW] Deleting old cache:", name);
            return caches.delete(name);
          })
      );
    })
  );
  
  // Take control of all clients immediately
  self.clients.claim();
});

// Fetch event - serve from cache, fall back to network
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  
  // Skip non-GET requests
  if (event.request.method !== "GET") {
    return;
  }
  
  // Skip blacklisted paths (API calls, real-time connections)
  if (CACHE_BLACKLIST.some((path) => url.pathname.includes(path) || url.href.includes(path))) {
    return;
  }
  
  // Skip cross-origin requests except for CDN assets
  if (url.origin !== location.origin && !url.href.includes("fonts.googleapis.com")) {
    return;
  }
  
  // Stale-while-revalidate for pages
  if (event.request.mode === "navigate") {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        const fetchPromise = fetch(event.request)
          .then((networkResponse) => {
            // Update cache with fresh response
            if (networkResponse.ok) {
              const responseClone = networkResponse.clone();
              caches.open(DYNAMIC_CACHE_NAME).then((cache) => {
                cache.put(event.request, responseClone);
              });
            }
            return networkResponse;
          })
          .catch(() => {
            // If network fails and no cache, return offline page
            return caches.match("/") || new Response("Offline", { status: 503 });
          });
        
        // Return cached version immediately, then update in background
        return cachedResponse || fetchPromise;
      })
    );
    return;
  }
  
  // Cache-first for static assets
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      
      return fetch(event.request).then((response) => {
        // Don't cache non-ok responses
        if (!response.ok) {
          return response;
        }
        
        // Cache successful responses
        const responseClone = response.clone();
        caches.open(DYNAMIC_CACHE_NAME).then((cache) => {
          cache.put(event.request, responseClone);
        });
        
        return response;
      });
    })
  );
});

// Handle push notifications (for future match notifications)
self.addEventListener("push", (event) => {
  if (!event.data) return;
  
  const data = event.data.json();
  const options = {
    body: data.body || "You have a new notification",
    icon: "/icons/icon-192x192.png",
    badge: "/icons/badge-72x72.png",
    vibrate: [100, 50, 100],
    data: data.data || {},
    actions: data.actions || [],
  };
  
  event.waitUntil(
    self.registration.showNotification(data.title || "KaspaClash", options)
  );
});

// Handle notification clicks
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  
  const urlToOpen = event.notification.data?.url || "/";
  
  event.waitUntil(
    clients.matchAll({ type: "window" }).then((clientList) => {
      // Focus existing window if open
      for (const client of clientList) {
        if (client.url === urlToOpen && "focus" in client) {
          return client.focus();
        }
      }
      // Otherwise open new window
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});

// Background sync for failed match moves (future feature)
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-moves") {
    event.waitUntil(syncPendingMoves());
  }
});

async function syncPendingMoves() {
  // Future: Implement background sync for failed move submissions
  console.log("[SW] Background sync triggered for moves");
}
