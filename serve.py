#!/usr/bin/env python3
"""get-a-box local server: serves the static app and reverse-proxies LXD on the same origin.

LXD rejects cross-origin browser requests, so the app and the LXD API must share an origin.
Anyone who can reach this server gets root-equivalent access to the configured LXD remotes.
"""
import argparse
import ipaddress
import json
import os
import re
import select
import socket
import ssl
import sys
import threading
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.parse import parse_qs, unquote, urlencode, urlsplit

ROOT = os.path.dirname(os.path.realpath(__file__))
STATIC_DIRS = ("css", "js", "vendor")
STATIC_FILES = {"/": "index.html", "/index.html": "index.html", "/favicon.svg": "favicon.svg"}
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
}
SECURITY_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws: wss: https:; "
    "img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
    "frame-ancestors 'none'",
}
PROXY_RE = re.compile(r"^/_gab/r/([^/?#]+)/(1\.0.*)$")
SECRET_RE = re.compile(r"(secret=)[^&\s\"]*")
DROP_HEADERS = {"host", "origin", "referer", "cookie", "connection", "keep-alive",
                "upgrade", "transfer-encoding", "te", "trailer"}
SOCKET_CANDIDATES = ("/var/snap/lxd/common/lxd/unix.socket", "/var/lib/lxd/unix.socket")
CONNECT_TIMEOUT = 60
BUF = 65536

LP_API = "https://api.launchpad.net/1.0/"
SERIES_RE = re.compile(r"^[a-z]{3,20}$")
KPKG_RE = re.compile(r"^linux-[a-z0-9][a-z0-9.+-]{1,60}$")
# snapshot.ubuntu.com has no data before this.
SNAPSHOT_START = datetime(2023, 3, 1, 1, tzinfo=timezone.utc)
KV_TTL = 3600
_kv_cache = {}
_kv_lock = threading.Lock()


def _lp_time(s):
    return datetime.fromisoformat(s) if s else None


def _lp_page(url):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                return json.load(response)
        except HTTPError as error:
            error.close()
            if error.code not in (502, 503, 504) or attempt == 2:
                raise
            time.sleep(2 ** attempt)


def kernel_versions(series, pkg):
    """Versions of `pkg` ever published for `series` (amd64) with a snapshot.ubuntu.com timestamp
    at which each version was the one served by its pocket."""
    key = (series, pkg)
    with _kv_lock:
        hit = _kv_cache.get(key)
        if hit and time.time() - hit[0] < KV_TTL:
            return hit[1]
    url = LP_API + "ubuntu/+archive/primary?" + urlencode({
        "ws.op": "getPublishedBinaries", "binary_name": pkg, "exact_match": "true", "ws.size": "300",
        "distro_arch_series": LP_API + "ubuntu/%s/amd64" % series,
    })
    entries = []
    for _ in range(10):
        page = _lp_page(url)
        entries += page.get("entries", [])
        url = page.get("next_collection_link")
        if not url or not url.startswith(LP_API):
            break
    now = datetime.now(timezone.utc)
    best = {}
    for e in entries:
        if e.get("pocket") not in ("Release", "Updates", "Security"):
            continue
        pub = _lp_time(e.get("date_published"))
        if not pub:
            continue
        # A stable series' final Release publication stays Published; earlier ones were superseded.
        end = _lp_time(e.get("date_superseded")) or _lp_time(e.get("date_removed")) or now
        start = max(pub + timedelta(hours=1), SNAPSHOT_START)
        if start >= end:
            start = pub + (end - pub) / 2
            if start < SNAPSHOT_START or end - pub < timedelta(minutes=20):
                continue
        v = e["binary_package_version"]
        cand = {"version": v, "pocket": e["pocket"], "published": pub.strftime("%Y-%m-%d"),
                "ts": start.strftime("%Y%m%dT%H%M%SZ"), "current": e.get("status") == "Published"}
        old = best.get(v)
        if old is None or (cand["current"] and not old["current"]):
            best[v] = cand
    out = sorted(best.values(), key=lambda c: (c["published"], c["version"]), reverse=True)
    with _kv_lock:
        _kv_cache[key] = (time.time(), out)
    return out


# ---------------------------------------------------------------- config.yml

def _scalar(val):
    if len(val) >= 2 and val[0] == val[-1] and val[0] in "'\"":
        return val[1:-1]
    if val == "{}":
        return {}
    if val in ("true", "false"):
        return val == "true"
    return val


