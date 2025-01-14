import { select as d3_select } from 'd3-selection';
import { Extent } from '@id-sdk/extent';
import { uiToggle } from './toggle';


export function uiLasso(context) {
    var group, polygon;

    lasso.coordinates = [];

    function lasso(selection) {
        context.container()
            .classed('lasso', true);

        group = selection
            .append('g')
            .attr('class', 'lasso hide');

        polygon = group
            .append('path')
            .attr('class', 'lasso-path');

        group
            .call(uiToggle(true));
    }


    function draw() {
        if (polygon) {
            polygon.data([lasso.coordinates])
                .attr('d', function(d) { return 'M' + d.join(' L') + ' Z'; });
        }
    }


    lasso.extent = function () {
        return lasso.coordinates.reduce(function(extent, point) {
            // update extent in place
            extent.min = [ Math.min(extent.min[0], point[0]), Math.min(extent.min[1], point[1]) ];
            extent.max = [ Math.max(extent.max[0], point[0]), Math.max(extent.max[1], point[1]) ];
            return extent;
        }, new Extent());
    };


    lasso.p = function(_) {
        if (!arguments.length) return lasso;
        lasso.coordinates.push(_);
        draw();
        return lasso;
    };


    lasso.close = function() {
        if (group) {
            group.call(uiToggle(false, function() {
                d3_select(this).remove();
            }));
        }
        context.container().classed('lasso', false);
    };


    return lasso;
}
