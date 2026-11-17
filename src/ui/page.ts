/**
 * The single page (plan §6: one screen, no navigation, no lists, no dashboard).
 *
 * Plain HTML with a little CSS, served as-is: no framework, no build step, no
 * client-side dependency. The markup carries no data — every value on screen
 * comes from the server, so the page can never show a payload that was not
 * parsed or hashed on the server.
 *
 * The layout is the flow, top to bottom, and the steps below the preview stay
 * hidden until the parse succeeds: a rejected message leaves nothing actionable.
 */
export const PAGE_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MDL Logistics — envío manual</title>
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
    max-width: 62rem;
    padding: 1.5rem 1.25rem 4rem;
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.05rem; margin: 0 0 .75rem; }
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
  footer { color: var(--muted); font-size: .82rem; border-top: 1px solid var(--line); padding-top: .8rem; }
</style>
</head>
<body>

<h1>Envío manual — MVP 01</h1>
<p class="lead">Pegá el mensaje de WhatsApp, revisá los datos, aprobalos y recién después autorizá la creación. Una página, un envío.</p>

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

<footer>Esta página puede crear envíos, por eso escucha solo en 127.0.0.1. No hay ninguna acción sobre la etiqueta: el flujo termina con la etiqueta impaga.</footer>

<script src="/app.js"></script>
</body>
</html>
`;
