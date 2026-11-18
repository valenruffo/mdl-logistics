/**
 * The one page: an operator's desk, not a console with tabs.
 *
 * The layout follows the approved artboard (`design/consola-operador/04-mesa-con-rail.html`)
 * exactly: a 224 px dark rail on the left holding the agent's state, and a
 * single centred work column on the right holding the whole shipment flow.
 *
 * - **The rail** is fed only by `GET /api/console`: the session as the last
 *   recorded check saw it, the newest run records, the newest failing report, the
 *   artifacts on disk and the count of open attempts. Every one of those is
 *   closed-vocabulary data — a level, a timestamp, a path, an identifier, a size.
 *   No report text, no check output, no recipient data. The rails dots always
 *   carry a word next to them, so no state is conveyed by colour alone.
 * - **The work column** is paste → `Analizar` → edit → `Crear envío`, plus the
 *   `Probar en seco` path that touches nothing. There is no approval hash and no
 *   typed token: creating a shipment costs nothing, so it needs no ceremony
 *   (R10 as amended). Buying the label does cost money, it stays forbidden, and
 *   nothing on this page names it.
 *
 * The markup carries **no data**: every value on screen comes from
 * `/api/console` or from an analyze/run response, and the client writes all of it
 * with `textContent`. Nothing on this page is written by a model.
 *
 * Also declared here, so a test can assert the page shows exactly these words:
 * the artifact-retrieval instruction, the on-disk note about failing reports, and
 * the on-disk note about the session-check output.
 */

import { CARRIER_NAME } from '../core/carrier';

/**
 * The one instruction for getting at the artifact files. The rail lists them and
 * never serves them: they hold recipient personal data and panel-session material,
 * so they leave the box over SSH, not over the web server that can create
 * shipments. Exported so a test can assert the page shows exactly this.
 */
export const ARTIFACT_RETRIEVAL_INSTRUCTION =
  'Los artefactos quedan en el volumen montado y se retiran por SSH desde el equipo del operador, por ejemplo con docker compose cp mdl-logistics:/app/artifacts ./artifacts, o leyendo directo la ruta del volumen (/app/artifacts en el contenedor).';

/**
 * The one sentence about the failing report. Same rule as the artifacts above:
 * the rail shows structural facts, the file stays on disk, and the operator reads
 * it over SSH because it may name the recipient.
 */
export const REPORT_ON_DISK_NOTE =
  'El informe completo queda en disco, en la ruta que se muestra arriba, y se retira por SSH desde el equipo del operador (docker compose cp, o directo la ruta del volumen). Esta página no copia ni muestra su texto porque el informe puede contener datos del destinatario: nombre, dirección y teléfono.';

/**
 * The one sentence about the session-check history. The check prints what it saw
 * on the panel, which can name the recipient, so the rail shows only its four
 * closed facts (result, exit code, when, how long) and the file leaves over SSH.
 */
export const SESSION_CHECK_OUTPUT_NOTE =
  'La salida completa de cada chequeo queda en disco, en el historial que se nombra arriba, y se retira por SSH desde el equipo del operador (docker compose cp, o directo la ruta del volumen). Esta página no copia ni muestra su texto, porque la salida es lo que el chequeo imprimió al leer el panel y puede nombrar al destinatario: de cada chequeo se muestran solo el resultado, el código de salida, la fecha y la duración.';

/**
 * What the rail's footer shows on the right. The artboard prints a commit hash
 * there; the page cannot know one without shelling out to `git` at runtime, so it
 * prints the package version instead. `tests/unit/ui-flow.test.ts` pins it to
 * `package.json`, so the two cannot drift apart.
 */
export const APP_VERSION = '0.1.0';