def parse_yaml_subset(text):
    """Parse the nested 'key: value' mappings used by lxc's config.yml (no lists)."""
    root = {}
    stack = [(-1, root)]
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#") or stripped.startswith("- "):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        key, sep, val = stripped.partition(":")
        if not sep:
            continue
        val = val.split(" #", 1)[0].strip()
        while indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]
        key = _scalar(key.strip())
        if val == "":
            child = {}
            parent[key] = child
            stack.append((indent, child))
        else:
            parent[key] = _scalar(val)
    return root


def find_conf_dir(cli_value):
    if cli_value:
        return os.path.expanduser(cli_value)
    if os.environ.get("LXD_CONF"):
        return os.environ["LXD_CONF"]
    snap = os.path.expanduser("~/snap/lxd/common/config")
    if os.path.isfile(os.path.join(snap, "config.yml")):
        return snap
    return os.path.expanduser("~/.config/lxc")


def find_socket():
    candidates = [os.environ.get("LXD_SOCKET")] + list(SOCKET_CANDIDATES)
    for path in candidates:
        if path and os.path.exists(path):
            return path
    return os.environ.get("LXD_SOCKET") or SOCKET_CANDIDATES[0]


class Remote:
    def __init__(self, name, addr, project, conf_dir, socket_path=None):
        self.name, self.addr, self.project = name, addr, project
        self.conf_dir, self.socket_path = conf_dir, socket_path
        if socket_path:
            self.host_header = "lxd"
        else:
            parts = urlsplit(addr)
            self.host, self.port = parts.hostname, parts.port or 8443
            self.host_header = parts.netloc

    def _ssl_context(self):
        pinned = os.path.join(self.conf_dir, "servercerts", self.name + ".crt")
        if os.path.isfile(pinned):
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_REQUIRED
            ctx.load_verify_locations(cafile=pinned)
            # LXD server certs are self-signed leaves, not CAs.
            ctx.verify_flags |= getattr(ssl, "VERIFY_X509_PARTIAL_CHAIN", 0)
        else:
            ctx = ssl.create_default_context()
        crt = os.path.join(self.conf_dir, "client.crt")
        key = os.path.join(self.conf_dir, "client.key")
        if os.path.isfile(crt) and os.path.isfile(key):
            ctx.load_cert_chain(crt, key)
        return ctx

    def connect(self):
        if self.socket_path:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                sock.settimeout(CONNECT_TIMEOUT)
                sock.connect(self.socket_path)
            except OSError:
                sock.close()
                raise
        else:
            ctx = self._ssl_context()
            raw = socket.create_connection((self.host, self.port), timeout=CONNECT_TIMEOUT)
            try:
                sock = ctx.wrap_socket(raw, server_hostname=self.host)
            except OSError:
                raw.close()
                raise
        sock.settimeout(None)
        return sock


def load_remotes(conf_dir):
    """Return (default_name, {name: Remote}) from the lxc client config."""
    config = {}
    try:
        with open(os.path.join(conf_dir, "config.yml"), encoding="utf-8") as f:
            config = parse_yaml_subset(f.read())
    except (OSError, ValueError, UnicodeDecodeError):
        pass
    remotes = {}
    entries = config.get("remotes")
    for name, entry in (entries.items() if isinstance(entries, dict) else ()):
        if not isinstance(entry, dict) or name == "local":
            continue
        addr = str(entry.get("addr", ""))
        if entry.get("protocol", "lxd") != "lxd" or not addr.startswith("https://"):
            continue
        project = entry.get("project") or "default"
        remotes[name] = Remote(name, addr, str(project), conf_dir)
    sock = find_socket()
    remotes["local"] = Remote("local", "unix://" + sock, "default", conf_dir, socket_path=sock)
    local_cfg = entries.get("local") if isinstance(entries, dict) else None
    if isinstance(local_cfg, dict) and local_cfg.get("project"):
        remotes["local"].project = str(local_cfg["project"])
    default = config.get("default-remote")
    return (default if default in remotes else "local"), remotes


# ------------------------------------------------------------------ plumbing

def _shutdown(sock, how):
    try:
        sock.shutdown(how)
    except OSError:
        pass


