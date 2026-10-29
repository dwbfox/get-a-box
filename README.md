# get-a-box

A static browser app to quickly launch Ubuntu LXD containers and VMs, optionally with
Ubuntu Pro presets (FIPS, DISA STIG, CIS, real-time kernel), and drop straight into a
web terminal.

It is built for Ubuntu support engineers and troubleshooters who constantly need a
throwaway reproducer: "FIPS on 22.04", "DISA STIG on 24.04", "plain focal container"
— pick a release, pick a profile, click **Launch & connect**, get a shell.

## Features

- Release picker: 20.04, 22.04, 24.04, 25.10, 26.04 (images from
  `https://cloud-images.ubuntu.com/releases/` via simplestreams).
- Container or VM; Pro presets that need their own kernel switch the type to VM automatically.
- Ubuntu Pro presets generated as cloud-init `ubuntu_pro` config, with warnings for missing
  token, container vs VM, and releases where a preset is not known to be supported.
- SSH key import (`ssh-import-id`), CPU / memory / disk limits, storage pool, custom name.
- Settings-level cloud-config override (merge or replace) plus per-launch extra cloud-config,
  with a redacted user-data preview.
- Box list with status, IPv4, cloud-init progress, and Shell / Start / Stop / Delete actions
  (auto-refresh every 10 s).
- Tabbed xterm.js terminals over LXD exec websockets.
- LXD project switcher; multiple `lxc` remotes via `serve.py`.
- Activity log panel.

## Quick start

```sh
cd get-a-box
./serve.py
# open http://127.0.0.1:8080
```

`serve.py` reuses your existing `lxc` client configuration:

- Config dir: `--lxd-conf`, else `$LXD_CONF`, else the snap path `~/snap/lxd/common/config`
  (if it has a `config.yml`), else `~/.config/lxc`.
- Remotes come from `config.yml`; `client.crt` / `client.key` from that directory are used as
  the TLS client certificate, and `servercerts/<remote>.crt` pins the server certificate.
  Only `lxd`-protocol `https://` remotes are exposed (image servers are skipped). The config
  is re-read on every request, so newly added remotes show up without a restart.
- `local` talks to the LXD unix socket (`$LXD_SOCKET`, `/var/snap/lxd/common/lxd/unix.socket`
  or `/var/lib/lxd/unix.socket`). Your user needs access to it, e.g. membership of the `lxd`
  group.

To add a remote LXD server:

```sh
# on the server
lxc config trust add --name my-laptop      # prints a trust token
# on your machine
lxc remote add myserver <token>
```

Then pick the remote in **Settings**. Options:

```
./serve.py [--bind 127.0.0.1] [--port 8080] [--lxd-conf DIR] [--allow-host HOST[:PORT]]...
```

`--allow-host` adds accepted `Host` header values (e.g. when reaching it through an SSH tunnel
under a different name). Binding a non-loopback address prints a loud warning.

## Why `serve.py` exists

LXD protects its API against CSRF: LXD 5.21 checks `Sec-Fetch-Site`, and LXD 6.8+ uses Go's
`CrossOriginProtection`. A page loaded from another origin therefore cannot `POST`/`PUT`/`DELETE`
to the LXD API, even with a valid client certificate and CORS configured. The app and the API
must share an origin.

`serve.py` solves that with a tiny, **stateless** same-origin server:

- Serves the static files (`/`, `favicon.svg`, `css/`, `js/`, `vendor/`).
- Reverse-proxies `/_gab/r/<remote>/1.0/...` (including exec websockets) to the chosen remote,
  and lists remotes at `/_gab/remotes`.
- Python standard library only, no dependencies.
- Binds `127.0.0.1:8080` by default.
- Rejects API requests with an unexpected `Host`, a mismatched `Origin`, a cross-site
  `Sec-Fetch-Site`, or a non-JSON request body. Exec websocket secrets are redacted in its log.

Everything else — settings, Pro token, SSH IDs, user-data overrides, last-used choices — lives in
the browser's `localStorage`. `serve.py` stores nothing.

## Direct mode (browser mTLS)

Instead of the proxy, the browser can talk HTTPS to the LXD API itself, presenting a client
certificate.

**Caveat:** because of LXD's CSRF protection this only works when this page is served from the
**same origin** as the API URL (e.g. your own reverse proxy serving both the static files and
`/1.0`). From a different origin, reads may work but launching/stopping/deleting will be rejected.

1. Create a client certificate and a PKCS#12 bundle:

   ```sh
   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:secp384r1 -sha384 -nodes \
     -days 3650 -subj "/CN=get-a-box-browser" -keyout browser.key -out browser.crt
   openssl pkcs12 -export -inkey browser.key -in browser.crt -name get-a-box -out browser.p12
   ```

2. Import `browser.p12` into the browser:
   - Firefox: Settings → Privacy & Security → Certificates → View Certificates → Your
     Certificates → Import.
   - Chrome/Chromium: Settings → Privacy and security → Security → Manage certificates → Import
     (on Linux also: `pk12util -d sql:$HOME/.pki/nssdb -i browser.p12`).

   Visit `https://<server>:8443/1.0` once to accept LXD's self-signed server certificate and
   select the client certificate.

3. Trust it in LXD: either `lxc config trust add browser.crt`, or run
   `lxc config trust add --name browser` and paste the token into **Settings → Add trust**.