export const PAGE_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MDL Logistics — enviar un pedido</title>
<style>
  :root {
    --bg:#f6f5f2; --surface:#fff; --ink:#15181d; --muted:#5b6270; --line:#e4e1da;
    --rail:#1a1d22; --rail-ink:#e7e5e0; --rail-muted:#8f96a2; --rail-line:#2a3038;
    --accent:#1f5c4a; --accent-ink:#fff; --ok:#2f8a68; --warn:#c9963c; --bad:#c9614f;
    --sans:-apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    --mono:ui-monospace, "Cascadia Mono", Consolas, monospace;
  }
  * { box-sizing:border-box; }
  [hidden] { display:none !important; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 var(--sans); }
  :focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:4px; }
  .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden;
             clip:rect(0 0 0 0); white-space:nowrap; border:0; }
  .app { display:grid; grid-template-columns:224px 1fr; min-height:100vh; }

  /* compact rail */
  .rail { background:var(--rail); color:var(--rail-ink); padding:16px 14px; display:flex; flex-direction:column; gap:18px; font-size:13px; }
  .rail .brand { font-weight:650; font-size:14px; letter-spacing:-.01em; }
  .rail h2 { font-size:10px; text-transform:uppercase; letter-spacing:.11em; color:var(--rail-muted); margin:0 0 6px; font-weight:600; }
  .state { display:flex; gap:7px; align-items:flex-start; line-height:1.35; }
  .state + .state { margin-top:6px; }
  .b { width:7px; height:7px; border-radius:50%; background:var(--rail-muted); flex:none; margin-top:6px; }
  .b.ok { background:var(--ok); } .b.warn { background:var(--warn); } .b.bad { background:var(--bad); }
  .rail .meta { color:var(--rail-muted); font-size:11.5px; display:block; margin-top:1px; }
  .rail .note { color:var(--rail-muted); font-size:11px; margin:6px 0 0; }
  .rail .rail-line { color:var(--rail-muted); font-size:11.5px; margin:8px 0 0; }
  .rail details { margin-top:8px; }
  .rail summary { color:var(--rail-muted); font-size:11.5px; cursor:pointer; }
  .rail ul.issues { margin:6px 0 0; padding-left:1rem; font-size:11.5px; }
  .runs { list-style:none; margin:0; padding:0; }
  .runs li { padding:6px 0; border-bottom:1px solid var(--rail-line); line-height:1.3; }
  .runs li:last-child { border-bottom:0; }
  .runs .id { font-variant-numeric:tabular-nums; }
  .runs .meta { font-size:11px; }
  .rail button { width:100%; font:600 12px/1 var(--sans); color:var(--rail-ink); background:transparent;
                 border:1px solid var(--rail-line); border-radius:6px; padding:8px; cursor:pointer; margin-top:10px; }
  .rail button:hover { background:#22272e; }
  .rail button:disabled { opacity:.55; cursor:not-allowed; }
  .rail footer { margin-top:auto; font-size:11px; color:var(--rail-muted); display:flex; justify-content:space-between; gap:8px; }

  /* work */
  .work { padding:36px 40px 64px; }
  .col { max-width:720px; margin:0 auto; }
  h1 { font-size:28px; line-height:1.2; letter-spacing:-.02em; margin:0 0 6px; }
  .sub { color:var(--muted); margin:0 0 26px; }

  section { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:22px; }
  section + section { margin-top:18px; }
  .sec-head { display:flex; align-items:baseline; gap:10px; margin-bottom:16px; }
  h2.sec { font-size:11px; text-transform:uppercase; letter-spacing:.1em; color:var(--muted); margin:0; font-weight:600; }
  .badge { font-size:11.5px; color:var(--muted); border:1px solid var(--line); border-radius:99px; padding:2px 8px; }

  .field-label { display:block; font-size:12.5px; color:var(--muted); margin-bottom:5px; }
  textarea, input, select { width:100%; font:14px/1.5 var(--sans); color:var(--ink); background:#fdfcfa;
    border:1px solid var(--line); border-radius:8px; padding:9px 11px; }
  textarea { min-height:132px; font-family:var(--mono); font-size:13px; resize:vertical; }
  .hint { font-size:12.5px; color:var(--muted); margin:7px 0 0; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:14px 18px; }
  .grid .wide { grid-column:1/-1; }
  .group { grid-column:1/-1; font-size:11px; text-transform:uppercase; letter-spacing:.09em; color:var(--muted); font-weight:600; margin:6px 0 -2px; }

  .quote { display:flex; gap:10px; align-items:center; font-size:13.5px; color:var(--ok); margin-top:18px; padding-top:16px; border-top:1px solid var(--line); }
  .actions { display:flex; gap:10px; align-items:center; margin-top:18px; flex-wrap:wrap; }
  button.primary, button.ghost { font:600 14px/1 var(--sans); border-radius:8px; padding:11px 18px; cursor:pointer; border:1px solid transparent; }
  button.primary { background:var(--accent); color:var(--accent-ink); }
  button.ghost { background:transparent; color:var(--ink); border-color:var(--line); }
  button.primary:disabled, button.ghost:disabled { opacity:.5; cursor:not-allowed; }
  .note { font-size:12.5px; color:var(--muted); }

  ul.issues { margin:6px 0 0; padding-left:1.1rem; font-size:13.5px; }
  ul.issues li { margin:2px 0; }
  .bad { color:var(--bad); } .ok { color:var(--ok); } .warn { color:var(--warn); }
  .mono { font-family:var(--mono); font-size:12px; word-break:break-all; }
  .field-note { font-size:11.5px; color:var(--warn); margin:4px 0 0; }
  .field-wrap { display:block; }
  .inline-status { min-height:1.2rem; font-size:13px; color:var(--muted); margin:12px 0 0; }
  .inline-result { margin-top:16px; padding-top:14px; border-top:1px solid var(--line); font-size:13.5px; }
  .inline-result:empty { margin:0; padding:0; border:0; }
  .inline-result p { margin:4px 0; }
  .result-id { font-size:19px; font-weight:650; letter-spacing:-.01em; margin:0 0 6px; }

  @media (max-width:860px){ .app { grid-template-columns:1fr; } .rail { flex-direction:row; flex-wrap:wrap; gap:14px; }
    .rail footer { margin:0; } .work { padding:22px 18px 40px; } .grid { grid-template-columns:1fr; } }
  @media (prefers-reduced-motion:reduce){ * { transition:none !important; animation:none !important; } }
</style>
</head>
<body>
<div class="app">

  <aside class="rail" aria-label="Estado del agente">
    <div class="brand">MDL Logistics</div>

    <section aria-labelledby="rail-session-heading">
      <h2 id="rail-session-heading">Sesión</h2>
      <div class="state" id="rail-session-state">
        <span class="b" aria-hidden="true"></span>
        <span id="rail-session-text">Leyendo el estado…<span class="meta">desde GET /api/console</span></span>
      </div>
      <p class="rail-line" id="rail-health"></p>
      <button type="button" id="session-check-run">Verificar ahora</button>
      <p class="inline-status" id="session-check-status" role="status" aria-live="polite"></p>
      <details>
        <summary>Runtime del proceso</summary>
        <div id="rail-runtime"></div>
      </details>
      <details>
        <summary>De dónde sale cada dato</summary>
        <p class="note">${SESSION_CHECK_OUTPUT_NOTE}</p>
      </details>
    </section>

    <section aria-labelledby="rail-runs-heading">
      <h2 id="rail-runs-heading">Corridas</h2>
      <ul class="runs" id="rail-runs-list">
        <li><span class="meta">leyendo los registros…</span></li>
      </ul>
    </section>

    <section aria-labelledby="rail-errors-heading">
      <h2 id="rail-errors-heading">Errores</h2>
      <div class="state" id="rail-errors-state">
        <span class="b" aria-hidden="true"></span>
        <span id="rail-errors-text">Leyendo los informes…</span>
      </div>
      <div id="rail-errors-detail"></div>
      <div id="rail-warnings"></div>
      <details>
        <summary>El informe completo, en disco</summary>
        <p class="note">${REPORT_ON_DISK_NOTE}</p>
      </details>
    </section>

    <section aria-labelledby="rail-artifacts-heading">
      <h2 id="rail-artifacts-heading">Artefactos</h2>
      <ul class="runs" id="rail-artifacts-list">
        <li><span class="meta">leyendo el volumen…</span></li>
      </ul>
      <details>
        <summary>Cómo se retiran</summary>
        <p class="note">${ARTIFACT_RETRIEVAL_INSTRUCTION}</p>
      </details>
    </section>

    <footer><span id="rail-open">leyendo intentos…</span><span>v${APP_VERSION}</span></footer>
  </aside>

  <main class="work">
    <div class="col">
      <h1>Enviar un pedido</h1>
      <p class="sub">Pegá el mensaje, revisá los datos, creá el envío. La etiqueta queda impaga.</p>

      <section aria-labelledby="sec-mensaje">
        <div class="sec-head"><h2 class="sec" id="sec-mensaje">Mensaje</h2><span class="badge" id="message-badge">sin datos</span></div>
        <label class="field-wrap" for="message">
          <span class="field-label">Mensaje estructurado</span>
          <textarea id="message" spellcheck="false" autocomplete="off" placeholder="MDL - Datos de envío&#10;&#10;Destino&#10;Código postal: 1424&#10;Provincia: ..."></textarea>
        </label>
        <p class="hint">Los asteriscos se descartan solos. Si falta un dato, se rechaza y te dice cuál.</p>
        <p class="inline-status" id="analyze-status" role="status" aria-live="polite"></p>
        <div class="actions">
          <button class="primary" type="button" id="analyze">Analizar</button>
        </div>
      </section>

      <section aria-labelledby="sec-datos">
        <div class="sec-head"><h2 class="sec" id="sec-datos">Datos del envío</h2><span class="badge" id="data-badge">sin analizar</span></div>
        <p class="hint" id="data-empty">Pegá el mensaje y tocá Analizar: acá aparecen los datos que se van a escribir en el panel, todos editables.</p>
        <div id="rejection"></div>
        <div id="warnings"></div>
        <div class="grid" id="shipment-form"></div>

        <div class="quote">
          <span class="b ok" aria-hidden="true"></span>
          <span id="quote-text">${CARRIER_NAME} · el costo y el plazo se leen del panel en el resumen</span>
        </div>

        <div class="actions">
          <button class="primary" type="button" id="create" disabled>Crear envío</button>
          <button class="ghost" type="button" id="dry-run" disabled>Probar en seco</button>
          <span class="note">Crear no cobra. La etiqueta se paga aparte.</span>
        </div>

        <p class="inline-status" id="run-status" role="status" aria-live="polite"></p>
        <div class="inline-result" id="result" aria-live="polite"></div>
      </section>
    </div>
  </main>
</div>

<script src="/app.js"></script>
</body>
</html>
`;
