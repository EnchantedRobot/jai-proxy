# Deploying the archive to a server (unraid)

The end state: the archive runs as a container on the unraid box, alongside
SillyTavern, and reaching it is the same gesture as reaching SillyTavern — a URL
on the LAN. The Mac still runs the acquisition userscripts, but they now post
into that remote archive rather than a local one.

Three moving parts:

| | |
| --- | --- |
| **Image** | `ghcr.io/enchantedrobot/jai-proxy`, built and pushed by `.github/workflows/publish.yml` on every push to `main` |
| **Data** | one bind mount at `/app/data`, seeded manually, holding everything the container writes |
| **Userscripts** | repointed at the server's address via a value in Tampermonkey storage |

> ⚠️ **The archive has no authentication.** It serves write endpoints
> (`POST /api/v1/characters`, avatar and gallery upload) with
> `allowed_origins=["*"]`. That is the same posture as SillyTavern, and it is
> fine on a trusted LAN — but do not port-forward it, and do not expose it
> through a reverse proxy without putting auth in front.

---

## 1. Publish the image (once)

Merge to `main`. The `publish` workflow builds `linux/amd64` and pushes:

- `:latest` — what the server tracks
- `:sha-<short>` — the exact rollback target for that commit
- `:1.2.3` / `:1.2` — additionally, when you push a `v1.2.3` git tag

Then **make the package public, once**, so unraid can pull with no credentials:
GitHub → your profile → **Packages** → `jai-proxy` → **Package settings** →
*Danger Zone* → **Change visibility** → Public.

GHCR packages are private on first push and there is no workflow flag to change
that, which is why this step is here instead of in the workflow. The image holds
only server code and the vendored frontend — no cards, no galleries, no tokens.

Confirm from any machine, with no `docker login`:

```bash
docker pull ghcr.io/enchantedrobot/jai-proxy:latest
```

## 2. Seed the data mount

Everything the container writes lives under one directory. Copy the whole of the
Mac's `data/` into the share — it is roughly 10 GB, dominated by `galleries/`:

```
/mnt/user/appdata/jai-proxy/
├── characters/     # the archive: <Name>_<id8>.png
├── galleries/      # per-character image folders
├── cache/thumbs/   # avatar/ + gallery/ thumbnails (pure cache, regenerated on miss)
├── state/          # captures, lorebook cache, dead-URL ledger
├── _quarantine/    # never scanned or indexed, but it lives inside the mount
└── settings.json   # the browser UI's own settings, incl. Chub/DataCat tokens
```

`cache/thumbs/` is the one directory you *can* skip — it regenerates, at the cost
of a slow first paint over ~3,800 cards. Everything else should travel.

Then give it to the uid the container runs as:

```bash
chown -R 99:100 /mnt/user/appdata/jai-proxy
```

99:100 is unraid's `nobody:users`, which owns shares by default. If the mount is
wrong, the server prints one line naming the path, its owner and its own uid,
then exits — it does not die in a traceback
(`proxy/server.py::_preflight`). Check `docker logs jai-proxy` first when a
start fails.

## 3. Start the container

Two equivalent paths — use whichever is less annoying:

**Docker Compose Manager plugin** — copy `compose.prod.yaml` to the server. All
defaults already target unraid; override in a `.env` beside it if needed
(`JAI_PROXY_PORT`, `JAI_PROXY_DATA`, `PUID`/`PGID`, `JAI_PROXY_TAG`).

```bash
docker compose -f compose.prod.yaml pull
docker compose -f compose.prod.yaml up -d
```

**Native Add Container UI** — drop `unraid-template.xml` into
`/boot/config/plugins/dockerMan/templates-user/`, then Docker → Add Container →
`jai-proxy` under *User templates*.

Either way the container listens on 8000 internally. Only the **host** port is
adjustable — note that SillyTavern's stock port is also 8000, so if it is on the
same box one of the two has to move. Moving the archive's host port is fine now;
step 4 is where you tell the userscripts about it.

Verify: `http://<unraid-ip>:<port>/health` returns JSON, and the same URL in a
browser loads the archive with thumbnails.

## 4. Point the userscripts at it

Reinstall both bridges from `userscript/*.user.js` (v0.9.0 — the server URL is
no longer compiled in). Then, once, in the browser console on **janitorai.com**
and again on **saucepan.ai**:

```js
GM_setValue("serverUrl", "http://192.168.1.50:8000")   // your host:port
```

Reload. The connection pill should go green.

Two things worth knowing:

- **No TLS is needed**, even though JanitorAI is HTTPS. Every call to the server
  goes out through `GM_xmlhttpRequest`, which runs in the extension context and
  is exempt from the page's mixed-content and CSP rules. And JanitorAI's own
  chat request is intercepted in-page by `FetchHook`
  (`userscript/src_jai/bootstrap.js`) and answered locally — the browser never
  actually dials the endpoint at all.
- **JanitorAI's custom-provider URL must match `serverUrl`.** The `/models`
  probe is recognised with `url.startsWith(SERVER)`, so set the provider
  endpoint to `http://192.168.1.50:8000/v1/chat/completions` using the same
  host:port. A mismatch breaks the probe silently.

Clearing the stored value (`GM_setValue("serverUrl", "")`) falls back to
`http://127.0.0.1:8000`, i.e. a server running on the Mac.

## 5. Afterwards

The maintenance scripts (`make import` / `check` / `names` / `thumbs` /
`gallery-ids`) still run **on the Mac, against the Mac's `data/`** — which is now
a *different, diverging copy* from the live archive. They are deliberately not in
the image. Either run them before seeding, or point `JAI_PROXY_ARCHIVE_DIR` at
the mounted share when you run them.

To roll back a bad `:latest`, repin to a known commit:

```bash
JAI_PROXY_TAG=sha-abc1234 docker compose -f compose.prod.yaml up -d
```
