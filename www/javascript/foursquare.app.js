export { start };

var map;
var base_layer;
var markers_layer;
var locality_layers = [];
var neighbourhood_layers = [];
var popups = {};

var dt_formatter;
var num_formatter;

var foursquare_venues_url;
var whosonfirst_properties_url;
var pmtiles_data_url;

async function start(db){

    var foursquare_venues = document.body.getAttribute("data-foursquare-venues");
    var whosonfirst_properties = document.body.getAttribute("data-whosonfirst-properties");
    var pmtiles_data = document.body.getAttribute("data-pmtiles");        

    var foursquare_url = new URL("http://localhost:8080");
    foursquare_url.pathname = "/data/" + foursquare_venues;

    var whosonfirst_url = new URL("http://localhost:8080");
    whosonfirst_url.pathname = "/data/" + whosonfirst_properties;

    var pmtiles_url = new URL("http://localhost:8080");
    pmtiles_url.pathname = "/pmtiles/" + pmtiles_data;
    
    foursquare_venues_url = foursquare_url.toString();
    whosonfirst_properties_url = whosonfirst_url.toString();
    pmtiles_data_url = pmtiles_url.toString();
    
    var fb = document.getElementById("feedback");
    
    var query_el = document.getElementById("q");
    var locality_el = document.getElementById("locality");
    var neighbourhood_el = document.getElementById("neighbourhood");	   	   
    var button_el = document.getElementById("submit");
    
    // en-CA is important in order to get YYYY-MM-dd formatting. Go, Canada!
    dt_formatter = new Intl.DateTimeFormat('en-CA', {
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	timeZone: 'America/Los_Angeles',		    
    });	   

    num_formatter = new Intl.NumberFormat();
        
    fb.innerText = "Connecting to database";
    
    const conn = await db.connect();
    
    fb.innerText = "Setting up map";   
    
    // Apparently ST_Extent_Agg is not available in duckdb-wasm
    // await conn.query("LOAD spatial");    
    // const extent_r = await conn.query("SELECT ST_Extent_Agg(geom) FROM (SELECT ST_GeomFromWKB(geom) FROM read_parquet('http://localhost:8080/data/sfba-foursquare.parquet')) AS _(geom)");
    // Error: Catalog Error: Scalar Function with name st_extent_agg does not exist!
    // Did you mean "ST_Extent"?
    // LINE 1: SELECT ST_Extent_Agg(geom) FROM (SELECT ST_Geo...
    
    var min_x;
    var min_y;
    var max_x;
    var max_y;
    
    try {
	const minx_r = await conn.query("SELECT longitude FROM read_parquet('" + foursquare_venues_url + "') ORDER by longitude ASC LIMIT 1");
	const miny_r = await conn.query("SELECT latitude FROM read_parquet('" + foursquare_venues_url + "') ORDER by latitude ASC LIMIT 1");
	const maxx_r = await conn.query("SELECT longitude FROM read_parquet('" + foursquare_venues_url + "') ORDER by longitude DESC LIMIT 1");
	const maxy_r = await conn.query("SELECT latitude FROM read_parquet('" + foursquare_venues_url + "') ORDER by latitude DESC LIMIT 1");	   
	
	min_x = minx_r.toArray()[0].longitude;
	min_y = miny_r.toArray()[0].latitude;
	max_x = maxx_r.toArray()[0].longitude;
	max_y = maxy_r.toArray()[0].latitude;
	
    } catch(err) {
	fb.innerText = "Failed to derive extent, " + err;
	console.error(err);	       
	return;
    }
    
    var bounds = [
	[ min_y, min_x ],
	[ max_y, max_x ],
    ];
    
    map = L.map('map');    
    map.fitBounds(bounds);
        
    base_layer = protomapsL.leafletLayer({
	url: pmtiles_data_url,	// 'http://localhost:8080/pmtiles/sfba.pmtiles',
	theme:"white"
    });
    
    base_layer.addTo(map);

    const panes = {
	"popups": 4000,
	"markers": 3000,
	"neighbourhoods": 2000,
	"localities": 1000,
    };

    for (var label in panes) {
	var p = map.createPane(label);
	p.style.zIndex = panes[label];
    }
    
    fb.innerText = "Setting up localities";

    fetch_localities(conn);
    
    fb.innerText = "Setting up search table";
    
    await conn.query("CREATE TABLE search AS SELECT fsq_place_id AS id, name, address, JSON_EXTRACT(\"wof:hierarchies\", '$[0].locality_id') AS locality_id, JSON_EXTRACT(\"wof:hierarchies\", '$[0].neighbourhood_id') AS neighbourhood_id FROM read_parquet('" + foursquare_venues_url + "')");
    
    fb.innerText = "Indexing search table";	   
    
    await conn.query("PRAGMA create_fts_index('search', 'id', 'name', 'address', 'locality_id', 'neighbourhood_id')");
    
    fb.innerText = "Ready to search";
    
    button_el.removeAttribute("disabled");
    query_el.removeAttribute("disabled");
    locality_el.removeAttribute("disabled");
    neighbourhood_el.removeAttribute("disabled");	   	   
    
    button_el.onclick = async function(e){
	
	if (markers_layer){
	    map.removeLayer(markers_layer);
	    markers_layer = null;
	    popups = {};	    
	}

	for (var i in neighbourhood_layers){
	    map.removeLayer(neighbourhood_layers[i]);
	}

	for (var i in locality_layers){
	    map.removeLayer(locality_layers[i]);
	}
	
	neighbourhood_layers = [];
	locality_layers = [];
	
	do_search(conn);
	return false;
    };
    
}

