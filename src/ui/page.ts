/**
 * The one page: an operator's desk, not a console with tabs.
 *
 * The layout follows the approved artboard (`design/consola-operador/04-mesa-con-rail.html`)
 * exactly: a 224 px dark rail on the left holding the agent's state, and a
 * single centred work column on the right holding the whole shipment flow.
 *
 * - **The rail** is fed only by `GET /api/console`: the session as the last
 *   recorded check saw it (plus the panel cookie's expiry), the newest run
 *   records, the newest failing report and the count of open attempts. Every one
 *   of those is closed-vocabulary data — a level, a timestamp, a count, an
 *   identifier, a number of days. No report text, no check output, no recipient
 *   data, no cookie value. The rail's dots always carry a word next to them, so no
 *   state is conveyed by colour alone.
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
 * The rail says only what an operator reads at a glance: the session's word and
 * when it was last verified (plus the panel cookie's expiry), the last five runs,
 * the error word and, when there is one, the failing check with its time. It
 * explains nothing: process facts, artifact listings and the on-disk notes live in
 * the request docs, not here.
 */

import { CARRIER_NAME } from '../core/carrier';

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
<meta name="color-scheme" content="light dark">
<title>MDL Logistics — enviar un pedido</title>
<script>
/* The saved theme is applied before the first paint, so a page opened in dark
   never flashes light. The key is the same one the script below writes. */
