# Stack — what it is, why it is, and when to change it

For an engineer reading this repo. Every technology here earned its place; the list of things
deliberately **not** used matters as much as the list of things used.

## 1. The governing constraint

The workload is: **one operator, one store, 11–40 shipments per week, one browser session at a
time.** A run takes ~16 seconds. That is the whole load profile.

Everything below follows from it. Any component that solves concurrency, horizontal scale or
multi-tenancy is paying for a problem this system does not have. The design goal is *few moving
parts that can each be understood in ten minutes*, not *resume-driven enterprise architecture*.

The second constraint is honesty about failure: creating a shipment spends money, so the system
is built to stop rather than guess.

## 2. Language and runtime

| Choice | Why |
| --- | --- |
| **TypeScript** | The parser manipulates a fixed set of fields; the compiler catches the boring regressions. Also the Playwright API is typed, which makes page objects self-documenting. |
| **Node 24, ESM** | Same runtime as the browser tooling. ESM because Playwright and tsx are ESM-first; mixing module systems buys nothing. |
| **tsx** at runtime | Runs TypeScript directly with no build step. A build step would add a `dist/` to keep in sync and a sourcemap hop in stack traces, for zero benefit at this scale. If startup time ever mattered, this is the first thing to swap for `tsc` + compiled output. |
| **`node:test`** | The standard runner. No test framework to configure, no plugin ecosystem, no watch-mode quirks. 151 tests run in ~0.7s. |
| **`tsc --noEmit`** for typecheck | Type checking and transpilation are separate concerns; tsx does one, tsc verifies the other. |

### Runtime dependencies: none

`"dependencies": {}`. The entire production surface is `playwright` plus the standard library.
A `npm audit` on a zero-dependency runtime is a very short conversation.

## 3. Layering, and why each layer exists

| Layer | Directory | Responsibility | Why it is separate |
| --- | --- | --- | --- |
| Core | `src/core/` | Parser, province map, postal-code rule, config, payload types | Pure functions: no network, no browser, no I/O. Testable in milliseconds and portable anywhere. |
| Executor | `src/executor/` | Session, page objects, the journey, the readback | **The only place that touches a browser.** Everything browser-shaped and fragile lives here and nowhere else. |
| CLI | `src/cli/` | Two gates, the run record, the `ship` command | The safety logic is usable without any UI. A headless environment can still create shipments safely. |
| UI | `src/ui/` | One page, one HTTP server | Presentation only. It calls the same gates; it does not own policy. |

The rule this enforces: **core never imports Playwright**, so a test that only checks parsing
cannot accidentally start a browser. Verified by measurement: importing the carrier constant
loads 1 module; importing `gates.ts` loads 3 and resolves Playwright zero times.

## 4. Browser automation

| Choice | Why |
| --- | --- |
| **Playwright** over Puppeteer | First-class frame handling (the Envío Nube UI is a cross-origin iframe), auto-waiting on actionability, `storageState` for session transfer, and traces that replay a failure. |
| **Chromium only** | One engine to keep working. Cross-browser support would multiply the thing most likely to break. |
| **Persistent profile locally / `storageState` on the server** | Locally, a real profile survives restarts and makes the human login trivial. On a headless server, a transferred `storageState` is the smaller, auditable artifact. |
| **Headless on the server, headed locally** | A VPS has no display. `MDL_HEADLESS` accepts exactly `true`/`false` and refuses `1`, so a typo fails loudly instead of silently doing the wrong thing. |
| **Structural assertions** | Proof that the label is unpaid is `#EM<number>` + `Por enviar` badge + a `Comprar` button. Prose matching already produced a false negative once, after a real creation. |

Why not a hosted service (Browserless, Playwright grid): one browser, one operator, one session.
Adding a remote browser service would introduce a network hop and a third party into a flow that
currently runs in one process.

## 5. HTTP server

`node:http`, hand-rolled routing table, one HTML page, one ~90-line client script, no framework.

Why: the surface is five routes and one form. Express or Fastify would add a dependency, an
upgrade path and a middleware model for something the standard library does in ~200 lines. The
routing table is a data structure — you can read it and know every endpoint exists.

Why not Next.js/React here: the page has no client-side state beyond one form, and no navigation.
A single-page framework would be more code, a build step, and a bundler to keep patched, to render
14 inputs.

**Boundary:** the server binds `127.0.0.1` with no configurable host. In production it reaches the
internet only through Nginx with TLS. This is not a preference; the page can create shipments.

## 6. Persistence

**Files on disk, not a database.** `.json` run records in `artifacts/run-records/`, artifacts
(traces, screenshots) beside them.

Why: the data is small, append-only, human-readable, and single-writer. A run record is written
*before* the click, so a crash mid-action leaves a visible unresolved attempt. Diagnostics mean
opening a file in any editor.