function draw_names(select_el, names_table, onchange_cb) {

    var lookup = {};
    var names = [];
    
    for (var id in names_table){
	    
	var name = names_table[id];
	
	if(names.indexOf(names) == -1){
	    names.push(name);
	}
	
	var ids = lookup[name];
	
	if (!ids){
	    ids = [];
	}
	
	ids.push(id);
	lookup[name] = ids;
    }
    
    names.sort()

    select_el.innerHTML = "";
    
    var opt = document.createElement("option");
    opt.setAttribute("value", "-1");
    opt.appendChild(document.createTextNode(""));
    
    select_el.appendChild(opt);
    
    for (var i in names){
	
	var name = names[i];
	var ids = lookup[name];
	
	for (var j in ids){
	    
	    var id = ids[j];
	    
	    var opt = document.createElement("option");
	    opt.setAttribute("value", id);
	    opt.appendChild(document.createTextNode(name));
	    
	    select_el.appendChild(opt);
	}
    }
    
    if (onchange_cb) {
	select_el.onchange = onchange_cb;
    }
}

async function do_search(conn){

    var fb = document.getElementById("feedback");
    
    var query_el = document.getElementById("q");
    var locality_el = document.getElementById("locality");
    var neighbourhood_el = document.getElementById("neighbourhood");	   	   
    var results_el = document.getElementById("results");
    
    results_el.innerText = "";
    
    var q = query_el.value;
    var locality_id = parseInt(locality_el.value);
    var neighbourhood_id = parseInt(neighbourhood_el.value);	       
    
    fb.innerText = "Performing search";
    
    var where = [
	"score IS NOT NULL",
    ];
    
    if ((locality_id) && (locality_id != -1)){
	where.push("locality_id = " + locality_id);
    }
    
    if ((neighbourhood_id) && (neighbourhood_id != -1)){
	where.push("neighbourhood_id = " + neighbourhood_id);
    }
    
    const str_where = where.join(" AND ");
    
    // Note the "conjunctive := 1" bit - this is what is necessary to match all the terms
    const ids_results = await conn.query("SELECT fts_main_search.match_bm25(id, '" + q + "', conjunctive := 1) AS score, id FROM search WHERE " + str_where + " ORDER BY score DESC");
    
    var ids_count = ids_results.toArray().length;
    
    if (! ids_count){
	fb.innerText = "No results found. Ready to search";
	return false;
    }
    
    var ids_list = [];
    
    for (const row of ids_results) {
	ids_list.push("'" + row.id + "'");
    }
    
    const search_results = await conn.query("SELECT fsq_place_id AS id, name, address, locality, JSON(fsq_category_labels) AS categories, latitude, longitude FROM read_parquet('" + foursquare_venues_url + "') WHERE fsq_place_id IN ( " + ids_list.join(",") + ") AND date_closed IS NULL");

    if ((locality_id) && (locality_id != -1)){
	draw_geometry(conn, "localities", locality_id);
    }
    
    if ((neighbourhood_id) && (neighbourhood_id != -1)){
	draw_geometry(conn, "neighbourhoods", neighbourhood_id);	
    }
    
    await draw_search_results(search_results);
}

async function draw_geometry(conn, pane, id) {

    const geom = await get_geometry(conn, id);

    if (! geom){
	return
    }

    var geom_layer = L.geoJSON(geom);
    geom_layer.addTo(map, { 'pane': pane });

    switch (pane){
	case "localities":
	    locality_layers.push(geom_layer);
	    break;
	case "neighbourhoods":
	    neighbourhood_layers.push(geom_layer);
	    break;
    }
}