def redact(text):
    return SECRET_RE.sub(r"\1***", text)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "get-a-box"
    sys_version = ""

    def log_request(self, code="-", size="-"):
        self.log_message("%s %s -> %s", self.command, self.path, code)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), redact(fmt % args)))

    def _send(self, code, body, ctype, extra=None):
        if self.headers.get("Content-Length", "0").strip() not in ("", "0"):
            self.close_connection = True  # request body was not consumed
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in {**SECURITY_HEADERS, **(extra or {})}.items():
            self.send_header(k, v)
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self._send(code, body, "application/json", {"Cache-Control": "no-store"})

    def send_text(self, code, text):
        self._send(code, text.encode(), "text/plain; charset=utf-8")

    def _dispatch(self):
        path = urlsplit(self.path).path
        if not path.startswith("/_gab/"):
            return self.serve_static(path)
        err = self.check_request()
        if err:
            return self.send_json(403, {"error": err})
        if path == "/_gab/remotes":
            if self.command not in ("GET", "HEAD"):
                return self.send_json(405, {"error": "method not allowed"})
            return self.serve_remotes()
        if path == "/_gab/kernel-versions":
            if self.command not in ("GET", "HEAD"):
                return self.send_json(405, {"error": "method not allowed"})
            return self.serve_kernel_versions()
        m = PROXY_RE.match(self.path)
        if not m:
            return self.send_json(404, {"error": "not found"})
        name = unquote(m.group(1))
        remote = load_remotes(self.server.conf_dir)[1].get(name)
        if remote is None:
            return self.send_json(404, {"error": "unknown remote: %s" % name})
        return self.proxy(remote, "/" + m.group(2))

    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = _dispatch

    # -------------------------------------------------------------- static

    def resolve_static(self, path):
        try:
            path = unquote(path)
            if path in STATIC_FILES:
                base, rel = ROOT, STATIC_FILES[path]
            else:
                top, _, rel = path.lstrip("/").partition("/")
                if top not in STATIC_DIRS or not rel:
                    return None
                base = os.path.realpath(os.path.join(ROOT, top))
            full = os.path.realpath(os.path.join(base, rel))
            if full == base or os.path.commonpath([full, base]) != base:
                return None
            return full if os.path.isfile(full) else None
        except ValueError:  # e.g. embedded NUL bytes
            return None

    def serve_static(self, path):
        full = self.resolve_static(path) if self.command in ("GET", "HEAD") else None
        if full is None:
            return self.send_text(404, "Not found\n")
        try:
            with open(full, "rb") as f:
                body = f.read()
        except OSError:
            return self.send_text(404, "Not found\n")
        ctype = CONTENT_TYPES.get(os.path.splitext(full)[1].lower(), "application/octet-stream")
        self._send(200, body, ctype)

    # ------------------------------------------------------------- API

    def check_request(self):
        host = (self.headers.get("Host") or "").strip().lower()
        if host not in self.server.allowed_hosts:
            return "host not allowed: %s" % host
        origin = self.headers.get("Origin")
        if origin is not None and origin.strip().lower() != "http://" + host:
            return "cross-origin request rejected"
        site = self.headers.get("Sec-Fetch-Site")
        if site is not None and site.strip().lower() not in ("same-origin", "none"):
            return "cross-site request rejected"
        if self.command not in ("GET", "HEAD"):
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return "invalid Content-Length"
            ctype = (self.headers.get("Content-Type") or "").lower()
            if length > 0 and not ctype.startswith("application/json"):
                return "Content-Type must be application/json"
        return None

    def serve_remotes(self):
        default, remotes = load_remotes(self.server.conf_dir)
        items = [{"name": r.name, "addr": r.addr, "project": r.project}
                 for r in sorted(remotes.values(), key=lambda r: (r.name != "local", r.name))]
        self.send_json(200, {"default": default, "remotes": items})

    def serve_kernel_versions(self):
        q = parse_qs(urlsplit(self.path).query)
        series, pkg = (q.get("series") or [""])[0], (q.get("pkg") or [""])[0]
        if not SERIES_RE.match(series) or not KPKG_RE.match(pkg):
            return self.send_json(400, {"error": "invalid series or package"})
        try:
            versions = kernel_versions(series, pkg)
        except Exception as e:  # network/Launchpad errors are reported to the UI
            return self.send_json(502, {"error": "Launchpad lookup failed: %s" % e})
        self.send_json(200, {"series": series, "pkg": pkg, "versions": versions})

    def proxy(self, remote, upstream_path):
        if self.headers.get("Transfer-Encoding"):
            return self.send_json(411, {"error": "chunked request bodies are not supported"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length < 0:
                raise ValueError
        except ValueError:
            return self.send_json(400, {"error": "invalid Content-Length"})
        upgrade = "websocket" in (self.headers.get("Upgrade") or "").lower()

        lines = ["%s %s HTTP/1.1" % (self.command, upstream_path), "Host: " + remote.host_header]
        for k, v in self.headers.items():
            lk = k.lower()
            if lk in DROP_HEADERS or lk.startswith(("sec-fetch-", "proxy-")):
                continue
            lines.append("%s: %s" % (k, v.replace("\r", " ").replace("\n", " ")))
        lines += ["Connection: Upgrade", "Upgrade: websocket"] if upgrade else ["Connection: close"]
        head = ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1", "replace")

        self.close_connection = True
        try:
            upstream = remote.connect()
        except OSError as e:
            return self.send_json(502, {"error": "cannot connect to remote %r: %s" % (remote.name, e)})
        try:
            try:
                upstream.sendall(head)
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(BUF, remaining))
                    if not chunk:
                        raise ConnectionError("client closed during request body")
                    upstream.sendall(chunk)
                    remaining -= len(chunk)
            except OSError as e:
                return self.send_json(502, {"error": "upstream write failed: %s" % e})
            if upgrade:
                self._relay_websocket(upstream)
            elif not self._relay_response(upstream):
                self.send_json(502, {"error": "empty response from remote %r" % remote.name})
        finally:
            upstream.close()

    def _relay_response(self, upstream):
        """Stream upstream -> client until upstream closes. Returns True if anything was sent."""
        sent = False
        try:
            while True:
                data = upstream.recv(BUF)
                if not data:
                    break
                if not sent:
                    status = data.split(b"\r\n", 1)[0].split(b" ")
                    self.log_request(status[1].decode("latin-1") if len(status) > 1 else "?")
                    sent = True
                self.connection.sendall(data)
        except OSError:
            pass
        return sent

    def _relay_websocket(self, upstream):
        # Single thread: SSL objects must not be read and written concurrently.
        client = self.connection
        client.settimeout(None)
        upstream.settimeout(5)
        is_ssl = isinstance(upstream, ssl.SSLSocket)
        got_response = False
        try:
            while True:
                if is_ssl and upstream.pending():
                    readable = [upstream]
                else:
                    readable, _, _ = select.select([client, upstream], [], [])
                for src in readable:
                    try:
                        data = src.recv(BUF)
                    except socket.timeout:
                        continue
                    if not data:
                        return
                    if src is upstream:
                        if not got_response:
                            status = data.split(b"\r\n", 1)[0].split(b" ")
                            self.log_request(status[1].decode("latin-1") if len(status) > 1 else "?")
                            got_response = True
                        client.sendall(data)
                    else:
                        upstream.sendall(data)
        except OSError:
            pass
        finally:
            if not got_response:
                self.send_json(502, {"error": "empty response from remote"})
            _shutdown(client, socket.SHUT_RDWR)


class Server(ThreadingHTTPServer):
    daemon_threads = True


def is_loopback(host):
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def main():
    p = argparse.ArgumentParser(description="Serve get-a-box and proxy the LXD API on the same origin.")
    p.add_argument("--bind", default="127.0.0.1", help="address to bind (default 127.0.0.1)")
    p.add_argument("--port", type=int, default=8080, help="port (default 8080)")
    p.add_argument("--lxd-conf", help="lxc client config dir (default: $LXD_CONF, snap or ~/.config/lxc)")
    p.add_argument("--allow-host", action="append", default=[],
                   help="extra allowed Host header value (host or host:port); repeatable")
    args = p.parse_args()

    if ":" in args.bind:
        Server.address_family = socket.AF_INET6
    try:
        server = Server((args.bind, args.port), Handler)
    except OSError as e:
        sys.exit("error: cannot bind %s:%d: %s" % (args.bind, args.port, e))
    port = server.server_address[1]
    bind_host = "[%s]" % args.bind if ":" in args.bind else args.bind
    allowed = {"localhost:%d" % port, "127.0.0.1:%d" % port, "[::1]:%d" % port,
               "%s:%d" % (bind_host, port)}
    for h in args.allow_host:
        h = h.strip().lower()
        has_port = h.rsplit("]", 1)[-1].count(":") == 1
        allowed.add(h if has_port else "%s:%d" % (h, port))
    server.allowed_hosts = {h.lower() for h in allowed}
    server.conf_dir = find_conf_dir(args.lxd_conf)

    if not is_loopback(args.bind):
        bar = "!" * 72
        sys.stderr.write("%s\nWARNING: bound to non-loopback address %s.\n"
                         "Anyone who can reach this port gets ROOT-EQUIVALENT access to your LXD\n"
                         "remotes. Only do this on a trusted network.\n%s\n" % (bar, args.bind, bar))
    url_host = "localhost" if args.bind in ("0.0.0.0", "::", "") else bind_host
    default, remotes = load_remotes(server.conf_dir)
    print("lxc config: %s (remotes: %s)" % (server.conf_dir, ", ".join(sorted(remotes))))
    print("get-a-box: http://%s:%d/" % (url_host, port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
