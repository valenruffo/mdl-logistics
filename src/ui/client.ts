/**
 * The page's script: a handful of `fetch` calls and DOM rendering. No framework,
 * no bundler, no dependency — served verbatim by `server.ts` as `/app.js`.
 *
 * Deliberate boundaries:
 *
 * - **No native dialog.** `alert`, `confirm` and `prompt` are not used anywhere:
 *   every message, warning, rejection, 409 and success is rendered in the page
 *   itself, in `#analyze-status`, `#run-status`, `#result` or the rail. The
 *   operator asked for that, and a test asserts it.
 * - **No creation ceremony.** The script posts the message, the values on screen
 *   and the mode. It never computes or echoes an approval hash and there is no
 *   token input to fill: creating a shipment costs nothing (R10 as amended).
 * - **No markup injection.** Every value shown comes from a server response and
 *   is written with `textContent`/`createElement`: pasted data, panel text, file
 *   names and record fields are never interpreted as HTML.
 * - **The rail is read-only** except for its own `Verificar ahora` button, which
 *   is the one control that opens a browser, `Cerrar sesión`, which posts the
 *   logout and returns to the login card, and the theme toggle, which is the one
 *   control that writes anything locally (the theme key, never a datum).
 * - **An expired session is not an error dialog.** A `401` from any call sends the
 *   browser to `/login`: the operator sees the card, not a JSON reason in the rail.
 */
