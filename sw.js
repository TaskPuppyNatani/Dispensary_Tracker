const CACHE_NAME = "dispensary-tracker-v17";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./js/app.js",
  "./js/constants.js",
  "./js/db.js",
  "./js/state.js",
  "./js/utils.js",
  "./js/ocr.js",
  "./js/matcher.js",
  "./manifest.webmanifest",
  "./vendor/tesseract.min.js",
  "./vendor/jszip.min.js",
  "./vendor/worker.min.js",
  "./vendor/tesseract-core.wasm.js",
  "./vendor/tesseract-core.wasm",
  "./vendor/tesseract-core-simd.wasm.js",
  "./vendor/tesseract-core-simd.wasm",
  "./assets/tessdata/eng.traineddata.gz",
  "./assets/dispensaries.json",
  "./assets/dispensary_list/dispensaries.json",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((oldKey) => caches.delete(oldKey))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const requestUrl = new URL(event.request.url);
  const sameOrigin = requestUrl.origin === self.location.origin;
  const isNavigationRequest = event.request.mode === "navigate";
  const isAppCodeAsset =
    sameOrigin && /\.(?:html|js|css|webmanifest)$/i.test(requestUrl.pathname);

  if (isNavigationRequest || isAppCodeAsset) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  event.respondWith(cacheFirst(event.request));
});

async function networkFirst(request) {
  try {
    const networkResponse = await fetch(request);

    if (networkResponse && networkResponse.status === 200) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, networkResponse.clone());
    }

    return networkResponse;
  } catch (error) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }

    if (request.mode === "navigate") {
      return caches.match("./index.html");
    }

    throw error;
  }
}

async function cacheFirst(request) {
  const cachedResponse = await caches.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }

  const networkResponse = await fetch(request);
  if (networkResponse && networkResponse.status === 200) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, networkResponse.clone());
  }

  return networkResponse;
}
