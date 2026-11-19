# Technical plan — MVP 01: manual shipment from a pasted WhatsApp message

Status: **blocked on two inputs** (see §7). No source code written yet.

## 1. Objective (verbatim)

> Pegar en la aplicación un mensaje estructurado recibido por WhatsApp y automatizar la
> creación de un envío manual en Envío Nube, dejando su etiqueta pendiente de pago.

## 2. What this MVP is

An operator pastes one structured WhatsApp message. The application validates it, drives the
Envío Nube panel, creates a manual shipment, and **stops with the label pending payment**.

Two pieces of work, and only two:

1. A deterministic parser: structured text → validated shipment request.
2. A browser executor: validated request → shipment created in the panel.

## 3. What this MVP is not

| Excluded | Why |
| --- | --- |
| Tiendanube API, OAuth, webhooks | The input is a pasted message. No store integration is required. |
| AI / LLM extraction | The message is *structured*. A fixed format is parsed by code, which is testable and free. R8 is satisfied by not needing an LLM at all. |
| Paying for the label | Out of scope by design: the flow ends at "pending payment". See R10. |
| Dashboard, order list, filters | Explicitly out of scope. One input, one shipment, one result. |
| Free-text WhatsApp messages | If the message does not match the format, the MVP refuses it. Handling free text is a later stage. |
| Multiple carriers, carrier routing | Everything goes through Envío Nube, manual shipment. |

## 4. Flow

| Stage | This MVP | Module seam (R16) |
| --- | --- | --- |
| Intake | Paste one message (CLI argument, stdin, or file) | `intake` — replaceable by a WhatsApp connector later |
| Resolution | Parse + validate against R12: complete or blocked, never invented | `parser` — the only place that knows the message format |
| Execution | Playwright drives the Envío Nube panel up to "label pending payment" | `executor` — replaceable if an API ever exists (R13) |
| Record | Durable local ledger: message, parsed payload, approved payload, result, screenshot/trace path | `record` — the invariant |

## 4b. Ordered steps to implement (operator-defined)

Captured from the operator. These are the executable steps of the MVP, in order.

| ID | Step | Implementation note |
| --- | --- | --- |
| S1 | Receive the full message text | single input, one message per run |
| S2 | Extract and normalize fields in TypeScript | deterministic parser; no LLM. Normalization is explicit and named (province aliases, CP formats, phone formats); anything unmatched is rejected with the exact reason |
| S3 | Detect missing or inconsistent fields and show an editable preview | the preview is the approval artifact (R10) and enforces R12 |
| S4 | Allow manual approval of the data before continuing | approval stores the hash of the exact payload shown |
| S5 | Playwright → Tiendanube → Envío Nube → **Agregar envío manual** | entry anchor; the whole run happens inside the store admin session |
| S6 | Default modality = domicilio; branch delivery uses its own flow | a decision field in the payload, never inferred from prose; scope of sucursal still to be decided |
| S7 | Enter postal code and the default dimensions and weight, configurable in the project | declared policy, not invented data; effective values must be visible in the preview |
| S8 | Continue and select the corresponding **Andreani** modality | Andreani is the only carrier in this MVP; carrier selection lives in configuration (R16) |
| S9 | Fill personal and address data; resolve province and other dropdowns correctly | exact match against the panel's own options; no silent fuzzy matching; native select vs custom combo changes the implementation |
| S10 | Before creating, verify the form matches what was approved, and ask for human confirmation | requires `fill` + `read` per field; the human confirms what is actually written in the panel, not the intended payload |
| S11 | Create the shipment and verify it was really registered | unknown outcome must be reconciled against the shipment list before any retry; never a blind retry |
| S12 | **Stop before any purchase or payment of labels** | terminal state of the MVP: shipment created, label unpaid. Structural, not configurable |


## 4c. Observed panel structure (verified by DOM inspection)

Captured with `scripts/observe.mjs` against the real admin. Not inferred, not copied from docs.

### Navigation and framing

| Fact | Value |
| --- | --- |
| Store admin | `<store>.mitiendanube.com`, supplied by `MDL_STORE_ORIGIN`; never committed |
| Envío Nube app | `/admin/apps/envionube/ar`, hash-routed (`#/dashboard`, `#/create-single-shipment`) |
| Actual UI location | **cross-origin iframe**: `services-ne-app-front-ar.nuvemshop.com.br/create-single-shipment` |

Consequences:

- Every selector must be **scoped to the Envío Nube frame**. The top document contains only the admin shell.
- The frame must be located **by URL prefix**, never by index: the page also hosts `cirrus.tiendanube.com` (validator), `google.com/recaptcha`, `challenges.cloudflare.com` (Turnstile) and two `about:blank` frames.
- This is why Playwright Codegen recorded no actions: it attached to the top document.

### Authentication and bot protection

- Login passes through `/auth/recovery-code`, so **2FA is enabled**: login is human, always (R15).
- Cloudflare **Turnstile** (invisible) and Google reCAPTCHA frames are present. This is a
  bot-detection surface, not just a form. It can challenge a run at any time and cannot be
  solved by the automation; the executor must treat a challenge as a loud stop.

### Screen 1 — “Envío manual a domicilio” → “Calcular costo de envío”

All six controls are plain inputs identified **only by `name`**: no `id`, no `aria-label`, no
`for=` association. Labels are siblings, so the reliable anchor is `[name=...]` inside the frame.

| Field | Anchor | Notes |
| --- | --- | --- |
| Postal code | `[name="zipCode"]` | placeholder: “Ingresá el código postal de destino” |
| Height | `[name="box.height"]` | unit shown as a `cm` button |
| Width | `[name="box.width"]` | unit `cm` |
| Depth | `[name="box.depth"]` | unit `cm` |
| Weight | `[name="box.weight"]` | **unit shown as `g`: grams**, not kilograms |
| Declared value | `[name="declaredValue"]` | label says “Monto total abonado (opcional)”; unit `$` |

Buttons: `Cancelar` (type `reset`) and `Continuar` (type `submit`, **disabled until the form is
valid**). Waiting for `Continuar` to become enabled is a real precondition check, better than
clicking and hoping.

### Screen 2 — `#/create-single-shipment/quotation` → “Seleccionar medio de envío”

The route changes in both places: admin hash `#/create-single-shipment/quotation` and iframe URL
`.../create-single-shipment/quotation`.

Options are native radios sharing `name="deliveryOptionId"`, each wrapped in its own `<label>`. The
inputs are **not visible** (`visible=false`): the click target is the wrapping label, and the radio
lives under a `Modalidades activas` or `Modalidades inactivas` heading. Group detection must read the
nearest preceding heading, not the container text.

| Accessible name | Use in this MVP |
| --- | --- |
| `Andreani a domicilio` | **the one to select (S8)** |
| `Entrega a domicilio` | meaning unknown — must be clarified with the operator, never inferred |
| `Correo Argentino Clásico a domicilio` | out of scope |
| `Correo Argentino Expreso a domicilio` | out of scope |

- Radio `id`s embed UUIDs (`delivery-<uuid>-<suffix>`) and are **unstable**: never use them as
  selectors. Anchor by role + accessible name (`getByRole('radio', { name })`), which resolves
  through the associated label.
- `Continuar` becomes enabled once an option is chosen; `Cancelar` is a reset.
- If `Andreani a domicilio` is not offered for a postal code, the run **stops** and reports it.
  Choosing another carrier is a different product decision and a wrong purchase (R12).

### Screen 3 — `#/create-single-shipment/customer` → “Completar datos del destinatario”

| Label in panel | Anchor | Optional? |
| --- | --- | --- |
| Provincia | `select[name="address.province"]` (has `id="province"`) | required |
| Ciudad | `[name="address.city"]` — free text | required |
| Calle | `[name="address.address"]` | required |
| Número | `[name="address.number"]` | required, separate field |
| Departamento | `[name="address.complement"]` | **opcional** |
| Barrio | `[name="address.neighborhood"]` | **no marker — assume required** |
| Nombre | `[name="customer.name"]` | required |
| Apellido | `[name="customer.lastName"]` | **opcional** |
| Email | `[name="customer.email"]` | **opcional** |
| Teléfono | `[name="customer.phoneNumber"]` | **opcional** |

`Continuar` (submit) is disabled until the required fields validate. `Cancelar` is a reset.

### Provincia: the real option list

Native `<select>`, **26 entries: one placeholder plus 25 real choices**, and **`value` is a letter
code, not the province name**:

| Code | Name | Code | Name |
| --- | --- | --- | --- |
| B | Buenos Aires | N | Misiones |
| K | Catamarca | Q | Neuquén |
| H | Chaco | R | Río Negro |
| U | Chubut | A | Salta |
| C | Ciudad Autónoma de Buenos Aires | J | San Juan |
| **BX** | **Gran Buenos Aires** | D | San Luis |
| X | Córdoba | Z | Santa Cruz |
| W | Corrientes | S | Santa Fe |
| E | Entre Ríos | G | Santiago del Estero |
| P | Formosa | V | Tierra del Fuego |
| Y | Jujuy | T | Tucumán |
| L | La Pampa | F | La Rioja |
| M | Mendoza | | |

