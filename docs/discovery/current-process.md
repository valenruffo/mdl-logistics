# Discovery — Current Process (as-is)

Status: **in progress** — filled during Stage 1 by the operator, step by step.
Owner: operator (MDL). Scribe: agent.

## Purpose

Capture how orders are handled today, before designing anything. This document is the
source of truth for the next stages: the data model, the business rules, and the
automation boundary all derive from what is recorded here.

Rules for this document:

- Record the process **as it is**, not as it should be. No improvements, no automation
  proposals. Those belong to a later stage.
- One step per block, in the order it actually happens.
- **Data used** is what the step consumes or produces, in the operator's own words.
  It becomes the data model.
- **Decision** is a real choice the operator makes. It becomes a business rule.
- **Exception** is anything that breaks the happy path. It becomes a branch to handle.
- Quote the operator verbatim where wording matters (labels, messages, field names).
- No source code in this stage.

## Scope of this stage

| In scope | Out of scope |
| --- | --- |
| Current manual flows, end to end | Designing the application |
| Data, decisions, exceptions per step | Choosing libraries or infrastructure |
| Volumes and error frequency | Writing source code |
| Evidence (screenshots, exports) | Repository scaffolding |

## Flow 1 — Tiendanube orders

Starts when an order arrives at the store. Recorded first because the data behind it is
structured and reachable through the Tiendanube API.

### Step template

Copy this block for every step. Keep the identifiers stable (S1, S2, …): later stages
reference them.

```text
### S1 — <short title of the step>

- Trigger: <what causes this step to start>
- Actor: <who or what performs it>
- Tool: <where it happens: store admin, Envío Nube panel, spreadsheet, WhatsApp>
- Action: <what is actually done, in order>
- Data used:
  - input: <fields read, and from where>
  - output: <fields produced or written, and where>
- Decision: <the choice made, and the criteria used to make it> | none
- Exception: <what can go wrong or deviate here> | none
- Frequency / cost: <how often, how long it takes>
- Evidence: <screenshot or file name> | none
- Notes: <anything the operator flags as annoying, risky, or error-prone>
```

### Recorded steps

_Empty. To be filled from the operator's walkthrough._

### Context confirmed by the operator

| Question | Answer | Consequence |
| --- | --- | --- |
| Shipments per week | 11–40 | Moderate volume: needs per-order persistent state and mid-way failure tolerance, but not a distributed queue. |
| Who operates | The operator alone | No concurrency. Single-process application, no locking, no multi-user model. |
| Shipping surfaces | Everything goes through Envío Nube | One execution surface only. No carrier-routing rules to design. |
| Tiendanube plan | **Impulso** (second tier, not Next) | `fulfillment_order_label_api` is **not** granted. The Labels API returns `403 Forbidden`. |

### Volumes

| Question | Answer |
| --- | --- |
| Orders per day (typical) | ~2–6, derived from 11–40 per week |
| Orders per week | 11–40 |
| Peak periods (dates, events) | pending |
| Share of orders that ship, vs. pickup/delivery in person | pending |
| Time spent per order, end to end | pending |

## Flow 2 — WhatsApp orders

Recorded after Flow 1. The entry point is free text, so the problems are different:
missing data, ambiguous addresses, no order ID.

_Empty. To be filled in the second block._

## Detected entities (working list)

Running list of the things the process manipulates. Becomes the data model.

| Entity | Known in | Identifier | Key attributes | Notes |
| --- | --- | --- | --- | --- |
| | | | | |

## Detected decisions (working list)

Every branch point found in the steps. Becomes a business rule.

| ID | Decision | Criteria | Recorded at | Consequences if wrong |
| --- | --- | --- | --- | --- |
| | | | | |

## Detected exceptions (working list)

| ID | Exception | Frequency | Current handling | Cost |
| --- | --- | --- | --- | --- |
| | | | | |

## Evidence

| File | What it shows | Step |
| --- | --- | --- |
| | | |

## Open questions

Questions that must be answered before the design stage. Do not guess the answer.

| ID | Question | Blocks | Status |
| --- | --- | --- | --- |

