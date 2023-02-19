// we replace these with the appropriate source= tag instead
const nzCrap = {
  attribution: {
    'http://wiki.osm.org/wiki/Attribution#LINZ': 'LINZ',
    'http://wiki.openstreetmap.org/wiki/Attribution#LINZ': 'LINZ',
    'http://www.aucklandcouncil.govt.nz/EN/ratesbuildingproperty/propertyinformation/GIS_maps/Pages/opendata.aspx': 'Auckland Council',
    'https://koordinates.com/publisher/wcc/': 'Wellington City Council',
    'http://wiki.openstreetmap.org/wiki/Contributors#Statistics_New_Zealand': 'Statistics NZ',
  },
  source_ref: {
    'http://www.linz.govt.nz/topography/topo-maps/': 'LINZ',
    'http://www.linz.govt.nz/topography/topo-maps/index.aspx': 'LINZ',
    'http://www.linz.govt.nz/about-linz/linz-data-service/dataset-information': 'LINZ',
    'http://www.stats.govt.nz/browse_for_stats/people_and_communities/Geographic-areas/digital-boundary-files.aspx': 'Statistics NZ',
  },
  source: {
    'LINZ & NZ Open GIS': 'LINZ',
    'LINZ;NZ Open GIS': 'LINZ',
    'LINZ/NZOGPS': 'LINZ',
    'LINZ_NZ_Topo50_Gridless_Maps': 'LINZ',
    'Sourced from the LINZ Data Service and licensed for reuse under CC BY 4.0': 'LINZ',
  },
  'source:ele': {
    'LINZ Topo50': 'LINZ',
    'Topo50 gridless': 'LINZ',
  }
};

const json = {
  'linz2osm:objectid': true,
  'LINZ2OSM:dataset': true,
  'LINZ2OSM:source_version': true,
  'LINZ2OSM:layer': true,
  'LINZ:layer': true,
  'LINZ:source_version': true,
  'LINZ:dataset': true,
  'linz:garmin_type': true,
  'linz:garmin_road_class': true,
  'linz:sufi': true,
  'linz:RoadID': true,
  'seamark': true, // just while we're doing the maritime import
};

export function actionDiscardTags(difference, discardTags) {
  discardTags = discardTags || {};

  Object.assign(discardTags, json);

  return (graph) => {
    difference.modified().forEach(checkTags);
    difference.created().forEach(checkTags);
    return graph;

    function checkTags(entity) {
      const keys = Object.keys(entity.tags);
      let didDiscard = false;
      let didDiscardLinz = false;
      let tags = {};

      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const v = entity.tags[k];
        if (discardTags[k] || !entity.tags[k]) {
          didDiscard = true;
        } else if (k in nzCrap && v in nzCrap[k]) {
          didDiscard = true;
          didDiscardLinz = nzCrap[k][v];
        } else {
          tags[k] = entity.tags[k];
        }
      }

      const anyLinzRefTags = tags['ref:linz:topo50_id'] || tags['ref:linz:place_id'] || tags['ref:linz:hydrographic_id'];

      // if we removed attribution=* or source_ref=*, add source=* instead
      // but not if there is already a linz:ref:* tag
      if (didDiscardLinz && !anyLinzRefTags) {
        if (tags.source) {
          // merge with existing source tag
          tags.source = [ ...new Set([didDiscardLinz, ...tags.source.split(';')])].join(';');
        } else {
          tags.source = didDiscardLinz;
        }
      }

      if (didDiscard) {
        graph = graph.replace(entity.update({ tags: tags }));
      }
    }

  };
}
