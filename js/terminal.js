// xterm.js <-> LXD interactive exec websockets.

const enc = new TextEncoder();

function shellCommand(user) {
  const env = { TERM: "xterm-256color", LANG: "C.UTF-8", COLORTERM: "truecolor" };
  if (user === "root") {
    return { command: ["bash", "-l"], env: { ...env, HOME: "/root", USER: "root" }, cwd: "/root" };
  }
  // Fall back to root if the user doesn't exist yet (cloud-init still running).
  const script = `if id ${user} >/dev/null 2>&1; then exec su -l ${user}; else echo "[get-a-box] user '${user}' not ready yet, dropping to root"; exec bash -l; fi`;
  return { command: ["bash", "-c", script], env: { ...env, HOME: "/root", USER: "root" }, cwd: "/root" };
}

export class TerminalSession {
  constructor({ client, instance, container, user = "root", onExit }) {
    this.client = client;
    this.instance = instance;
    this.container = container;
    this.user = /^[a-z_][a-z0-9_-]*$/.test(user) ? user : "root";
    this.onExit = onExit;
    this.term = new window.Terminal({
      cursorBlink: true,
      fontFamily: '"Ubuntu Mono", "DejaVu Sans Mono", Menlo, monospace',
      fontSize: 14,
      scrollback: 5000,
      theme: { background: "#1d1d1d", foreground: "#e8e8e8", cursor: "#E95420" },
    });
    this.fit = new window.FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(container);
    this.fit.fit();
    this.term.onData((d) => this.send(enc.encode(d)));
    this.term.onBinary((d) => this.send(Uint8Array.from(d, (c) => c.charCodeAt(0))));
    this.term.onResize(({ cols, rows }) => this.resize(cols, rows));
    this.ro = new ResizeObserver(() => { try { this.fit.fit(); } catch { /* hidden tab */ } });
    this.ro.observe(container);
  }

  async connect() {
    if (this.connecting || this.disposed) return;
    this.connecting = true;
    this.closed = false;
    try {
      await this.open();
    } catch (e) {
      this.closed = true;
      throw e;
    } finally {
      this.connecting = false;
    }
  }

  async open() {
    this.closeSockets();
    const { cols, rows } = this.term;
    this.term.write(`\x1b[90m[get-a-box] connecting to ${this.instance} as ${this.user}…\x1b[0m\r\n`);
    const sh = shellCommand(this.user);
    const urls = await this.client.execInteractive(this.instance, {
      command: sh.command, env: sh.env, cwd: sh.cwd, width: cols, height: rows,
    });
    if (this.disposed) return;
    this.control = new WebSocket(urls.control);
    this.data = new WebSocket(urls.data);
    this.data.binaryType = "arraybuffer";
    this.data.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        if (ev.data.length === 0) return;  // LXD EOF barrier
        this.term.write(ev.data);
      } else {
        this.term.write(new Uint8Array(ev.data));
      }
    };
    this.data.onopen = () => { this.resize(this.term.cols, this.term.rows); this.term.focus(); };
    this.data.onclose = () => {
      this.term.write("\r\n\x1b[90m[get-a-box] session closed — press Enter to reconnect\x1b[0m\r\n");
      this.control?.close();
      this.closed = true;
      if (this.onExit) this.onExit();
    };
    this.data.onerror = () => this.term.write("\r\n\x1b[31m[get-a-box] websocket error\x1b[0m\r\n");
  }

  send(bytes) {
    if (this.closed) {
      if (bytes.length === 1 && bytes[0] === 13) this.connect().catch((e) => this.term.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`));
      return;
    }
    if (this.data?.readyState === WebSocket.OPEN) this.data.send(bytes);
  }

  resize(cols, rows) {
    if (this.control?.readyState === WebSocket.OPEN) {
      this.control.send(JSON.stringify({ command: "window-resize", args: { width: String(cols), height: String(rows) } }));
    }
  }

  closeSockets() {
    for (const ws of [this.data, this.control]) {
      if (ws) { ws.onclose = null; try { ws.close(); } catch { /* ignore */ } }
    }
    this.data = this.control = null;
  }

  dispose() {
    this.disposed = true;
    this.closeSockets();
    this.ro.disconnect();
    this.term.dispose();
  }
}
