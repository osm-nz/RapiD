import { dispatch as d3_dispatch } from 'd3-dispatch';
import { json as d3_json } from 'd3-fetch';
import { select as d3_select } from 'd3-selection';

import { Projection, Tiler } from '@id-sdk/math';

import { coreGraph, coreTree } from '../core';
import { osmNode, osmRelation, osmWay } from '../osm';
import { utilRebind } from '../util';

const DEV = new URLSearchParams(location.hash).get('dev');
const DEV_CDN = 'http://localhost:5001';
const PROD_CDN = 'https://osm-nz.github.io/linz-address-import';
const APIROOT = DEV ? DEV_CDN : PROD_CDN;
window.APIROOT = APIROOT;

const TILEZOOM = 14;
const tiler = new Tiler().zoomRange(TILEZOOM);
const dispatch = d3_dispatch('loadedData');

let _datasets = {};
let _off;
let _loaded = {};

window._dsState = {};
window._mostRecentDsId = null;

window.__locked = {};

function esc(str) {
  // because btoa/atob is stupid but we need to use it for our data-url gpx extent thing
  return str.replace(/ā/ig, 'aa').replace(/ē/ig, 'ee').replace(/ī/ig, 'ii').replace(/ō/ig, 'oo').replace(/ū/ig, 'uu');
}


function abortRequest(controller) {
  controller.abort();
}


// API
function searchURL() {
  return `${APIROOT}/index.json?noCache=${Math.random()}`;
  // use to get
  // .results[]
  //   .extent
  //   .id
  //   .thumbnail
  //   .title
  //   .snippet
  //   .url (featureServer)
}


function tileURL(dataset, extent) {
  let url = dataset.url;
  if (DEV) url = url.replace(PROD_CDN, DEV_CDN);

  const bbox = extent.toParam();
  return `${url}?geometry=${bbox}&u=${(window.__user || {}).display_name}`;
}


function parseTile(dataset, tile, geojson, context, callback) {
  if (!geojson) return callback({ message: 'No GeoJSON', status: -1 });

  if (!window._dsState[dataset.id]) window._dsState[dataset.id] = {};

  // expect a FeatureCollection with `features` array
  let results = [];
  (geojson.features || []).forEach(f => {
    let entities = parseFeature(f, dataset);
    if (entities) results.push.apply(results, entities);
  });

  callback(null, results);
}


