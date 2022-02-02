import { select as d3_select } from 'd3-selection';
import { t } from '../core/localizer';

import { actionNoop, actionRapidAcceptFeature, actionChangeTags, actionDeleteNode } from '../actions';
import { modeBrowse, modeSelect } from '../modes';
import { services } from '../services';
import { svgIcon } from '../svg';
import { uiFlash } from './flash';
import { uiTooltip } from './tooltip';

const MAP = { n: 'node', r: 'relation', w: 'way' };

export function uiRapidFeatureInspector(context, keybinding) {
  const rapidContext = context.rapidContext();
  const ACCEPT_FEATURES_LIMIT = Infinity;
  let _datum;


  function isAddFeatureDisabled() {
    // when task GPX is set in URL (TM mode), "add roads" is always enabled
    const gpxInUrl = context.initialHashParams.hasOwnProperty('gpx');
    if (gpxInUrl) return false;

    const annotations = context.history().peekAllAnnotations();
    const aiFeatureAccepts = annotations.filter(a => a.type === 'rapid_accept_feature');
    return aiFeatureAccepts.length >= ACCEPT_FEATURES_LIMIT;
  }

  /** @param {string} osmId */
  function addCheckDate(osmId) {
    const graph = context.graph();

    if (!graph.hasEntity(osmId)) {
      context.ui().flash
        .iconName('#iD-icon-no')
        .label('Looks like this node has not loaded yet or has been deleted')();
      return; // not loaded yet or already deleted;
    }

    const osmFeature = graph.entity(osmId);

    context.perform(
      actionChangeTags(osmFeature.id, Object.assign({
        check_date: new Date().toISOString().split('T')[0]
      }, osmFeature.tags)),
      t('operations.change_tags.annotation')
    );
  }

  /**
   * @param {string} osmId
   * @returns {boolean} OK
   */
  function deleteAddr(osmId) {
    const graph = context.graph();

    if (!graph.hasEntity(osmId)) {
      context.ui().flash
        .iconName('#iD-icon-no')
        .label('Looks like this node hasn\'t downloaded yet, or has already been deleted')();
      return false; // not loaded yet or already deleted;
    }

    context.perform(
      actionDeleteNode(osmId),
      t('operations.delete.annotation.point')
    );
    return true;
  }

  /**
   * @param {string} osmId
   * @param {Record<string, string>} _tags
   * @returns {boolean} OK - whether the operation was sucessful
   */
  function editAddr(osmId, _tags) {
    // clone just in case
    const tags = Object.assign({}, _tags);

    const graph = context.graph();

    if (!graph.hasEntity(osmId)) {
      context.ui().flash
        .iconName('#iD-icon-no')
        .label('Looks like this node hasn\'t downloaded yet')();
      return false; // not loaded yet so abort
    }

    const osmFeature = graph.entity(osmId);

    const newTags = Object.assign({}, osmFeature.tags, tags);

    for (const k in newTags) if (newTags[k] === '🗑️') delete newTags[k];
    delete newTags.__action;

    context.perform(
      actionChangeTags(osmFeature.id, newTags),
      t('operations.change_tags.annotation')
    );

    return true; // OK
  }


  function onAcceptFeature() {
    if (!_datum) return;
    const [osmAction, osmId] = _datum.__featureid__.split('-');

    if (osmAction === 'create') {
      // cool. just continue on.
    } else if (osmAction === 'move') {

      // grab the two-node way from the rapid graph to find its endpoints
      const rapidGraph = services.esriData.graph(_datum.__datasetid__);
      const fromLoc = rapidGraph.entity(_datum.nodes[0]).loc;
      const toLoc = rapidGraph.entity(_datum.nodes[1]).loc;

      // grab the real node from the the real graph
      const realOsmNode = context.graph().entity(osmId);

      const ok = window.__moveNodeHook(realOsmNode, fromLoc, toLoc);

      if (ok) return onIgnoreFeature(true);
      else return;

    } else if (osmAction === 'edit') {
      const ok = editAddr(osmId, _datum.tags);

      if (ok) return onIgnoreFeature(true);
      else return;
    } else if (osmAction === 'delete') {
      const ok = deleteAddr(osmId);
      if (ok) return onIgnoreFeature(true);
      else return;
    } else {
      console.error('Invalid osmAction', osmAction);
      return;
    }

    if (isAddFeatureDisabled()) {
      const flash = uiFlash(context)
        .duration(5000)
        .label(t(
          'rapid_feature_inspector.option_accept.disabled_flash',
          { n: ACCEPT_FEATURES_LIMIT }
        ));
      flash();
      return;
    }

    // In place of a string annotation, this introduces an "object-style"
    // annotation, where "type" and "description" are standard keys,
    // and there may be additional properties. Note that this will be
    // serialized to JSON while saving undo/redo state in history.save().
    let annotation = {
      type: 'rapid_accept_feature',
      description: t('rapid_feature_inspector.option_accept.annotation'),
      id: _datum.id,
      origid: _datum.__origid__
    };

    const service = _datum.__service__ === 'esri' ? services.esriData : services.fbMLRoads;
    const graph = service.graph(_datum.__datasetid__);
    context.perform(actionRapidAcceptFeature(_datum.id, graph), annotation);
    context.enter(modeSelect(context, [_datum.id]));

    if (context.inIntro()) return;

    // remember sources for later when we prepare the changeset
    const source = _datum.tags && _datum.tags.source;
    if (source) {
      rapidContext.sources.add(source);
    }

    // mark as done
    window._dsState[_datum.__datasetid__][_datum.__featureid__] = 'done';

    if (window.sessionStorage.getItem('acknowledgedLogin') === 'true') return;
    window.sessionStorage.setItem('acknowledgedLogin', 'true');

  }


  /** @param {boolean} fromAccept */
  function onIgnoreFeature(fromAccept) {
    if (!_datum) return;
    const [osmAction, osmId] = _datum.__featureid__.split('-');

    const annotation = {
      type: 'rapid_ignore_feature',
      description: t('rapid_feature_inspector.option_ignore.annotation'),
      id: _datum.id,
      origid: _datum.__origid__
    };
    context.perform(actionNoop(), annotation);
    context.enter(modeBrowse(context));

    window._dsState[_datum.__datasetid__][_datum.__featureid__] = 'done';

    if (fromAccept === true) return;

    if (osmAction === 'create') {
      // the user cancelled a create action, so we tell the API to not
      // show this feature again

      fetch(window.APIROOT + '/__ignoreFeature?' + (new URLSearchParams({
        reportedBy: (window.__user || {}).display_name,
        id: `t${osmId}`, // for creates, this isn't the osmId. It's whatever ID the conflation service used.
        sector: _datum.__datasetid__
      }).toString()));
      return;
    } else {
      // if the user cancelled anything except create (edit, move, or delete), then add a check_date tag.
      addCheckDate(osmId);
    }
  }


  // https://www.w3.org/TR/AERT#color-contrast
  // https://trendct.org/2016/01/22/how-to-choose-a-label-color-to-contrast-with-background/
  // pass color as a hexstring like '#rgb', '#rgba', '#rrggbb', '#rrggbbaa'  (alpha values are ignored)
  function getBrightness(color) {
    const short = (color.length < 6);
    const r = parseInt(short ? color[1] + color[1] : color[1] + color[2], 16);
    const g = parseInt(short ? color[2] + color[2] : color[3] + color[4], 16);
    const b = parseInt(short ? color[3] + color[3] : color[5] + color[6], 16);
    return ((r * 299) + (g * 587) + (b * 114)) / 1000;
  }


  function featureInfo(selection) {
    if (!_datum) return;

    const datasetID = _datum.__datasetid__.replace('-conflated', '');
    const dataset = rapidContext.datasets()[datasetID];
    const color = dataset.color;

    let featureInfo = selection.selectAll('.feature-info')
      .data([color]);

    // enter
    let featureInfoEnter = featureInfo
      .enter()
      .append('div')
      .attr('class', 'feature-info');

    featureInfoEnter
      .append('div')
      .attr('class', 'dataset-label')
      .text(dataset.label || dataset.id);   // fallback to dataset ID

    if (dataset.beta) {
      featureInfoEnter
        .append('div')
        .attr('class', 'dataset-beta beta')
        .attr('title', t('rapid_poweruser_features.beta'));
    }

    // update
    featureInfo = featureInfo
      .merge(featureInfoEnter)
      .style('background', d => d)
      .style('color', d => getBrightness(d) > 140.5 ? '#333' : '#fff');
  }


  function tagInfo(selection) {
    const tags = _datum && _datum.tags;
    if (!tags) return;

    let tagInfoEnter = selection.selectAll('.tag-info')
      .data([0])
      .enter()
      .append('div')
      .attr('class', 'tag-info');

    let tagBagEnter = tagInfoEnter
      .append('div')
      .attr('class', 'tag-bag');

    tagBagEnter
      .append('div')
      .attr('class', 'tag-heading')
      .text(t('rapid_feature_inspector.tags'));

    const tagEntries = Object.keys(tags)
      .map(k => ({ key: k, value: tags[k] }) )
      .filter(kv => kv.key !== '__action');

    tagEntries.forEach(e => {
      let entryDiv = tagBagEnter.append('div')
        .attr('class', 'tag-entry');

      entryDiv.append('div').attr('class', 'tag-key').text(e.key);
      entryDiv.append('div').attr('class', 'tag-value').text(e.value);
    });

    // FIXME: use the NSI/deprecated tags UI here.
  }


  function rapidInspector(selection) {
    let inspector = selection.selectAll('.rapid-inspector')
      .data([0]);

    let inspectorEnter = inspector
      .enter()
      .append('div')
      .attr('class', 'rapid-inspector');

    inspector = inspector
      .merge(inspectorEnter);


    // Header
    let headerEnter = inspector.selectAll('.header')
      .data([0])
      .enter()
      .append('div')
      .attr('class', 'header');

    headerEnter
      .append('h3')
      .append('svg')
      // .attr('class', 'logo-rapid dark')
      .attr('class', 'logo-rapid')
      .append('use')
      .attr('xlink:href', '#iD-logo-rapid');

    headerEnter
      .append('button')
      .attr('class', 'fr rapid-inspector-close')
      .on('click', () => {
        context.enter(modeBrowse(context));
      })
      .call(svgIcon('#iD-icon-close'));


    // Body
    let body = inspector.selectAll('.body')
      .data([0]);

    let bodyEnter = body
      .enter()
      .append('div')
      .attr('class', 'body');

    body = body
      .merge(bodyEnter)
      .call(featureInfo)
      .call(tagInfo);

    const action = (_datum && _datum.tags && _datum.tags.__action) || 'create';

    let recentlyEditted = false;
    try {
      if (action === 'edit') {
        const id = _datum.__featureid__.split('-')[1];
        if (context.graph().hasEntity(id)) {
          const entity = context.graph().entity(id);
          const daysAgo = (new Date() - new Date(entity.timestamp))/1000/60/60/24;
          if (daysAgo < 30) {
            recentlyEditted = [entity, daysAgo];
          }
        }
      }
    } catch (ex) { console.error(ex); }

    const acceptMessages = {
      move: 'Move this address',
      create: t('rapid_feature_inspector.option_accept.label'),
      edit: 'Edit this address',
      delete: 'Delete this address'
    };
    const acceptDescriptions = {
      move: 'Move the existing node to the new proposed location',
      create: t('rapid_feature_inspector.option_accept.description'),
      edit: 'Update the tags on this node with the suggested changes',
      delete: 'Remove this node from OSM'
    };
    const ignoreMessages = {
      move: 'Do not move',
      create:  t('rapid_feature_inspector.option_ignore.label'),
      edit: 'Do not edit',
      delete: 'Do not delete',
    };
    const mainMessages = {
      move: '✨ This node is in the wrong location! Do you want to move it?',
      delete: '🗑️ This node has been deleted by LINZ! Do you want to delete it from OSM?',
      edit: '🔢 Some tags need changing on the address under this diamond!',
      create: t('rapid_feature_inspector.prompt')
    };
    const headerMessages = {
      move: 'Move',
      delete: 'Delete',
      edit: 'Edit',
      create: 'Create',
    };

    // Choices
    const choiceData = [
      {
        key: 'accept',
        iconName: '#iD-icon-rapid-plus-circle',
        label: acceptMessages[action],
        description: acceptDescriptions[action],
        onClick: onAcceptFeature,
        flag: !!recentlyEditted,
        isDelete: action === 'action',
      }, {
        key: 'ignore',
        iconName: '#iD-icon-rapid-minus-circle',
        label: ignoreMessages[action],
        description: t('rapid_feature_inspector.option_ignore.description'),
        onClick: onIgnoreFeature
      }
    ];

    let choices = body.selectAll('.rapid-inspector-choices')
      .data([0]);

    let choicesEnter = choices
      .enter()
      .append('div')
      .attr('class', 'rapid-inspector-choices');

    choicesEnter
      .append('h3')
      .text(headerMessages[action]);

    choicesEnter
      .append('p')
      .text(mainMessages[action]);

    if (recentlyEditted) {
      const osmUrl = `https://openstreetmap.org/${MAP[recentlyEditted[0].id[0]]}/${recentlyEditted[0].id.slice(1)}`;
      choicesEnter
        .append('p')
        .html(`Last editted by <strong>${recentlyEditted[0].user}</strong> <a href="${osmUrl}" target="_blank">${Math.round(recentlyEditted[1])} days ago</a>`);

    }

    choicesEnter.selectAll('.rapid-inspector-choice')
      .data(choiceData, d => d.key)
      .enter()
      .append('div')
      .attr('class', d => `rapid-inspector-choice rapid-inspector-choice-${d.key}`)
      .each(showChoice);
  }


  function showChoice(d, i, nodes) {
    let selection = d3_select(nodes[i]);
    const disableClass = (d.key === 'accept' && isAddFeatureDisabled()) ? 'secondary disabled': '';

    let choiceWrap = selection
      .append('div')
      .attr('class', `choice-wrap choice-wrap-${d.key}`);

    let choiceReference = selection
      .append('div')
      .attr('class', 'tag-reference-body');

    choiceReference
      .text(d.description);

    const onClick = d.onClick;
    let choiceButton = choiceWrap
      .append('button')
      .attr('class', `choice-button choice-button-${d.key} ${disableClass} ${d.isDelete ? 'del-btn' : ''} ${d.flag ? 'flag-btn' : ''}`)
      .on('click', onClick);

    // build tooltips
    let title, keys;
    if (d.key === 'accept') {
      if (isAddFeatureDisabled()) {
        title = t('rapid_feature_inspector.option_accept.disabled', { n: ACCEPT_FEATURES_LIMIT } );
        keys = [];
      } else {
        title = t('rapid_feature_inspector.option_accept.tooltip');
        keys = [t('rapid_feature_inspector.option_accept.key')];
      }
    } else if (d.key === 'ignore') {
      title = t('rapid_feature_inspector.option_ignore.tooltip');
      keys = [t('rapid_feature_inspector.option_ignore.key')];
    }

    if (title && keys) {
      choiceButton = choiceButton
        .call(uiTooltip().placement('bottom').title(title).keys(keys));
    }

    choiceButton
      .append('svg')
      .attr('class', 'choice-icon icon')
      .append('use')
      .attr('xlink:href', d.iconName);

    choiceButton
      .append('div')
      .attr('class', 'choice-label')
      .text(d.label);

    choiceWrap
      .append('button')
      .attr('class', `tag-reference-button ${disableClass}`)
      .attr('title', 'info')
      .attr('tabindex', '-1')
      .on('click', () => {
        choiceReference.classed('expanded', !choiceReference.classed('expanded'));
      })
      .call(svgIcon('#iD-icon-inspect'));
  }


  rapidInspector.datum = function(val) {
    if (!arguments.length) return _datum;
    _datum = val;
    return this;
  };

  if (keybinding) {
    keybinding()
      .on(t('rapid_feature_inspector.option_accept.key'), onAcceptFeature)
      .on(t('rapid_feature_inspector.option_ignore.key'), onIgnoreFeature);
  }

  return rapidInspector;
}