Consequences for the parser (R12):

- The select has **25 real choices** — the 24 jurisdictions plus **Gran Buenos Aires (BX)**, a
  distinct choice from Buenos Aires (B). The 26th entry is the empty placeholder
  “Seleccioná una provincia de destino”. “Bs As” is therefore ambiguous and must be **rejected**,
  not mapped. This is exactly the wrong-province failure the alias map exists to prevent.
- Mapping goes alias → code (`CABA`, `C.A.B.A.`, `Capital Federal` → `C`); the write is by `value`,
  then re-read to confirm the selected option text matches the approved text.

### Gaps between the WhatsApp message and the real form

1. **Código postal is missing and is blocking.** Screen 1 (“Calcular costo de envío”) requires it
   before anything else, and the real message does not carry it. This is the one gap that stops the
   MVP: either the message gains the field, or the operator supplies it in the preview — but the
   flow cannot begin without it.
2. **Nombre completo is one field in the message, two in the panel**, and `Apellido` is optional
   there. The parser must split it; because splitting a full name is a derivation, the result goes
   to the editable preview for confirmation (R12).
3. **Documento is out.** The message does not carry it and the form has no field for it.
4. **City may hold a barrio.** In the sample, `Ciudad` and `Barrio` are both “devoto”. The automation
   must reproduce the operator's data, not correct it, but the duplication deserves a question.

### Screen 4 — summary (`Paso 4 de 4`), the S10/S11 boundary

Route: **`#/create-single-shipment/review`** (observed by the verified dry run).

Heading `Resumen del envío`. Three cards, each with an `Editar` link, and two buttons:

| Element | Content observed |
| --- | --- |
| Button | `Cancelar` |
| Button | **`Crear envío`** — creates the shipment; allowed only under explicit approval (S10) |
| Card `Datos para envío` | `Origen:` the store's configured address; `Destino:` street, number, complement, barrio, city, province, postal code; `Paquete:` dimensions and weight as the panel normalized them |
| Card `Modalidad de envío` | service name, price, delivery estimate |
| Card `Datos del destinatario` | the recipient name |

Two facts that matter:

- **The origin is not part of the message.** It comes from the store's Envío Nube configuration, so the parser never provides it.
- The summary confirms that `Continuar` on screen 3 does **not** create anything: creation is the explicit
  `Crear envío` button on this screen.

### Screen 5 — shipment detail, the real end of the flow

Route: **`#/shipping-details/<id>`**, and the app frame becomes
`services-ne-app-front-ar.nuvemshop.com.br/shipping-details/<id>`. The panel also prints
`Envío creado con éxito`.

Reached after `Crear envío`. Observed structure:

| Element | Content |
| --- | --- |
| Heading | `#EM1053` — the created shipment's identifier, pattern `#EM<number>` |
| Badges | `Por enviar`, `Envío manual` |
| Card `Comprar etiqueta` | text “El código de seguimiento se generará automáticamente al imprimir la etiqueta” and a **`Comprar`** button |
| Card `Datos del envío` | Modalidad, Plazo, Costo, Peso y dimensiones |
| Card `Más información` | Datos del destinatario, Datos del cliente |

Three facts that settle earlier open questions:

- **Creating does not charge.** The cost is displayed and paying is a separate action. So the
  irreversible step is `Comprar`, not `Crear envío`.
- **The created shipment is identified by `#EM<number>`**, which is what the ledger records and what
  a duplicate check can reconcile against.
- **The flow ends here.** The automation stops with the label unpaid, `Comprar` visible and never
  clicked. That is S12, and it is structural: no purchase code path exists.
- The detail page prints its own copy, verbatim:
  `Comprar etiqueta` / `El código de seguimiento se generará automáticamente al imprimir la etiqueta` /
  `Comprar`. Any assertion over this text must be accent- and case-insensitive: the first real
  creation aborted on `código` vs `El código` **after** the shipment already existed, which produced a
  false negative. Prove the unpaid label with the `Comprar` button's presence and the `Por enviar`
  badge, not with prose matching.

### Screen order — verified, not assumed

`#/create-single-shipment` (cost) → `.../quotation` (carrier) → `.../customer` (recipient) →
pending capture (confirmation, where the create button lives).

### Sucursal — Screen Entry — verified: direct URL navigation