## Standing rules (operator-defined)

Verbatim rules the operator set for this project. They apply to every stage, not only to
discovery, and override any convenience the agent might prefer.

| ID | Rule |
| --- | --- |
| R1 | Work in stages; do not develop the whole application at once. |
| R2 | Stage 1 is discovery. |
| R3 | First explain and show how the operations are performed today. |
| R4 | Document every step, the data used, the decisions taken, and the exceptions. |
| R5 | Investigate which operations can be solved through official Tiendanube APIs, and which require browser automation. |
| R6 | For browser operations, evaluate Playwright; use Codegen to record the manual procedure. |
| R7 | Do not assume an API exists without verifying its documentation. |
| R8 | Identify which data an AI must extract from WhatsApp messages, and which operations must be resolved with conventional code. |
| R9 | Do not implement features until the flow is understood. |
| R10 | Never create, modify, buy or confirm real shipments without the operator's explicit approval. |
| R11 | Use fictional data during tests. |
| R12 | Never invent missing recipient or address data. |
| R13 | Prioritize official APIs when they are available. |
| R14 | If Playwright is used, implement robust selectors, validations, error handling and duplicate-prevention mechanisms. |
| R15 | Never store credentials, cookies or sensitive information in the repository. |
| R16 | Keep the project modular and ready to add new automations. |
| R17 | Do not send real data to external models without authorization. |

R17 has a direct architectural consequence for the WhatsApp stage: a real message carries a
name, an address, a phone and a document. Sending it to a hosted model is a data transfer, so
that path requires explicit authorization per use — or a local model. It is also why the MVP
parser is deterministic: no message ever leaves the machine.

R7 has a corollary that already caught an agent error: a search-engine summary is not
documentation. Claims in this document are valid only with a cited official page, and
otherwise must be written as unverified.

## Irreversible operations policy

R10 is a hard boundary, not a preference. Money leaves the account and a purchased label is
not cleanly reversible, so this rule must be enforced by the system, never by remembering it.

### Operations covered

| Operation | Why it is covered |
| --- | --- |
| Creating a shipment in Envío Nube | buys a shipping service |
| Buying or confirming a label | charges the operator's account |
| Changing the carrier or service of an existing shipment | may re-price or invalidate the label |
| Cancelling a shipment | may forfeit the amount already paid |
| Reprinting a label after changes | may create a second charge |

### Enforcement the design must carry

- **Default deny.** The system ships with the live path disabled. No configuration default,
  no environment fallback, and no "first run" may enable it.
- **Prepare, do not submit.** The automated path produces a reviewable proposal (order,
  carrier, service, weight, address, price) and stops. Submission requires a distinct human
  action that the system records.
- **Approval is per action, not per session.** An approval applies to one shipment, is tied to
  the exact payload shown to the human, and expires. Changing any field after approval
  invalidates it.
- **Audit trail.** Who approved, what exactly was approved, when, and the resulting provider
  response, stored durably before the action is attempted.
- **Read-only during discovery.** Stage 1 and the browsing/recording work use only read
  operations. Recording a Codegen flow must not buy anything; if a flow reaches the submit
  step while recording, stop before it.
- **Tests prove the guard.** An automated test must fail if the submit path becomes reachable
  without a recorded approval. The guard is code with a test, not a prompt instruction.

## Test data policy

R11 has three consequences, and one genuine conflict that must be designed for instead of
ignored.

- **No network in tests.** The Tiendanube client sits behind an interface with a fake
  implementation, so unit and integration tests never reach the real API and never depend on a
  real store token.
- **Fictional fixtures only.** Orders, recipients, addresses and products in tests are invented:
  `Juan Pérez`, `Av. Siempre Viva 742`, `CP 1000`. A real order is never copied into a fixture,
  a snapshot, a log or the repository.
- **No real PII in logs.** Logs and traces redact names, phone numbers and addresses. A debug
  trace containing a real customer is a data leak in a file.

The conflict, stated plainly: a real admin panel cannot contain fictional orders, so
end-to-end browser tests cannot run against the live panel with invented data. Resolution:

