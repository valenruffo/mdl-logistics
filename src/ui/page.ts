/**
 * The single page: a maintenance console with tabs, no navigation, no framework.
 *
 * Plain HTML with a little CSS, served as-is: no build step, no client-side
 * dependency. The markup carries **no data** — every value on screen (runtime,
 * session, runs, artifacts, errors, the health line) comes from
 * `GET /api/console`, and the shipment flow is built from the server's own
 * analyze/approve responses. Nothing on this page is written by a model.
 *
 * Tabs, in order:
 *
 * 1. `Envío manual` — the existing flow: paste, review, approve, authorize.
 * 2. `Runtime` — process, Node, PID, store host, session source, headless flag,
 *    artifacts directory.
 * 3. `Sesión` — the storageState/profile on disk and the last checks, plus the
 *    one explicit button that runs `session-check` (it opens a browser).
 * 4. `Runs` — every run record, newest first, with the open ones marked.
 * 5. `Artefactos` — per run, the files with their sizes, the plain warning
 *    that traces and screenshots carry personal data, and the instruction for
 *    retrieving them over SSH. No download link: the page serves no file.
 * 6. `Errores` — the most recent failure report the executor wrote, verbatim,
 *    next to the warning that its text may name the recipient.
 *
 * The health line sits above the tabs because it answers the only question that
 * matters before touching anything: can the agent work right now?
 */

/**
 * The one instruction for getting at the artifact files. The page lists them and
 * never serves them: they hold recipient personal data and panel-session material,
 * so they leave the box over SSH, not over the web server that can create
 * shipments. Exported so a test can assert the page shows exactly this.
 */
export const ARTIFACT_RETRIEVAL_INSTRUCTION =
  'Los artefactos quedan en el volumen montado y se retiran por SSH desde el equipo del operador, por ejemplo con docker compose cp mdl-logistics:/app/artifacts ./artifacts, o leyendo directo la ruta del volumen (/app/artifacts en el contenedor).';

