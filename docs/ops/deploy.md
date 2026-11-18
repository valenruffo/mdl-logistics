# Operations — deploy and session runbook

Single operator, single store, one VPS. Nothing here is automated: the session has 2FA, so a human seeds it, and nobody stores a password.

## Prerequisites

- VPS reachable over SSH, ARM64, with Docker and Docker Compose installed.
- `agents.<store-domain>` resolving to the VPS, and Nginx with a TLS certificate for it.
- The repo cloned on the server at `/home/ubuntu/mdl-logistics`.
- A session file produced on a machine **with a screen** (see below). There is no headless login.

## 1. Seed the session (on your desktop, not the server)

```bash
export MDL_STORE_ORIGIN=https://<store>.mitiendanube.com
npm run session-export -- ./session/storage-state.json
```

A headed Chromium opens on the store admin. **Log in by hand**, including the 2FA code. When the admin shell appears, the script writes the file and prints its size.

Treat that file as a password. It grants full admin access. It is git-ignored, and it must never be attached to an issue, a chat or an email.

## 2. Transfer it

```bash
scp ./session/storage-state.json ubuntu@<vps>:/srv/mdl-session/storage-state.json
ssh ubuntu@<vps> 'sudo chown 1000:1000 /srv/mdl-session/storage-state.json && sudo chmod 600 /srv/mdl-session/storage-state.json'
```

`1000` is the container's `node` user. A root-owned `600` file fails at run time with a confusing error, not at deployment.

## 3. Configure and start

Create `/home/ubuntu/mdl-logistics/.env` on the server (git-ignored) with:

```
MDL_STORE_ORIGIN=https://<store>.mitiendanube.com
MDL_STORAGE_STATE=/run/mdl/storage-state.json
MDL_HEADLESS=true
```

Then:

```bash
cd /home/ubuntu/mdl-logistics
docker compose build
docker compose up -d
docker compose ps        # healthcheck must report healthy
```

## 4. Verify before trusting it

```bash
docker compose exec mdl-logistics npm run session-check
```

| Exit | Meaning | Action |
| --- | --- | --- |
| 0 | session usable: no login page, no 2FA prompt, admin shell and Envío Nube frame present | proceed |
| 1 | session unusable or expired | repeat steps 1–2, then re-check |
| 2 | configuration refused before any browser opened | fix the env or the file path/permissions |
| 3 | the browser could not start | check headless flag, Chromium presence, sandbox |

Run this **after every restart** and **whenever the session alarm fires**. It is read-only.

## 5. Behind the proxy

The app listens on `127.0.0.1:4319` **inside the container**, which uses host networking, so on the VPS that is the host's loopback. Nginx terminates TLS and forwards to it. Never publish that port to the internet, and never bind the app to `0.0.0.0`.

## 6. When the session expires

The layout is expected, not exceptional. `session-check` exits 1, or a run stops at the session precondition with a clear message. There is **no** automatic refresh and **no** stored password: repeat steps 1–4. If this becomes frequent, the honest fix is to make the alarm louder, not to automate the login.

## 7. Redeploying

Artifacts (traces, screenshots, run-records) live in a named volume and survive a rebuild. The session file lives outside the image and outside the repo, so a rebuild never invalidates it.

Every redeploy leaves the previous image dangling and grows the build cache. The standing procedure is: build, recreate, **prune what the build replaced**, then report the disk.

```bash
docker compose --env-file server.env build
docker compose --env-file server.env up -d --force-recreate
docker image prune -f                      # removes the replaced mdl image (dangling)
docker builder prune -f --filter until=168h # trims the build cache, keeps the last week
```

Do not use `docker image prune -a` or `docker system prune -a` on this host: it also removes images that belong to other services that happen to be stopped at that moment.

**Report the disk after every deploy**, so growth is visible instead of surprising:

```bash
df -h / | tail -1
docker system df
```

The first line gives total, used and free; the second gives how much of that is Docker layers and cache, and how much is reclaimable.

## Known limits

- The image has **not** been built or run yet: no Docker engine existed on the operator's machine. First build happens on the VPS, and the Chromium path inside the image must be confirmed there.
- `network_mode: host` is deliberate: the app binds loopback only, and a published bridge port cannot reach a container-loopback listener. It is Linux-only, which is the only target.
- One Chromium, one operator: `mem_limit 2g` and `shm_size 512m`. Raising either is a deployment decision, not a code one.
- `MDL_HEADLESS` accepts exactly `true`/`false`. A legacy `MDL_HEADLESS=1` is refused loudly rather than assumed.