function parseFeature(feature, dataset) {
  const geom = feature.geometry;
  const props = feature.properties;
  if (!geom || !props) return null;



  const featureID = `${props.__action || 'create'}-${feature.id}`;
  if (!featureID) return null;

  // skip if we've seen this feature already on another tile
  if (dataset.cache.seen[featureID]) return null;
  dataset.cache.seen[featureID] = true;

  const id = `${dataset.id}-${featureID}`;
  const meta = { __fbid__: id, __origid__: id, __service__: 'esri', __datasetid__: dataset.id, __featureid__: featureID };
  let entities = [];
  let nodemap = new Map();

  // Point:  make a single node
  if (geom.type === 'Point') {
    const node = new osmNode({ loc: geom.coordinates, tags: parseTags(props) }, meta);

    // for normal address points
    if (window._dsState[dataset.id][featureID] !== 'done') {
      window._dsState[dataset.id][featureID] = { feat: node, geo: geom.coordinates };
    }

    return [node];

  // LineString:  make nodes, single way
  } else if (geom.type === 'LineString') {
    const nodelist = parseCoordinates(geom.coordinates);
    if (nodelist.length < 2) return null;

    const w = new osmWay({ nodes: nodelist, tags: parseTags(props) }, meta);
    entities.push(w);

    // for the location-wrong line, or any imported LineString
    if (window._dsState[dataset.id][featureID] !== 'done') {
      window._dsState[dataset.id][featureID] = { feat: w, geo: geom.coordinates[0] };
    }

    return entities;

  // Polygon:  make nodes, way(s), possibly a relation
  } else if (geom.type === 'Polygon') {
    let ways = [];
    geom.coordinates.forEach(ring => {
      const nodelist = parseCoordinates(ring);
      if (nodelist.length < 3) return null;

      const first = nodelist[0];
      const last = nodelist[nodelist.length - 1];
      if (first !== last) nodelist.push(first);   // sanity check, ensure rings are closed

      const w = new osmWay({ nodes: nodelist });
      ways.push(w);
    });

    if (ways.length === 1) {  // single ring, assign tags and return
      const updatedWay = ways[0].update( Object.assign({ tags: parseTags(props) }, meta) );
      entities.push(updatedWay);

      // for address-modification diamonds, or importing a Plygon
      if (window._dsState[dataset.id][featureID] !== 'done') {
        window._dsState[dataset.id][featureID] = { feat: updatedWay, geo: geom.coordinates[0][0] };
      }

    } else {  // multiple rings, make a multipolygon relation with inner/outer members

      // 🚨 I'm pretty sure this logic is untested

      const members = ways.map((w, i) => {
        entities.push(w);
        return { id: w.id, role: (i === 0 ? 'outer' : 'inner'), type: 'way' };
      });
      const tags = Object.assign(parseTags(props), { type: 'multipolygon' });
      const r = new osmRelation({ members: members, tags: tags }, meta);
      entities.push(r);

      if (window._dsState[dataset.id][featureID] !== 'done') {
        window._dsState[dataset.id][featureID] = { feat: r, geo: geom.coordinates[0][0] };
      }
    }

    return entities;
  } else if (geom.type === 'MultiPolygon') {
    /** @type {osmWay[][]} */
    let relationMembers = [];

    geom.coordinates.forEach((member, memberNum) => {
      relationMembers[memberNum] = [];
      member.forEach(ring => {
        const nodelist = parseCoordinates(ring);
        if (nodelist.length < 3) return null;

        const first = nodelist[0];
        const last = nodelist[nodelist.length - 1];
        if (first !== last) nodelist.push(first);   // sanity check, ensure rings are closed

        const w = new osmWay({ nodes: nodelist });
        relationMembers[memberNum].push(w);
      });
    });

    const members = relationMembers.flatMap(ways => {
      return ways.map((w, i) => {
        entities.push(w);
        return { id: w.id, role: (i === 0 ? 'outer' : 'inner'), type: 'way' };
      });
    });

    const tags = Object.assign(parseTags(props), { type: 'multipolygon' });
    const r = new osmRelation({ members: members, tags: tags }, meta);
    entities.push(r);

    if (window._dsState[dataset.id][featureID] !== 'done') {
      window._dsState[dataset.id][featureID] = { feat: r, geo: geom.coordinates[0][0][0] };
    }

    return entities;
  }
  // no Multitypes for now (maybe not needed)

  function parseCoordinates(coords) {
    let nodelist = [];
    coords.forEach(coord => {
      const key = coord.toString();
      let n = nodemap.get(key);
      if (!n) {
        n = new osmNode({ loc: coord });
        entities.push(n);
        nodemap.set(key, n);
      }
      nodelist.push(n.id);
    });
    return nodelist;
  }

  function parseTags(props) {
    let tags = {};
    Object.keys(props).forEach(prop => {
      const k = clean(dataset.layer.tagmap[prop] || prop);
      const v = clean(props[prop]);
      if (k && v) {
        tags[k] = v;
      }
    });

    // tags.source = `esri/${dataset.name}`;
    return tags;
  }

  function clean(val) {
    return val ? val.toString().trim() : null;
  }
}


