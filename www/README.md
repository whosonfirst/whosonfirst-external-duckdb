# whosonfirst-external-duckdb/www

Example web application demonstrating area-based (San Francisco Bay Area in this case) venue search using Foursquare data that has been supplemented with Who's On First ancestries.

## tl;dr - Serving the "www" folder

You will need to "serve" the `www` folder from a local webserver. These are lots of different ways to do that. I like to use the `fileserver` tool which is part of the [aaronland/go-http-fileserver](https://github.com/aaronland/go-http-fileserver) package:

```
$> cd /usr/local/src/go-http-fileserver
$> make cli

$> ./bin/fileserver -root /usr/local/src/whosonfirst-external-duckdb/www/
2025/01/14 17:41:37 Serving whosonfirst-external-duckdb/www/ and listening for requests on http://localhost:8080
```

Open your web browser to `http://localhost:8080` and you'll see something like this:

![](../docs/images/whosonfirst-external-duckdb-pmtiles.png)

![](../docs/images/whosonfirst-external-duckdb-daeho.png)

### Serving the "www" folder locally versus on "the internet"

This works either way. It is not, however, especially fast when served from a remote server on the internet. The DuckDB WASM file is 30MB alone and then there is the time to query and retrieve data from the (geo) parquet files over the wire. Once that is done it is still necessary to index that data in the in-memory full-text search index. It all works but it's not fast and if you're being metered and charged for outbound traffic you might not want to tell the entire internet about it.

## This is work in progress

Documentation is incomplete.

## Setting up

Note: The `sfba.parquet` and `sfba.pmtiles` that are created in the examples below are actually bundled (using `git-lfs`) with this respository.

This documentation is provided so you can how you might create your own data sources to work with. You will need to ensure the following data sources are present:

* The [Foursquare open data (venue) Parquet files](https://opensource.foursquare.com/os-places/)
* The appropriate [whosonfirst-data/whosonfirst-external-foursquare-venue-*](https://github.com/whosonfirst-data/?q=-external&type=all&language=&sort=) data repository.

Note that there are not `whosonfirst-external-foursquare-venue-*` repositories for all countries yet. You can use the tools in the [whosonfirst/go-whosonfirst-external](https://github.com/whosonfirst/go-whosonfirst-external] to produce your own data but the documentation for this process is incomplete as of this writing. (Basically you need to run the [assign-ancestors](https://github.com/whosonfirst/go-whosonfirst-external?tab=readme-ov-file#assign-ancestors) tool followed by the [sort-ancestors](https://github.com/whosonfirst/go-whosonfirst-external/tree/main/cmd/sort-ancestors) tool.)

You will also need to make sure that you have cloned the following repositories which contain tools used to build custom data sources:

* [whosonfirst/go-whosonfirst-external](https://github.com/whosonfirst/go-whosonfirst-external]
* [whosonfirst/go-whosonfirst-spatial](https://github.com/whosonfirst/go-whosonfirst-spatial)
* [protomaps/go-pmtiles](https://github.com/protomaps/go-pmtiles)

### Parquet data

First, compile Foursquare data for venues which are part of the Alameda ([102086959](https://spelunker.whosonfirst.org/id/102086959)), San Mateo ([102085387](https://spelunker.whosonfirst.org/id/102085387)) and San Francisco ([102087579](https://spelunker.whosonfirst.org/id/102087579)) counties. This data is compiled using the [Foursquare open data release](https://opensource.foursquare.com/os-places/) and the [whosonfirst-data/whosonfirst-external-foursquare-venue-us](https://github.com/whosonfirst-data/whosonfirst-external-foursquare-venue-us) repository and is written to a new file called `sfba.parquet`.

This file is created using the `compile-area` tool which is part of the [whosonfirst/go-whosonfirst-external](https://github.com/whosonfirst/go-whosonfirst-external?tab=readme-ov-file#compile-area) package.

```
$> cd /usr/local/src/go-whosonfirst-external
$> make cli

$> ./bin/compile-area \
	-external-source "/usr/local/data/foursquare/parquet/*.parquet" \
	-external-id-key fsq_place_id \
	-mode any \
	-ancestor-id 102086959 \
	-ancestor-id 102085387 \
	-ancestor-id 102087579 \
	-target sfba.parquet \
	/usr/local/data/foursquare/whosonfirst/whosonfirst-external-foursquare-venue-us/data/85688637
```

_See the `whosonfirst-external-foursquare-venue-us/data/85688637` part? `85688637` is the Who's On First ID for [California](https://spelunker.whosonfirst.org/id/85688637) so we're only scanning for records parented by that state rather than all 50 states in the US._

### PMTiles

Next, derive the bounding box for San Francisco, Alameda and San Mateo counties using the `mbr` tool in the [whosonfirst/go-whosonfirst-spatial](https://github.com/whosonfirst/go-whosonfirst-spatial) package:

```
$> cd /usr/local/src/go-whosonfirst-spatial
$> make cli

$> ./bin/mbr -id 102087579 -id 102086959 -id 102085387
-123.173825,37.053858,-121.469214,37.929824
```

Next, extract the tile data for that bounding box from the global Protomaps tileset using the [protomaps/go-pmtiles](https://github.com/protomaps/go-pmtiles) package:

```
$> cd /usr/local/src/go-pmtiles
$> go run main.go extract https://build.protomaps.com/20240812.pmtiles sfba.pmtiles --bbox="-123.173825,37.053858,-121.469214,37.929824"
```

Note: Until the [protomaps-leaflet.js](https://github.com/protomaps/protomaps-leaflet) library has been updated to support Protomaps "v4" builds make sure you grab data from a "v3" Protomaps build, circa August 2024 or earlier.

```
$> du -h sfba.pmtiles 
128M	sfba.pmtiles

$> go run main.go show sfba.pmtiles
pmtiles spec version: 3
tile type: Vector Protobuf (MVT)
bounds: (long: -123.173825, lat: 37.053858) (long: -121.469214, lat: 37.929824)
min zoom: 0
max zoom: 15
center: (long: -122.321519, lat: 37.491841)
center zoom: 0
addressed tiles count: 21419
tile entries count: 13773
tile contents count: 13204
clustered: true
internal compression: 2
tile compression: 2
attribution <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap</a>
planetiler:osm:osmosisreplicationtime 2025-01-13T04:00:00Z
planetiler:buildtime 2024-08-08T09:48:19.662Z
planetiler:osm:osmosisreplicationseq 108141
planetiler:version 0.8-SNAPSHOT
vector_layers <object...>
name Protomaps Basemap
description Basemap layers derived from OpenStreetMap and Natural Earth
planetiler:githash 1ccd7eea115e2ff63d2e898f2f84cca461c0074a
planetiler:osm:osmosisreplicationurl https://planet.osm.org/replication/hour/
type baselayer
version 4.0.4
pgf:devanagari:name NotoSansDevanagari-Regular
pgf:devanagari:version 1
```

### Who's On First properties (names)

Create a properties lookup table (currently just for place names for localities and neighbourhoods) derived from the `sfba.parquet` table derived from Who's On First records hosted on `data.whosonfirst.org` using the `area-whosonfirst-properties` tool in the [whosonfirst/go-whosonfirst-external](https://github.com/whosonfirst/go-whosonfirst-external?tab=readme-ov-file#area-whosonfirst-properties) package. For example:

```
$> cd /usr/local/go-whosonfirst-external
$> make cli

$> ./bin/area-whosonfirst-properties \
	-area-parquet sfba.parquet \
	-whosonfirst-parquet whosonfirst.parquet
```	

And then:

```
$> duckdb
v1.1.3 19864453f7
Enter ".help" for usage hints.
Connected to a transient in-memory database.
Use ".open FILENAME" to reopen on a persistent database.

D LOAD spatial;
D SELECT id, name, placetype, ST_AsText(ST_GeomFromGeoJSON(geometry)) FROM read_parquet('whosonfirst.parquet') LIMIT 1;
┌──────────┬─────────┬───────────────┬────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│    id    │  name   │   placetype   │                                            st_astext(st_geomfromgeojson(geometry))                                             │
│  int32   │ varchar │    varchar    │                                                            varchar                                                             │
├──────────┼─────────┼───────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 85887445 │ Noma    │ neighbourhood │ POLYGON ((-122.407691 37.780162, -122.408809 37.779294, -122.409046 37.779477, -122.409283 37.779658, -122.408161 37.780535,…  │
└──────────┴─────────┴───────────────┴────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Serving the "www" folder

See notes at the beginning of this document.

## See also

* https://github.com/whosonfirst/go-whosonfirst-external
* https://github.com/whosonfirst-data?q=whosonfirst-external-&type=all&language=&sort=
* https://github.com/protomaps/protomaps-leaflet
* https://maps.protomaps.com/builds/
