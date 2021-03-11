import { t } from '../../core/localizer';

/**
 * We've re-purposed this panel to be the status panel for addresses
 */

export function uiPanelHistory(context) {
    function redraw(selection) {
        selection.html('');

        if (!window._mostRecentDsId) {
            selection
                .append('span')
                .html('No active dataset. If you\'ve selected one, you need to zoom in to level 16+ to active it');
            return;
        }
        panel.label = 'Status of ' + window._mostRecentDsId;

        const data = window._dsState[window._mostRecentDsId];
        let { 0: next, length } = Object.values(data).filter(x => x !== 'done');

        if (length) {
            // it's a way so next = [lng, lat][] not [lng, lat]
            if (typeof next[0] === 'object') next = next[0];


            selection
                .append('span')
                .html(length + ' addresses remaining');

            selection
                .append('button')
                .html('Zoom to next')
                .on('click', () => context.map().centerZoomEase(next, /* zoom */ 18, /* transition time */ 0));
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


    return panel;
}

