/**
 * The page's script: a handful of `fetch` calls and DOM rendering. No framework,
 * no bundler, no dependency — served verbatim by `server.ts` as `/app.js`.
 *
 * Deliberate boundaries:
 *
 * - The script never computes a hash. It receives `approvalHash` from
 *   `/api/approve`, shows it, and posts it back with the run. The server
 *   recomputes the hash from the posted values every time, so a stale hash after
 *   an edit is refused there, not here.
 * - Every value shown comes from a server response, and all of it is rendered
 *   with `textContent`/`createElement`: pasted data, record fields and file names
 *   are never interpreted as HTML.
 * - The two gates stay separate on screen: approving the data has its own
 *   section, the creation needs its own token in its own input.
 * - The console is read-only. The only request that changes anything is
 *   `/api/session-check`, sent by its own button, because it opens a browser.
 */
export const CLIENT_JS = `(function () {
  'use strict';

  var state = {
    message: '',
    approvedHash: null,
    applying: false,
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

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (response) {
      if (!response.ok) {
        return response.text().then(function (text) {
          throw new Error(path + ' respondio ' + response.status + ': ' + text);
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
    return make('p', 'meta', label + ': ' + (value === '' || value === null ? '(no registrado)' : value));
  }

  function setBusy(busy) {
    state.busy = busy;
    syncButtons();
  }

  function syncButtons() {
    var token = byId('token').value.trim();
    byId('create').disabled = state.busy || state.approvedHash === null || token === '';
    byId('dry-run').disabled = state.busy || state.approvedHash === null;
  }

  function setApprovalState(text, className) {
    var node = byId('approval-state');
    node.className = 'status' + (className ? ' ' + className : '');
    node.textContent = text;
  }

  // --------------------------------------------------------------- the form

  function renderFields(fields, provinces) {
    var form = byId('shipment-form');
    clear(form);

    fields.forEach(function (field) {
      var derived = field.derived || [];
      var row = make('div', 'row' + (derived.length > 0 ? ' derived' : ''));
      var label = make('label', null, field.label + (field.unit ? ' (' + field.unit + ')' : ''));
      label.setAttribute('for', 'field-' + field.key);
      row.appendChild(label);

      var control;
      if (field.kind === 'province') {
        control = document.createElement('select');
        var blank = document.createElement('option');
        blank.value = '';
        blank.textContent = 'Selecciona una provincia';
        control.appendChild(blank);
        provinces.forEach(function (option) {
          var node = document.createElement('option');
          node.value = option.name;
          node.textContent = option.name + ' (' + option.code + ')';
          control.appendChild(node);
        });
        control.value = field.value;
      } else {
        control = document.createElement('input');
        control.type = 'text';
        if (field.kind === 'measure') control.setAttribute('inputmode', 'decimal');
        control.value = field.value;
        if (!field.required) control.placeholder = '(opcional)';
      }

      control.id = 'field-' + field.key;
      control.setAttribute('data-key', field.key);
      control.addEventListener('input', onFormEdited);
      control.addEventListener('change', onFormEdited);
      row.appendChild(control);

      row.appendChild(make('p', 'meta', 'panel: ' + field.panelField + (field.help ? ' - ' + field.help : '')));
      derived.forEach(function (derivation) {
        row.appendChild(make('p', 'derived-note', 'derivado: ' + derivation.note));
      });
      form.appendChild(row);
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

  function applyValues(values) {
    state.applying = true;
    try {
      var nodes = byId('shipment-form').querySelectorAll('[data-key]');
      for (var index = 0; index < nodes.length; index += 1) {
        var key = nodes[index].getAttribute('data-key');
        if (Object.prototype.hasOwnProperty.call(values, key)) nodes[index].value = values[key];
      }
    } finally {
      state.applying = false;
    }
  }

  function onFormEdited() {
    if (state.applying) return;
    if (state.approvedHash !== null) {
      state.approvedHash = null;
      clear(byId('approval'));
      setApprovalState('Los datos cambiaron: la aprobacion anterior ya no vale. Aproba otra vez.', 'warn');
    }
    syncButtons();
  }

  // ------------------------------------------------------------- the actions

  function hideAfterPreview() {
    show('step-approve', false);
    show('step-authorize', false);
    show('step-result', false);
  }

  function analyze() {
    var message = byId('message').value;
    if (message.trim() === '') {
      setText('analyze-status', 'Pega el mensaje primero.');
      return;
    }

    state.message = message;
    state.approvedHash = null;
    clear(byId('approval'));
    setApprovalState('', null);
    hideAfterPreview();
    setText('analyze-status', 'Analizando...');

    post('/api/analyze', { message: message }).then(function (data) {
      if (data.status === 'rejected') {
        renderRejection(data);
        setText('analyze-status', 'El mensaje fue rechazado: nada mas en la pagina esta disponible.');
        return;
      }
      renderParsed(data);
      setText('analyze-status', 'Mensaje aceptado. Revisa los datos antes de aprobarlos.');
    }).catch(function (error) {
      setText('analyze-status', 'Error: ' + (error && error.message ? error.message : String(error)));
    });
  }

  function renderRejection(data) {
    var box = byId('rejection');
    clear(box);
    box.appendChild(make('p', 'bad', 'RECHAZADO. El mensaje no se puede usar: el panel no se abrio y no se creo nada.'));

    if (data.missing.length > 0) {
      box.appendChild(make('p', 'bad', 'Faltan datos obligatorios:'));
      box.appendChild(issueList(data.missing.map(function (item) {
        return item.label + ' - ' + item.reason;
      })));
    }

    if (data.invalid.length > 0) {
      box.appendChild(make('p', 'bad', 'Datos invalidos:'));
      box.appendChild(issueList(data.invalid.map(function (item) {
        return item.label + ' (' + (item.value === '' ? 'vacio' : item.value) + ') - ' + item.reason;
      })));
    }

    if (data.unknownLabels.length > 0) {
      box.appendChild(make('p', 'bad', 'Etiquetas que el formato no define:'));
      box.appendChild(issueList(data.unknownLabels.map(function (label) {
        return label + ' - el formato solo acepta las etiquetas conocidas; revisa como esta escrito el mensaje';
      })));
    }

    show('step-preview', true);
    show('rejection', true);
    show('preview', false);
    hideAfterPreview();
  }

  function renderParsed(data) {
    var warnings = byId('warnings');
    clear(warnings);
    if (data.warnings.length > 0) {
      warnings.appendChild(make('p', 'warn', 'Avisos del parser (no bloquean, confirmalos al aprobar):'));
      warnings.appendChild(issueList(data.warnings.map(function (warning) { return warning.message; })));
    }
    warnings.appendChild(make('p', 'meta', 'Transporte: ' + data.carrier));

    renderFields(data.fields, data.provinces);

    show('step-preview', true);
    show('rejection', false);
    show('preview', true);
    show('step-approve', true);
    show('step-authorize', true);
    show('step-result', false);
    setApprovalState('Los datos todavia no estan aprobados.', null);
    syncButtons();
  }

  function approve() {
    if (state.message === '') {
      setApprovalState('Analiza un mensaje primero.', 'warn');
      return;
    }

    setBusy(true);
    setApprovalState('Aprobando...', null);

    post('/api/approve', { message: state.message, form: collect() }).then(function (data) {
      if (data.status === 'invalid-form') {
        var box = byId('approval');
        clear(box);
        box.appendChild(make('p', 'bad', 'Revisa estos campos antes de aprobar:'));
        box.appendChild(issueList(data.errors.map(function (item) { return item.message; })));
        setApprovalState('Los datos no se aprobaron.', 'bad');
        return;
      }

      state.approvedHash = data.approvalHash;
      applyValues(data.values);
      renderApproval(data);
      setApprovalState('Datos aprobados. Autorizar la creacion es un paso aparte.', 'ok');
    }).then(function () {
      setBusy(false);
    }, function (error) {
      setApprovalState('Error: ' + (error && error.message ? error.message : String(error)), 'bad');
      setBusy(false);
    });
  }

  function renderApproval(data) {
    var box = byId('approval');
    clear(box);
    box.appendChild(make('p', 'ok', 'Payload aprobado, tal como se escribira en el panel:'));

    var table = document.createElement('table');
    var head = document.createElement('thead');
    var headRow = document.createElement('tr');
    headRow.appendChild(make('th', null, 'Campo del panel'));
    headRow.appendChild(make('th', null, 'Valor'));
    head.appendChild(headRow);
    table.appendChild(head);

    var body = document.createElement('tbody');
    data.payload.forEach(function (row) {
      var tr = document.createElement('tr');
      tr.appendChild(make('td', null, row.field));
      tr.appendChild(make('td', null, row.value === '' ? '(vacio)' : row.value));
      body.appendChild(tr);
    });
    table.appendChild(body);
    box.appendChild(table);

    box.appendChild(make('p', 'meta', 'Hash de aprobacion (sha-256, calculado en el servidor):'));
    box.appendChild(make('p', 'hash', data.approvalHash));
    box.appendChild(make('p', 'hint', 'Si editas cualquier campo, el servidor recalcula el hash y este deja de valer.'));
    if (data.note) box.appendChild(make('p', 'note', data.note));
  }

  function run(mode) {
    if (state.approvedHash === null) {
      setApprovalState('Aprueba los datos antes de continuar.', 'warn');
      return;
    }

    var body = {
      message: state.message,
      form: collect(),
      mode: mode,
      approvedHash: state.approvedHash,
      token: mode === 'create' ? byId('token').value : null
    };

    setBusy(true);
    setApprovalState(
      mode === 'create' ? 'Creando el envio...' : 'Recorriendo el panel hasta el resumen...',
      null
    );

    post('/api/run', body).then(function (data) {
      renderResult(data);
      setApprovalState(data.status === 'created' ? 'Envio creado.' : 'Terminado: revisa el resultado.', null);
      loadConsole(null);
    }).then(function () {
      setBusy(false);
    }, function (error) {
      setApprovalState('Error: ' + (error && error.message ? error.message : String(error)), 'bad');
      setBusy(false);
    });
  }

  function renderResult(data) {
    var box = byId('result');
    clear(box);
    show('step-result', true);

    if (data.status === 'invalid-form') {
      box.appendChild(make('p', 'bad', 'No se ejecuto nada: revisa los campos.'));
      box.appendChild(issueList(data.errors.map(function (item) { return item.message; })));
      return;
    }

    if (data.status === 'refused') {
      box.appendChild(make('p', 'bad', 'RECHAZADO en el paso "' + data.stage + '": ' + data.reason));
      if (data.details.length > 0) box.appendChild(issueList(data.details));
      box.appendChild(make('p', 'hint', 'No se creo nada.'));
      return;
    }

    if (data.status === 'dry-run') {
      box.appendChild(make('p', data.formMatchesApproval ? 'ok' : 'bad',
        data.formMatchesApproval
          ? 'Resumen alcanzado. No se creo nada y no se toco la etiqueta.'
          : 'El panel no tiene el payload aprobado. No se creo nada.'));
      if (data.mismatches.length > 0) box.appendChild(issueList(data.mismatches));
      box.appendChild(pathRow('informe del recorrido', data.reportPath));
      box.appendChild(pathRow('hash aprobado', data.approvedHash));
      box.appendChild(pathRow('hash leido del formulario', data.currentHash));
      if (data.note) box.appendChild(make('p', 'note', data.note));
      return;
    }

    if (data.status === 'created') {
      box.appendChild(make('p', 'ok', 'Envio creado ' + data.shipmentId + '.'));
      box.appendChild(make('p', null, 'Estado en el panel: ' + (data.statusBadges.join(', ') || '(no leido)')));
      box.appendChild(make('p', null, 'Costo (resumen): ' + (data.cost.summary || '(no leido)')));
      box.appendChild(make('p', null, 'Costo (detalle): ' + (data.cost.detail || '(no leido)')));
      if (data.labelUnpaid.proven) {
        box.appendChild(make('p', 'ok',
          'Prueba de etiqueta impaga: el identificador, el estado del panel y el control de etiqueta siguen presentes; no se acciono nada sobre la etiqueta.'));
      } else {
        box.appendChild(make('p', 'bad', 'INCOMPLETO: no se puede probar que la etiqueta siga impaga.'));
        if (data.labelUnpaid.problem) box.appendChild(make('p', 'bad', data.labelUnpaid.problem));
        if (data.labelUnpaid.details.length > 0) box.appendChild(issueList(data.labelUnpaid.details));
      }
      box.appendChild(pathRow('informe del ejecutor', data.reportPath));
      if (data.detailScreenshot) box.appendChild(pathRow('captura del detalle', data.detailScreenshot));
      box.appendChild(pathRow('registro previo al click', data.recordPath));
      box.appendChild(pathRow('desenlace', data.outcomePath));
      return;
    }

    if (data.status === 'unknown') {
      box.appendChild(make('p', 'warn', 'Resultado DESCONOCIDO: ' + data.reason));
      box.appendChild(make('p', null, 'Conciliacion: ' + data.interpretation));
      if (data.matches.length > 0) box.appendChild(issueList(data.matches));
      if (data.details.length > 0) box.appendChild(issueList(data.details));
      box.appendChild(pathRow('registro a inspeccionar', data.recordPath));
      box.appendChild(pathRow('desenlace', data.outcomePath));
      box.appendChild(make('p', 'note', data.note));
      return;
    }

    box.appendChild(make('p', 'bad', 'La ejecucion se detuvo: ' + data.reason));
    if (data.details.length > 0) box.appendChild(issueList(data.details));
    if (data.recordPath) box.appendChild(pathRow('registro a inspeccionar', data.recordPath));
    box.appendChild(make('p', 'note', data.note));
  }

  // --------------------------------------------------------------- the console

  function textOr(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback || '(no registrado)';
    return String(value);
  }

  function formatSeconds(total) {
    var seconds = Math.floor(total % 60);
    var minutes = Math.floor(total / 60) % 60;
    var hours = Math.floor(total / 3600) % 24;
    var days = Math.floor(total / 86400);
    var parts = [];
    if (days > 0) parts.push(days + 'd');
    if (hours > 0) parts.push(hours + 'h');
    if (minutes > 0) parts.push(minutes + 'm');
    parts.push(seconds + 's');
    return parts.join(' ');
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

  function cellText(text, className) {
    return make('td', className || null, text);
  }

  function factsTable(rows) {
    var table = document.createElement('table');
    var body = document.createElement('tbody');
    rows.forEach(function (row) {
      var tr = document.createElement('tr');
      tr.appendChild(make('th', null, row[0]));
      var td = document.createElement('td');
      if (row[1] instanceof Node || typeof row[1] === 'object') td.appendChild(row[1]);
      else td.textContent = String(row[1]);
      tr.appendChild(td);
      body.appendChild(tr);
    });
    table.appendChild(body);
    return table;
  }

  function renderWarnings(containerId, warnings) {
    var box = byId(containerId);
    clear(box);
    if (!warnings || warnings.length === 0) return;
    box.appendChild(make('p', 'warn', 'Avisos de lectura (la pagina sigue funcionando):'));
    var list = make('ul', 'issues');
    warnings.forEach(function (warning) {
      list.appendChild(make('li', 'warn', warning.source + ' - ' + warning.message));
    });
    box.appendChild(list);
  }

  function appendWarningItems(containerId, problems) {
    if (!problems || problems.length === 0) return;
    var box = byId(containerId);
    var list = box.querySelector('ul.issues');
    if (list === null) {
      box.appendChild(make('p', 'warn', 'Avisos de lectura (la pagina sigue funcionando):'));
      list = make('ul', 'issues');
      box.appendChild(list);
    }
    problems.forEach(function (problem) {
      list.appendChild(make('li', 'warn', problem));
    });
  }

  function renderHealth(data) {
    var level = data.health.level;
    byId('health').className = 'health ' + level;
    var line = byId('health-line');
    line.className = level;
    line.textContent = data.health.line;

    var facts = byId('health-facts');
    clear(facts);
    data.health.facts.forEach(function (fact) {
      facts.appendChild(make('li', fact.level, fact.label + ': ' + fact.detail));
    });
  }

  function renderRuntime(data) {
    renderWarnings('runtime-warnings', data.runtime.warnings);
    var box = byId('runtime-body');
    clear(box);

    var runtime = data.runtime;
    box.appendChild(factsTable([
      ['uptime', formatSeconds(runtime.uptimeSeconds) + ' (arrancó ' + runtime.startedAt + ')'],
      ['node', runtime.nodeVersion],
      ['pid', String(runtime.pid)],
      ['plataforma', runtime.platform],
      ['directorio de trabajo', runtime.cwd],
      ['origen del panel',
        runtime.storeHost === null
          ? '(no configurado: ' + runtime.storeVariable + ')'
          : runtime.storeHost + ' - solo el host, sin credenciales (' + runtime.storeVariable + ')'],
      ['fuente de la sesión', runtime.sessionSource],
      ['ruta de la sesión', runtime.sessionPath === null ? '(sin resolver)' : runtime.sessionPath],
      ['headless', runtime.headless === null ? '(no se pudo leer el interruptor)' : String(runtime.headless)],
      ['directorio de artefactos', runtime.artifactsDirAbsolute],
      ['registros de ejecución', runtime.recordDirAbsolute]
    ]));

    if (runtime.storeProblem !== null) {
      box.appendChild(make('p', 'bad', 'origen del panel: ' + runtime.storeProblem));
    }
    if (runtime.headlessProblem !== null) {
      box.appendChild(make('p', 'bad', 'headless: ' + runtime.headlessProblem));
    }
  }

  function checkTable(checks) {
    var table = document.createElement('table');
    var head = document.createElement('thead');
    var headRow = document.createElement('tr');
    ['cuándo', 'resultado', 'salida', 'mensaje que imprimió'].forEach(function (title) {
      headRow.appendChild(make('th', null, title));
    });
    head.appendChild(headRow);
    table.appendChild(head);

    var body = document.createElement('tbody');
    checks.forEach(function (check) {
      var tr = document.createElement('tr');
      tr.appendChild(cellText(check.runAt));
      tr.appendChild(cellText(check.result, check.result === 'usable' ? 'ok' : 'bad'));
      tr.appendChild(cellText(check.exitCode === null ? 'sin código' : String(check.exitCode)));
      tr.appendChild(cellText(check.message));
      body.appendChild(tr);
    });
    table.appendChild(body);
    return table;
  }

  function renderSession(data) {
    renderWarnings('session-warnings', data.session.warnings);
    var box = byId('session-body');
    clear(box);

    var file = data.session.file;
    box.appendChild(make('h3', null, 'El archivo de la sesión'));
    box.appendChild(factsTable([
      ['modo',
        file.mode === 'storage-state'
          ? 'storageState transferido'
          : file.mode === 'persistent-profile'
            ? 'perfil persistente de Chromium'
            : '(no se pudo resolver)'],
      ['ruta', file.path === null ? '(sin resolver)' : file.path],
      ['existe', file.exists ? 'sí' : 'no'],
      ['es un archivo', file.isFile ? 'sí' : 'no'],
      ['tamaño', file.exists ? formatBytes(file.sizeBytes) : '(no aplica)'],
      ['última modificación', file.exists ? textOr(file.modifiedAt) : '(no aplica)']
    ]));

    if (file.problems.length > 0) {
      box.appendChild(make('p', 'warn', 'Problemas con el archivo de la sesión:'));
      box.appendChild(issueList(file.problems));
    }
    box.appendChild(make('p', 'hint', 'El contenido de este archivo es la sesión del panel: la página solo mira tamaño y fecha, nunca lo abre.'));

    box.appendChild(make('h3', null, 'Últimos chequeos (' + data.session.checks.length + ' de ' + data.session.limit + ')'));
    if (data.session.checks.length === 0) {
      box.appendChild(make('p', 'warn', 'Todavía no hay ningún chequeo registrado: la salud no puede afirmar que la sesión esté usable hasta que corras uno.'));
      return;
    }

    box.appendChild(checkTable(data.session.checks));

    var last = data.session.lastCheck;
    if (last !== null) {
      box.appendChild(make('h3', null, 'Salida completa del último chequeo (verbatim)'));
      box.appendChild(make('p', 'mono', last.output === '' ? '(no imprimió nada)' : last.output));
      if (last.spawnProblem !== null) box.appendChild(make('p', 'bad', last.spawnProblem));
    }
  }

  function renderRuns(data) {
    renderWarnings('runs-warnings', data.runs.warnings);
    var box = byId('runs-body');
    clear(box);

    box.appendChild(make('p', 'meta', data.runs.rows.length + ' registro(s) visible(s) de ' + data.runs.total + '.'));
    if (data.runs.rows.length === 0) {
      box.appendChild(make('p', 'warn', 'No hay ningún run registrado todavía.'));
      return;
    }

    var table = document.createElement('table');
    var head = document.createElement('thead');
    var headRow = document.createElement('tr');
    ['run', 'cuándo', 'hash del mensaje', 'hash de aprobación', 'estado', 'desenlace', 'envío', 'costo', 'artefactos'].forEach(function (title) {
      headRow.appendChild(make('th', null, title));
    });
    head.appendChild(headRow);
    table.appendChild(head);

    var body = document.createElement('tbody');
    data.runs.rows.forEach(function (row) {
      var tr = document.createElement('tr');
      tr.appendChild(cellText(row.runId, row.unresolved ? 'bad' : null));
      tr.appendChild(cellText(textOr(row.recordedAt)));
      tr.appendChild(cellText(textOr(row.messageHashShort)));
      tr.appendChild(cellText(textOr(row.approvalHashShort)));
      tr.appendChild(cellText(textOr(row.status)));
      tr.appendChild(cellText(row.outcome === null ? 'sin desenlace' : row.outcome, row.unresolved ? 'bad' : null));
      tr.appendChild(cellText(textOr(row.shipmentId, '(sin envío)')));
      tr.appendChild(cellText(textOr(row.costText, '(sin costo leído)')));

      var artifactCell = document.createElement('td');
      artifactCell.textContent = row.artifactDir === null ? '(no registrado)' : 'artifacts/' + row.artifactDir;
      tr.appendChild(artifactCell);

      body.appendChild(tr);
    });
    table.appendChild(body);
    box.appendChild(table);

    var withProblems = data.runs.rows.filter(function (row) { return row.problems.length > 0; });
    if (withProblems.length > 0) {
      box.appendChild(make('h3', 'warn', 'Registros con problemas de lectura'));
      withProblems.forEach(function (row) {
        box.appendChild(make('p', 'mono', row.runId));
        box.appendChild(issueList(row.problems));
      });
    }

    var unresolved = data.runs.rows.filter(function (row) { return row.unresolved; });
    if (unresolved.length > 0) {
      box.appendChild(make('h3', 'bad',
        'Runs sin resolver (' + unresolved.length + '): la creación de ese mismo mensaje queda bloqueada hasta que una persona los resuelva a mano'));
      unresolved.forEach(function (row) {
        box.appendChild(make('p', 'mono',
          row.runId + ' - ' + (row.outcome === 'unknown' ? 'desenlace desconocido' : 'sin desenlace escrito')));
        box.appendChild(make('p', 'mono', textOr(row.resolution, '(el gate no produjo una instrucción)'), 'bad'));
      });
    }
  }

  function renderArtifacts(data) {
    renderWarnings('artifacts-warnings', data.artifacts.warnings);
    var box = byId('artifacts-body');
    clear(box);

    if (data.artifacts.runs.length === 0) {
      box.appendChild(make('p', 'warn', 'No hay runs, así que no hay artefactos que listar.'));
      return;
    }

    data.artifacts.runs.forEach(function (run) {
      box.appendChild(make('h3', null, run.runId));
      box.appendChild(make('p', 'meta',
        run.dir === null
          ? 'sin directorio de artefactos registrado'
          : 'artifacts/' + run.dir + ' - ' + formatBytes(run.totalBytes) + ' en total'));

      if (run.problems.length > 0) box.appendChild(issueList(run.problems));
      if (run.files.length === 0) {
        box.appendChild(make('p', 'warn', 'No hay archivos que listar en este directorio.'));
        return;
      }

      box.appendChild(make('p', 'note',
        'Capturas y traces de este run: pueden contener datos personales del destinatario y la sesión del panel. Se retiran del volumen por SSH; esta página no los sirve ni los muestra.'));

      var table = document.createElement('table');
      var head = document.createElement('thead');
      var headRow = document.createElement('tr');
      headRow.appendChild(make('th', null, 'archivo'));
      headRow.appendChild(make('th', null, 'tamaño'));
      head.appendChild(headRow);
      table.appendChild(head);

      var body = document.createElement('tbody');
      run.files.forEach(function (file) {
        var tr = document.createElement('tr');
        tr.appendChild(cellText(file.name));
        tr.appendChild(cellText(formatBytes(file.sizeBytes)));
        body.appendChild(tr);
      });
      table.appendChild(body);
      box.appendChild(table);
    });
  }

  function renderErrors(data) {
    renderWarnings('errors-warnings', data.errors.warnings);
    var box = byId('errors-body');
    clear(box);

    var latest = data.errors.latest;
    if (latest === null) {
      box.appendChild(make('p', 'warn',
        'No hay ningún informe de fallo del ejecutor: no existe un dry-run.json ni un create-run.json con una comprobación estructural fallida.'));
      return;
    }

    box.appendChild(factsTable([
      ['informe', latest.path],
      ['archivo', latest.kind],
      ['modo', textOr(latest.mode)],
      ['terminado', textOr(latest.finishedAt)],
      ['escrito', latest.recordedAt]
    ]));

    box.appendChild(make('p', 'note',
      'Este informe es de un run real: su texto puede citar el nombre o la dirección del destinatario. No se descarga desde acá; el archivo se retira del volumen por SSH, como el resto de los artefactos.'));

    box.appendChild(make('h3', null, 'Comprobación estructural que falló (verbatim)'));
    var table = document.createElement('table');
    var head = document.createElement('thead');
    var headRow = document.createElement('tr');
    headRow.appendChild(make('th', null, 'campo del informe'));
    headRow.appendChild(make('th', null, 'valor'));
    head.appendChild(headRow);
    table.appendChild(head);

    var body = document.createElement('tbody');
    latest.checks.forEach(function (check) {
      var tr = document.createElement('tr');
      tr.appendChild(cellText(check.check));
      tr.appendChild(cellText(check.detail));
      body.appendChild(tr);
    });
    table.appendChild(body);
    box.appendChild(table);

    box.appendChild(make('h3', null, 'Mensaje del informe (verbatim)'));
    if (latest.message === null) {
      box.appendChild(make('p', 'warn', 'El informe no trae un campo message, reason, failure ni error.'));
    } else {
      box.appendChild(make('p', 'warn', 'Texto tal como lo escribió el ejecutor: puede nombrar al destinatario o su dirección.'));
      box.appendChild(make('p', 'mono', latest.message));
    }
  }

  function renderConsole(data, extraSessionProblems) {
    renderHealth(data);
    renderRuntime(data);
    renderSession(data);
    renderRuns(data);
    renderArtifacts(data);
    renderErrors(data);
    if (extraSessionProblems) appendWarningItems('session-warnings', extraSessionProblems);
  }

  function loadConsole(statusId) {
    if (state.consoleBusy) return;
    state.consoleBusy = true;
    if (statusId) setText(statusId, 'Leyendo...');

    fetch('/api/console', { method: 'GET' }).then(function (response) {
      if (!response.ok) throw new Error('/api/console respondio ' + response.status);
      return response.json();
    }).then(function (data) {
      renderConsole(data, null);
      if (statusId) setText(statusId, 'Leido a las ' + data.readAt + '.');
    }).catch(function (error) {
      var reason = error && error.message ? error.message : String(error);
      if (statusId) setText(statusId, 'Error: ' + reason);
      byId('health').className = 'health bad';
      byId('health-line').className = 'bad';
      byId('health-line').textContent = 'No se pudo leer el estado del agente: ' + reason;
    }).then(function () {
      state.consoleBusy = false;
    });
  }

  function runSessionCheck() {
    if (state.consoleBusy) return;
    state.consoleBusy = true;

    var button = byId('session-check-run');
    button.disabled = true;
    setText('session-check-status', 'Corriendo el chequeo: abre un navegador y puede tardar uno o dos minutos.');

    post('/api/session-check', {}).then(function (data) {
      renderConsole(data, data.problems || []);
      setText('session-check-status',
        'Chequeo terminado: ' + data.check.result +
        ' (' + (data.check.exitCode === null ? 'sin codigo de salida' : 'codigo ' + data.check.exitCode) + ').');
    }).catch(function (error) {
      setText('session-check-status', 'Error: ' + (error && error.message ? error.message : String(error)));
    }).then(function () {
      state.consoleBusy = false;
      button.disabled = false;
    });
  }

  var TABS = ['shipment', 'runtime', 'session', 'runs', 'artifacts', 'errors'];

  function selectTab(name) {
    TABS.forEach(function (tab) {
      var button = document.querySelector('[data-tab="' + tab + '"]');
      var panel = byId('panel-' + tab);
      var active = tab === name;
      if (button) button.setAttribute('aria-selected', active ? 'true' : 'false');
      if (panel) panel.hidden = !active;
    });
    if (name !== 'shipment') loadConsole(name === 'runtime' ? 'runtime-status' : null);
  }

  var tabButtons = document.querySelectorAll('.tab');
  for (var index = 0; index < tabButtons.length; index += 1) {
    tabButtons[index].addEventListener('click', function () {
      selectTab(this.getAttribute('data-tab'));
    });
  }

  byId('analyze').addEventListener('click', analyze);
  byId('approve').addEventListener('click', approve);
  byId('create').addEventListener('click', function () { run('create'); });
  byId('dry-run').addEventListener('click', function () { run('dry-run'); });
  byId('token').addEventListener('input', syncButtons);
  byId('console-refresh').addEventListener('click', function () { loadConsole('runtime-status'); });
  byId('session-check-run').addEventListener('click', runSessionCheck);

  syncButtons();
  loadConsole(null);
})();
`;