- Deterministic browser tests run against recorded page fixtures or intercepted routes.
- Exercises against the live panel are read-only and manual, outside the automated suite.
- No automated test reaches the purchase or submit step, with or without data.

## Data integrity policy

R12 makes missing data a **state**, not a gap to fill.

- A recipient record is either complete or it blocks. No defaults (`N/A`, `sin datos`, `0`), no
  placeholder text, no guessing a city from a street name.
- The only permitted derivation is from an authoritative, cited source (for example an official
  postal-code table). The derived value is marked as derived, shown to the operator for
  confirmation, and stored together with its source. When no source exists, the value is unknown.
- LLM output is never a source of truth for an address field. It is a candidate that requires
  confirmation like any other.
- Changing an address after approval invalidates the approval (R10).
- A shipment cannot be proposed while a required field is unknown. The pipeline must state
  exactly what is missing, instead of producing a plausible-looking shipment.

## Automation precedence

R13 turns "prefer the API" into an ordered decision, evaluated per operation, and recorded:

1. Official API, documented and stable.
2. Official API behind a feature flag or plan the operator can enable.
3. Official import/export surface.
4. Browser automation — fragile, and bound by R14.
5. Human step — always acceptable, and always the fallback.

Choosing 4 over 1–3 requires a written reason in the decision record, naming the exact
operation and the rejected path. The choice is re-evaluated when the API gains the capability:
an API arriving later retires the automation, it does not coexist with it.

## Browser automation requirements

Mandatory whenever Playwright is used (R14). Each item is a testable requirement, not advice.

| Area | Requirement |
| --- | --- |
| Selectors | Prefer accessible role + name, label text, or a stable data attribute. Never positional CSS (`nth-child`), never absolute XPath. A selector matching more than one element is a failure, not a coin flip. |
| Waits | Wait for observable state — element visible, expected network response. Never a fixed sleep. |
| Preconditions | Verify it is the expected entity before acting: store name, order id visible on screen. Acting on the wrong order is worse than failing. |
| Validation | Check every read value against its expected shape (a tracking code that is not a code is a failure). |
| Errors | Fail loudly with trace, video and screenshot. Never continue past a missing step, never leave partial state behind. |
| Duplicates | Before submitting, query both the local ledger and the panel for an existing shipment for that order. Every run carries an idempotency key. A retry after an unknown outcome reconciles state first; it never re-submits. |
| Confirmation | After acting, assert the result actually happened (label exists, tracking code captured) and record it durably. |


## Secrets and sensitive data policy

R15 has a non-obvious consequence: a Playwright session cookie **is** a credential. Holding a
logged-in store session (needed for the Envío Nube surface) is therefore a storage problem, not
a convenience. Session state is treated exactly like a password.

### Never in the repository

| Item | Why |
| --- | --- |
| Tiendanube app token, Envío Nube credentials | full account access |
| Playwright `storageState` / session cookies | functionally a password for the store admin |
| Traces, videos, HAR files | contain customer PII and often request headers with tokens |
| Real order or customer exports | personal data, and R11 already forbids using them |
| `.env` files | the usual accidental leak |

### Design

- **Secrets arrive at runtime** from the host: an env file outside the image or Docker secrets
  mounted at `/run/secrets`. Never baked into the image, never a committed default, never a
  placeholder that silently works.
- The only committed file is `.env.example`, with empty values and a comment per variable.
- **Session state lives outside the repo**, on a mounted volume, encrypted at rest, with
  restrictive permissions, and is treated as an expiring credential. Re-login is a normal
  operation, not an incident.
- Captures and traces go to a git-ignored artifacts directory with a retention limit.
- Logs mask `Authorization` headers and redact PII before writing anything.
- A secret scan runs before the first commit and in CI; a hit blocks the commit.

No git repository exists yet. `.gitignore` is created now, before any code, so the rule holds
from the first commit instead of being retrofitted after a leak.


## Modularity constraint

R16 asks the project to accept new automations without rewriting the pipeline. That is a
constraint on seams, not a licence to abstract everything up front.

The pipeline has four stages, and only these are meant to be replaced independently:

| Stage | Responsibility | Grows when |
| --- | --- | --- |
| Intake | Where an order comes from: Tiendanube webhook, WhatsApp message, manual entry | a new sales channel appears |
| Resolution | Turn an intake into a complete validated order: catalog match, address, weight | new data sources or rules appear |
| Execution | Perform the operation: API call, browser flow, or human step | a new carrier or surface appears |
| Record | Durable ledger of what was attempted, approved and produced | almost never — this is the invariant |

Rules that keep it modular for real:

- A new automation is a new **operation descriptor** plus an optional executor. Never a fork of
  the flow, never an `if` in the middle of the pipeline.
- Adding a sales channel touches Intake only. Adding a carrier or a shipping surface touches
  Execution only.
- The core pipeline depends on interfaces, never on a named provider.
- **No premature abstraction.** Introduce a seam where a second implementation is real or
  clearly planned. R16 means "ready for", not "abstract now": an interface with one
  implementation and no planned second one is noise.


## Automation boundary

Result of stage 3 of the working method. The boundary follows the **entity**, not the
operation: Tiendanube data is reachable through the official API, while the Envío Nube
shipping lifecycle is not reachable at all.

| Operation | Official API | Verdict |
| --- | --- | --- |
| Read orders (list, detail, filters) | `GET /orders`, scope `read_orders` | API |
| Receive new-order events | `POST /webhooks`, events `order/created`, `order/paid`; HMAC via `x-linkedstore-hmac-sha256` | API |
| Read shipping / fulfillment state | `GET /orders/{id}?aggregates=fulfillment_orders`, `GET /orders/{id}/fulfillments` | API |
| Read tracking data | `fulfillment_order.tracking_info` (`url`, `code`), `tracking_info_history`, `tracking_events` | API (read) |
| Write tracking data to an order | writable in the model, no merchant endpoint confirmed | Unverified — must be tested |
| Read products (weights, dimensions) | product resources | API |
| Register shipping carriers / rate callbacks | `POST /shipping_carriers` — requires an app in the Partners Portal plus an onboarding form; grants access to the shipping endpoints only on approval | Not available to a merchant app |
| Create an Envío Nube shipment | no documented endpoint | Browser / human (unverified) |
| **Generate a label** | **Labels API on the Fulfillment Order resource**, gated by the `fulfillment_order_label_api` feature, *currently granted only to stores on the Next plan*; every other store gets `403 Forbidden` | **Conditional — API if the store has the feature, otherwise browser/human** |
| Reprint or cancel a shipment | panel-only actions | Browser / human |

Consequence for the design: two distinct integration surfaces with different reliability.
The API surface is stable and testable; the browser surface is a consumer UI that nobody
committed to keep stable, and it must degrade gracefully to "the system prepares, the human
submits" instead of failing silently.

### Verified API facts (source: official Nuvemshop/Tiendanube API reference)

Order resource (`/api-documentation/resources/order`):

- `status`: `open`, `closed`, `cancelled`.
- `payment_status`: `authorized`, `pending`, `paid`, `partially_paid`, `abandoned`, `refunded`, `partially_refunded`, `voided`.
- `shipping_status`: `unpacked`, `shipped` (fulfilled), `unshipped`, `delivered`, `partially_packed`, `partially_fulfilled`.
- `weight` is marked **deprecated** on the order.
- There is no `tracking_number` field on the order: tracking moved to Fulfillment Order.

Fulfillment Order resource (`/api-documentation/resources/fulfillment-order`):

- One order can have multiple shipments; each shipment is a Fulfillment Order.
- Carries `recipient`, destination address, `status` (`UNPACKED`, `PACKED`, …), `status_history`,
  `tracking_info` (`url`, `code`), `tracking_info_history`, `tracking_events`.
- Documents a backward-compatibility mapping from Order V1 shipping fields and fulfillment events.
- Exposes the **Labels API**, which is feature-gated as described above.

Shipping Carrier resource (`/api-documentation/resources/shipping-carrier`):

- Creating a carrier requires an app in the Partners Portal plus the onboarding form, so the
  Platform team grants access to the shipping endpoints.
