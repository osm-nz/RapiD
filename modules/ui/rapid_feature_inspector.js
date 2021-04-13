import { select as d3_select } from 'd3-selection';
import { t } from '../core/localizer';

import { actionNoop, actionRapidAcceptFeature, actionChangeTags, actionDeleteNode } from '../actions';
import { modeBrowse, modeSelect } from '../modes';
import { services } from '../services';
import { svgIcon } from '../svg';
import { uiFlash } from './flash';
import { uiTooltip } from './tooltip';
import { utilStringQs } from '../util';

const MOVE_PREFIX = 'LOCATION_WRONG_SPECIAL_';
const DELETE_PREFIX = 'SPECIAL_DELETE_';
const EDIT_PREFIX = 'SPECIAL_EDIT_';


export function uiRapidFeatureInspector(context, keybinding) {
  const rapidContext = context.rapidContext();
  const ACCEPT_FEATURES_LIMIT = Infinity;
  let _datum;


  function isAddFeatureDisabled() {
    // when task GPX is set in URL (TM mode), "add roads" is always enabled
    const gpxInUrl = utilStringQs(window.location.hash).gpx;
    if (gpxInUrl) return false;

    const annotations = context.history().peekAllAnnotations();
    const aiFeatureAccepts = annotations.filter(a => a.type === 'rapid_accept_feature');
    return aiFeatureAccepts.length >= ACCEPT_FEATURES_LIMIT;
  }

  /** @param {string} linzRef */
  function addCheckDate(linzRef) {
    const realAddrEntity = window._seenAddresses[linzRef];
    if (!realAddrEntity) {
      context.ui().flash
        .iconName('#iD-icon-no')
        .label('Looks like this node has not loaded yet or has been deleted')();
      return; // not loaded yet or already deleted;
    }

    context.perform(
      actionChangeTags(realAddrEntity.id, Object.assign({
        check_date: new Date().toISOString().split('T')[0]
      }, realAddrEntity.tags)),
      t('operations.change_tags.annotation')
    );
  }

  /** @param {string} linzRef */
  function deleteAddr(linzRef) {
    const realAddrEntity = window._seenAddresses[linzRef];
    if (!realAddrEntity) {
      context.ui().flash
        .iconName('#iD-icon-no')
        .label('Looks like this node has already been deleted')();
      return; // not loaded yet or already deleted;
    }

    context.perform(
      actionDeleteNode(realAddrEntity.id),
      t('operations.delete.annotation.point')
    );
  }

  /**
   * @param {string} linzRef
   * @param {Record<string, string>} tags
   * @returns {boolean} OK - whether the operation was sucessful
   */
  function editAddr(linzRef, _tags) {
    // clone just in case
    const tags = Object.assign({}, _tags);
    delete tags['ref:linz:address_id'];

    // if the ref has changed, u need to specify a tag called new_linz_ref=
    if (tags.new_linz_ref) {
     tags['ref:linz:address_id'] = tags.new_linz_ref;
     delete tags.new_linz_ref;
    }

    const realAddrEntity = window._seenAddresses[linzRef] || window._seenAddresses[`noRef|${tags.osm_id}`];
    delete tags.osm_id;

    if (!realAddrEntity) {
      context.ui().flash
        .iconName('#iD-icon-no')
        .label('Looks like this node hasn\'t downloaded yet')();
      return false; // not loaded yet so abort
    }

    const newTags = Object.assign({}, realAddrEntity.tags, tags);

    for (const k in newTags) if (newTags[k] === '🗑️') delete newTags[k];


    context.perform(
      actionChangeTags(realAddrEntity.id, newTags),
      t('operations.change_tags.annotation')
    );

    return true; // OK
  }


  function onAcceptFeature() {
    if (!_datum) return;

    function done() {
      const id = _datum.__origid__.split('-').slice(1).join('-');
      window._dsState[_datum.__datasetid__][id] = 'done';
    }

    const prefixedLinzRef =
      _datum &&
      _datum.tags &&
      _datum.tags['ref:linz:address_id'];

    if (prefixedLinzRef && prefixedLinzRef.startsWith(MOVE_PREFIX)) {
      const linzRef = prefixedLinzRef && prefixedLinzRef.slice(MOVE_PREFIX.length);

      if (!linzRef) {
        alert('failed to find linzRef for move action');
        return;
      }

      const { fromLoc, toLoc } = window._dsState[_datum.__datasetid__][prefixedLinzRef];
      const realAddrEntity = window._seenAddresses[linzRef];

      const ok = window.__moveNodeHook(realAddrEntity, fromLoc, toLoc);

      // switch to the ingore case because we don't want to actually create this line as an OSM way
      if (ok) {
        onIgnoreFeature(true);
        done();
      }
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


    if (prefixedLinzRef && prefixedLinzRef.startsWith(EDIT_PREFIX)) {
      // edit
      const linzRef = prefixedLinzRef.slice(EDIT_PREFIX.length);
      const ok = editAddr(linzRef, _datum.tags);
      // switch to the ignore case because we don't want to actually create anything in the OSM graph
      if (ok) {
        onIgnoreFeature(true);
        done();
      }
      return;
    }

    if (prefixedLinzRef && prefixedLinzRef.startsWith(DELETE_PREFIX)) {
      // delete
      const linzRef = prefixedLinzRef.slice(DELETE_PREFIX.length);
      deleteAddr(linzRef);
      // switch to the ingore case because we don't want to actually create anything in the OSM graph
      onIgnoreFeature(true);
      done();
      return;
    }


    // In place of a string annotation, this introduces an "object-style"
    // annotation, where "type" and "description" are standard keys,
    // and there may be additional properties. Note that this will be
    // serialized to JSON while saving undo/redo state in history.save().
    const annotation = {
      type: 'rapid_accept_feature',
      description: t('rapid_feature_inspector.option_accept.annotation'),
      id: _datum.id,
      origid: _datum.__origid__,
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
    done();

    if (window.sessionStorage.getItem('acknowledgedLogin') === 'true') return;
    window.sessionStorage.setItem('acknowledgedLogin', 'true');


    // disabling beacuse it's broken (TypeError: Cannot read property 'undefined' of undefined) in rapid_first_edit_dialog.js:49
    // const osm = context.connection();
    // if (!osm.authenticated()) {
    //   context.container()
    //     .call(uiRapidFirstEditDialog(context));
    // }
  }


  function onIgnoreFeature(fromAccept) {
    if (!_datum) return;

    const annotation = {
      type: 'rapid_ignore_feature',
      description: t('rapid_feature_inspector.option_ignore.annotation'),
      id: _datum.id,
      origid: _datum.__origid__
    };
    context.perform(actionNoop(), annotation);
    context.enter(modeBrowse(context));

    const prefixedLinzRef =
      _datum &&
      _datum.tags &&
      _datum.tags['ref:linz:address_id'];

    const id = _datum.__origid__.split('-')[1];
    window._dsState[_datum.__datasetid__][id] = 'done';

    if (fromAccept === true) return;

    // if the user cancels a DELETE or EDIT, add a check_date= tag
    if (prefixedLinzRef.startsWith(DELETE_PREFIX)) {
      const linzRef = prefixedLinzRef && prefixedLinzRef.slice(DELETE_PREFIX.length);
      addCheckDate(linzRef);
    }
    if (prefixedLinzRef.startsWith(EDIT_PREFIX)) {
      const linzRef = prefixedLinzRef && prefixedLinzRef.slice(EDIT_PREFIX.length);
      addCheckDate(linzRef);
    }

    if (prefixedLinzRef.startsWith(MOVE_PREFIX)) {
      const linzRef = prefixedLinzRef && prefixedLinzRef.slice(MOVE_PREFIX.length);

      if (!linzRef) {
        alert('failed to find linzRef for move action');
        return;
      }

      addCheckDate(linzRef);

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

    const tagEntries = Object.keys(tags).map(k => ({ key: k, value: tags[k] }) ).filter(kv => {
      // if a special linz ref, hide this tag
      if (kv.key === 'ref:linz:address_id' && kv.value.includes('SPECIAL_')) return false;
      return true;
    });

    tagEntries.forEach(e => {
      let entryDiv = tagBagEnter.append('div')
        .attr('class', 'tag-entry');

      entryDiv.append('div').attr('class', 'tag-key').text(e.key);
      entryDiv.append('div').attr('class', 'tag-value').text(e.value);
    });
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


    /** @type {string | undefined} */
    const linzRef = _datum && _datum.tags &&_datum.tags['ref:linz:address_id'];
    const isMove = linzRef && linzRef.startsWith(MOVE_PREFIX);
    const isDelete = linzRef && linzRef.startsWith(DELETE_PREFIX);
    const isEdit = linzRef && linzRef.startsWith(EDIT_PREFIX);
    const type = isEdit ? 'edit' : isMove ? 'move' : isDelete ? 'delete' : 'normal';

    const acceptMessages = {
      move: 'Move this address',
      normal: t('rapid_feature_inspector.option_accept.label'),
      edit: 'Edit this address',
      delete: 'Delete this address'
    };
    const acceptDescriptions = {
      move: 'Move the existing node to the new proposed location',
      normal: t('rapid_feature_inspector.option_accept.description'),
      edit: 'Update the tags on this node with the suggested changes',
      delete: 'Remove this node from OSM'
    };
    const ignoreMessages = {
      move: 'Do not move',
      normal:  t('rapid_feature_inspector.option_ignore.label'),
      edit: 'Do not edit',
      delete: 'Do not delete',
    };
    const mainMessages = {
      move: '❗✨ This node is in the wrong location! Do you want to move it?',
      delete: '❗🚮 This node has been deleted by LINZ! Do you want to delete it from OSM?',
      edit: '❗🔁 Some tags need changing on the address under this diamond!',
      normal: t('rapid_feature_inspector.prompt')
    };

    // Choices
    const choiceData = [
      {
        key: 'accept',
        iconName: '#iD-icon-rapid-plus-circle',
        label: acceptMessages[type],
        description: acceptDescriptions[type],
        onClick: onAcceptFeature,
        isDelete,
      }, {
        key: 'ignore',
        iconName: '#iD-icon-rapid-minus-circle',
        label: ignoreMessages[type],
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
      .append('p')
      .text(mainMessages[type]);

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
      .attr('class', `choice-button choice-button-${d.key} ${disableClass} ${d.isDelete ? 'del-btn' : ''}`)
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
