/**
 * The login page: the whole of the app's front door, and the reason the browser's
 * native Basic Auth dialog is gone.
 *
 * It is a small centred card on the same artboard tokens as the operator's desk —
 * same palette, same type scale, same `:focus-visible` ring, same
 * `prefers-reduced-motion` rule — with one password field, one submit button and
 * one inline error line. There is no browser dialog anywhere: a wrong password is
 * a sentence under the field, and the field keeps the focus.
 *
 * Deliberate boundaries, matching the main page's:
 *
 * - **No data in the markup.** The card is static text; the error text is written
 *   by the script with `textContent`, so nothing a server says can become markup.
 * - **No `alert(`, `confirm(` or `prompt(`.** A test asserts this, the same way it
 *   does for the main page and its script.
 * - **No asset requests beyond itself.** Styles and the few lines of script are
 *   inline, so the only thing a not-yet-authenticated browser asks for is
 *   `GET /login` (and the one `POST /api/login` it submits).
 * - **The password never leaves the field except in the request body.** It is not
 *   stored, echoed, put in the URL or written to a log.
 */

/**
 * The sentence the card shows when the server's answer cannot be read at all. Kept
 * here so the script and the tests quote one string instead of two copies.
 */
export const LOGIN_ERROR_FALLBACK = 'No se pudo iniciar sesión: volvé a intentar.';
export const LOGIN_EMPTY_PASSWORD = 'Escribí la contraseña.';
export const LOGIN_NETWORK_ERROR = 'No se pudo contactar el servidor: revisá que siga corriendo y volvé a intentar.';

export const LOGIN_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>MDL Logistics — entrar</title>
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
  html, body { height:100%; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 var(--sans);
         display:grid; place-items:center; padding:24px; }
  :focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:4px; }

  .card { width:100%; max-width:360px; background:var(--surface); border:1px solid var(--line);
          border-radius:10px; padding:26px 24px 22px; }
  .brand { margin:0 0 18px; font-size:13px; font-weight:650; letter-spacing:-.01em; }
  .brand span { display:block; margin-top:2px; font-size:10px; font-weight:600; letter-spacing:.11em;
                text-transform:uppercase; color:var(--muted); }
  h1 { margin:0 0 6px; font-size:22px; line-height:1.2; letter-spacing:-.02em; }
  .sub { margin:0 0 20px; font-size:13px; color:var(--muted); }

  .field-label { display:block; font-size:12.5px; color:var(--muted); margin-bottom:5px; }
  input { width:100%; font:14px/1.5 var(--sans); color:var(--ink); background:#fdfcfa;
          border:1px solid var(--line); border-radius:8px; padding:9px 11px; }
  button.primary { width:100%; margin-top:14px; font:600 14px/1 var(--sans); color:var(--accent-ink);
                   background:var(--accent); border:1px solid transparent; border-radius:8px;
                   padding:11px 18px; cursor:pointer; }
  button.primary:disabled { opacity:.5; cursor:not-allowed; }

  .error { min-height:1.3rem; margin:12px 0 0; font-size:13px; color:var(--bad); }
  .error:empty { margin:0; min-height:0; }
  .note { margin:18px 0 0; padding-top:14px; border-top:1px solid var(--line);
          font-size:11.5px; color:var(--muted); }

  @media (prefers-reduced-motion:reduce){ * { transition:none !important; animation:none !important; } }
</style>
</head>
<body>
<main class="card">
  <form id="login-form" method="post" action="/api/login" novalidate>
    <p class="brand">MDL Logistics<span>consola de mantenimiento</span></p>
    <h1>Entrar</h1>
    <p class="sub">Esta consola puede crear envíos. Escribí la contraseña del operador para continuar.</p>

    <label class="field-label" for="password">Contraseña</label>
    <input id="password" name="password" type="password" autocomplete="current-password"
           aria-describedby="login-error" spellcheck="false" autocapitalize="off" required autofocus>

    <button class="primary" type="submit" id="login-submit">Entrar</button>
    <p class="error" id="login-error" role="alert" aria-live="polite"></p>
  </form>
  <p class="note">Una sola contraseña, una sola sesión. La cookie de sesión vence a los 30 días y se borra al cerrar sesión.</p>
</main>
<script>
(function () {
  'use strict';

  var form = document.getElementById('login-form');
  var input = document.getElementById('password');
  var error = document.getElementById('login-error');
  var submit = document.getElementById('login-submit');

  function showError(message) {
    error.textContent = message;
  }

  function setBusy(busy) {
    submit.disabled = busy;
    submit.textContent = busy ? 'Entrando…' : 'Entrar';
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (input.value === '') {
      showError(${JSON.stringify(LOGIN_EMPTY_PASSWORD)});
      input.focus();
      return;
    }

    showError('');
    setBusy(true);

    fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: input.value })
    }).then(function (response) {
      if (response.ok) {
        document.location.assign('/');
        return;
      }
      return response.json().then(function (data) {
        showError(data && typeof data.reason === 'string' && data.reason !== ''
          ? data.reason
          : ${JSON.stringify(LOGIN_ERROR_FALLBACK)});
      }, function () {
        showError(${JSON.stringify(LOGIN_ERROR_FALLBACK)});
      });
    }).catch(function () {
      showError(${JSON.stringify(LOGIN_NETWORK_ERROR)});
    }).then(function () {
      setBusy(false);
    });
  });
})();
</script>
</body>
</html>
`;