(function () {
  'use strict';
  try {
    var saved = localStorage.getItem('mdl-theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
  } catch (ignored) {}
})();
</script>
<style>
  :root {
    color-scheme: light;
    --bg:#f6f5f2; --surface:#fff; --ink:#15181d; --muted:#5b6270; --line:#e4e1da; --field:#fdfcfa;
    --rail:#1a1d22; --rail-ink:#e7e5e0; --rail-muted:#8f96a2; --rail-line:#2a3038;
    --rail-edge:#6b7484; --rail-hover:#22272e; --rail-focus:#66c2a4;
    --rail-ok:#5fbf9a; --rail-warn:#e0b862; --rail-bad:#f0907d;
    --accent:#1f5c4a; --accent-ink:#fff; --accent-off:#e9e7e2;
    --ok:#2f8a68; --warn:#c9963c; --bad:#c9614f;
    --ok-text:#1f6b4f; --warn-text:#7a5a12; --bad-text:#a23325;
    --focus:#1f5c4a;
    --sans:-apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    --mono:ui-monospace, "Cascadia Mono", Consolas, monospace;
  }
  /* Dark, chosen by hand: the rail's palette carried over the work column. */
  html[data-theme="dark"] {
    color-scheme: dark;
    --bg:#0e1116; --surface:#151a21; --ink:#dfe3e9; --muted:#8b93a1; --line:#252c36; --field:#11161c;
    --accent-off:#1f252d; --focus:#5fbfa0;
    --ok-text:#5fbf9a; --warn-text:#e0b862; --bad-text:#f0907d;
  }
  /* Dark because the system says so. The same values as the block above; it is
     skipped when the operator stored a choice, and never when the choice is dark. */
  @media (prefers-color-scheme: dark) {
    html:not([data-theme="light"]) {
      color-scheme: dark;
      --bg:#0e1116; --surface:#151a21; --ink:#dfe3e9; --muted:#8b93a1; --line:#252c36; --field:#11161c;
      --accent-off:#1f252d; --focus:#5fbfa0;
      --ok-text:#5fbf9a; --warn-text:#e0b862; --bad-text:#f0907d;
    }
  }
  * { box-sizing:border-box; }
  [hidden] { display:none !important; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 var(--sans); }
  :focus-visible { outline:2px solid var(--focus); outline-offset:2px; border-radius:4px; }
  .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden;
             clip:rect(0 0 0 0); white-space:nowrap; border:0; }
  .app { display:grid; grid-template-columns:224px 1fr; min-height:100vh; }

  /* The rail is furniture of the viewport, not of the page: it sticks beside
     the scrolling work column at exactly one screen tall, so a long work
     column can never stretch it into a giant half-empty sidebar. Only Corridas
     scrolls, and only inside itself, so Sesión, Errores and the footer stay
     visible without ever scrolling the rail. On narrow screens the media query
     below resets the stickiness: there the rail stacks on top and flows with
     the page, exactly as before. */
  .rail { position:sticky; top:0; height:100vh; overflow:hidden;
          background:var(--rail); color:var(--rail-ink); padding:16px 14px; display:flex; flex-direction:column; gap:18px; font-size:13px; }
  /* The brand and the theme toggle share one discreet line. */
  .rail-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
  .rail .brand { font-weight:650; font-size:14px; letter-spacing:-.01em; }
  .rail h2 { font-size:10px; text-transform:uppercase; letter-spacing:.11em; color:var(--rail-muted); margin:0 0 6px; font-weight:600; }
  .state { display:flex; gap:7px; align-items:flex-start; line-height:1.35; }
  .state + .state { margin-top:6px; }
  .b { width:7px; height:7px; border-radius:50%; background:var(--rail-muted); flex:none; margin-top:6px; }
  .b.ok { background:var(--ok); } .b.warn { background:var(--warn); } .b.bad { background:var(--bad); }
  .rail .meta { color:var(--rail-muted); font-size:11.5px; display:block; margin-top:1px; }
  .rail .rail-line { color:var(--rail-muted); font-size:11.5px; margin:8px 0 0; }
  .rail .inline-status { color:var(--rail-muted); font-size:11.5px; }
  .rail footer { margin-top:auto; font-size:11px; color:var(--rail-muted); display:flex; justify-content:space-between; gap:8px; }
  /* Small and quiet: one line in the corner, not a control that competes. */
  .rail button.rail-toggle { width:auto; align-self:center; margin-top:0; padding:2px 6px; font-size:10.5px;
                             border-color:transparent; color:var(--rail-muted); font-weight:500; }
  .rail button.rail-toggle:hover { color:var(--rail-ink); }
  /* Corridas is the one block that can grow (the last five runs, one line
     each), so it gets the rail's only internal scroll: it caps at 240 px and
     rolls inside itself instead of pushing the footer off the viewport. The
     scrollbar is thin and quiet, painted from the rail's own palette in both
     themes (the rail surface never changes with the theme), and the list text
     keeps ≥4.5:1 on it: --rail-ink 13.4:1, --rail-muted 5.7:1 on --rail. */
  .runs { list-style:none; margin:0; padding:0; max-height:240px; overflow-y:auto;
          scrollbar-width:thin; scrollbar-color:var(--rail-line) transparent; }
  .runs::-webkit-scrollbar { width:8px; }
  .runs::-webkit-scrollbar-track { background:transparent; }
  .runs::-webkit-scrollbar-thumb { background:var(--rail-line); border-radius:99px; }
  .runs::-webkit-scrollbar-thumb:hover { background:var(--rail-edge); }
  .runs li { padding:6px 0; border-bottom:1px solid var(--rail-line); line-height:1.3; font-variant-numeric:tabular-nums; }
  .runs li:last-child { border-bottom:0; }
  .runs .meta { font-size:11px; display:inline; }

  /* The rail's blocks sit on the dark surface: they are not cards, so they get
     no fill, no border, no radius and no shadow. The section rule below belongs
     to the work column only. */
  .rail section { background:none; border:0; border-radius:0; box-shadow:none; padding:0; margin:0; }

  .rail button { width:100%; font:600 12px/1 var(--sans); color:var(--rail-ink); background:transparent;
                 border:1px solid var(--rail-edge); border-radius:6px; padding:8px; cursor:pointer; margin-top:10px; }
  .rail button:hover { background:var(--rail-hover); border-color:var(--rail-ink); }
  .rail button:disabled { color:var(--rail-muted); border-color:var(--rail-line); cursor:not-allowed; }
  .rail button:disabled:hover { background:transparent; border-color:var(--rail-line); }
  .rail :focus-visible { outline-color:var(--rail-focus); }

  /* work */
  .work { padding:36px 40px 64px; }
  .col { max-width:720px; margin:0 auto; }
  h1 { font-size:28px; line-height:1.2; letter-spacing:-.02em; margin:0 0 6px; }
  .sub { color:var(--muted); margin:0 0 26px; }

  .work section { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:22px; }
  .work section + section { margin-top:18px; }
  .sec-head { display:flex; align-items:baseline; gap:10px; margin-bottom:16px; }
  h2.sec { font-size:11px; text-transform:uppercase; letter-spacing:.1em; color:var(--muted); margin:0; font-weight:600; }
  .badge { font-size:11.5px; color:var(--muted); border:1px solid var(--line); border-radius:99px; padding:2px 8px; }

  .field-label { display:block; font-size:12.5px; color:var(--muted); margin-bottom:5px; }
  textarea, input, select { width:100%; font:14px/1.5 var(--sans); color:var(--ink); background:var(--field);
    border:1px solid var(--line); border-radius:8px; padding:9px 11px; }
  ::placeholder { color:var(--muted); opacity:1; }
  textarea { min-height:132px; font-family:var(--mono); font-size:13px; resize:vertical; }
  .hint { font-size:12.5px; color:var(--muted); margin:7px 0 0; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:14px 18px; }
  .grid .wide { grid-column:1/-1; }
  .group { grid-column:1/-1; font-size:11px; text-transform:uppercase; letter-spacing:.09em; color:var(--muted); font-weight:600; margin:6px 0 -2px; }

  /* The Modalidad segmented control: one decision, two equal options. */
  .segmented { display:flex; gap:10px; flex-wrap:wrap; }
  .segmented label { display:inline-flex; align-items:center; gap:8px; border:1px solid var(--line);
    background:var(--field); border-radius:8px; padding:8px 14px; cursor:pointer; font-size:13.5px; }
  .segmented input { width:auto; margin:0; accent-color:var(--accent); cursor:pointer; }
  .segmented label:hover { border-color:var(--ink); }

  .quote { display:flex; gap:10px; align-items:center; font-size:13.5px; color:var(--ok-text); margin-top:18px; padding-top:16px; border-top:1px solid var(--line); }
  .actions { display:flex; gap:10px; align-items:center; margin-top:18px; flex-wrap:wrap; }
  button.primary, button.ghost { font:600 14px/1 var(--sans); border-radius:8px; padding:11px 18px; cursor:pointer; border:1px solid transparent; }
  button.primary { background:var(--accent); color:var(--accent-ink); }
  button.ghost { background:transparent; color:var(--ink); border-color:var(--line); }
  /* A disabled control is dimmer, never unreadable: the label keeps its 4.5:1
     instead of being faded with an opacity on the whole button. */
  button.primary:disabled { background:var(--accent-off); color:var(--muted); border-color:var(--accent-off); cursor:not-allowed; }
  button.ghost:disabled { background:transparent; color:var(--muted); border-color:var(--line); cursor:not-allowed; }
  .note { font-size:12.5px; color:var(--muted); }

  ul.issues { margin:6px 0 0; padding-left:1.1rem; font-size:13.5px; }
  ul.issues li { margin:2px 0; overflow-wrap:anywhere; }
  /* The analyze rejection and its warnings are prose fed by the parser: same
     containment rule, so no reason line can leave the frame either. */
  #rejection, #warnings { min-width:0; overflow-wrap:anywhere; }
  /* Text colours are the ones that clear 4.5:1 on their own surface; the dot
     palette above stays for the dots, which always carry a word next to them. */
  .bad { color:var(--bad-text); } .ok { color:var(--ok-text); } .warn { color:var(--warn-text); }
  .rail .bad { color:var(--rail-bad); } .rail .ok { color:var(--rail-ok); } .rail .warn { color:var(--rail-warn); }
  .mono { font-family:var(--mono); font-size:12px; word-break:break-all; }
  .field-note { font-size:11.5px; color:var(--warn-text); margin:4px 0 0; }
  .field-wrap { display:block; }
  .inline-status { min-height:1.2rem; font-size:13px; color:var(--muted); margin:12px 0 0; }
  .inline-result { margin-top:16px; padding-top:14px; border-top:1px solid var(--line); font-size:13.5px;
                   min-width:0; overflow-wrap:anywhere; }
  .inline-result:empty { margin:0; padding:0; border:0; }
  .inline-result p { margin:4px 0; }
  .result-id { font-size:19px; font-weight:650; letter-spacing:-.01em; margin:0 0 6px; }

  /* Every run outcome — success, estimate or error — is one contained card.
     overflow-wrap:anywhere keeps run-record paths and long technical lines
     inside the column (the operator's complaint: "todo salido del encuadre"),
     and the details body scrolls internally so even a big raw reason can never
     push the layout wider than the page. */
  .result-card { border:1px solid var(--line); border-radius:8px; padding:14px 16px; margin-top:6px;
                 min-width:0; overflow-wrap:anywhere; }
  .result-card.is-bad { border-color:var(--bad); }
  .error-heading { font-size:15px; font-weight:650; margin:0 0 6px; }
  .error-action { margin:0; }
  .error-details { margin-top:10px; }
  .error-details summary { cursor:pointer; font-size:12.5px; color:var(--muted); }
  .error-detail-body { margin-top:8px; padding:10px; border:1px solid var(--line); border-radius:6px;
                       background:var(--field); max-height:220px; overflow-y:auto; overflow-wrap:anywhere; }
  .error-detail-body p { margin:3px 0; }
  .progress-title { font-weight:650; margin:0 0 2px; }
  .progress-note { font-size:12px; color:var(--muted); margin:0 0 8px; }
  .progress-steps { list-style:none; margin:0; padding:0; font-size:13.5px; }
  .progress-steps li { padding:3px 0; }
  .progress-steps li.done { color:var(--ok-text); }
  .progress-steps li.current { font-weight:600; }
  .progress-steps li.pending { color:var(--muted); }
  .progress-percent { font-variant-numeric:tabular-nums; margin:10px 0 0; }

  /* Narrow screens: the rail stacks on top of the work column and flows with
     the page again — sticky, viewport height and overflow clipping are wide
     -screen behaviour only. */
  @media (max-width:860px){ .app { grid-template-columns:1fr; }
    .rail { position:static; top:auto; height:auto; overflow:visible; flex-direction:row; flex-wrap:wrap; gap:14px; }
    .rail footer { margin:0; } .work { padding:22px 18px 40px; } .grid { grid-template-columns:1fr; } }
  @media (prefers-reduced-motion:reduce){ * { transition:none !important; animation:none !important; } }
</style>
</head>
<body>
<div class="app">

  <aside class="rail" aria-label="Estado del agente">
    <div class="rail-head">
      <span class="brand">MDL Logistics</span>
      <button type="button" id="theme-toggle" class="rail-toggle" aria-pressed="false">Tema: sistema</button>
    </div>

    <section aria-labelledby="rail-session-heading">
      <h2 id="rail-session-heading">Sesión</h2>
      <div class="state" id="rail-session-state">
        <span class="b" aria-hidden="true"></span>
        <span id="rail-session-text">Leyendo el estado…</span>
      </div>
      <p class="rail-line" id="rail-expiry"></p>
      <button type="button" id="session-check-run">Verificar ahora</button>
      <p class="inline-status" id="session-check-status" role="status" aria-live="polite"></p>
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
    </section>

    <footer><span id="rail-open">leyendo intentos…</span><span>v${APP_VERSION}</span></footer>
    <button type="button" id="logout">Cerrar sesión</button>
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
