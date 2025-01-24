const cache_name = 'sfba-v0.0.1';

const app_files = [
    
    // HTML
    "./index.html",
    "./foursquare/index.html",
    
    // CSS
    "./css/bootstrap.min.css",
    "./css/leaflet.css",
    "./css/foursquare.css",
    
    // Data files
    
    "./data/sfba-foursquare.parquet",
    "./data/sfba-whosonfirst.parquet",

    // PMTiles
    
    "./pmtiles/sfba.pmtiles",

    // WASM

    "./duckdb-wasm-local/apache-arrow.js",
    "./duckdb-wasm-local/duckdb-browser-eh.worker.js",
    "./duckdb-wasm-local/duckdb-eh.wasm",
    "./duckdb-wasm-local/duckdb-wasm.js",
    "./duckdb-wasm-local/flatbuffers.js",
    "./duckdb-wasm-local/tslib.js",            
    
    // Javascript

    "./javascript/offline.js",
    "./javascript/foursquare.app.js",
    "./javascript/foursquare.init.js",
    "./javascript/leaflet.js",
    "./javascript/protomaps-leaflet.js",
    "./javascript/whosonfirst.spelunker.geojson.js",                        

    // Service worker
    
    "./sw.js"    
];

self.addEventListener("install", (e) => {

    console.log("SW installed", cache_name);

    e.waitUntil((async () => {
	const cache = await caches.open(cache_name);
	// console.log('[Service Worker] Caching all: app shell and content');
	await cache.addAll(app_files);
    })());
});

self.addEventListener("activate", (event) => {
    console.log("SW activate", cache_name);
});

self.addEventListener("message", (event) => {
    // event is a MessageEvent object
    console.log(`The service worker sent me a message: ${event.data}`);
  });


// https://developer.mozilla.org/en-US/docs/Web/API/FetchEvent

self.addEventListener('fetch', (e) => {

    console.log("FETCH", e);
    
    // https://developer.mozilla.org/en-US/docs/Web/API/Cache
    
    e.respondWith((async () => {

	console.log("fetch", cache_name, e.request.url);
	
	const cache = await caches.open(cache_name);
	const r = await cache.match(e.request);
	
	console.log(`[Service Worker] Fetching resource: ${e.request.url}`);
	
	if (r) {
	    console.log("return cache", e.request.url);
	    return r;
	}
	
	const response = await fetch(e.request);
	
	console.log(`[Service Worker] Caching new resource: ${e.request.url}`);
	cache.put(e.request, response.clone());
	
	return response;
    })());
    
});