- Carrier properties include `callback_url` (rates) and `callback_labels_url` (asynchronous label
  generation), both required to be HTTPS.
- This is the **carrier** side of the contract, not something a merchant app can use.

### Decisive question — resolved

> Which Tiendanube plan is the store on, and does it expose the `fulfillment_order_label_api` feature?

**Answered: Impulso. The feature is not granted.**

Consequences, now settled instead of conditional:

- Label generation **cannot** use the Labels API. It is a panel action.
- Playwright is therefore **mandatory** for the label step, not an optional fallback. R14 applies
  from the first implementation, not later.
- The API boundary is exactly: orders, order state, products, webhooks. The label is outside it.
- Re-check this if the store ever moves to Next: the API arriving retires the automation (R13),
  it does not coexist with it.
- No further documentation lookups are needed to decide this. The remaining proof is an account
  probe (call the endpoint with the store token and read the status code), which is a technical
  step of the next stage, not research.

## Browser automation evaluation (Playwright)

Stage 4 of the working method. Playwright is the right tool for the Envío Nube surface, but
with explicit limits.

### What Codegen is and is not

Codegen is a **discovery instrument** first, and only later a source of selectors. It records
what was clicked, not how to click reliably. Recorded output has no waits, no retries, no
idempotency, no error handling, and selectors tied to the current markup. Treat a recording
as documentation plus a selector source, never as production code.

Its highest value in this stage is that it produces a literal, ordered trace of the manual
procedure — which is exactly the step list this document needs.

### Constraints to resolve before committing

| # | Constraint | Why it matters |
| --- | --- | --- |
| C1 | Session authentication and 2FA | The panel needs a logged-in session; storing it means holding credentials or cookies. Cookies expire, and re-login may require a human. |
| C2 | ARM64 container runtime | Chromium under Docker on ARM64 works but needs a compatible base image and roughly 1–2 GB of headroom per browser instance. |
| C3 | Irreversible actions | Creating a shipment spends real money and cannot be cleanly undone. The first automated version must stop before the final submit for human confirmation. |
| C4 | Selector drift | The panel can change without notice. A run that cannot find its target must fail loudly and leave no partial state, never guess. |
| C5 | Observability | Every run needs a trace, a screenshot and a video, otherwise a failure is undiagnosable a day later. |
| C6 | Idempotency | A retried run must not create a second shipment for the same order. Requires an external record of what was already submitted. |

### Recommended shape

Semi-automated first: the system decides what to ship and fills the panel up to the final
click, then waits for the operator. Fully unattended execution only after the flow has run
cleanly for a meaningful number of real orders and C1–C6 are resolved.

## Technical premises to verify

Unproven assumptions that the design depends on. Verified in the second block of this
stage, against the operator's real accounts — not from documentation alone.

| ID | Premise | Why it matters | Verification method | Status |
| --- | --- | --- | --- | --- |
| P1 | Tiendanube exposes orders and webhooks to a private ("app a medida") token | This is the only structured data entry point | Create the app, call `/orders`, register a webhook | unverified |
| P2 | Envío Nube has no standalone public API; shipment and label creation exist only inside the Tiendanube admin | Decides whether shipping creation can be automated or must stay a human click | Inspect Tiendanube shipping/fulfillment resources and the merchant panel | **documented, pending account check** |
| P3 | A single operator runs the whole flow, so there is no multi-user concurrency to design for | Changes the entire persistence and UI model | Confirm with the operator | unverified |
| P4 | A logged-in store admin session can be held and reused on a headless VPS | Browser automation of the shipping step depends entirely on this | Prove re-login and session reuse survive a container restart | unverified |
| P5 | The store has the `fulfillment_order_label_api` feature (Next plan) | If true, label generation is an API call and browser automation may be unnecessary | Operator confirmed the store is on **Impulso**, not Next | **resolved — false** |

Source for P2: public search, no documented `api.envionube.com`-style endpoints found;
Envío Nube is described as a shipping aggregator native to Tiendanube. The shipping carrier
endpoints that do exist are gated to registered partner/carrier apps, not merchant apps.
Must be confirmed against the real account.
