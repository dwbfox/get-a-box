// Minimal LXD REST client usable from the browser.
// Two transports:
//   proxy  -> same-origin via serve.py: /_gab/r/<remote>/1.0/...
//   direct -> https://host:8443/1.0/... (browser presents a TLS client cert)

export class LxdError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// LXD may return operation URLs with a ?project= suffix; drop it before appending sub-paths.
function opPathOnly(p) {
  const i = p.indexOf("?");
  return i < 0 ? p : p.slice(0, i);
}

export class LxdClient {
  constructor({ mode, remote, directUrl, project }) {
    this.mode = mode;
    this.project = project || "default";
    if (mode === "direct") {
      this.base = (directUrl || "").replace(/\/+$/, "");
    } else {
      this.base = `${location.origin}/_gab/r/${encodeURIComponent(remote || "local")}`;
    }
  }

  url(path, params = {}) {
    const u = new URL(this.base + path);
    if (this.project && !("project" in params)) u.searchParams.set("project", this.project);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
    return u.toString();
  }

  wsUrl(operationPath, secret) {
    const u = new URL(this.base + opPathOnly(operationPath) + "/websocket");
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.searchParams.set("secret", secret);
    if (this.project) u.searchParams.set("project", this.project);
    return u.toString();
  }

  async request(method, path, body, params) {
    const init = {
      method,
      headers: {},
      credentials: this.mode === "direct" ? "include" : "same-origin",
    };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(this.url(path, params), init);
    } catch (e) {
      throw new LxdError(`Network error talking to LXD (${e.message}). Check the endpoint, CORS/cert setup, or that serve.py is running.`, 0);
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new LxdError(`Unexpected non-JSON response (HTTP ${res.status})`, res.status);
    }
    if (!res.ok || data.type === "error") {
      throw new LxdError(data.error || `HTTP ${res.status}`, res.status);
    }
    return data;
  }

  get(path, params) { return this.request("GET", path, undefined, params); }
  post(path, body, params) { return this.request("POST", path, body ?? {}, params); }
  put(path, body, params) { return this.request("PUT", path, body, params); }
  patch(path, body, params) { return this.request("PATCH", path, body, params); }
  del(path, params) { return this.request("DELETE", path, undefined, params); }

  async getText(path) {
    const res = await fetch(this.url(path), { credentials: this.mode === "direct" ? "include" : "same-origin" });
    if (!res.ok) throw new LxdError(`HTTP ${res.status} fetching ${path}`, res.status);
    return res.text();
  }

  setInstanceConfig(name, config) { return this.patch(`/1.0/instances/${encodeURIComponent(name)}`, { config }); }

  // Run a command, wait for it, and return { rc, stdout }. Exec log files are removed afterwards.
  async execCapture(name, command, timeoutSec = 120) {
    const res = await this.post(`/1.0/instances/${encodeURIComponent(name)}/exec`, {
      command, interactive: false, "wait-for-websocket": false, "record-output": true,
    });
    const deadline = Date.now() + timeoutSec * 1000;
    let op;
    do {
      op = await this.waitOperation(res.operation, 15);
    } while (op.status_code !== 200 && Date.now() < deadline);
    if (op.status_code !== 200) throw new LxdError("Timed out waiting for command", 0);
    const out = op.metadata?.output || {};
    let stdout = "";
    try { if (out["1"]) stdout = await this.getText(out["1"]); } finally {
      for (const p of Object.values(out)) this.del(p).catch(() => {});
    }
    return { rc: op.metadata?.return, stdout };
  }

  // Operation path as returned by LXD ("/1.0/operations/<id>").
  async waitOperation(opPath, timeoutSec = 30) {
    let res;
    try {
      res = await this.get(`${opPathOnly(opPath)}/wait`, { timeout: timeoutSec });
    } catch (e) {
      // Some LXD versions error out (504) instead of returning the still-running op.
      if (e instanceof LxdError && (e.status === 504 || /timeout|deadline/i.test(e.message))) return { status_code: 103 };
      throw e;
    }
    const op = res.metadata;
    if (op.status_code >= 400) throw new LxdError(op.err || op.status, op.status_code);
    return op;
  }

  async waitOperationDone(opPath, onTick) {
    for (;;) {
      const op = await this.waitOperation(opPath, 15);
      if (op.status_code === 200) return op;
      if (onTick) onTick(op);
    }
  }

  server() { return this.get("/1.0"); }
  async projects() { return (await this.get("/1.0/projects", { recursion: 0, project: null })).metadata; }
  async instances() { return (await this.get("/1.0/instances", { recursion: 2 })).metadata; }
  instanceState(name) { return this.get(`/1.0/instances/${encodeURIComponent(name)}/state`); }

  createInstance(body) { return this.post("/1.0/instances", body); }

  async setState(name, action, force = false) {
    const res = await this.put(`/1.0/instances/${encodeURIComponent(name)}/state`, { action, timeout: 30, force });
    return this.waitOperationDone(res.operation);
  }

  async deleteInstance(name) {
    const res = await this.del(`/1.0/instances/${encodeURIComponent(name)}`);
    return this.waitOperationDone(res.operation);
  }

  addTrustToken(token) { return this.post("/1.0/certificates", { trust_token: token.trim() }, { project: null }); }

  // Run a non-interactive command and return its exit code.
  async execWait(name, command, timeoutSec = 600) {
    const res = await this.post(`/1.0/instances/${encodeURIComponent(name)}/exec`, {
      command, interactive: false, "wait-for-websocket": false, "record-output": false,
    });
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      const op = await this.waitOperation(res.operation, 15);
      if (op.status_code === 200) return op.metadata?.return;
    }
    throw new LxdError("Timed out waiting for command", 0);
  }

  // Start an interactive exec session; returns websocket URLs.
  async execInteractive(name, { command, env, user, group, cwd, width, height }) {
    const body = {
      command,
      environment: env,
      interactive: true,
      "wait-for-websocket": true,
      width, height,
    };
    if (user !== undefined) body.user = user;
    if (group !== undefined) body.group = group;
    if (cwd) body.cwd = cwd;
    const res = await this.post(`/1.0/instances/${encodeURIComponent(name)}/exec`, body);
    const fds = res.metadata.metadata.fds;
    return {
      operation: res.operation,
      data: this.wsUrl(res.operation, fds["0"]),
      control: this.wsUrl(res.operation, fds.control),
    };
  }
}

export async function fetchProxyRemotes() {
  const res = await fetch("/_gab/remotes", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
