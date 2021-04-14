import { t } from '../../core/localizer';
import { modeRapidSelectFeatures } from '../../modes';
import { utilKeybinding } from '../../util';

const { sin, cos, sqrt, PI: π, atan2 } = Math;

const R = 6371; // radius of the earth in km
const K = π / 180; // marginal performance boost by pre-calculating this

/** @param {number} deg */
const deg2rad = (deg) => deg * K;

/**
 * returns the distance in metres between two coordinates
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 */
function distanceBetween(lat1, lng1, lat2, lng2) {
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lng2 - lng1);
  const a =
    sin(dLat / 2) * sin(dLat / 2) +
    cos(deg2rad(lat1)) * cos(deg2rad(lat2)) * sin(dLon / 2) * sin(dLon / 2);
  const c = 2 * atan2(sqrt(a), sqrt(1 - a));
  return 1000 * R * c;
}

/**
 * @template T
 * @param {T[]} list
 * @param {number} ourLat
 * @param {number} ourLng
 * @returns {T}
 */
const findNearest = (list, ourLat, ourLng) => {
    let closest;
    let closestDistance;
    for (const item of list) {
        const [thisLng, thisLat] = item.geo || item.fromLoc;
        const distance = distanceBetween(thisLat, thisLng, ourLat, ourLng);
        if (!closest || distance < closestDistance) {
            closest = item;
            closestDistance = distance;
        }
    }
    return closest;
};

/**
 * We've re-purposed this panel to be the status panel for addresses
 */

export function uiPanelHistory(context) {
    function getNext() {
        // we can probably get this info from some context
        const [zoom, lat, lng ] = new URLSearchParams(location.hash).get('map').split('/').map(Number);

        const data = window._dsState[window._mostRecentDsId];
        const list = Object.values(data).filter(x => x !== 'done');
        const next = findNearest(list, lat, lng);

        return { next, length: list.length, zoom };
    }
    function toNext() {
        const { next, zoom } = getNext();
        if (!next) return;

        context.map().centerZoomEase(next.geo || next.fromLoc, /* zoom */ Math.max(zoom, 18), /* transition time */ 0);

        // select the RapiD feature to open the sidebar
        context
            .selectedNoteID(null)
            .selectedErrorID(null)
            .enter(modeRapidSelectFeatures(context, next.feat));
    }

    function redraw(selection) {
        selection.html('');

        if (!window._mostRecentDsId) {
            selection
                .append('span')
                .html('No active dataset. If you\'ve selected one, you need to zoom in to level 16+ to active it');
            return;
        }
        panel.label = 'Status of ' + window._mostRecentDsId;


        const { length } = getNext();
        if (length) {
            selection
                .append('span')
                .html(length + ' addresses remaining');

            selection
                .append('button')
                .html('Zoom to next (G)')
                .on('click', toNext);

        } else {
            selection
                .append('span')
                .html('🥰 Done! You\'ve added all addresses in ' + window._mostRecentDsId);
        }

    }

    var panel = function(selection) {
        selection.call(redraw);

        context.map()
            .on('drawn.info-history', function() {
                selection.call(redraw);
            });

        context
            .on('enter.info-history', function() {
                selection.call(redraw);
            });
    };

    panel.off = function() {
        context.map().on('drawn.info-history', null);
        context.on('enter.info-history', null);
    };

    panel.id = 'history';
    panel.label = 'Status';
    panel.key = t('info_panels.history.key');



    const keybinding = utilKeybinding('statusPanel');
    keybinding().on('G', toNext);

    return panel;
}