**Resolved (2026-11-19):** navigating directly to the app frame URL
`https://services-ne-app-front-ar.nuvemshop.com.br/agency-shipment` (admin hash
`#/agency-shipment`) loads Screen P directly — the `Agregar envío manual` dropdown is **not**
needed. Verified by the operator loading the admin URL in the browser. The executor enters the
sucursal journey by navigating to that route and asserting the `Envío manual a sucursal` heading.

The dropdown capture attempts failed twice (the menu unmounts before the dump), and the direct
navigation makes them moot.

### Sucursal — Screen P — `#/agency-shipment` → recipient + package

First sucursal screen. No address section at all — the destination is only a postal code, entered
on the next screen.

| Label in panel | Anchor | Notes |
| --- | --- | --- |
| Nombre | `input[name="customer.name"]` | same anchor as domicilio |
| Apellido | `input[name="customer.surname"]` | **different** from domicilio's `customer.lastName` |
| Email (opcional) | `input[name="customer.email"]` | same |
| Teléfono (opcional) | `input[name="customer.phoneNumber"]` | same |
| Alto/Ancho/Profundidad | `box.height` / `box.width` / `box.depth` | same as domicilio |
| Peso | `box.weight` | unit buttons `cm` ×3 + `g`, same as domicilio |
| **Valor declarado** | `input[name="declaredValue"]` | unit `$`; **required here** (domicilio: optional) |

Buttons: `Cancelar` (reset) and `Continuar` (`role="submit-form"`, type `submit`).

Note the trap: `customer.surname` vs `customer.lastName`, and `declaredValue` required vs optional —
a domicilio-shaped executor would silently skip the declared value and never be able to advance.

### Sucursal — Screen Q — `#/agency-shipment/quotation` → destination + carrier + branch + create

Unlike domicilio, the sucursal flow's quotation screen combines everything: CP, carrier, branch,
and the create button — no separate summary screen.

| Element | Anchor |
| --- | --- |
| Sub-heading | `Destino` + `Modalidad de envío` + `Sucursales` |
| Postal code | `input[name="address.zipCode"]` — **different name** from domicilio's `zipCode` |
| Carrier radios | `input[name="freight-option"]` — **different name** from `deliveryOptionId`; ids embed UUIDs (unstable) |
| The one to pick | label `Andreani a sucursal` (exact), by accessible name |
| Branch dropdown | `select[name="sucursal"]` with `id="sucursal"`; placeholder `Seleccioná una sucursal` |
| Option values | UUIDs — match must be by **option text**, never by value or index |
| Create button | `Crear envío` — lives **on this screen**, no summary screen |
| Also present | `Editar` + `Cancelar` buttons; `Resumen del envío` side panel |

Observed branch options for CP 1419 (13): `Villa Devoto (Av Beiro) - Av. Francisco Beiró, 4740, C.A.B.A., Buenos Aires`,
plus 12 `Punto Andreani Hop …` entries — matching the panel screenshot exactly. This list is the
**authoritative** one the manual client entry is validated against.

Branch-name matching rule for the executor: exact text match after normalization (case/accent/
whitespace); a message name that matches no option is a rejection listing the real options.

### Corrections to earlier assumptions

- **Weight is displayed in grams.** S7 must therefore define the unit explicitly and convert, or a
  500 g package becomes 500 kg. The unit is a real, clickable control, so the executor must verify
  it rather than assume it.
- **The real order is cost first, address later.** The MVP flow as I had written it (personal data
  before cost) is wrong. Screen 1 is postal code + package + declared value only.
- **Ciudad does not cascade from Provincia.** It is a free-text input, so no dependent select has to
  be driven, and no postal table is required to fill it.


## 5. Safety and constraints already fixed

- **R10 — no real shipment without explicit approval.** The MVP's terminal state is "shipment
  created, label pending payment". That is the natural stopping point: creation is
  recoverable, payment is not. The executor must stop there and refuse any step beyond it.
- **R12 — never invent data.** A message with a missing required field is rejected with the
  exact list of missing fields. No defaults, no inferred city, no placeholder phone numbers.
- **R14 — browser requirements** apply from the first line: role/label-based selectors, state
  waits, precondition checks (right panel, right recipient), fail-loud with trace + screenshot,
  duplicate prevention, and post-action assertion.
- **R11 — fictional data in tests.** Parser tests use invented messages. Executor tests run
  against recorded page fixtures, never the live panel.
- **R15 — no secrets in the repo.** Session state lives on a mounted volume outside the repo,
  encrypted at rest; `.gitignore` already covers it.
- **Single process, no concurrency** (one operator, 11–40 per week). No queue service, no locks,
  no users.
- **Runtime target:** TypeScript, Docker, Linux ARM64.

## 6. Runtime shape