async function draw_search_results(search_results) {

    var fb = document.getElementById("feedback");
    
    var query_el = document.getElementById("q");
    var locality_el = document.getElementById("locality");
    var neighbourhood_el = document.getElementById("neighbourhood");	   	   
    var results_el = document.getElementById("results");
    
    var count_results = search_results.toArray().length;
    
    var list_el = document.createElement("ul");
    
    switch (count_results) {
	case 1:
	    fb.innerText = "Compiling only result";
	    break;
	default:
	    fb.innerText = "Compiling " + count_results + " results";
	    break;
    }
    
    var features = [];
    
    for (const row of search_results) {
	
	var props = {
	    'id': row.id,
	    'name': row.name,
	    'address': row.address,
	    'locality': row.locality,
	    'categories': JSON.parse(row.categories),
	};
	
	var geom = {
	    'type': 'Point',
	    'coordinates': [ row.longitude, row.latitude ],
	};
	
	var f = {
	    'type': 'Feature',
	    'geometry': geom,
	    'properties': props,
	}
	
	features.push(f);

	var popup_func = function(e){
	    
	    var el = e.target;
	    var id = el.getAttribute("data-id");

	    var p = popups[id];

	    if (p){
		console.log("TOGGLE");
		p.togglePopup();
	    }
	    
	    return false;
	};
	
	var item = document.createElement("li");
	item.setAttribute("id", row.id);
	item.setAttribute("class", "venue");
	
	var name = document.createElement("div");
	name.setAttribute("data-id", row.id);	
	name.setAttribute("class", "venue-name");
	name.appendChild(document.createTextNode(row.name));
	name.onclick = popup_func;
	
	item.appendChild(name);
	
	var loc_els = [];
	
	if (row.address){
	    loc_els.push(row.address);
	}

	if (row.locality){
	    loc_els.push(row.locality);
	}

	if (loc_els.length > 0){
	    
	    var loc = document.createElement("div");
	    loc.setAttribute("data-id", row.id);
	    loc.setAttribute("class", "venue-location");
	    loc.appendChild(document.createTextNode(loc_els.join(", ")));
	    loc.onclick = popup_func;
	    
	    item.appendChild(loc);
	}

	/*

	    Dining and Drinking > Restaurant > Asian Restaurant > Japanese Restaurant
	    Dining and Drinking > Restaurant > Asian Restaurant
            Dining and Drinking > Restaurant > Asian Restaurant > Korean Restaurant
	*/
	
	if (row.categories){
	    
	    var categories_list = JSON.parse(row.categories);
	    var foo = {};

	    for (var c in categories_list){

		var parts = categories_list[c].split(" > ");
		var count = parts.length;

		for (var p=0; p < count; p++){

		    var label = parts[p];
		    var keys = parts.slice(0, p);

		    // var str_key = keys.join(" > ");
		    
		    console.log("DEBUG", keys, label);
		}
		
	    }
	    
	}
	
	if (row.categories){
	    
	    var categories_list = JSON.parse(row.categories);
	    
	    var categories_ul = document.createElement("ul");
	    categories_ul.setAttribute("class", "venue-categories");

	    for (var c in categories_list){

		var categories_li = document.createElement("li");
		categories_li.appendChild(document.createTextNode(categories_list[c]));
		categories_ul.appendChild(categories_li);
	    }
	    
	    item.appendChild(categories_ul);
	}
	
	list_el.appendChild(item);
    }
    
    var circle_opts = {
	pane: "markers",
	radius: 8,
	fillColor: "#ff7800",
	color: "#000",
	weight: 1,
	opacity: 1,
	fillOpacity: 0.8
    };
    
    var markers_opts = {
	pointToLayer: function (feature, latlng) {
	    return L.circleMarker(latlng, circle_opts);
	},
	onEachFeature: function (feature, layer) {

	    var id = feature.properties.id;
	    
	    var popup = L.popup({
		pane: "popups",
	    });

	    popup.setContent(function(){

		var el = document.getElementById(id);

		if (el){
		    // https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollIntoView		    
		    el.scrollIntoView();
		}
		
		return feature.properties.name
	    });	   	    
	    
	    popups[id] = layer.bindPopup(popup);
	},
    };

    
    markers_layer = L.geoJSON(features, markers_opts);
    markers_layer.addTo(map);

    if (features.length > 1){

	var fc = {
	    'type': 'FeatureCollection',
	    'features': features,
	};
	
	var bounds = whosonfirst.spelunker.geojson.derive_bounds(fc);
	map.fitBounds(bounds);
	
    } else {
	var coords = features[0].geometry.coordinates;
	map.setView([coords[1], coords[0]], 14);
    }
    
    results_el.appendChild(list_el);
    
    switch (count_results){
	case 1:
	    fb.innerText = "Ready to search again.";
	    break;
	default:		       
	    fb.innerText = num_formatter.format(count_results) + " results. Ready to search again.";
	    break;
    }
}

