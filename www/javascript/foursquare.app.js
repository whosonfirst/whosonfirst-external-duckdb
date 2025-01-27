export { start };

var conn;

var map;
var base_layer;
var markers_layers = [];
var locality_layers = [];
var neighbourhood_layers = [];
var pointinpolygon_layers = {};
var popups = {};

var dt_formatter;
var num_formatter;

var foursquare_venues_url;
var whosonfirst_properties_url;
var pmtiles_data_url;

var filters = {};

var query_el = document.getElementById("q");
var categories_el = document.getElementById("categories");    
var locality_el = document.getElementById("locality");
var neighbourhood_el = document.getElementById("neighbourhood");
var filters_el = document.getElementById("filters");
var button_el = document.getElementById("submit");

var feedback_el = document.getElementById("feedback");
var results_el = document.getElementById("results");

async function start(db){

    var url_prefix = document.body.getAttribute("data-url-prefix");
    var foursquare_venues = document.body.getAttribute("data-foursquare-venues");
    var whosonfirst_properties = document.body.getAttribute("data-whosonfirst-properties");
    var pmtiles_data = document.body.getAttribute("data-pmtiles");        

    var root_url = location.protocol + "//" + location.host;
    
    var data_root = "/data/";
    var pmtiles_root = "/pmtiles/";
    
    if (url_prefix){
	data_root = url_prefix + data_root;
	pmtiles_root = url_prefix + pmtiles_root;	
    }

    var foursquare_url = new URL(root_url);
    foursquare_url.pathname = data_root + foursquare_venues;

    var whosonfirst_url = new URL(root_url);
    whosonfirst_url.pathname = data_root + whosonfirst_properties;

    var pmtiles_url = new URL(root_url);
    pmtiles_url.pathname = pmtiles_root + pmtiles_data;
    
    foursquare_venues_url = foursquare_url.toString();
    whosonfirst_properties_url = whosonfirst_url.toString();
    pmtiles_data_url = pmtiles_url.toString();
        
    // en-CA is important in order to get YYYY-MM-dd formatting. Go, Canada!
    dt_formatter = new Intl.DateTimeFormat('en-CA', {
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	timeZone: 'America/Los_Angeles',		    
    });	   

    num_formatter = new Intl.NumberFormat();
        
    feedback_el.innerText = "Connecting to database";
    
    conn = await db.connect();

    feedback_el.innerText = "Loading extensions";
    
    feedback_el.innerText = "Setting up map";   
    
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
	feedback_el.innerText = "Failed to derive extent, " + err;
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
	url: pmtiles_data_url,
	theme:"white"
    });
    
    base_layer.addTo(map);

    const panes = {
	"popups": 4000,
	"markers": 3000,
	"neighbourhoods": 2000,
	"pointinpolygon": 3100,		
	"localities": 1000,
    };

    for (var label in panes) {
	var p = map.createPane(label);
	p.style.zIndex = panes[label];
    }

    // onmove PIP handler is installed below
    // after search is ready
    
    feedback_el.innerText = "Setting up localities";

    await fetch_localities(conn);

    // Borough?
    // Macrohood?

    
    feedback_el.innerText = "Setting up categories";

    const categories_results = await conn.query("SELECT DISTINCT(JSON_EXTRACT_STRING(fsq_category_labels, '$[*]')) AS category FROM read_parquet('" + foursquare_venues_url + "') ORDER BY category ASC");

    var categories_list = [];

    for (const row of categories_results){

	if (row.category){
	    row.category.toArray().forEach( path => categories_list.push(path));
	}
    }

    const categories_dict = buildCetgoriesDictionary(categories_list);
    
    var opt = document.createElement("option");
    categories_el.appendChild(opt);
    
    for (var k in categories_dict){
	var opt = document.createElement("option");
	opt.setAttribute("value", k);
	opt.appendChild(document.createTextNode(k));
	categories_el.appendChild(opt);
    }
    
    feedback_el.innerText = "Setting up search table";
    
    await conn.query("CREATE TABLE search AS SELECT fsq_place_id AS id, name, address, JSON_EXTRACT_STRING(fsq_category_labels, '$[*]') AS categories, JSON_EXTRACT(\"wof:hierarchies\", '$[0].locality_id') AS locality_id, JSON_EXTRACT(\"wof:hierarchies\", '$[0].neighbourhood_id') AS neighbourhood_id FROM read_parquet('" + foursquare_venues_url + "')");
    
    feedback_el.innerText = "Indexing search table";	   
    
    await conn.query("PRAGMA create_fts_index('search', 'id', 'name', 'address', 'categories', 'locality_id', 'neighbourhood_id')");

    setup_pointinpolygon();
    
    feedback("Ready to search");
    
    button_el.removeAttribute("disabled");
    query_el.removeAttribute("disabled");
    categories_el.removeAttribute("disabled");    
    locality_el.removeAttribute("disabled");
    neighbourhood_el.removeAttribute("disabled");	   	   
    
    button_el.onclick = async function(e){
	
	do_search();
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

    var current_value = select_el.value;
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

    select_el.value = current_value;
    if (onchange_cb) {
	select_el.onchange = onchange_cb;
    }
}

