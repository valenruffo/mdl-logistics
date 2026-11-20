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
 *   and the mode — always `create`: it is the only run path in the UI (the
 *   `Probar en seco` button is gone; the executor's dry run stays a dev-tool
 *   capability). It never computes or echoes an approval hash and there is no
 *   token input to fill: creating a shipment costs nothing (R10 as amended).
 * - **A queue, not a one-shot.** A confirmed `created` resets only the inputs —
 *   message, fields, preview — so the operator pastes the next message right
 *   away; the result card keeps showing the created `#EM`. A failure or a
 *   refusal keeps the form untouched for a fix-and-retry, and every run
 *   response re-fetches the rail so the new run shows up without a reload.
 *   One refinement the operator asked for: `Analizar` never locks, so the next
 *   message can be analyzed *while* the current one runs — the preview is pure
 *   parsing, no browser. When the response then arrives, that analyzed message
 *   stays on screen and `Crear envío` is enabled again immediately; a preview
 *   prepared during the run is never wiped by the queue reset.
 * - **One run at a time, said out loud.** The executor is single-flight (one
 *   Chromium, one session), so `Crear envío` disables while a run is in flight
 *   and the page says why next to it: `Una corrida a la vez: el panel maneja un
 *   solo navegador.` A second create attempt is refused by the server's 409,
 *   and the refusal is shown in the page as always.
 * - **Every run has a duration.** The run response carries `durationMs`,
 *   measured where the journey begins and ends, persisted in the outcome record
 *   and shown three ways: the created card's `Duración: 19,4 s` line, the
 *   workers panel's rows (`#EM1068 · creada · 02:07 · 19s`), and as the final
 *   line of the real post-run card that snaps over the estimate.
 * - **No markup injection.** Every value shown comes from a server response and
 *   is written with `textContent`/`createElement`: pasted data, panel text, file
 *   names and record fields are never interpreted as HTML.
 * - **The rail is read-only** except for its own `Verificar ahora` button, which
 *   is the one control that opens a browser, `Cerrar sesión`, which posts the
 *   logout and returns to the login card, and the theme toggle, which is the one
 *   control that writes anything locally (the theme key, never a datum).
 * - **An expired session is not an error dialog.** A `401` from any call sends the
 *   browser to `/login`: the operator sees the card, not a JSON reason in the rail.
 * - **Progress is an honest estimate.** The run POST answers only at the end, so
 *   the in-flight card advances its step checklist on a timer over the known
 *   journey (`JOURNEY_STEPS`, injected from `./progress`), labels the percentage
 *   `aproximado`/`estimado`, never shows the last step as done, and snaps to the
 *   response's real outcome when it arrives. Nothing says "creado" before the
 *   response says so.
 * - **Errors come in tiers.** One human heading, one actionable sentence, and
 *   the raw internals (run-record paths, the executor's reason) collapsed inside
 *   a `<details>` that wraps and scrolls inside its card. The hand-edit JSON
 *   recipe for resolving a record never reaches the screen — the record's file
 *   path does, and the recipe itself stays in docs/ops.
 */
import { JOURNEY_STEPS } from './progress';

export const CLIENT_JS = `(function (document, fetch, localStorage, matchMedia, setTimer, clearTimer) {
  'use strict';

  var THEME_KEY = 'mdl-theme';

  // The fixed journey steps, injected from src/ui/progress.ts: one source of
  // truth for the estimate the progress card shows while the run POST is in
  // flight.
  var JOURNEY_STEPS = ${JSON.stringify(JOURNEY_STEPS)};

  var state = {
    message: '',
    analyzed: false,
    modalidad: null,
    fieldsByModalidad: null,
    provinces: [],
    busy: false,
    consoleBusy: false,
    // True when the operator analyzed a NEW message while a run was in flight:
    // that preview is the queue, and the created-run reset must not wipe it.
    preparedNext: false,
    // The in-flight run's own start instant, for its worker card.
    runStartedAt: null,
    // The last console snapshot, so the workers panel can re-render between reads.
    lastConsole: null
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

  function textOr(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback || '(no registrado)';
    return String(value);
  }

  function pad2(value) { return value < 10 ? '0' + value : String(value); }

  /**
   * A run duration as the created card prints it: seconds with one decimal and
   * a comma, "Duración: 19,4 s". null when the response carried no usable
   * duration — the line is then omitted, never invented.
   */
  function durationText(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return null;
    return 'Duración: ' + (ms / 1000).toFixed(1).replace('.', ',') + ' s';
  }

  /**
   * The same duration as a workers-panel row prints it: rounded seconds
   * ("19s"), or minutes and seconds once it passes a minute ("2m 05s").
   */
  function durationShort(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return null;
    var seconds = Math.round(ms / 1000);
    if (seconds < 60) return seconds + 's';
    return Math.floor(seconds / 60) + 'm ' + pad2(seconds % 60) + 's';
  }

  /** A wall-clock label for an ISO timestamp; the raw value when it is not one. */
  function timeOf(iso) {
    if (iso === null || iso === undefined || iso === '') return '(sin fecha)';
    var parsed = new Date(String(iso));
    if (isNaN(parsed.getTime())) return String(iso);
    return pad2(parsed.getHours()) + ':' + pad2(parsed.getMinutes());
  }

  /**
   * A short "since when": the clock for a same-day timestamp, and a relative
   * count for anything older ("hace 3 h", "hace 2 d"). Nothing longer, because
   * the rail is read in a glance.
   */
  function sinceWhen(iso) {
    if (iso === null || iso === undefined || iso === '') return null;
    var then = Date.parse(String(iso));
    if (isNaN(then)) return null;

    var now = new Date();
    var when = new Date(then);
    var sameDay = when.getFullYear() === now.getFullYear() &&
      when.getMonth() === now.getMonth() && when.getDate() === now.getDate();
    var minutes = Math.round((now.getTime() - then) / 60000);

    if (minutes < 60) return 'hace ' + (minutes < 1 ? 1 : minutes) + ' min';
    if (sameDay) return timeOf(iso);
    var hours = Math.round(minutes / 60);
    if (hours < 24) return 'hace ' + hours + ' h';
    return 'hace ' + Math.round(hours / 24) + ' d';
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
    if (field.kind === 'modalidad') {
      // The segmented control: two radios, one per modality. Switching one
      // re-derives the visible field set (see switchModalidad).
      control = document.createElement('span');
      control.className = 'segmented';
      ['domicilio', 'sucursal'].forEach(function (option) {
        var optionLabel = document.createElement('label');
        var input = document.createElement('input');
        input.type = 'radio';
        input.name = 'modalidad';
        input.value = option;
        input.checked = field.value === option;
        input.setAttribute('data-key', 'modalidad');
        input.addEventListener('change', function () { switchModalidad(option); });
        optionLabel.appendChild(input);
        optionLabel.appendChild(make('span', null, option));
        control.appendChild(optionLabel);
      });
    } else if (field.kind === 'province') {
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
    if (field.kind !== 'modalidad') {
      // The radio pair carries its own data-key and per-option labels; a single
      // id here would be duplicated across the two inputs.
      control.id = 'field-' + field.key;
      control.setAttribute('data-key', field.key);
    }
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

  /**
   * Re-derives the visible field set when the operator switches the Modalidad
   * control: domicilio shows the address group, sucursal shows Sucursal + CP
   * and hides it. Values the operator already has on screen for shared keys
   * (postal code, recipient, package) carry over; mode-specific keys take the
   * target list's own prefill — the sucursal field stays empty (nothing is
   * invented), and each modality keeps its own declared-value policy.
   */
  var SHARED_FIELD_KEYS = ['zipCode', 'name', 'lastName', 'height', 'width', 'depth', 'weight'];

  function switchModalidad(next) {
    if (!state.fieldsByModalidad || (next !== 'domicilio' && next !== 'sucursal')) return;
    if (next === state.modalidad) return;
    var current = collect();
    state.modalidad = next;
    renderFields(state.fieldsByModalidad[next].map(function (field) {
      if (SHARED_FIELD_KEYS.indexOf(field.key) !== -1 && typeof current[field.key] === 'string') {
        field.value = current[field.key];
      }
      return field;
    }));
  }

  function collect() {
    var values = {};
    var nodes = byId('shipment-form').querySelectorAll('[data-key]');
    for (var index = 0; index < nodes.length; index += 1) {
      // The Modalidad control is a radio pair: only the checked one counts.
      if (nodes[index].type === 'radio' && !nodes[index].checked) continue;
      values[nodes[index].getAttribute('data-key')] = nodes[index].value;
    }
    return values;
  }

  function syncButtons() {
    var ready = state.analyzed && !state.busy;
    byId('create').disabled = !ready;
    // Analizar never locks: parsing is pure and never touches the executor's
    // browser lock, so the operator prepares the next message during a run.
    byId('analyze').disabled = false;
  }

  // ----------------------------------------------------- the progress estimate

  var PROGRESS_TICK_MS = 2000;
  var progress = { timer: null, steps: [], completed: 0 };

  function stepsFor(modality) {
    return JOURNEY_STEPS[modality === 'sucursal' ? 'sucursal' : 'domicilio'];
  }

  /** Completed steps to a percentage, capped below 100: only the response can say "done". */
  function approximatePercent(completed, total) {
    if (total <= 0) return 0;
    var capped = Math.max(0, Math.min(completed, total - 1));
    return Math.round((capped / total) * 100);
  }

  function stopProgress() {
    if (progress.timer !== null) {
      clearTimer(progress.timer);
      progress.timer = null;
    }
  }

  function renderProgressList(list, percentNode) {
    clear(list);
    progress.steps.forEach(function (label, index) {
      var marker;
      var cls;
      if (index < progress.completed) {
        marker = '✓';
        cls = 'done';
      } else if (index === progress.completed) {
        marker = '⏳';
        cls = 'current';
      } else {
        marker = '·';
        cls = 'pending';
      }
      list.appendChild(make('li', cls, marker + ' ' + label));
    });
    // Approximate by nature: the steps last about the same, the clock is a
    // guess, and the wording on screen says so.
    percentNode.textContent =
      'Progreso estimado: ' + approximatePercent(progress.completed, progress.steps.length) + ' % (aproximado)';
  }

  /**
   * The in-flight card: the step checklist for this modality, a current step
   * advancing on a timer, and an approximate percentage. The timer stops at the
   * second-to-last step and never marks the last one done — the response is the
   * only thing that can close the run, and renderResult snaps the card to it.
   */
  function startProgressCard(modality) {
    progress.steps = stepsFor(modality).slice();
    progress.completed = 0;
    stopProgress();

    var box = byId('result');
    clear(box);
    var card = make('div', 'result-card progress-card');
    card.appendChild(make('p', 'progress-title', 'Creando el envío — progreso estimado'));
    card.appendChild(make('p', 'progress-note', 'El porcentaje es aproximado: los pasos duran parejo y el recuento es estimado.'));
    var list = document.createElement('ul');
    list.className = 'progress-steps';
    card.appendChild(list);
    var percentNode = make('p', 'progress-percent', '');
    card.appendChild(percentNode);
    box.appendChild(card);

    renderProgressList(list, percentNode);

    progress.timer = setTimer(function () {
      if (progress.completed < progress.steps.length - 1) {
        progress.completed += 1;
        renderProgressList(list, percentNode);
        // The worker card's live percentage rides on the same tick.
        renderWorkersFromState();
      }
    }, PROGRESS_TICK_MS);
  }

  // ------------------------------------------------------------ the error card

  function pushUnique(lines, text) {
    if (text !== '' && lines.indexOf(text) === -1) lines.push(text);
  }

  /**
   * The technical lines for the collapsed details: everything is demoted there,
   * nothing is dropped — except the hand-edit JSON recipe for resolving a run
   * record, which is an operator trap on screen. The recipe stays in docs/ops;
   * here the record's file path survives so the file can still be found.
   */
  function technicalLines(items) {
    var lines = [];
    (items || []).forEach(function (item) {
      var text = String(item);
      if (text.indexOf('"runId"') !== -1) {
        var recordPath = /run-records\\/[^\\s")]+\\.json/.exec(text);
        if (recordPath) pushUnique(lines, 'registro en disco: ' + recordPath[0]);
        return;
      }
      pushUnique(lines, text);
    });
    return lines;
  }

  function errorDetails(lines) {
    var details = document.createElement('details');
    details.className = 'error-details';
    var summary = document.createElement('summary');
    summary.textContent = 'Detalles técnicos';
    details.appendChild(summary);
    var body = make('div', 'error-detail-body');
    lines.forEach(function (line) {
      body.appendChild(make('p', 'mono', line));
    });
    details.appendChild(body);
    return details;
  }

  /**
   * The readable, contained error: one short human heading, one actionable
   * sentence, and the raw internals collapsed. Everything lives inside the
   * card, so long paths wrap instead of pushing the layout wide.
   */
  function renderErrorCard(parts) {
    stopProgress();
    var box = byId('result');
    clear(box);
    var card = make('div', 'result-card is-bad');
    card.appendChild(make('p', 'error-heading bad', parts.heading));
    if (parts.sub) card.appendChild(make('p', null, parts.sub));
    card.appendChild(make('p', 'error-action', 'Qué podés hacer: ' + parts.action));
    if (parts.lines.length > 0) card.appendChild(errorDetails(parts.lines));
    if (parts.note) card.appendChild(make('p', 'note', parts.note));
    // The real duration, when the run measured one — the final word on how
    // long the attempt actually took, over whatever the estimate claimed.
    var duration = durationText(parts.durationMs);
    if (duration !== null) card.appendChild(make('p', 'note result-duration', duration));
    box.appendChild(card);
  }

  /** The heading and the one action sentence, derived from the gate's refusal. */
  function refusalCopy(reason) {
    if (String(reason).indexOf('already created a shipment') !== -1) {
      return {
        heading: 'Este mensaje ya creó un envío.',
        action: 'Si de verdad necesitás otro envío, cambiá el mensaje para que sea un pedido distinto.',
      };
    }
    return {
      heading: 'Este mensaje ya tiene una corrida sin resolver.',
      action: 'Revisá el panel y, si el envío no existe, marcá la corrida como resuelta.',
    };
  }

  /** An HTTP-level failure (the run POST itself failed): the same tiers, honestly worded. */
  function renderRunFailure(error) {
    var reason = error && error.message ? error.message : String(error);
    if (error && error.status === 409) {
      renderErrorCard({
        heading: 'Hay otra corrida en curso.',
        sub: null,
        action: 'Esperá a que termine y volvé a intentar; no se cambió nada.',
        lines: [reason],
        note: null,
      });
      return;
    }
    renderErrorCard({
      heading: 'No se pudo completar la corrida.',
      sub: null,
      action: 'Podés volver a intentar; si vuelve a fallar, avisá con los detalles de abajo.',
      lines: ['código HTTP: ' + (error && error.status ? error.status : '(desconocido)'), reason],
      note: null,
    });
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
    // The in-flight progress card is not the preview's to close: analyzing the
    // next message while a run is going leaves it exactly where it was.
    if (!state.busy) clear(byId('result'));
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
    state.modalidad = null;
    state.fieldsByModalidad = null;
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
    state.modalidad = data.modalidad;
    state.fieldsByModalidad = data.fieldsByModalidad;
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
    if (state.busy) {
      // This message was analyzed while another run is in flight: it is the
      // prepared next step of the queue, and the reset below must keep it.
      state.preparedNext = true;
    } else {
      clear(byId('result'));
      setStatus('run-status', '', null);
    }
    syncButtons();
  }

  function run() {
    if (!state.analyzed) {
      setStatus('run-status', 'Analizá el mensaje antes de continuar.', 'warn');
      return;
    }

    state.busy = true;
    state.preparedNext = false;
    state.runStartedAt = new Date().toISOString();
    syncButtons();
    setStatus('run-status', 'Creando el envío: recorre el panel y hace un solo click en Crear envío…', null);

    // The POST answers only at the end, so the card is an estimate that runs on
    // a timer; renderResult snaps it to the response's real outcome. The same
    // instant puts the run's worker card at the top of the workers panel.
    startProgressCard(state.modalidad);
    renderWorkersFromState();

    post('/api/run', { message: state.message, form: collect(), mode: 'create' }).then(function (data) {
      renderResult(data);
      // The queue: only a confirmed creation clears the inputs — and never a
      // preview the operator analyzed while this run was in flight: that is
      // already the next step, and wiping it would throw prepared work away.
      if (data.status === 'created') {
        if (state.preparedNext) {
          setStatus('analyze-status', 'Envío anterior creado: el mensaje que analizaste ya está listo para crear.', null);
        } else {
          resetForNextShipment();
        }
      }
      loadConsole(null);
    }).catch(function (error) {
      renderRunFailure(error);
      setStatus('run-status', 'La corrida no se completó.', 'bad');
      loadConsole(null);
    }).then(function () {
      state.busy = false;
      syncButtons();
      // The in-flight worker card goes away the moment the response arrives.
      // A console read in flight renders the fresh list itself; when there is
      // none, this re-render is what removes the card honestly.
      if (!state.consoleBusy) renderWorkersFromState();
    });
  }

  /**
   * The queue step the operator asked for: after a confirmed creation only the
   * inputs reset — message, fields, preview — so the next message can be pasted
   * immediately. The result card is not touched: it keeps showing the created
   * shipment id until the next analyze clears it. A failure or refusal never calls
   * this: the operator fixes the form and retries without re-pasting.
   */
  function resetForNextShipment() {
    state.message = '';
    state.analyzed = false;
    state.modalidad = null;
    state.fieldsByModalidad = null;
    byId('message').value = '';
    updateMessageBadge();
    clear(byId('shipment-form'));
    clear(byId('warnings'));
    clear(byId('rejection'));
    show('data-empty', true);
    setText('data-badge', 'sin analizar');
    setStatus('analyze-status', 'En cola: pegá el siguiente mensaje y tocá Analizar.', null);
    syncButtons();
  }

  /**
   * The run's final state, snapped over whatever estimate the progress card
   * was showing: whatever the response says is what the screen now says.
   */
  function renderResult(data) {
    stopProgress();

    if (data.status === 'invalid-form') {
      var box = byId('result');
      clear(box);
      var formCard = make('div', 'result-card is-bad');
      formCard.appendChild(make('p', 'error-heading bad', 'No se ejecutó nada: revisá estos campos.'));
      formCard.appendChild(issueList(data.errors.map(function (item) { return item.message; })));
      box.appendChild(formCard);
      setStatus('run-status', 'El envío no se creó.', 'bad');
      return;
    }

    if (data.status === 'refused') {
      var copy = refusalCopy(data.reason);
      renderErrorCard({
        heading: copy.heading,
        sub: 'La corrida se detuvo antes del primer paso: el panel no se abrió y no se creó nada.',
        action: copy.action,
        lines: technicalLines(data.details).concat([data.reason]),
        note: null,
      });
      setStatus('run-status', 'El envío no se creó.', 'bad');
      return;
    }

    if (data.status === 'created') {
      var box = byId('result');
      clear(box);
      var card = make('div', 'result-card');
      card.appendChild(make('p', 'result-id ok', 'Envío creado: ' + data.shipmentId));
      card.appendChild(make('p', null, 'Estado en el panel: ' + (data.statusBadges.join(', ') || '(no leído)')));
      card.appendChild(make('p', null, 'Costo (resumen): ' + (data.cost.summary || '(no leído)')));
      card.appendChild(make('p', null, 'Costo (detalle): ' + (data.cost.detail || '(no leído)')));
      if (data.labelUnpaid.proven) {
        card.appendChild(make('p', 'ok',
          'Etiqueta impaga confirmada: el identificador, el estado del panel y el control de etiqueta siguen presentes; no se accionó nada sobre la etiqueta.'));
      } else {
        card.appendChild(make('p', 'bad', 'INCOMPLETO: no se puede probar que la etiqueta siga impaga.'));
        if (data.labelUnpaid.problem) card.appendChild(make('p', 'bad', data.labelUnpaid.problem));
        if (data.labelUnpaid.details.length > 0) card.appendChild(issueList(data.labelUnpaid.details));
      }
      // The true duration, measured by the run itself: the final line the
      // estimate card was always going to be replaced by.
      var duration = durationText(data.durationMs);
      if (duration !== null) card.appendChild(make('p', 'result-duration', duration));
      card.appendChild(errorDetails(technicalLines([
        data.recordPath ? 'registro previo al click: ' + data.recordPath : '',
        data.outcomePath ? 'desenlace: ' + data.outcomePath : '',
        data.reportPath ? 'informe del ejecutor: ' + data.reportPath : '',
        data.detailScreenshot ? 'captura del detalle: ' + data.detailScreenshot : '',
      ])));
      box.appendChild(card);
      setStatus('run-status', 'Listo: la etiqueta queda impaga.', 'ok');
      return;
    }

    if (data.status === 'unknown') {
      renderErrorCard({
        heading: 'No sabemos si el envío se creó.',
        sub: 'El click se hizo una sola vez y la página de detalle nunca llegó: la corrida queda abierta a propósito.',
        action: 'Revisá la lista de envíos del panel antes de repetir este mensaje.',
        lines: technicalLines(data.details.concat(data.matches)).concat([
          data.reason,
          'Conciliación: ' + data.interpretation,
          data.recordPath ? 'registro a inspeccionar: ' + data.recordPath : '',
          data.outcomePath ? 'desenlace: ' + data.outcomePath : '',
        ]),
        note: data.note,
        durationMs: data.durationMs,
      });
      setStatus('run-status', 'Hay que conciliar a mano antes de repetir este mensaje.', 'warn');
      return;
    }

    if (data.status === 'not-created') {
      renderErrorCard({
        heading: 'El envío no se creó.',
        sub: 'La corrida se detuvo antes del click: nada se creó y la corrida quedó resuelta sola.',
        action: 'Podés repetir este mensaje cuando quieras: no hay nada que conciliar.',
        lines: technicalLines(data.details).concat([
          data.reason,
          'Etapa alcanzada: ' + data.stage,
          data.recordPath ? 'registro previo al click: ' + data.recordPath : '',
          data.outcomePath ? 'desenlace escrito: ' + data.outcomePath : '',
        ]),
        note: data.note,
        durationMs: data.durationMs,
      });
      setStatus('run-status', 'El envío no se creó. La corrida quedó resuelta: podés reintentar.', 'warn');
      return;
    }

    renderErrorCard({
      heading: 'No se pudo crear el envío.',
      sub: 'La corrida se detuvo: no se puede saber hasta qué paso llegó.',
      action: data.recordPath
        ? 'Antes de reintentar, resolvé la corrida que quedó abierta (el archivo está en los detalles).'
        : 'Podés volver a intentar cuando quieras: no quedó ninguna corrida abierta.',
      lines: technicalLines(data.details).concat([
        data.reason,
        data.recordPath ? 'registro a inspeccionar: ' + data.recordPath : '',
      ]),
      note: data.note,
      durationMs: data.durationMs,
    });
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
      railState('rail-session-state', 'rail-session-text', 'warn', 'Sin chequeos', 'nunca se verificó');
    } else {
      var since = sinceWhen(last.runAt);
      var meta = since === null ? null : 'verificada ' + since;
      if (last.result === 'usable') {
        railState('rail-session-state', 'rail-session-text', 'ok', 'Utilizable', meta);
      } else {
        railState('rail-session-state', 'rail-session-text', 'bad', 'No utilizable', meta);
      }
    }
    renderExpiry(data.session.expiry);
  }

  /**
   * The panel cookie's expiry, as a number of days. The payload carries only
   * the day count; a value that could not be read says so instead of guessing.
   */
  function renderExpiry(expiry) {
    var node = byId('rail-expiry');
    if (!node) return;
    var days = expiry && typeof expiry.daysRemaining === 'number' ? expiry.daysRemaining : null;
    if (days === null) {
      node.className = 'rail-line';
      node.textContent = 'vence: desconocido';
      return;
    }
    node.className = expiry.soon ? 'rail-line warn' : 'rail-line';
    node.textContent = 'vence en ' + days + (days === 1 ? ' día' : ' días');
  }

  /** The one word a run's outcome gets in its single line. */
  function outcomeWord(row) {
    if (row.outcome === 'created') return 'creada';
    if (row.outcome === 'unknown') return 'desconocida';
    if (row.outcome === 'not-created') return 'sin crear';
    return 'sin desenlace';
  }

  function renderWorkers(data) {
    var list = byId('workers-list');
    if (!list) return;
    clear(list);

    // The in-flight run is always the first worker card, with its live estimate
    // straight from the same progress machinery the result card uses.
    if (state.busy) {
      var inFlight = document.createElement('li');
      inFlight.className = 'worker in-flight';
      inFlight.appendChild(make('span', 'worker-line', '— · en curso · ' + timeOf(state.runStartedAt)));
      inFlight.appendChild(make('span', 'worker-progress',
        'Progreso estimado: ' + approximatePercent(progress.completed, progress.steps.length) + ' % (aproximado)'));
      list.appendChild(inFlight);
    }

    var rows = (data && data.runs && data.runs.rows ? data.runs.rows : []).slice(0, 5);
    if (rows.length === 0) {
      if (!state.busy) {
        var empty = document.createElement('li');
        empty.appendChild(make('span', 'meta', 'no hay ningún run registrado todavía'));
        list.appendChild(empty);
      }
      return;
    }

    rows.forEach(function (row) {
      var item = document.createElement('li');
      var line = textOr(row.shipmentId, '—') + ' · ' + outcomeWord(row) + ' · ' + timeOf(row.recordedAt);
      var duration = durationShort(row.durationMs);
      if (duration !== null) line += ' · ' + duration;
      item.textContent = line;
      list.appendChild(item);
    });
  }

  /** Re-renders the workers panel over the last console snapshot, in-flight card included. */
  function renderWorkersFromState() {
    renderWorkers(state.lastConsole);
  }

  function renderErrorsRail(data) {
    var detail = byId('rail-errors-detail');
    clear(detail);

    var latest = data.errors.latest;
    if (latest === null) {
      railState('rail-errors-state', 'rail-errors-text', 'ok', 'Ninguno', null);
    } else {
      railState('rail-errors-state', 'rail-errors-text', 'bad', 'Hay un informe con fallas', null);

      // One line: the failing check and when. The report's path and its text stay
      // on disk; the check names come from the server's closed vocabulary.
      var check = latest.checks.length > 0
        ? latest.checks.join(', ')
        : latest.unparseable ? 'informe ilegible' : 'sin comprobación';
      detail.appendChild(make('p', 'rail-line bad', check + ' · ' + timeOf(latest.recordedAt)));
    }

    var warnings = byId('rail-warnings');
    clear(warnings);
    if (data.warnings && data.warnings.length > 0) {
      data.warnings.forEach(function (warning) {
        warnings.appendChild(make('p', 'rail-line bad', warning.source + ': ' + warning.message));
      });
    }
  }

  function renderOpenAttempts(data) {
    var open = data.runs.rows.filter(function (row) { return row.unresolved; }).length;
    var node = byId('rail-open');
    node.className = open === 0 ? null : 'bad';
    node.textContent = open === 0 ? 'sin abiertas' : open === 1 ? '1 abierta' : open + ' abiertas';
  }

  function renderRail(data) {
    renderSessionRail(data);
    renderErrorsRail(data);
    renderOpenAttempts(data);
  }

  function renderRailFailure(reason) {
    railState('rail-session-state', 'rail-session-text', 'bad', 'No se pudo leer', reason);
    renderExpiry(null);
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
      state.lastConsole = data;
      renderRail(data);
      renderWorkers(data);
      if (statusId) setStatus(statusId, 'Leído a las ' + timeOf(data.readAt) + '.', 'ok');
    }).catch(function (error) {
      var reason = error && error.message ? error.message : String(error);
      renderRailFailure(reason);
      // The workers panel follows the same truth: with busy already false, the
      // in-flight card is dropped and the last known rows stay.
      renderWorkersFromState();
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
      state.lastConsole = data;
      renderRail(data);
      renderWorkers(data);
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
  byId('create').addEventListener('click', run);
  byId('session-check-run').addEventListener('click', runSessionCheck);
  byId('logout').addEventListener('click', logout);

  updateMessageBadge();
  syncButtons();
  loadConsole(null);
})(document, fetch, localStorage, matchMedia, setInterval, clearInterval);
`;
