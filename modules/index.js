// btoa/atob are not URL-safe and crash when provided some UTF-8 characters
window.toBase64 = (text) =>
  btoa(
    encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_, g1) =>
      String.fromCharCode(+`0x${g1}`),
    )
  )
    .replace(/[=]/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
window.fromBase64 = (b64) =>
  decodeURIComponent(
    atob(b64.replace(/_/g, '/').replace(/-/g, '+'))
      .split('')
      .map((c) => `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`)
      .join(''),
  );

export * from './actions/index';
export * from './behavior/index';
export * from './core/index';
export * from './geo/index';
export * from './modes/index';
export * from './operations/index';
export * from './osm/index';
export * from './presets/index';
export * from './renderer/index';
export * from './services/index';
export * from './svg/index';
export * from './ui/fields/index';
export * from './ui/intro/index';
export * from './ui/panels/index';
export * from './ui/panes/index';
export * from './ui/sections/index';
export * from './ui/settings/index';
export * from './ui/index';
export * from './util/index';
export * from './validations/index';

// When `debug = true`, we use `Object.freeze` on immutables in iD.
// This is only done in testing because of the performance penalty.
export let debug = false;

// Reexport just what our tests use, see #4379
import * as D3 from 'd3';
export let d3 = {
  dispatch:  D3.dispatch,
  geoMercator: D3.geoMercator,
  geoProjection: D3.geoProjection,
  polygonArea: D3.polygonArea,
  polygonCentroid: D3.polygonCentroid,
  select: D3.select,
  selectAll: D3.selectAll,
  timerFlush: D3.timerFlush
};