4. If the page origin differs from the API origin (read-only use), allow CORS:

   ```sh
   lxc config set core.https_allowed_origin https://<page-origin>
   lxc config set core.https_allowed_methods "GET, POST, PUT, DELETE, OPTIONS"
   lxc config set core.https_allowed_headers "Content-Type"
   lxc config set core.https_allowed_credentials true
   ```

5. In **Settings**, choose *Direct HTTPS*, enter the `https://` API URL and **Test connection**.

## Settings reference

| Setting | Description |
|---|---|
| LXD endpoint | *Via local serve.py* (pick a remote) or *Direct HTTPS* (API URL + optional trust token). |
| Project | LXD project (also switchable from the top bar). Default `default`. |
| Pro token | Ubuntu Pro token, used by Pro presets. |
| Attach Pro on every launch | Also attach Pro (default services) for non-Pro presets. |
| SSH IDs | Space/comma separated; bare names become `gh:`. Imported for the default `ubuntu` user. |
| User-data overrides | Cloud-config YAML; *Merge* into the generated config or *Replace* it entirely. |
| CPUs / Memory / Disk | Launch defaults (`2`, `2GiB`, `10GiB`); editable per launch. Disk size is applied to VMs only (container quotas depend on the storage driver). |
| Storage pool | Root disk pool; empty = pool of the `default` profile's root disk. |
| Shell user | User for terminals (default `root`). |
| Name prefix | Auto names are `<prefix>-<release>-<preset>-<random>` (default prefix `gab`). |
| Forget all settings | Clears everything stored in `localStorage`, including the Pro token. |

## Presets

| Preset | Pro services (`ubuntu_pro.enable`) | Extra steps | VM only | Reboot | Supported releases |
|---|---|---|---|---|---|
| Plain | — (no Pro) | — | no | no | all |
| Pro attached | default services | — | no | no | all |
| FIPS (updates) | `fips-updates` | — | yes | yes | 20.04, 22.04, 24.04 |
| FIPS (strict) | `fips` | — | yes | yes | 20.04, 22.04 |
| DISA STIG | `usg` | package `usg`, `usg fix disa_stig` | yes | yes | 20.04, 22.04, 24.04 |
| STIG + FIPS | `fips-updates`, `usg` | package `usg`, `usg fix disa_stig` | yes | yes | 20.04, 22.04, 24.04 |
| CIS L1 server | `usg` | package `usg`, `usg fix cis_level1_server` | yes | yes | 20.04, 22.04, 24.04 |
| Real-time kernel | `realtime-kernel` | — | yes | yes | 22.04, 24.04 |

Unsupported combinations are allowed but produce warnings.

## How user-data is built

1. A cloud-config is generated from settings and the preset:
   - `ssh_import_id` from SSH IDs;
   - `ubuntu_pro: {token, enable}` when the preset needs Pro (or "attach on every launch" is set)
     and a token is configured;
   - `packages` and `runcmd` from the preset;
   - `power_state: {mode: reboot}` for presets that need a reboot.
2. The **settings override** is merged in, then the **per-launch extra cloud-config** is merged
   last. Merge semantics: objects merge recursively, lists concatenate (deduplicated), scalars
   from the override win.
3. In **Replace** mode (with non-empty override), the override is used verbatim instead
   (`#cloud-config` header added if missing); the per-launch extra config is not applied.

The result is set as `cloud-init.user-data`. **Preview user-data** shows it with the token
redacted.

## Instances

Launched instances get `user.get-a-box=1` and `user.get-a-box.preset=<preset>` config keys.
The box list shows only those by default; tick **show all** to list every instance in the project.

After launch, the app waits for the instance (and, for VMs, the LXD agent), opens a terminal,
and runs `cloud-init status --wait` in the background, showing progress in the box list and
surviving the preset's reboot.

## Terminal

- Interactive `exec` over LXD websockets, rendered with xterm.js (resizes with the window).
- Runs `bash -l` as root, or `su -l <shell user>` when configured (falling back to root if that
  user does not exist yet, e.g. while cloud-init is still running).
- When a session closes (exit, reboot), press **Enter** to reconnect. Closed terminals of an
  instance reconnect automatically once cloud-init finishes after the post-setup reboot.

## Security notes

- The Pro token is stored in this browser's `localStorage`, and ends up in the instance's
  `cloud-init.user-data` config, readable by anyone with access to that LXD instance/project.
- `serve.py` grants **root-equivalent LXD access** to whoever can reach it. Keep it on loopback;
  for remote use, tunnel it instead of binding publicly:
  `ssh -L 8080:127.0.0.1:8080 host` (then open `http://127.0.0.1:8080`).
- Direct mode relies on a client certificate held by the browser; any page on the API's origin
  can use it.

## Vendored dependencies

| Library | Version | File |
|---|---|---|
| xterm.js | 5.5.0 | `vendor/xterm.js`, `vendor/xterm.css` |
| @xterm/addon-fit | 0.10.0 | `vendor/addon-fit.js` |
| js-yaml | 4.1.0 | `vendor/js-yaml.min.js` |

No build step, no CDN, no network access needed besides LXD and the image server.

## Files

```
get-a-box/
├── index.html        # UI markup
├── favicon.svg
├── serve.py          # static server + same-origin LXD proxy (stdlib only)
├── css/app.css
├── js/
│   ├── app.js        # UI, settings, launch flow, box list, tabs
│   ├── cloudinit.js  # releases, presets, cloud-config generation/merge
│   ├── lxd.js        # LXD REST client (proxy / direct transports)
│   └── terminal.js   # xterm.js <-> LXD exec websockets
└── vendor/           # xterm.js, addon-fit, js-yaml
```
