import { dispatch as d3_dispatch } from 'd3-dispatch';
import { json as d3_json } from 'd3-fetch';
import { select as d3_select } from 'd3-selection';
import { actionNoop } from '../actions';
import { coreGraph, coreTree, t } from '../core';
import { modeBrowse } from '../modes';
import { osmNode, osmRelation, osmWay } from '../osm';
import { utilRebind, utilTiler } from '../util';


const APIROOT = 'https://linz-addr-cdn.kyle.kiwi';
window.APIROOT = APIROOT;
const TILEZOOM = 14;
const tiler = utilTiler().zoomExtent([TILEZOOM, TILEZOOM]);
const dispatch = d3_dispatch('loadedData');

let _datasets = {};
let _off;
let _fields = {};
let _loaded = {};

window._dsState = {};
window._mostRecentDsId = null;

window.__locked = {};
fetch(APIROOT+'/__locked')
  .then(r => r.json())
  .then(obj => window.__locked = obj)
  .catch(console.error);


function abortRequest(controller) {
  controller.abort();
}


// API
function searchURL() {
  return `${APIROOT}/index.json`;
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
  const bbox = extent.toParam();
  return `${dataset.url}?geometry=${bbox}&u=${(window.__user || {}).display_name}`;
}


function parseTile(dataset, tile, geojson, context, callback) {
  if (!geojson) return callback({ message: 'No GeoJSON', status: -1 });

  // expect a FeatureCollection with `features` array
  let results = [];
  (geojson.features || []).forEach(f => {
    let entities = parseFeature(f, dataset, context);
    if (entities) results.push.apply(results, entities);
  });

  callback(null, results);
}


function parseFeature(feature, dataset, context) {
  const geom = feature.geometry;
  const props = feature.properties;
  if (!geom || !props) return null;

  const linzRefKey = Object.keys(props).find(x => x.startsWith('ref:linz:'));

  const featureID = props[dataset.layer.idfield] || props[linzRefKey] || props.OBJECTID || props.FID || props.id;
  if (!featureID) return null;

  // the OSM service has already seen this linz ref, so skip it - it must already be mapped
  if (window._seenAddresses[featureID]) {

    // if it was already mapped before the OSM service loaded, we should delete it here
    if (dataset.cache.seen[featureID]) {
      const maybeEntity = Object.values(dataset.graph.base().entities).find((n) => n.__fbid__.endsWith(featureID));
      // dataset.graph.remove(maybeEntity); // TODO: why doesn't this work?
      if (!maybeEntity) {
        console.log('failed to find ' + featureID + ' in graph');
        return;
      }
      const annotation = {
        type: 'rapid_ignore_feature',
        description: t('rapid_feature_inspector.option_ignore.annotation'),
        id: maybeEntity.id,
        origid: maybeEntity.__origid__
      };
      context.perform(actionNoop(), annotation);
      context.enter(modeBrowse(context));
      window._dsState[maybeEntity.__datasetid__][featureID] = 'done';
    }

    return;
  }

  // skip if we've seen this feature already on another tile
  if (dataset.cache.seen[featureID]) return null;
  dataset.cache.seen[featureID] = true;

  const id = `${dataset.id}-${featureID}`;
  const meta = { __fbid__: id, __origid__: id, __service__: 'esri', __datasetid__: dataset.id };
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

    // for the location-wrong line
    if (window._dsState[dataset.id][featureID] !== 'done') {
      window._dsState[dataset.id][featureID] = { feat: w, fromLoc: geom.coordinates[0], toLoc: geom.coordinates[1] };
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

      // for address-modification diamonds
      if (window._dsState[dataset.id][featureID] !== 'done') {
        window._dsState[dataset.id][featureID] = { feat: updatedWay, geo: geom.coordinates[0][0] };
      }

    } else {  // multiple rings, make a multipolygon relation with inner/outer members
      const members = ways.map((w, i) => {
        entities.push(w);
        return { id: w.id, role: (i === 0 ? 'outer' : 'inner'), type: 'way' };
      });
      const tags = Object.assign(parseTags(props), { type: 'multipolygon' });
      const r = new osmRelation({ members: members, tags: tags }, meta);
      entities.push(r);
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
    const tiles = tiler.getTiles(projection);

    // abort inflight requests that are no longer needed
    Object.keys(cache.inflight).forEach(k => {
      const wanted = tiles.find(tile => tile.id === k);
      if (!wanted) {
        abortRequest(cache.inflight[k]);
        delete cache.inflight[k];
      }
    });

    if (!_loaded[datasetID]) {
      setTimeout(() => {
        window._mostRecentDsId = datasetID;
        const [[minLng, minLat], [maxLng, maxLat]] = ds.extent;
        const xml = `<gpx xmlns="http://www.topografix.com/GPX/1/1" creator="LINZ Addr" version="1.1">
        <metadata>
          <link href="https://github.com/hotosm/tasking-manager">
            <text>LINZ Addr</text>
          </link>
          <time>2021-03-08T22:14:43.088005</time>
        </metadata>
        <trk>
          <name>Extent of the ${ds.name} data</name>
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
        const url = 'data:text/xml;base64,' + btoa(xml);

        const layer = context.layers().layer('data');
        layer.url(url);
      }, 2000);
    }

    tiles.forEach(tile => {
      if (cache.loaded[tile.id] || cache.inflight[tile.id]) return;

      const controller = new AbortController();
      const url = tileURL(ds, tile.extent);

      d3_json(url, { signal: controller.signal })
        .then(geojson => {
          _loaded[datasetID] = ds.name;

          delete cache.inflight[tile.id];
          if (!geojson) throw new Error('no geojson');
          window.__reParse = () => parseTile(ds, tile, geojson, context, (err, results) => {
            if (err) throw new Error(err);
            graph.rebase(results, [graph], true);
            tree.rebase(results, true);
            cache.loaded[tile.id] = true;
            dispatch.call('loadedData');
          });
          window.__reParse();
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
        _fields = json.fields;
        (json.results || []).forEach(ds => {   // add each one to _datasets, create internal state
          if (_datasets[ds.id]) return;        // unless we've seen it already
          _datasets[ds.id] = ds;
          window._dsState[ds.id] = {};
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
  getLoadedDatasetNames: () => Object.values(_loaded),
  resetLoadedDatasets: () => { _loaded = {}; },


  loadLayer: function (datasetID) {
    let ds = _datasets[datasetID];
    if (!ds || !ds.url) {
      return Promise.reject(`Unknown datasetID: ${datasetID}`);
    } else if (ds.layer) {
      return Promise.resolve(ds.layer);
    }

    // heritage, no longer used.
    return Promise.resolve(_fields)
      .then(fields => {
        ds.layer = { fields };

        // Use the field metadata to map to OSM tags
        let tagmap = {};
        ds.layer.fields.forEach(f => {
          if (f.type === 'esriFieldTypeOID') {  // this is an id field, remember it
            ds.layer.idfield = f.name;
          }
          if (!f.editable) return;   // 1. keep "editable" fields only
          tagmap[f.name] = f.alias;  // 2. field `name` -> OSM tag (stored in `alias`)
        });
        ds.layer.tagmap = tagmap;

        return ds.layer;
      })
      .catch(() => { /* ignore */ });
  }
};
