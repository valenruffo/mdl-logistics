# Production deployment — MDL Logistics on the Oracle VPS

Status: in progress. Slice 1 (container + server runtime) delegated; slice 2 blocked on SSH access.

## Specs

S1. **One user.** Only the operator logs in. No multi-user, no accounts, no per-person permissions.
S2. **One store.** The project is dedicated to MDL, not a multi-store platform.
S3. **The interface shows the agent's state**: errors, logs, and every piece of information needed to maintain it, without leaving that interface.
S4. **No AI in that interface.** It reports and records; it does not interpret.
S5. **Domain**: `agents.mujeresdelinaje.store`, DNS managed at Hostinger. The apex `mujeresdelinaje.store` is the official store domain and stays as it is.
S6. **Deploy on the Oracle VPS** (164.152.194.196, Ampere A1 ARM64, Ubuntu 24.04), executed by the agent.

## Tasks

| ID | Task | Specs | Route | State |
| --- | --- | --- | --- | --- |
| T1 | ARM64 container, headless/storageState runtime, session export/check scripts | S6 | worker | in progress |
| T2 | VPS recon: nginx sites, free ports, docker, certbot, disk | S6 | inline (blocked on SSH alias) | blocked |
| T3 | DNS A record `agents` → 164.152.194.196 | S5 | operator | pending |
| T4 | Nginx vhost + Let's Encrypt for the subdomain, proxy to 127.0.0.1 | S5, S6 | inline | pending |
| T5 | Deploy the container, verify health and session | S6 | inline | pending |
| T6 | Maintenance interface: agent state, run history, logs, session status, config, errors | S3, S4 | worker | pending |
| T7 | End-to-end verification on the server with a dry run | S6 | inline | pending |

## Constraints discovered on the VPS

- Ports already taken: 22, 80, 2022, 3000?, 3306, 6379, 8000, 8080, 9000, 9001, 18080.
- Nginx is already the reverse proxy for other services (Pterodactyl on 80, MoviBot on 9001). Any change must add a site, run `nginx -t`, and reload — never rewrite existing sites.
- Login has 2FA, so the session is seeded by a human on a machine with a screen and transferred. When it expires, the interface must say so loudly and block work.

## Standing rules that apply

R10 (no real shipment without explicit approval), R12 (never invent data), R15 (no credentials in the repo), R13 (APIs before automation), R16 (modularity), R17 (no real data to external models). The purchase of a label must never gain a code path.

## Log

L1 (verbatim): "pera, solo yo ingreso, sin multiusaurio, luego es solo una tiend,a es dedicado a mdl el proyecto no a mil tiendas. la interfaz si todo lo que me indique el estado del agente, errores, logs, toda la info para que yo mpueda ir manteniendolo, sin salir de esa interfaz, nada de ia, oy veo los erroe sy voy corrigiendolo aca mismo ene sta sesion. tema dominio, el dominio oficial es mujeresdelinaje.store, lo tengo en hostinger, asi seria diela que sea agents.mujeresdelinaje.store . desplega vos."

L2 (verbatim): "pero yo necesito desplegarlo en mi vps para hace run proyecot completo, real, aparte para luego que empleados puedan usar agentes, xq este lo uso yo y puecdo hacerlo local pero la ideas es hacer un par mas para mdl, asi que hagamos la interfaz bien par aproduccion linda, y en el vps "C:\Users\valen\Desktop\vps-oracle""

L3: The operator rejected the deployed UI ("esa interfaz es un asco") and named the missing step: the design skills were never read. Also: a native `alert()` on load is forbidden, and the creation ceremony must go — creating does not charge, so it needs no approval; buying stays forbidden. R10 amended accordingly.

L4: Design directions written to `design/consola-operador/` (01-mesa-de-trabajo, 02-bandeja-operativa, 03-consola-densa), with their tradeoffs in `design.json`. Alternatives, not final: the next step is the operator's pick, then implementation in `src/ui/`.
