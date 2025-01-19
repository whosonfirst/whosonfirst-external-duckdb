const getDb = async () => {
    const duckdb = window.duckdbduckdbWasm;
    // @ts-ignore
    if (window._db) return window._db;
    
    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
    
    // Select a bundle based on browser checks
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
    
    const worker_url = URL.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker}");`], {
	    type: "text/javascript",
        })
    );
    
    // Instantiate the asynchronus version of DuckDB-wasm
    const worker = new Worker(worker_url);
    // const logger = null //new duckdb.ConsoleLogger();
    const logger = new duckdb.ConsoleLogger();
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(worker_url);
    window._db = db;
    return db;
};