export const CLIENT_JS = `(function () {
  'use strict';

  var THEME_KEY = 'mdl-theme';

  var state = {
    message: '',
    analyzed: false,
    provinces: [],
    busy: false,
    consoleBusy: false
  };

  function byId(id) { return document.getElementById(id); }

  function show(id, visible) { byId(id).hidden = !visible; }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function setText(id, text) { byId(id).textContent = text; }

  function setStatus(id, text, className) {
    var node = byId(id);
    node.className = 'inline-status' + (className ? ' ' + className : '');
    node.textContent = text;
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (response) {
      if (!response.ok) {
        // The session expired or the cookie is gone: there is nothing to show in
        // the page, so go back to the card that can establish a new one.
        if (response.status === 401) document.location.assign('/login');
        return response.text().then(function (text) {
          // A 409 while another run holds the browser lock carries an actionable
          // sentence in "reason"; show that instead of the raw JSON.
          var detail = text;
          try {
            var parsed = JSON.parse(text);
            if (parsed && typeof parsed.reason === 'string' && parsed.reason !== '') detail = parsed.reason;
          } catch (ignored) {}
          var error = new Error(detail);
          error.status = response.status;
          throw error;
        });
      }
      return response.json();
    });
  }

  function issueList(items) {
    var list = make('ul', 'issues');
    items.forEach(function (item) {
      if (item === '') return;
      list.appendChild(make('li', null, item));
    });
    return list;
  }

  function pathRow(label, value) {
    return make('p', 'mono', label + ': ' + (value === '' || value === null || value === undefined ? '(no registrado)' : value));
  }

  function textOr(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback || '(no registrado)';
    return String(value);
  }

  function pad2(value) { return value < 10 ? '0' + value : String(value); }

  /** A wall-clock label for an ISO timestamp; the raw value when it is not one. */
  function timeOf(iso) {
    if (iso === null || iso === undefined || iso === '') return '(sin fecha)';
    var parsed = new Date(String(iso));
    if (isNaN(parsed.getTime())) return String(iso);
    return pad2(parsed.getHours()) + ':' + pad2(parsed.getMinutes());
  }

  function formatBytes(bytes) {
    if (bytes === null || bytes === undefined) return '(sin tamaño)';
    if (bytes < 1000) return bytes + ' B';
    var units = ['kB', 'MB', 'GB'];
    var value = bytes / 1000;
    var index = 0;
    while (value >= 1000 && index < units.length - 1) {
      value = value / 1000;
      index += 1;
    }
    return (Math.round(value * 10) / 10) + ' ' + units[index];
  }

  // ------------------------------------------------------------ the message

  /**
   * How many "label: value" pairs the operator just pasted. It is a counter, not
   * a parser: the server decides whether the message is usable, this only fills
   * the badge next to the heading.
   */
  function countPastedFields(text) {
    var count = 0;
    text.split(String.fromCharCode(10)).forEach(function (line) {
      var trimmed = line.split('*').join('').trim();
      if (trimmed === '') return;
      var colon = trimmed.indexOf(':');
      if (colon <= 0) return;
      if (trimmed.slice(colon + 1).trim() === '') return;
      count += 1;
    });
    return count;
  }

  function updateMessageBadge() {
    var count = countPastedFields(byId('message').value);
    setText('message-badge', count === 0 ? 'sin datos' : count === 1 ? '1 campo' : count + ' campos');
  }

  // --------------------------------------------------------------- the form

  function fieldLabel(field) {
    var suffix = [];
    if (field.unit) suffix.push(field.unit);
    if (!field.required) suffix.push('opcional');
    return suffix.length === 0 ? field.label : field.label + ' (' + suffix.join(', ') + ')';
  }

  function controlFor(field) {
    var control;
    if (field.kind === 'province') {
      control = document.createElement('select');
      var blank = document.createElement('option');
      blank.value = '';
      blank.textContent = 'Seleccioná una provincia';
      control.appendChild(blank);
      state.provinces.forEach(function (option) {
        var node = document.createElement('option');
        node.value = option.name;
        node.textContent = option.name + ' (' + option.code + ')';
        control.appendChild(node);
      });
      control.value = field.value;
    } else {
      control = document.createElement('input');
      control.type = 'text';
      control.autocomplete = 'off';
      if (field.kind === 'measure') control.setAttribute('inputmode', 'decimal');
      control.value = field.value;
    }
    control.id = 'field-' + field.key;
    control.setAttribute('data-key', field.key);
    return control;
  }

  function renderFields(fields) {
    var grid = byId('shipment-form');
    clear(grid);

    var currentGroup = null;
    fields.forEach(function (field) {
      if (field.group !== currentGroup) {
        currentGroup = field.group;
        grid.appendChild(make('div', 'group', field.groupLabel));
      }

      var wrap = make('div', field.wide ? 'wide' : null);
      var label = document.createElement('label');
      label.className = 'field-wrap';
      label.setAttribute('for', 'field-' + field.key);
      label.appendChild(make('span', 'field-label', fieldLabel(field)));

      var control = controlFor(field);
      label.appendChild(control);

      // The panel field and the unit hint are useful but noisy: they stay
      // available to a screen reader and out of the artboard's visual rhythm.
      if (field.help) {
        var help = make('span', 'sr-only', field.help + ' (campo del panel: ' + field.panelField + ')');
        help.id = 'help-' + field.key;
        label.appendChild(help);
        control.setAttribute('aria-describedby', help.id);
      } else {
        control.setAttribute('title', 'campo del panel: ' + field.panelField);
      }

      wrap.appendChild(label);

      (field.derived || []).forEach(function (derivation) {
        wrap.appendChild(make('p', 'field-note', 'derivado: ' + derivation.note));
      });

      grid.appendChild(wrap);
    });
  }

  function collect() {
    var values = {};
    var nodes = byId('shipment-form').querySelectorAll('[data-key]');
    for (var index = 0; index < nodes.length; index += 1) {
      values[nodes[index].getAttribute('data-key')] = nodes[index].value;
    }
    return values;
  }

  function syncButtons() {
    var ready = state.analyzed && !state.busy;
    byId('create').disabled = !ready;
    byId('dry-run').disabled = !ready;
    byId('analyze').disabled = state.busy;
  }

  // ------------------------------------------------------------- the actions

  function analyze() {
    var message = byId('message').value;
    if (message.trim() === '') {
      setStatus('analyze-status', 'Pegá el mensaje primero.', 'bad');
      return;
    }

    state.message = message;
    state.analyzed = false;
    syncButtons();
    setStatus('analyze-status', 'Analizando el mensaje…', null);
    clear(byId('result'));
    clear(byId('warnings'));
    clear(byId('rejection'));
    setText('data-badge', 'analizando');

    post('/api/analyze', { message: message }).then(function (data) {
      if (data.status === 'rejected') {
        renderRejection(data);
        setStatus('analyze-status', 'El mensaje fue rechazado: revisá los motivos y corregí el texto.', 'bad');
        return;
      }
      renderParsed(data);
      setStatus('analyze-status', 'Mensaje leído: revisá los datos antes de crear el envío.', 'ok');
    }).catch(function (error) {
      state.analyzed = false;
      syncButtons();
      setText('data-badge', 'sin analizar');
      setStatus('analyze-status', describeError(error), 'bad');
    });
  }

  function describeError(error) {
    var reason = error && error.message ? error.message : String(error);
    if (error && error.status) return 'No se pudo completar (' + error.status + '): ' + reason;
    return 'No se pudo completar: ' + reason;
  }

  function renderRejection(data) {
    state.analyzed = false;
    state.provinces = [];
    syncButtons();
    clear(byId('shipment-form'));
    show('data-empty', true);
    setText('data-badge', 'rechazado');

    var box = byId('rejection');
    clear(box);
    box.appendChild(make('p', 'bad', 'RECHAZADO. El mensaje no se puede usar: el panel no se abrió y no se creó nada.'));

    if (data.missing.length > 0) {
      box.appendChild(make('p', 'bad', 'Faltan datos obligatorios:'));
      box.appendChild(issueList(data.missing.map(function (item) {
        return item.label + ' - ' + item.reason;
      })));
    }

    if (data.invalid.length > 0) {
      box.appendChild(make('p', 'bad', 'Datos inválidos:'));
      box.appendChild(issueList(data.invalid.map(function (item) {
        return item.label + ' (' + (item.value === '' ? 'vacío' : item.value) + ') - ' + item.reason;
      })));
    }

    if (data.unknownLabels.length > 0) {
      box.appendChild(make('p', 'bad', 'Etiquetas que el formato no define:'));
      box.appendChild(issueList(data.unknownLabels.map(function (label) {
        return label + ' - el formato solo acepta las etiquetas conocidas; revisá cómo está escrito el mensaje';
      })));
    }
  }

  function renderParsed(data) {
    state.analyzed = true;
    state.provinces = data.provinces;

    var warnings = byId('warnings');
    clear(warnings);
    if (data.warnings.length > 0) {
      warnings.appendChild(make('p', 'warn', 'Avisos del parser (no bloquean, confirmalos al revisar):'));
      warnings.appendChild(issueList(data.warnings.map(function (warning) { return warning.message; })));
    }

    clear(byId('rejection'));
    renderFields(data.fields);
    show('data-empty', false);
    setText('data-badge', 'editable');
    setText('quote-text', data.carrier + ' · el costo y el plazo se leen del panel en el resumen');
    clear(byId('result'));
    setStatus('run-status', '', null);
    syncButtons();
  }

  function run(mode) {
    if (!state.analyzed) {
      setStatus('run-status', 'Analizá el mensaje antes de continuar.', 'warn');
      return;
    }

    state.busy = true;
    syncButtons();
    clear(byId('result'));
    setStatus(
      'run-status',
      mode === 'create' ? 'Creando el envío: recorre el panel y hace un solo click en Crear envío…' : 'Recorriendo el panel hasta el resumen, sin crear nada…',
      null
    );

    post('/api/run', { message: state.message, form: collect(), mode: mode }).then(function (data) {
      renderResult(data);
      loadConsole(null);
    }).catch(function (error) {
      var box = byId('result');
      clear(box);
      box.appendChild(make('p', 'bad', describeError(error)));
      if (error && error.status === 409) {
        box.appendChild(make('p', 'note', 'No se cambió nada: cuando la corrida en curso termine, volvé a intentar.'));
      }
      setStatus('run-status', 'La corrida no se completó.', 'bad');
      loadConsole(null);
    }).then(function () {
      state.busy = false;
      syncButtons();
    });
  }

  function renderResult(data) {
    var box = byId('result');
    clear(box);

    if (data.status === 'invalid-form') {
      box.appendChild(make('p', 'bad', 'No se ejecutó nada: revisá estos campos.'));
      box.appendChild(issueList(data.errors.map(function (item) { return item.message; })));
      setStatus('run-status', 'El envío no se creó.', 'bad');
      return;
    }

    if (data.status === 'refused') {
      box.appendChild(make('p', 'bad', 'RECHAZADO antes de tocar el panel: ' + data.reason));
      if (data.details.length > 0) box.appendChild(issueList(data.details));
      box.appendChild(make('p', 'note', 'No se creó nada y no se escribió ningún registro nuevo.'));
      setStatus('run-status', 'El envío no se creó.', 'bad');
      return;
    }

    if (data.status === 'dry-run') {
      box.appendChild(make('p', data.formMatchesApproval ? 'ok' : 'bad',
        data.formMatchesApproval
          ? 'Resumen alcanzado. No se creó nada y no se tocó la etiqueta.'
          : 'El panel no tiene el payload que muestra la página. No se creó nada.'));
      if (data.mismatches.length > 0) box.appendChild(issueList(data.mismatches));
      box.appendChild(pathRow('hash del payload', data.payloadHash));
      box.appendChild(pathRow('informe del recorrido', data.reportPath));
      if (data.note) box.appendChild(make('p', 'note', data.note));
      setStatus('run-status', 'Prueba en seco terminada: nada se creó.', data.formMatchesApproval ? 'ok' : 'warn');
      return;
    }

    if (data.status === 'created') {
      var heading = make('p', 'result-id ok', 'Envío creado ' + data.shipmentId);
      box.appendChild(heading);
      box.appendChild(make('p', null, 'Estado en el panel: ' + (data.statusBadges.join(', ') || '(no leído)')));
      box.appendChild(make('p', null, 'Costo (resumen): ' + (data.cost.summary || '(no leído)')));
      box.appendChild(make('p', null, 'Costo (detalle): ' + (data.cost.detail || '(no leído)')));
      if (data.labelUnpaid.proven) {
        box.appendChild(make('p', 'ok',
          'Prueba de etiqueta impaga: el identificador, el estado del panel y el control de etiqueta siguen presentes; no se accionó nada sobre la etiqueta.'));
      } else {
        box.appendChild(make('p', 'bad', 'INCOMPLETO: no se puede probar que la etiqueta siga impaga.'));
        if (data.labelUnpaid.problem) box.appendChild(make('p', 'bad', data.labelUnpaid.problem));
        if (data.labelUnpaid.details.length > 0) box.appendChild(issueList(data.labelUnpaid.details));
      }
      box.appendChild(pathRow('registro previo al click', data.recordPath));
      box.appendChild(pathRow('desenlace', data.outcomePath));
      box.appendChild(pathRow('informe del ejecutor', data.reportPath));
      if (data.detailScreenshot) box.appendChild(pathRow('captura del detalle', data.detailScreenshot));
      setStatus('run-status', 'Listo: la etiqueta queda impaga.', 'ok');
      return;
    }

    if (data.status === 'unknown') {
      box.appendChild(make('p', 'warn', 'Resultado DESCONOCIDO: ' + data.reason));
      box.appendChild(make('p', null, 'Conciliación: ' + data.interpretation));
      if (data.matches.length > 0) box.appendChild(issueList(data.matches));
      if (data.details.length > 0) box.appendChild(issueList(data.details));
      box.appendChild(pathRow('registro a inspeccionar', data.recordPath));
      box.appendChild(pathRow('desenlace', data.outcomePath));
      box.appendChild(make('p', 'note', data.note));
      setStatus('run-status', 'Hay que conciliar a mano antes de repetir este mensaje.', 'warn');
      return;
    }

    box.appendChild(make('p', 'bad', 'La ejecución se detuvo: ' + data.reason));
    if (data.details.length > 0) box.appendChild(issueList(data.details));
    if (data.recordPath) box.appendChild(pathRow('registro a inspeccionar', data.recordPath));
    box.appendChild(make('p', 'note', data.note));
    setStatus('run-status', 'La corrida no se completó.', 'bad');
  }

  // ---------------------------------------------------------------- the rail

  /**
   * Every rail state is a dot **plus its own words**, so nothing is conveyed by
   * colour alone: ok / warn / bad only tints the dot.
   */
  function railState(stateId, textId, level, text, meta) {
    var box = byId(stateId);
    var dot = box.querySelector('.b');
    if (dot) dot.className = 'b ' + level;

    var span = byId(textId);
    span.textContent = text;
    if (meta) span.appendChild(make('span', 'meta', meta));
  }

  function renderSessionRail(data) {
    var last = data.session.lastCheck;
    if (last === null) {
      railState('rail-session-state', 'rail-session-text', 'warn', 'Sin chequeos',
        'la sesión no se puede afirmar utilizable hasta que corras uno');
    } else if (last.result === 'usable') {
      railState('rail-session-state', 'rail-session-text', 'ok', 'Utilizable',
        'verificada ' + timeOf(last.runAt) + ' · ' + last.durationMs + ' ms');
    } else {
      railState('rail-session-state', 'rail-session-text', 'bad', 'No utilizable',
        'chequeo del ' + timeOf(last.runAt) + ' · ' +
          (last.exitCode === null ? 'sin código de salida' : 'código ' + last.exitCode));
    }
    setText('rail-health', data.health.line);
  }

  function runRowLabel(row) {
    var when = timeOf(row.recordedAt);
    if (row.outcome === 'created') return 'creada · ' + when;
    if (row.outcome === 'unknown') return 'desconocida · ' + when;
    if (row.outcome === 'not-created') return 'sin crear · ' + when;
    return 'sin desenlace · ' + when;
  }

  function renderRunsRail(data) {
    var list = byId('rail-runs-list');
    clear(list);

    var rows = data.runs.rows.slice(0, 6);
    if (rows.length === 0) {
      var empty = document.createElement('li');
      empty.appendChild(make('span', 'meta', 'no hay ningún run registrado todavía'));
      list.appendChild(empty);
      return;
    }

    rows.forEach(function (row) {
      var item = document.createElement('li');
      item.appendChild(make('span', 'id', textOr(row.shipmentId, '—')));
      item.appendChild(make('span', 'meta', runRowLabel(row)));
      if (row.unresolved) item.appendChild(make('span', 'meta bad', 'sin resolver'));
      list.appendChild(item);
    });
  }

  /** The closed vocabulary of failed structural checks, as fixed sentences. */
  var CHECK_LABELS = {
    'shipment-id': 'el encabezado del detalle no trae un identificador #EM<numero>',
    'status-badge': 'ningún estado del panel dice "Por enviar"',
    'label-button': 'no hay un botón visible para la etiqueta',
    'form-mismatch': 'el panel no coincide con el payload mostrado',
    'form-not-approved': 'el hash del payload no coincide con el formulario leído',
    'outcome-unknown': 'el desenlace quedó desconocido',
    'status-failed': 'el informe quedó en estado failed',
    'status-error': 'el informe quedó en estado error',
    'reconciliation-unread': 'el informe trae una conciliación'
  };

  function renderErrorsRail(data) {
    var detail = byId('rail-errors-detail');
    clear(detail);

    var latest = data.errors.latest;
    if (latest === null) {
      railState('rail-errors-state', 'rail-errors-text', 'ok', 'Ninguno',
        'ningún informe del ejecutor falló sus comprobaciones');
    } else {
      railState('rail-errors-state', 'rail-errors-text', 'bad', 'Hay un informe con fallas',
        latest.kind + ' · ' + timeOf(latest.recordedAt));

      detail.appendChild(make('p', 'mono', latest.path));
      if (latest.unparseable) {
        detail.appendChild(make('p', 'bad', 'informe ilegible: se informa solo la ruta, nunca su contenido'));
      } else if (latest.checks.length === 0) {
        detail.appendChild(make('p', 'warn', 'el informe no nombró ninguna comprobación conocida'));
      } else {
        var list = make('ul', 'issues');
        latest.checks.forEach(function (id) {
          list.appendChild(make('li', 'bad', CHECK_LABELS[id] || id));
        });
        detail.appendChild(list);
      }
    }

    var warnings = byId('rail-warnings');
    clear(warnings);
    if (data.warnings && data.warnings.length > 0) {
      warnings.appendChild(make('p', 'note', 'Avisos de lectura (' + data.warnings.length + '), la página sigue funcionando:'));
      var warningList = make('ul', 'issues');
      data.warnings.forEach(function (warning) {
        warningList.appendChild(make('li', null, warning.source + ' - ' + warning.message));
      });
      warnings.appendChild(warningList);
    }
  }

  function renderArtifactsRail(data) {
    var list = byId('rail-artifacts-list');
    clear(list);

    var runs = data.artifacts.runs.filter(function (run) { return run.dir !== null; }).slice(0, 4);
    if (runs.length === 0) {
      var empty = document.createElement('li');
      empty.appendChild(make('span', 'meta', 'no hay archivos que listar'));
      list.appendChild(empty);
      return;
    }

    runs.forEach(function (run) {
      var item = document.createElement('li');
      item.appendChild(make('span', 'id', run.runId));
      item.appendChild(make('span', 'meta',
        'artifacts/' + run.dir + ' · ' + run.files.length + ' archivo(s) · ' + formatBytes(run.totalBytes)));
      // The page lists names and sizes and never serves a byte: traces and
      // screenshots carry recipient data and leave the volume over SSH.
      item.appendChild(make('span', 'meta', 'se retiran por SSH; no se sirven por HTTP'));
      list.appendChild(item);
    });
  }

  /**
   * The process facts the old Runtime tab showed, collapsed so the rail keeps the
   * artboard's rhythm. The store origin appears as a host and nothing else: the
   * console never resolves a credential, and this list only prints what it read.
   */
  function renderRuntimeRail(data) {
    var box = byId('rail-runtime');
    clear(box);

    var rows = [
      ['node', data.runtime.nodeVersion],
      ['pid', String(data.runtime.pid)],
      ['panel', data.runtime.storeHost === null ? '(sin configurar)' : data.runtime.storeHost],
      ['sesión', data.runtime.sessionSource],
      ['artefactos', data.runtime.artifactsDirAbsolute],
      ['registros', data.runtime.recordDirAbsolute]
    ];
    rows.forEach(function (row) {
      box.appendChild(make('p', 'meta', row[0] + ': ' + row[1]));
    });
  }

  function renderOpenAttempts(data) {
    var open = data.runs.rows.filter(function (row) { return row.unresolved; }).length;
    var node = byId('rail-open');
    node.className = open === 0 ? null : 'bad';
    node.textContent = open === 0 ? 'sin abiertas' : open === 1 ? '1 abierta' : open + ' abiertas';
  }

  function renderRail(data) {
    renderSessionRail(data);
    renderRunsRail(data);
    renderErrorsRail(data);
    renderArtifactsRail(data);
    renderRuntimeRail(data);
    renderOpenAttempts(data);
  }

  function renderRailFailure(reason) {
    railState('rail-session-state', 'rail-session-text', 'bad', 'No se pudo leer', reason);
    setText('rail-health', 'No se pudo leer el estado del agente: ' + reason);
  }

  function loadConsole(statusId) {
    if (state.consoleBusy) return;
    state.consoleBusy = true;
    if (statusId) setStatus(statusId, 'Leyendo el estado del agente…', null);

    fetch('/api/console', { method: 'GET' }).then(function (response) {
      if (response.status === 401) {
        document.location.assign('/login');
        throw new Error('/api/console respondió 401');
      }
      if (!response.ok) throw new Error('/api/console respondió ' + response.status);
      return response.json();
    }).then(function (data) {
      renderRail(data);
      if (statusId) setStatus(statusId, 'Leído a las ' + timeOf(data.readAt) + '.', 'ok');
    }).catch(function (error) {
      var reason = error && error.message ? error.message : String(error);
      renderRailFailure(reason);
      if (statusId) setStatus(statusId, 'No se pudo leer: ' + reason, 'bad');
    }).then(function () {
      state.consoleBusy = false;
    });
  }

  function runSessionCheck() {
    if (state.consoleBusy) return;
    state.consoleBusy = true;

    var button = byId('session-check-run');
    button.disabled = true;
    setStatus('session-check-status', 'Corriendo el chequeo: abre un navegador y puede tardar uno o dos minutos.', null);

    post('/api/session-check', {}).then(function (data) {
      renderRail(data);
      setStatus('session-check-status',
        'Chequeo terminado: ' + data.check.result +
        ' (' + (data.check.exitCode === null ? 'sin código de salida' : 'código ' + data.check.exitCode) + ').',
        data.check.result === 'usable' ? 'ok' : 'bad');
    }).catch(function (error) {
      setStatus('session-check-status', describeError(error), 'bad');
      if (error && error.status === 409) loadConsole(null);
    }).then(function () {
      state.consoleBusy = false;
      button.disabled = false;
    });
  }

  /** The one control that ends the session: post, then show the login card. */
  function logout() {
    var button = byId('logout');
    button.disabled = true;
    fetch('/api/logout', { method: 'POST' }).then(function () {
      document.location.assign('/login');
    }, function () {
      document.location.assign('/login');
    });
  }

  // ------------------------------------------------------------------ the theme
  //
  // The page follows the system until the operator picks a theme. The pick is
  // kept under THEME_KEY and wins over the system on the next load; the head of
  // the page reads the very same key before the first paint, so nothing flashes.

  function savedTheme() {
    try {
      var value = localStorage.getItem(THEME_KEY);
      return value === 'light' || value === 'dark' ? value : null;
    } catch (ignored) {
      return null;
    }
  }

  function systemTheme() {
    if (typeof matchMedia !== 'function') return 'light';
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function effectiveTheme() {
    var saved = savedTheme();
    return saved === null ? systemTheme() : saved;
  }

  /** Write the theme on the root element and keep the toggle's label honest. */
  function applyTheme(saved) {
    if (saved === null) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', saved);

    var shown = saved === null ? systemTheme() : saved;
    var button = byId('theme-toggle');
    if (!button) return;
    button.textContent = shown === 'dark' ? 'Tema: oscuro' : 'Tema: claro';
    button.setAttribute('aria-pressed', shown === 'dark' ? 'true' : 'false');
  }

  function toggleTheme() {
    var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (ignored) {}
    applyTheme(next);
  }

  var themeToggle = byId('theme-toggle');
  if (themeToggle) themeToggle.addEventListener('click', toggleTheme);
  applyTheme(savedTheme());

  // While no choice is stored, a system change is followed without a reload.
  if (typeof matchMedia === 'function') {
    var darkQuery = matchMedia('(prefers-color-scheme: dark)');
    var onSystemThemeChange = function () {
      if (savedTheme() === null) applyTheme(null);
    };
    if (typeof darkQuery.addEventListener === 'function') darkQuery.addEventListener('change', onSystemThemeChange);
    else if (typeof darkQuery.addListener === 'function') darkQuery.addListener(onSystemThemeChange);
  }

  byId('analyze').addEventListener('click', analyze);
  byId('message').addEventListener('input', updateMessageBadge);
  byId('create').addEventListener('click', function () { run('create'); });
  byId('dry-run').addEventListener('click', function () { run('dry-run'); });
  byId('session-check-run').addEventListener('click', runSessionCheck);
  byId('logout').addEventListener('click', logout);

  updateMessageBadge();
  syncButtons();
  loadConsole(null);
})();
`;