export const PAGE_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MDL Logistics — consola de mantenimiento</title>
<style>
  :root {
    color-scheme: light dark;
    --line: #c9ccd4;
    --muted: #62676f;
    --accent: #1c4ed8;
    --danger: #b3261e;
    --warn: #8a5a00;
    --ok: #1b6b3a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto;
    max-width: 68rem;
    padding: 1.5rem 1.25rem 4rem;
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.05rem; margin: 0 0 .75rem; }
  h3 { font-size: .95rem; margin: 1.1rem 0 .4rem; }
  p.lead, p.hint { color: var(--muted); margin: 0 0 1rem; }
  section.card {
    border: 1px solid var(--line);
    border-radius: .6rem;
    padding: 1rem 1.1rem;
    margin: 0 0 1rem;
  }
  section.card[hidden] { display: none; }
  textarea, input, select {
    font: inherit;
    width: 100%;
    padding: .45rem .55rem;
    border: 1px solid var(--line);
    border-radius: .4rem;
    background: transparent;
    color: inherit;
  }
  textarea { min-height: 13rem; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  label { display: block; font-weight: 600; margin: 0 0 .25rem; }
  .row { margin: 0 0 .85rem; }
  .row .meta { color: var(--muted); font-size: .82rem; margin: .15rem 0 0; }
  .row.derived input, .row.derived select { border-color: var(--warn); }
  .row .derived-note { color: var(--warn); font-size: .82rem; margin: .15rem 0 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: 0 .9rem; }
  button {
    font: inherit;
    font-weight: 600;
    padding: .5rem .9rem;
    border-radius: .4rem;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff;
    cursor: pointer;
  }
  button.secondary { background: transparent; color: var(--accent); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .actions { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; }
  ul.issues { margin: .3rem 0 .8rem; padding-left: 1.2rem; }
  ul.issues li { margin: .15rem 0; }
  .tag {
    display: inline-block;
    font: 600 .75rem/1 ui-monospace, monospace;
    padding: .2rem .4rem;
    border-radius: .25rem;
    border: 1px solid currentColor;
    margin-right: .35rem;
  }
  .bad { color: var(--danger); }
  .ok { color: var(--ok); }
  .warn { color: var(--warn); }
  .hash { font-family: ui-monospace, monospace; word-break: break-all; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { text-align: left; padding: .2rem .4rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 600; color: var(--muted); }
  .status { color: var(--muted); min-height: 1.2rem; margin: .5rem 0 0; }
  .note { color: var(--warn); }
  .mono { font-family: ui-monospace, monospace; word-break: break-all; white-space: pre-wrap; }
  .health {
    border: 2px solid var(--line);
    border-radius: .6rem;
    padding: .7rem .9rem;
    margin: 0 0 1rem;
  }
  .health.ok { border-color: var(--ok); }
  .health.warn { border-color: var(--warn); }
  .health.bad { border-color: var(--danger); }
  .health p { margin: 0; font-weight: 600; }
  .health ul { margin: .35rem 0 0; padding-left: 1.2rem; font-size: .85rem; color: var(--muted); }
  nav.tabs {
    display: flex;
    flex-wrap: wrap;
    gap: .4rem;
    border-bottom: 1px solid var(--line);
    margin: 0 0 1rem;
    padding: 0 0 .5rem;
  }
  nav.tabs button {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--line);
    font-weight: 600;
  }
  nav.tabs button[aria-selected="true"] {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .panel[hidden] { display: none; }
  footer { color: var(--muted); font-size: .82rem; border-top: 1px solid var(--line); padding-top: .8rem; }
</style>
</head>
<body>

<h1>Envío manual — MVP 01</h1>
<p class="lead">Una sola página para operar el agente: pegá el mensaje de WhatsApp para crear un envío, o revisá el runtime, la sesión, los runs, los artefactos y los errores sin salir de acá. Todo lo que se ve se lee del proceso o de los archivos; nada lo escribe un modelo.</p>

<div class="health" id="health">
  <p id="health-line">Leyendo el estado del agente…</p>
  <ul id="health-facts"></ul>
</div>

<nav class="tabs" role="tablist" aria-label="Secciones de la consola">
  <button type="button" class="tab" data-tab="shipment" role="tab" aria-selected="true">Envío manual</button>
  <button type="button" class="tab" data-tab="runtime" role="tab" aria-selected="false">Runtime</button>
  <button type="button" class="tab" data-tab="session" role="tab" aria-selected="false">Sesión</button>
  <button type="button" class="tab" data-tab="runs" role="tab" aria-selected="false">Runs</button>
  <button type="button" class="tab" data-tab="artifacts" role="tab" aria-selected="false">Artefactos</button>
  <button type="button" class="tab" data-tab="errors" role="tab" aria-selected="false">Errores</button>
</nav>

<div class="panel" id="panel-shipment" role="tabpanel">

<section class="card" id="step-message">
  <h2>1. Mensaje</h2>
  <div class="row">
    <label for="message">Mensaje pegado (uno solo)</label>
    <textarea id="message" spellcheck="false" autocomplete="off" placeholder="MDL - Datos de envío&#10;&#10;Destino&#10;Provincia: ..."></textarea>
  </div>
  <div class="actions">
    <button id="analyze" type="button">Analizar</button>
  </div>
  <p class="status" id="analyze-status" role="status"></p>
</section>

<section class="card" id="step-preview" hidden>
  <h2>2. Datos del envío</h2>
  <div id="rejection" hidden></div>
  <div id="preview" hidden>
    <div id="warnings"></div>
    <form id="shipment-form" autocomplete="off"></form>
    <p class="hint">Estos son los valores que se escribirán en el panel. Podés corregir cualquiera; si los corregís después de aprobarlos, la aprobación deja de valer.</p>
  </div>
</section>

<section class="card" id="step-approve" hidden>
  <h2>3. Aprobar los datos</h2>
  <p class="hint">Aprobar congela el payload que ves arriba en un hash calculado en el servidor. No autoriza nada todavía.</p>
  <div class="actions">
    <button id="approve" type="button">Aprobar estos datos</button>
  </div>
  <div id="approval"></div>
</section>

<section class="card" id="step-authorize" hidden>
  <h2>4. Autorizar la creación</h2>
  <p class="hint">Crear el envío es un paso distinto de aprobar los datos. Escribí el código postal de destino y la palabra <strong>crear</strong>.</p>
  <div class="row">
    <label for="token">Confirmación</label>
    <input id="token" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="1901 crear">
    <p class="meta">Se compara en el servidor con el código postal del payload aprobado.</p>
  </div>
  <div class="actions">
    <button id="create" type="button" disabled>Autorizar la creación</button>
    <button id="dry-run" type="button" class="secondary" disabled>Probar en seco hasta el resumen (no crea nada)</button>
  </div>
  <p class="status" id="approval-state" role="status"></p>
</section>

<section class="card" id="step-result" hidden>
  <h2>5. Resultado</h2>
  <div id="result"></div>
</section>

</div>

<div class="panel" id="panel-runtime" role="tabpanel" hidden>
<section class="card">
  <h2>Runtime</h2>
  <p class="hint">Lo que este proceso puede decir de sí mismo. El origen del panel se muestra solo como host: no hay token, cookie ni contraseña en ningún valor de esta página.</p>
  <div class="actions">
    <button id="console-refresh" type="button" class="secondary">Volver a leer ahora</button>
    <p class="status" id="runtime-status" role="status"></p>
  </div>
  <div id="runtime-warnings"></div>
  <div id="runtime-body"></div>
</section>
</div>

<div class="panel" id="panel-session" role="tabpanel" hidden>
<section class="card">
  <h2>Sesión</h2>
  <p class="hint">El chequeo de sesión abre un navegador Chromium contra el panel del admin y lo lee en modo lectura. No corre solo: se dispara únicamente con este botón, y cada corrida queda en el historial de abajo.</p>
  <div class="actions">
    <button id="session-check-run" type="button">Correr el chequeo de sesión ahora (abre un navegador)</button>
  </div>
  <p class="status" id="session-check-status" role="status"></p>
  <div id="session-warnings"></div>
  <div id="session-body"></div>
</section>
</div>

<div class="panel" id="panel-runs" role="tabpanel" hidden>
<section class="card">
  <h2>Runs</h2>
  <p class="hint">Todos los registros de ejecución, del más nuevo al más viejo. Un registro abierto bloquea la creación de ese mismo mensaje hasta que una persona lo resuelva a mano.</p>
  <div id="runs-warnings"></div>
  <div id="runs-body"></div>
</section>
</div>

<div class="panel" id="panel-artifacts" role="tabpanel" hidden>
<section class="card">
  <h2>Artefactos</h2>
  <p class="note">Las capturas y los traces contienen datos personales del destinatario (nombre, dirección, teléfono) y la sesión del panel. El informe de fallo también puede citar el nombre o la dirección del destinatario. Nada de esto se sirve por HTTP.</p>
  <p class="mono" id="artifacts-how">${ARTIFACT_RETRIEVAL_INSTRUCTION}</p>
  <div id="artifacts-warnings"></div>
  <div id="artifacts-body"></div>
</section>
</div>

<div class="panel" id="panel-errors" role="tabpanel" hidden>
<section class="card">
  <h2>Errores</h2>
  <p class="hint">El informe más reciente que el ejecutor escribió y que falló una comprobación estructural, con el mensaje tal como quedó en el archivo. El archivo no se descarga desde acá: se retira por SSH, como el resto de los artefactos.</p>
  <div id="errors-warnings"></div>
  <div id="errors-body"></div>
</section>
</div>

<footer>Esta página puede crear envíos, por eso escucha solo en 127.0.0.1. No hay ninguna acción sobre la etiqueta: el flujo termina con la etiqueta impaga. La página no sirve archivos: los artefactos se listan con su tamaño y se retiran del volumen por SSH.</footer>

<script src="/app.js"></script>
</body>
</html>
`;
