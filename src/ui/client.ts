/**
 * The page's script: three `fetch` calls and DOM rendering. No framework, no
 * bundler, no dependency — served verbatim by `server.ts` as `/app.js`.
 *
 * Deliberate boundaries:
 *
 * - The script never computes a hash. It receives `approvalHash` from
 *   `/api/approve`, shows it, and posts it back with the run. The server
 *   recomputes the hash from the posted values every time, so a stale hash after
 *   an edit is refused there, not here.
 * - Every value shown comes from the server response, and all of it is rendered
 *   with `textContent`/`createElement`: pasted data is never interpreted as HTML.
 * - The two gates stay separate on screen: approving the data has its own
 *   section, the creation needs its own token in its own input.
 */
export const CLIENT_JS = `(function () {
  'use strict';

  var state = {
    message: '',
    approvedHash: null,
    applying: false,
    busy: false
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

  byId('analyze').addEventListener('click', analyze);
  byId('approve').addEventListener('click', approve);
  byId('create').addEventListener('click', function () { run('create'); });
  byId('dry-run').addEventListener('click', function () { run('dry-run'); });
  byId('token').addEventListener('input', syncButtons);
  syncButtons();
})();
`;