async function do_search(){

    // Purge the map

    for (var i in markers_layers){    
	map.removeLayer(markers_layers[i]);
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
    
    // Set up DOM elements
        
    results_el.innerText = "";
    
    var q = query_el.value;
    var category = categories_el.value;
    var locality_id = parseInt(locality_el.value);
    var neighbourhood_id = parseInt(neighbourhood_el.value);	       

    
    feedback_el.innerText = "Performing search";
    
    var where = [];

    if (q){
	where.push("score IS NOT NULL");
    }
    
    if ((locality_id) && (locality_id != -1)){
	where.push("locality_id = " + locality_id);
    }
    
    if ((neighbourhood_id) && (neighbourhood_id != -1)){
	where.push("neighbourhood_id = " + neighbourhood_id);
    }

    if (category){
	where.push("categories LIKE '%" + category + "%'");
    }
    
    const str_where = where.join(" AND ");   

    var search_q = "SELECT id FROM search WHERE " + str_where + " ORDER BY name ASC";

    if (q){
	// Note the "conjunctive := 1" bit - this is what is necessary to match all the terms	
	search_q = "SELECT fts_main_search.match_bm25(id, '" + q + "', conjunctive := 1) AS score, id FROM search WHERE " + str_where + " ORDER BY score DESC"
    }

    console.log(search_q);
    
    const ids_results = await conn.query(search_q);
    
    var ids_count = ids_results.toArray().length;
    
    if (! ids_count){
	feedback("No results found. Ready to search");
	return false;
    }

    feedback_el.innerText = "Gathering results: " + ids_count;

    if ((locality_id) && (locality_id != -1)){
	draw_geometry(conn, "localities", locality_id);
    }
    
    if ((neighbourhood_id) && (neighbourhood_id != -1)){
	draw_geometry(conn, "neighbourhoods", neighbourhood_id);	
    }

    var count_rendered = 0;
    
    var fetch_ids = async function(ids_list){

	count_rendered += ids_list.length;

	feedback_el.innerText = "Rendering " + num_formatter.format(count_rendered) + " of " + num_formatter.format(ids_count) + " results";
	
	var results_where = [
	    "fsq_place_id IN ( " + ids_list.join(",") + ")",
	    "date_closed IS NULL",
	];
	
	var count_filters = filters_el.childElementCount;
	
	if (count_filters){
	    
	    var categories = [];
	    
	    for (var i=0; i < count_filters; i++){
		
		var f = filters_el.children[i];
		var c = f.getAttribute("data-categories");
		
		if (! c){
		    continue;
		}
		
		categories.push("categories LIKE '%" + c + "%'");
	    }
	    
	    if (categories.length){
		results_where.push("(" + categories.join(" OR ") + ")");
	    }
	}
	
	var str_results_where = results_where.join(" AND ");
	
	const search_results = await conn.query("SELECT fsq_place_id AS id, name, address, locality, JSON(fsq_category_labels) AS categories, latitude, longitude FROM read_parquet('" + foursquare_venues_url + "') WHERE " + str_results_where);
	
	await draw_search_results(search_results);
    };
    
    var ids_list = [];
    
    for (const row of ids_results) {
	
	ids_list.push("'" + row.id + "'");

	if (ids_list.length >= 1000){
	    await fetch_ids(ids_list);
	    ids_list = [];
	}
    }

    if (ids_list.length){
	fetch_ids(ids_list);
    }

    switch (ids_count){
	case 1:
	    feedback("Ready to search again.");
	    break;
	default:		       
	    feedback(num_formatter.format(ids_count) + " results. Ready to search again.");
	    break;
    }
    
}

async function draw_geometry(conn, pane, id) {

    const geom = await get_geometry(conn, id);

    if (! geom){
	return
    }

    var layer_args = {
	'pane': pane,
    };

    var geom_args = {};
    
    if (pane == "pointinpolygon"){

	function onEachFeature(feature, layer) {
	    layer.on('click', function (e) {
		console.log("CLICK", feature);
	    });
	}
	geom_args = {
	    onEachFeature: onEachFeature,
	};
    }

    var geom_layer = L.geoJSON(geom, geom_args);
    geom_layer.addTo(map, layer_args);

    switch (pane){
	case "localities":
	    locality_layers.push(geom_layer);
	    break;
	case "neighbourhoods":
	    neighbourhood_layers.push(geom_layer);
	    break;
	case "pointinpolygon":
	    pointinpolygon_layers[id] = geom_layer;
	    break;
	    
    }
}

async function draw_pointinpolygon_row(row, locality_id) {

    const props = {
	'id': row.id,
	'name': row.name,
	'placetype': row.placetype,
	'locality_id': locality_id,
    };

    const geom = JSON.parse(row.geometry);    

    const f = {
	type: 'Feature',
	properties: props,
	geometry: geom,
    };

    var layer_args = {
	'pane': 'pointinpolygon',
    };

    var geom_args = {
	style: {
	    fillColor: "#fff",
	    color: "#f0149b",
	    weight: 4,
	    opacity: .8,
	    fillOpacity: 0,
	},
	onEachFeature: function(feature, layer) {
	    layer.on('click', function (e) {
		
		const props = feature.properties;
		const id = props.id;
		const pt = props.placetype;
		
		switch(pt){
		    case "neighbourhood":

			locality_el.value = props.locality_id;			
			neighbourhood_el.value = id;
			break;
			
		    case "locality":
			
			neighbourhood_el.value = -1;
			locality_el.value = id;
			break;
			
		    default:
			break;
		}

		return false;
	    });
	}
    }

    var geom_layer = L.geoJSON(f, geom_args);
    geom_layer.addTo(map, layer_args);

    pointinpolygon_layers[row.id] = geom_layer;
}

async function draw_search_results(search_results) {

    var count_results = search_results.toArray().length;
    
    var list_el = document.createElement("ul");
    
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
	    var categories_dict = buildCetgoriesDictionary(categories_list);
	    
	    var breadcrumbs = [];
	    
	    var render = function(dict){

		for (const k in dict){

		    const v = dict[k];
		    
		    if (! v){

			var categories_ul = document.createElement("ul");
			categories_ul.setAttribute("class", "venue-categories");
			
			var to_render = breadcrumbs;
			to_render.push(k);

			var render_count = to_render.length;
			
			for (var r=0; r < render_count; r++){

			    var anchor = document.createElement("a");
			    anchor.setAttribute("href", "#");
			    anchor.setAttribute("data-categories", to_render.slice(0, r + 1).join(" > "));
			    anchor.appendChild(document.createTextNode(to_render[r]));

			    anchor.onclick = function(e){

				var el = e.target;
				var categories = el.getAttribute("data-categories");

				if (! categories){
				    console.error("Element is missing data-categories attribute", el);
				    return false;
				}

				var add_filter = true;

				for (var k in filters){

				    if (k.startsWith(categories)){
					add_filter = false;
					break;
				    }
				}
				
				if (add_filter){
				    filters[categories] = true;
				    draw_filters();
				    do_search();
				}
				
				return false;
			    };
			    
			    var categories_li = document.createElement("li");
			    categories_li.appendChild(anchor);
			    categories_ul.appendChild(categories_li);
			}

			item.appendChild(categories_ul);
    			
			// console.log(row.id, breadcrumbs, k);
			continue;
		    }
		    
		    breadcrumbs.push(k);
		    render(v);
		    breadcrumbs.pop();
		}
	    };

	    render(categories_dict);
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

    
    var markers_layer = L.geoJSON(features, markers_opts);
    markers_layer.addTo(map);

    markers_layers.push(markers_layer);
    
    switch (features.length){
	case 0:
	    break;
	case 1:
	    var coords = features[0].geometry.coordinates;
	    map.setView([coords[1], coords[0]], 14);
	    break;
	default:
	    var fc = {
		'type': 'FeatureCollection',
		'features': features,
	    };
	    
	    var bounds = whosonfirst.spelunker.geojson.derive_bounds(fc);
	    map.fitBounds(bounds);
	    break;
    }
    
    results_el.appendChild(list_el);
}

async function setup_pointinpolygon(){

    console.log("SET UP PIP");
    // Set up PIP handlers

    await conn.query("INSTALL spatial");    
    await conn.query("LOAD spatial");

    map.on("moveend", async function(){

	var location_el = document.getElementById("location");
	
	var loc = map.getCenter();

	// START OF put me in a function...
	var wkt = "POINT(" + loc.lng + " " + loc.lat + ")";

	const locality_query = "SELECT * FROM read_parquet('" + whosonfirst_properties_url + "') WHERE placetype='locality' AND ST_Contains(ST_GeomFromGeoJSON(geometry), ST_GeomFromText('" + wkt + "'))";

	const locality_results = await conn.query(locality_query);

	const locality_row = locality_results.get(0);

	if (! locality_row){
	    return;
	}

	var locality_id = locality_row.id;
	fetch_neighbourhoods(conn, locality_id);

	//

	var has_neighbourhoods = false;
	var new_layers = {};
	
	const pip_query = "SELECT * FROM read_parquet('" + whosonfirst_properties_url + "') WHERE placetype='neighbourhood' AND ST_Contains(ST_GeomFromGeoJSON(geometry), ST_GeomFromText('" + wkt + "'))";
	
	const pip_results = await conn.query(pip_query);
	
	for (const row of pip_results){
	    
	    new_layers[row.id] = true;
	    
	    if (pointinpolygon_layers[row.id]){
		console.log("PIP layer already drawn", row.id);
		continue;
	    }

	    location_el.innerText = "Map centered on " + row.name + " (neighbourhood). Click polygon to toggle locality and neighbourhood menus.";	    
	    draw_pointinpolygon_row(row, locality_id);
	    has_neighbourhoods = true;
	}

	if (! has_neighbourhoods){

	    new_layers[locality_id] = true;
	    
	    if (! pointinpolygon_layers[locality_id]){
		location_el.innerText = "Map centered on " + locality_row.name + " (locality). Click polygon to toggle locality menu.";
		draw_pointinpolygon_row(locality_row);
	    }
	}
	
	for (const id in pointinpolygon_layers){
	    
	    if (new_layers[id]){
		continue;
	    };
	    
	    map.removeLayer(pointinpolygon_layers[id]);
	    delete(pointinpolygon_layers[id]);
	}

	
	return false;
    });
    
    console.log("OKAY PIP");
}

async function fetch_localities(conn){

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

    feedback("Setting up localities");

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

    var wrapper_el = document.getElementById("neighbourhood-wrapper");	   	       

    var current_neighbourhood = neighbourhood_el.value;
    neighbourhood_el.innerHTML = "";
    
    if (locality_id == -1){
	wrapper_el.style.display = "none";
	return;
    }
    
    feedback_el.innerText = "Fetching neighbourhoods";
    
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
	feedback_el.innerText = "No neighbourhoods found for locality. Ready to search.";
	wrapper_el.style.display = "none";
	return;
    }
    
    var str_ids = neighbourhood_ids.join(",");
    
    const names_results = await conn.query("SELECT id, name  FROM read_parquet('" + whosonfirst_properties_url + "') WHERE id IN (" + str_ids + ")");
    
    for (const row of names_results){
	neighbourhood_names[row.id] = row.name;
    }
    
    draw_names(neighbourhood_el, neighbourhood_names);
    
    feedback("Ready to search");

    neighbourhood_el.value = current_neighbourhood;
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

function draw_filters() {

    var wrapper_el = document.getElementById("filters-wrapper");
    var filters_el = document.getElementById("filters");    

    filters_el.innerHTML = "";
    
    var categories = [];

    for (var k in filters){
	categories.push(k);
    }

    if (categories.length == 0){
	wrapper_el.style.display = "none";
	return;
    }

    categories.sort();

    for (var i in categories){

	var rm = document.createElement("span");
	rm.setAttribute("data-categories", categories[i]);		
	rm.setAttribute("class", "remove");
	rm.appendChild(document.createTextNode("[x]"));

	rm.onclick = function(e){

	    var el = e.target;
	    var categories = el.getAttribute("data-categories");

	    if (! categories){
		console.error("Element is missing data-categories", el);
		return false;
	    }

	    if (! filters[categories]){
		console.warn("Filter is missing key", categories);
		return false;
	    }

	    delete(filters[categories]);
	    draw_filters();
	    do_search();
	    
	    return false;
	};
	
	var item = document.createElement("li");
	item.appendChild(document.createTextNode(categories[i]));
	item.setAttribute("data-categories", categories[i]);	
	item.appendChild(rm);
	
	filters_el.appendChild(item);
    }

    wrapper_el.style.display = "block";
}

function draw_categories(categories_dict, target_el){

    var breadcrumbs = [];
    
    var render = function(dict){
	
	for (const k in dict){
	    
	    const v = dict[k];
	    
	    if (! v){
		
		var categories_ul = document.createElement("ul");
		categories_ul.setAttribute("class", "venue-categories");
		
		var to_render = breadcrumbs;
		to_render.push(k);
		
		var render_count = to_render.length;
		
		for (var r=0; r < render_count; r++){
		    
		    var anchor = document.createElement("a");
		    anchor.setAttribute("href", "#");
		    anchor.setAttribute("data-categories", to_render.slice(0, r + 1).join(" > "));
		    anchor.appendChild(document.createTextNode(to_render[r]));
		    
		    anchor.onclick = function(e){
			
			var el = e.target;
			var categories = el.getAttribute("data-categories");
			
			if (! categories){
			    console.error("Element is missing data-categories attribute", el);
			    return false;
			}
			
			var add_filter = true;
			
			for (var k in filters){
			    
			    if (k.startsWith(categories)){
				add_filter = false;
				break;
			    }
			}
			
			if (add_filter){
			    filters[categories] = true;
			    draw_filters();
			    do_search();
			}
			
			return false;
		    };
		    
		    var categories_li = document.createElement("li");
		    categories_li.appendChild(anchor);
		    categories_ul.appendChild(categories_li);
		}
		
		target_el.appendChild(categories_ul);
    		
		// console.log(row.id, breadcrumbs, k);
		continue;
	    }
	    
	    breadcrumbs.push(k);
	    render(v);
	    breadcrumbs.pop();
	}
    };

    render(categories_dict);
}

function buildCetgoriesDictionary(categories) {
    
    function addPathToTree(tree, path) {
	
        const parts = path.split(' > ');
        let currentLevel = tree;
	
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!currentLevel[part]) {
                currentLevel[part] = i === parts.length - 1 ? null : {};
            }
            currentLevel = currentLevel[part];
        }
    }

    const categoriesDictionary = {};

    categories.forEach(path => addPathToTree(categoriesDictionary, path));

    return categoriesDictionary;
}

async function feedback(msg){
    console.debug(msg);
    feedback_el.innerText = msg;
}