- One screen, served by the same process: paste the message, review the editable preview, confirm,
  run. No navigation, no lists, no dashboard. The preview is mandatory, not a convenience: it is
  where the operator sees recipient, address and service before the panel is touched, and it is
  the approval artifact for R10.
- The parsing and execution layers sit behind interfaces, so the surface can become a WhatsApp
  connector later without touching the core (R16).
- Dry run by default: parse, validate, open the panel, fill, screenshot, and stop before
  creating. Live creation requires an explicit flag **and** a per-run confirmation.
- One run = one shipment = one ledger row. The ledger is written *before* the panel is touched,
  so an interrupted run is visible instead of silent.
- Duplicate prevention: if the ledger already has a shipment for the same message fingerprint,
  the run refuses unless forced.

## 7. Blocked on two inputs

Both are facts only the operator has. Neither can be inferred from documentation.

### B1 — The message format — captured from a real example

Observed format: one `Label: value` per line, under two headings. Labels arrive wrapped in
WhatsApp's own bold markers (`*Código postal*: 1419`), so formatting markers must be stripped
before any label comparison — including the headings, which are bolded the same way.

```text
MDL - Datos de envío

Destino
Provincia: Ciudad Autónoma de Buenos Aires (CABA)
Ciudad: Villa Ejemplo
Calle: Calle Falsa
Número: 742
Departamento: 2b
Barrio: Villa Ejemplo

Datos del destinatario
Nombre completo: juan perez
```

| Field in message | Maps to panel anchor | Notes |
| --- | --- | --- |
| Provincia | `select[name="address.province"]` | arrives as “Full name (ABBREV)”; normalization strips the parenthetical |
| Ciudad | `[name="address.city"]` | free text |
| Calle | `[name="address.address"]` | |
| Número | `[name="address.number"]` | |
| Departamento | `[name="address.complement"]` | optional in the panel |
| Barrio | `[name="address.neighborhood"]` | present in the message, which resolves the earlier gap |
| Nombre completo | `[name="customer.name"]` + `[name="customer.lastName"]` | must be split; the panel marks Apellido optional |

**Not present in the message:**

| Missing | Consequence |
| --- | --- |
| Email, Teléfono | Both optional in the panel, so their absence is fine. |
| Documento | Not in the message and not in the form: dropped from scope. |
| Peso, dimensiones | Come from project configuration (S7); the panel shows grams and cm. |
| Monto total abonado | Optional in the panel; absent from the message. |

### Resolved by the operator

- **Código postal is now part of the message.** The previous blocker is gone; the exact label still
  has to be copied verbatim from the updated example.
- **The pasted text is exactly this structured message**, not a free rewrite of it.
- **`Ciudad` and `Barrio` always carry the same value.** The operator always enters the same text in
  both, as an artifact of how Tiendanube produces it. Rule: `address.neighborhood := address.city`,
  derived and shown in the preview. It is a deterministic rule, not an invention.

Remaining open question: is `Provincia` always written as “Full name (ABBREV)”, or does it sometimes
arrive as the abbreviation only?

### B2 — The panel path

Required: the manual-shipment journey inside Envío Nube, from the dashboard to the label
pending payment.

Cheapest way to produce it: **record one real manual shipment with Codegen, stopping before
payment.** That single recording yields the ordered steps, the selectors, and the field mapping
at once — and R6 already establishes Codegen as the instrument for exactly this.

Without it, the following must be answered by hand:

- Where "carga manual de envío" lives, and what it is called.
- The field order and which fields are mandatory.
- How the postal code drives service options.
- Where the weight/dimensions go, and whether a package type must be chosen.
- **The exact screen where "label pending payment" appears** — the executor's terminal state.
- Whether creating a shipment is reversible without a charge, and how.

## 8. Definition of done

- A structured message with all fields produces a shipment in the panel with the label pending
  payment, asserted by reading the resulting screen.
- A message with a missing field produces a rejection naming the missing fields, and creates
  nothing.
- A duplicate run for the same message creates nothing and says why.
- An interrupted run leaves a ledger row that makes the state obvious.
- Parser tests cover every field and the rejection paths; executor tests run on fixtures.
- A missing session or an unexpected screen produces a loud failure with a trace, and no
  partial shipment left behind silently.

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Panel changes and the automation breaks silently | Assertions after every step; a failed selector aborts the run and alerts |
| A retried run creates a second shipment | Ledger fingerprint check plus post-action assertion |
| Session expires mid-run | Precondition check before driving; re-login is a documented manual step |
| The message format drifts in real use | Parser rejects with the exact mismatch; format changes are versioned |