async function fetch_localities(conn){

    var fb = document.getElementById("feedback");
    
    var query_el = document.getElementById("q");
    var locality_el = document.getElementById("locality");
    var wrapper_el = document.getElementById("locality-wrapper");    
    
    // Note: It is not really useful to use SELECT DISTINCT(locality) FROM read_parquet('sfba-foursquare.parquet') ORDER BY locality ASC;
    // because it just returns garbage and gibberish.
    
    // Wut: The first query triggers the following error:
    // DuckDB: Error: Binder Error: Cannot extract field 'locality_id' from expression "array_extract(CAST(json_extract(wof:hierarchies, '$') AS VARCHAR), CAST(0 AS BIGINT))" because it is not a struct or a union
    // const locality_results = await conn.query("SELECT DISTINCT(JSON(\"wof:hierarchies\")[0].locality_id) FROM read_parquet('" + foursquare_venues_url + "')");
    
    // This however works...
    const locality_results = await conn.query("SELECT DISTINCT(JSON_EXTRACT_STRING(\"wof:hierarchies\", '$[0].locality_id')) AS locality_id FROM read_parquet('" + foursquare_venues_url + "')");
    
    var locality_onchange = async function(e){
	var el = e.target;
	var locality_id = el.value;
	
	fetch_neighbourhoods(conn, locality_id);
	return false;
    };

    fb.innerText = "Setting up localities";

    var locality_names = {};
    var locality_ids = [];
    
    for (const row of locality_results) {

	if (! row.locality_id){
	    continue;
	}
	
	locality_ids.push("'" + row.locality_id + "'");
    }

    var str_ids = locality_ids.join(",");

    const names_results = await conn.query("SELECT id, name, FROM read_parquet('" + whosonfirst_properties_url + "') WHERE id IN (" + str_ids + ")");

    for (const row of names_results){
	locality_names[row.id] = row.name;
    }

    draw_names(locality_el, locality_names, locality_onchange);
    wrapper_el.style.display = "block";
}

async function fetch_neighbourhoods(conn, locality_id) {

    var fb = document.getElementById("feedback");

    var locality_el = document.getElementById("locality");    
    var neighbourhood_el = document.getElementById("neighbourhood");
    var wrapper_el = document.getElementById("neighbourhood-wrapper");	   	       
    
    neighbourhood_el.innerHTML = "";
    
    if (locality_id == -1){
	wrapper_el.style.display = "none";
	return;
    }
    
    // locality_el.setAttribute("disabled", "disabled");
    // neighbourhood_el.setAttribute("disabled", "disabled");
    
    fb.innerText = "Fetching neighbourhoods";
    
    const neighbourhood_results = await conn.query("SELECT DISTINCT(JSON_EXTRACT_STRING(\"wof:hierarchies\", '$[0].neighbourhood_id')) AS neighbourhood_id FROM read_parquet('" + foursquare_venues_url + "') WHERE JSON_EXTRACT(\"wof:hierarchies\", '$[0].locality_id') = '" + locality_id + "'");
    
    var neighbourhood_names = {};	
    var neighbourhood_ids = [];
    
    for (const row of neighbourhood_results) {
	
	if (row.neighbourhood_id == null){
	    continue;
	}
	
	neighbourhood_ids.push("'" + row.neighbourhood_id + "'");
    }

    if (neighbourhood_ids.length == 0){
	fb.innerText = "No neighbourhoods found for locality. Ready to search.";
	wrapper_el.style.display = "none";
	return;
    }
    
    var str_ids = neighbourhood_ids.join(",");
    
    const names_results = await conn.query("SELECT id, name  FROM read_parquet('" + whosonfirst_properties_url + "') WHERE id IN (" + str_ids + ")");
    
    for (const row of names_results){
	neighbourhood_names[row.id] = row.name;
    }
    
    draw_names(neighbourhood_el, neighbourhood_names);
    
    // locality_el.removeAttribute("disabled");
    // neighbourhood_el.removeAttribute("disabled");
    fb.innerText = "Ready to search";
    
    wrapper_el.style.display = "block";    
}

async function fetch_categories(conn, placetype, wof_id) {

    // SELECT fsq_category_ids, fsq_category_labels FROM read_parquet('" + foursquare_venues_url + "') WHERE JSON("wof:hierarchies")[0].locality_id = '85921881' GROUP BY fsq_category_ids, fsq_category_labels ORDER BY fsq_category_labels;

}

async function get_geometry(conn, id) {

    try {
	
	const results = await conn.query("SELECT geometry FROM read_parquet('" + whosonfirst_properties_url + "') WHERE id = '" + id + "'");
	const row = results.get(0)

	if (! row){
	    console.log("No results", id);
	    return;
	}
	
	const geom = JSON.parse(row.geometry);
	return geom
	
    } catch (err) {
	console.error("Failed to get geometry for feature", id, err);
    }
}