Why not SQLite yet: nothing queries across records. When the maintenance UI needs to list, filter
and aggregate runs, SQLite is the correct next step — same file-per-machine model, real queries,
zero operational cost. Postgres only becomes necessary with concurrent writers or multiple
hosts.

## 7. Safety design (the part that is not negotiable)

| Mechanism | Purpose |
| --- | --- |
| Gate 1: approval hash | Canonical payload hash recomputed from the form, compared to the approved one. Any edit invalidates the approval by construction. |
| Gate 2: typed token | A second, different human action authorizes the click. |
| Pre-click run record | The only trace if the process dies between click and confirmation. |
| `Unresolved` blocks | An attempt with unknown outcome cannot be retried; a human reconciles first. |
| Duplicate refusal | The same message cannot create a second shipment. |
| Static guard (`scripts/safety-guard.mjs`) | Fails the build if a purchase identifier ever gains a click path. |
| No purchase code | The purchase is absent, not disabled. A flag can be flipped; a missing function cannot. |

## 8. Container and deployment

| Choice | Why |
| --- | --- |
| **`node:24-bookworm-slim` + `npx playwright install --with-deps chromium`** | The upstream Playwright image publishes amd64 only; the target is ARM64. Installing through Playwright keeps the browser revision matched to the pinned library version. |
| **Non-root user** | A compromised browser is a compromised browser; it should not be root. |
| **`network_mode: host`** | The app binds loopback only, and a published bridge port cannot reach a container-loopback listener. Host networking keeps the loopback bind literal on the host, where Nginx can reach it. Linux-only, and Linux is the only target. |
| **`mem_limit 2g`, `shm_size 512m`** | One Chromium's realistic footprint. Raising it is a capacity decision, not a code one. |
| **Nginx + Let's Encrypt** on the host | Already present for other services and already terminating TLS. |
| **No Caddy** | Caddy and Nginx would both want ports 80/443. Two reverse proxies on one box is a conflict, not an upgrade. |
| **No BullMQ, no Redis** | There is no queue. Runs are serialized by physical reality: one session, one browser, one operator. A queue would add a second source of truth for run state competing with the run records. |

## 9. Security posture

- No credentials in the repo; the browser session lives outside it, in a file treated as a password.
- The app never sees the store password: 2FA makes login human-only, and there is no stored secret.
- Secrets arrive at runtime through the environment; `MDL_STORE_ORIGIN` has no default pointing at a real store.
- The UI binds loopback and has no CORS headers.
- Logs and records are designed to be shareable: the operator log carries no name, address, phone or document.

## 10. When to change it — scale-up triggers

Add things when a **specific** condition appears, not before. The trigger column is the honest part
of this table.

| Symptom | Add | Why this one |
| --- | --- | --- |
| A second person needs access | Auth (Auth.js, Better Auth, or plain session + argon2) and per-user audit | Authentication is the smallest thing that makes "who approved this" true. |
| Runs list must be filtered/aggregated | SQLite (then Postgres if multiple hosts) | Queries are the actual need; a filesystem scan is the wrong shape. |
| More than ~50 runs/day, or two browsers must run at once | BullMQ + Redis | That is when queuing, retries and backoff stop being ceremony. Requires a second session, which 2FA makes a real constraint. |
| Failures need to page you | Sentry (errors) and a cron `session-check` that alerts | Detection beats dashboards. The session expiring silently is the biggest operational risk today. |
| Metrics over time (latency, success rate) | Prometheus + Grafana, or plain SQL over SQLite | Only worth it once records accumulate and someone reads them. |
| More than one store | Tenant column + per-tenant session, or one deployment per store | Isolation beats features; one compromised session should not reach two stores. |
| UI grows past one screen | React + Vite, or SvelteKit | The current page is 14 inputs. A framework earns its place at the second screen. |
| Tiendanube moves the store to the **Next** plan | Delete the browser path and use the Labels API | The API is more reliable than any UI automation. An arriving API retires the automation — it never coexists with it. |
| Deploys become frequent or multi-step | GitHub Actions: typecheck, tests, guard, build | The checks already exist; CI only automates running them. |
| You want backups you trust | `restic` or `borg` on a schedule, restoring tested | A backup nobody restored is a wish. |
| Several containers to manage | Traefik or Nginx with generated configs | Only when hand-maintained Nginx sites become the bottleneck. |

## 11. Known debt

- `src/ui/actions.ts` imports the unpaid-label helper from the executor; it is type-only today, so no browser stack is loaded, but a value import there would pull Playwright into the page process.
- The container image has not been built yet; the first build happens on the ARM64 VPS.
- The parser's operator-facing rejection text is English while the form is Spanish. Cosmetic, and deliberately not fixed to keep a single definition of the postal-code rule.
- Session expiry is a manual recovery. That is the design, not a gap, but it deserves an alarm.