export default {

  init: function () {
    this.event = utilRebind(this, dispatch, 'on');
  },


  reset: function () {
    Object.values(_datasets).forEach(ds => {
      if (ds.cache.inflight) {
        Object.values(ds.cache.inflight).forEach(abortRequest);
      }
      ds.graph = coreGraph();
      ds.tree = coreTree(ds.graph);
      ds.cache = { inflight: {}, loaded: {}, seen: {}, origIdTile: {} };
    });

    return this;
  },


  graph: function (datasetID)  {
    const ds = _datasets[datasetID];
    return ds && ds.graph;
  },


  intersects: function (datasetID, extent) {
    const ds = _datasets[datasetID];
    if (!ds || !ds.tree || !ds.graph) return [];
    return ds.tree.intersects(extent, ds.graph);
  },


  toggle: function (val) {
    _off = !val;
    return this;
  },


  loadTiles: function (datasetID, projection, _taskExtent, context) {
    if (_off) return;

    window._mostRecentDsId = datasetID;

    // `loadDatasets` and `loadLayer` are asynchronous,
    // so ensure both have completed before we start requesting tiles.
    const ds = _datasets[datasetID];
    if (!ds || !ds.layer) return;

    const cache = ds.cache;
    const tree = ds.tree;
    const graph = ds.graph;
    const proj = new Projection().transform(projection.transform()).dimensions(projection.clipExtent());
    const tiles = tiler.getTiles(proj).tiles;


    // abort inflight requests that are no longer needed
    Object.keys(cache.inflight).forEach(k => {
      const wanted = tiles.find(tile => tile.id === k);
      if (!wanted) {
        abortRequest(cache.inflight[k]);
        delete cache.inflight[k];
      }
    });


    if (!_loaded[datasetID]) {
      const [[minLng, minLat], [maxLng, maxLat]] = ds.extent;
      const xml = `<gpx xmlns="http://www.topografix.com/GPX/1/1" creator="LINZ Addr" version="1.1">
      <metadata>
        <link href="https://github.com/hotosm/tasking-manager">
          <text>LINZ Addr</text>
        </link>
        <time>2021-03-08T22:14:43.088005</time>
      </metadata>
      <trk>
        <name>Extent of the ${esc(ds.name)} data</name>
        <trkseg>
        <trkpt lat="${minLat-0.0003}" lon="${minLng-0.0003}"/>
        <trkpt lat="${maxLat+0.0003}" lon="${minLng-0.0003}"/>
        <trkpt lat="${maxLat+0.0003}" lon="${maxLng+0.0003}"/>
        <trkpt lat="${minLat-0.0003}" lon="${maxLng+0.0003}"/>
        <trkpt lat="${minLat-0.0003}" lon="${minLng-0.0003}"/>
        </trkseg>
      </trk>
      <wpt lat="${minLat-0.0003}" lon="${minLng-0.0003}"/>
      <wpt lat="${maxLat+0.0003}" lon="${minLng-0.0003}"/>
      <wpt lat="${maxLat+0.0003}" lon="${maxLng+0.0003}"/>
      <wpt lat="${minLat-0.0003}" lon="${maxLng+0.0003}"/>
      <wpt lat="${minLat-0.0003}" lon="${minLng-0.0003}"/>
      </gpx>`;
      const url = `data:text/xml;base64,${btoa(xml)}`;
      context.layers().layer('data').url(url);
    }

    tiles.forEach(tile => {
      if (cache.loaded[tile.id] || cache.inflight[tile.id]) return;

      const controller = new AbortController();
      const url = tileURL(ds, tile.wgs84Extent);

      d3_json(url, { signal: controller.signal })
        .then(geojson => {
          _loaded[datasetID] = { name: ds.name, source: ds.source };

          delete cache.inflight[tile.id];
          if (!geojson) throw new Error('no geojson');
          parseTile(ds, tile, geojson, context, (err, results) => {
            if (err) throw new Error(err);
            graph.rebase(results, [graph], true);
            tree.rebase(results, true);
            cache.loaded[tile.id] = true;
            dispatch.call('loadedData');
          });
        })
        .catch(console.error); // eslint-disable-line no-console

      cache.inflight[tile.id] = controller;
    });
  },


  loadDatasets: function () {    // eventually pass search params?
    if (Object.keys(_datasets).length) {   // for now, if we have fetched datasets, return them
      return Promise.resolve(_datasets);
    }

    const that = this;
    return d3_json(searchURL())
      .then(json => {
        (json.results || []).forEach(ds => {   // add each one to _datasets, create internal state
          if (_datasets[ds.id]) return;        // unless we've seen it already
          _datasets[ds.id] = ds;
          ds.graph = coreGraph();
          ds.tree = coreTree(ds.graph);
          ds.cache = { inflight: {}, loaded: {}, seen: {}, origIdTile: {} };

          // cleanup the `licenseInfo` field by removing styles  (not used currently)
          let license = d3_select(document.createElement('div'));
          license.html(ds.licenseInfo);       // set innerHtml
          license.selectAll('*')
            .attr('style', null)
            .attr('size', null);
          ds.license_html = license.html();   // get innerHtml

          // preload the layer info (or we could wait do this once the user actually clicks 'add to map')
          that.loadLayer(ds.id);
        });
        return _datasets;
      })
      .catch(() => { /* ignore */ });
  },

  getLoadedDatasetIDs: () => Object.keys(_loaded),
  getLoadedDatasetNames: () => Object.values(_loaded).map(x => x.name),
  getLoadedDatasetSources: () => [...new Set(Object.values(_loaded).map(x => x.source))],
  resetLoadedDatasets: () => { _loaded = {}; },

  loadLayer: function (datasetID) {
    // does nothing usefull since we've structured our API smarter so we don't need this
    const ds = _datasets[datasetID];
    ds.layer = { tagmap:{} };
  }
};
