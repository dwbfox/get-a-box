// Bring-up tracking: a stage state machine driven by probing the guest, then verification
// of the final state against what the user selected.
import { el } from "./dom.js";
import { BOOT_MARKER, presetOf, kernelOf, parseSshIds, pinnedKernel } from "./cloudinit.js";

// Expected end state for a selection; stored on the instance so bring-up can resume after reload.
export function expectFor(sel, settings) {
  const base = { v: 1, release: sel.release, type: sel.type };
  if (settings.userDataMode === "replace" && (settings.userData || "").trim()) return { ...base, custom: true };
  const p = presetOf(sel);
  const k = kernelOf(sel);
  const pro = !!settings.proToken && !!(p.needsPro || k.pro || sel.services.length || settings.alwaysAttach);
  const kernelPkg = k.pkg ? k.pkg(sel.release) : null;
  const pin = pinnedKernel(sel);
  return {
    ...base,
    pro,
    services: pro ? [...new Set([...(p.enable || []), ...(k.pro ? [k.pro] : []), ...sel.services])] : [],
    fips: !!p.installsKernel,
    kernel: k.id === "default" ? null : {
      id: k.id, label: k.label, flavour: k.flavour, pkg: kernelPkg, ...(pin ? { version: pin.version, ts: pin.ts } : {}),
    },
    packages: [...(p.packages || []), ...(kernelPkg && !pin ? [kernelPkg] : [])],
    harden: p.runcmd ? p.runcmd.map((c) => c.join(" ")).join("; ") : null,
    reboot: !!(p.reboot || k.id !== "default"),
    rebootLabel: p.installsKernel ? "the FIPS kernel" : k.id !== "default" ? `the ${k.label} kernel${pin ? ` ${pin.version}` : ""}` : "apply hardening",
    ssh: parseSshIds(settings.sshIds).length > 0,
  };
}

export function planStages(e) {
  const s = [
    { id: "create", label: e.fromImage ? "Create instance from cached image" : "Create instance" },
    { id: "boot", label: e.type === "container" ? "Start container" : "Boot VM and start guest agent" },
    { id: "network", label: "Acquire an IPv4 address" },
  ];
  if (e.ssh) s.push({ id: "ssh", mod: "ssh_import_id", label: "Import SSH keys" });
  if (!e.fromImage) {
    if (e.pro) s.push({ id: "pro", mod: "ubuntu_pro", label: e.services.length ? `Attach Ubuntu Pro, enable ${e.services.join(", ")}` : "Attach Ubuntu Pro" });
    if (e.packages?.length) s.push({ id: "packages", mod: "package_update_upgrade_install", label: `Install ${e.packages.join(", ")}` });
    if (e.kernel?.version) s.push({ id: "kernel-pin", mod: "scripts_user", label: `Install ${e.kernel.pkg} ${e.kernel.version} from snapshot.ubuntu.com` });
    if (e.harden) s.push({ id: "harden", mod: "scripts_user", label: `Run ${e.harden}` });
  }
  s.push({ id: "firstboot", label: e.reboot ? "Finish first-boot setup" : "Finish cloud-init" });
  if (e.reboot) s.push({ id: "reboot", label: `Reboot into ${e.rebootLabel}` }, { id: "final", label: "Post-reboot cloud-init" });
  s.push({ id: "verify", label: "Verify final state matches selection" });
  if (e.bake) s.push({ id: "cache", label: "Snapshot pristine state for the image cache" });
  return s;
}

const MODS = ["ssh_import_id", "ubuntu_pro", "package_update_upgrade_install", "scripts_user", "power_state_change"];
const PROBE = [
  "L=/var/log/cloud-init.log",
  `echo "boots=$(cat ${BOOT_MARKER} 2>/dev/null | wc -l)"`,
  `echo "ci=$(cloud-init status 2>/dev/null | sed -n 's/^status: *//p')"`,
  `echo "kernel=$(uname -r)"`,
  `echo "ipv4=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | head -n1)"`,
  `echo "mod=$(grep -o 'Running module [a-z_]*' $L 2>/dev/null | tail -n1 | cut -d' ' -f3)"`,
  `for m in ${MODS.join(" ")}; do echo "done_$m=$(grep -o "finish: modules-[a-z]*/config-$m: [A-Z]*" $L 2>/dev/null | tail -n1 | awk '{print $NF}')"; done`,
  `echo "tail=$(tail -n 5 /var/log/cloud-init-output.log 2>/dev/null | tr -d '\\r' | grep -v '^[[:space:]]*$' | tail -n1 | cut -c1-200)"`,
].join("\n");

// Runs inside the guest with the expectation JSON as argv[1]; prints a JSON list of checks.
const VERIFY_PY = String.raw`
import glob, json, os, re, subprocess, sys
e = json.loads(sys.argv[1])
C = []
def add(i, ok, label, detail=""):
    C.append({"id": i, "ok": bool(ok), "label": label, "detail": str(detail)[:400]})
def sh(*a):
    try:
        return subprocess.run(a, capture_output=True, text=True, timeout=90).stdout
    except Exception:
        return ""
def jload(s):
    try:
        return json.loads(s or "{}")
    except Exception:
        return {}
def installed(p):
    return "install ok installed" in sh("dpkg-query", "-W", "-f", "$" + "{Status}", p)

# Kernel release (e.g. 5.15.0-94-generic) that an installed meta package resolves to.
def pinned_release(p):
    seen, todo = set(), [p]
    while todo:
        n = todo.pop()
        if n in seen:
            continue
        seen.add(n)
        m = re.match(r"linux-image-(?:unsigned-)?(\d.*)$", n)
        if m and installed(n):
            return m.group(1)
        for d in sh("dpkg-query", "-W", "-f", "$" + "{Depends}", n).split(","):
            name = d.strip().split(" ")[0]
            if name.startswith("linux-image"):
                todo.append(name)
    return ""

ci = jload(sh("cloud-init", "status", "--format", "json"))
errs = ci.get("errors") or []
rec = ci.get("recoverable_errors") or {}
nrec = sum(len(v) for v in rec.values()) if isinstance(rec, dict) else 0
detail = "; ".join(map(str, errs)) if errs else "status %s%s" % (ci.get("status", "unknown"), ", %d warning(s)" % nrec if nrec else "")
add("cloud-init", ci.get("status") == "done" and not errs, "cloud-init finished without errors", detail)

osr = {}
for line in open("/etc/os-release"):
    if "=" in line:
        k, v = line.strip().split("=", 1)
        osr[k] = v.strip('"')
add("release", osr.get("VERSION_ID") == e["release"], "Ubuntu " + e["release"], osr.get("PRETTY_NAME", ""))

ips = re.findall(r"inet (\S+)", sh("ip", "-4", "-o", "addr", "show", "scope", "global"))
route = sh("ip", "route", "show", "default").strip()
add("network", bool(ips) and bool(route), "IPv4 address and default route", ", ".join(ips) or "no IPv4 address")

if e.get("reboot"):
    m = e["marker"]
    n = len(open(m).read().split()) if os.path.exists(m) else 0
    add("reboot", n >= 2, "Rebooted after setup", "%d boot(s) recorded" % n)

rel = os.uname().release
if e.get("fips") and e.get("type") == "virtual-machine":
    f = "/proc/sys/crypto/fips_enabled"
    fe = open(f).read().strip() if os.path.exists(f) else "missing"
    add("fips-kernel", rel.endswith("-fips"), "Running a FIPS kernel", rel)
    add("fips-mode", fe == "1", "Kernel FIPS mode on (fips_enabled=1)", fe)

k = e.get("kernel")
if k:
    fl = k["flavour"]
    add("kernel", rel.endswith("-" + fl), "Running %s kernel (-%s)" % (k["label"], fl), rel)
    if k.get("version"):
        iv = sh("dpkg-query", "-W", "-f", "$" + "{Version}", k["pkg"]).strip()
        add("kernel-version", iv == k["version"], "%s %s installed" % (k["pkg"], k["version"]), iv or "not installed")
        want = pinned_release(k["pkg"])
        add("kernel-pinned", bool(want) and rel == want, "Booted the pinned kernel", "running %s, pinned %s" % (rel, want or "unknown"))
    else:
        vers = [p.split("vmlinuz-", 1)[1] for p in glob.glob("/boot/vmlinuz-*-" + fl)]
        newest = sh("linux-version", "sort", *vers).split()[-1] if vers else ""
        add("kernel-newest", rel == newest, "Booted the newest installed -%s kernel" % fl, "running %s, newest %s" % (rel, newest or "none"))

for p in e.get("packages") or []:
    add("pkg-" + p, installed(p), "Package %s installed" % p, "installed" if installed(p) else "not installed")

if e.get("harden") and not e.get("fromImage"):
    log = open("/var/log/cloud-init.log").read() if os.path.exists("/var/log/cloud-init.log") else ""
    rc = "/var/lib/cloud/instance/scripts/runcmd"
    script = open(rc).read() if os.path.exists(rc) else ""
    scheduled = all(w in script for w in e["harden"].replace(";", " ").split())
    ran = re.search(r"config-scripts_user: SUCCESS", log) is not None
    add("harden", scheduled and ran, "Ran " + e["harden"],
        "not in runcmd" if not scheduled else "scripts_user succeeded" if ran else "scripts_user did not succeed")

if e.get("pro"):
    ps = jload(sh("pro", "status", "--format", "json"))
    add("pro-attached", ps.get("attached") is True, "Ubuntu Pro attached", "attached" if ps.get("attached") else "not attached")
    svc = {s.get("name"): s.get("status") for s in ps.get("services", [])}
    for s in e.get("services") or []:
        add("pro-" + s, svc.get(s) == "enabled", "Pro service %s enabled" % s, svc.get(s) or "unknown")

if e.get("ssh"):
    ak = "/home/ubuntu/.ssh/authorized_keys"
    n = sum(1 for l in open(ak) if l.strip() and not l.startswith("#")) if os.path.exists(ak) else 0
    add("ssh", n > 0, "SSH keys imported for ubuntu", "%d key(s)" % n)

print(json.dumps(C))
`;

function parseKv(text) {
  const o = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) o[line.slice(0, i)] = line.slice(i + 1);
  }
  return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ICON = { pending: "\u00b7", active: "", done: "\u2713", fail: "\u2717", skip: "\u2013" };

export class Provisioner {
  constructor({ client, name, expect, summary, container, onReady, onShell, onStatus, postVerify }) {
    Object.assign(this, { client, name, expect, onReady, onShell, onStatus, postVerify });
    this.stages = planStages(expect);
    this.st = Object.fromEntries(this.stages.map((s) => [s.id, { status: "pending", detail: "" }]));
    this.t0 = Date.now();
    this.bar = el("div", { class: "prov-fill" });
    this.pct = el("span", { class: "prov-pct" });
    this.list = el("ol", { class: "prov-stages" });
    this.tail = el("pre", { class: "prov-tail" });
    this.checks = el("ul", { class: "prov-checks" });
    this.verdict = el("div", { class: "prov-verdict" });
    this.reverifyBtn = el("button", { class: "btn btn-sm", hidden: true, onclick: () => this.verify() }, "Re-verify");
    container.replaceChildren(
      el("div", { class: "prov-head" }, el("h3", {}, `Bringing up ${name}`), el("small", {}, summary || "")),
      el("div", { class: "prov-bar" }, this.bar), this.pct,
      this.list, this.tail, this.verdict, this.checks,
      el("div", { class: "prov-actions" },
        el("button", { class: "btn btn-sm btn-ghost", onclick: () => this.onShell() }, "Open shell now"),
        this.reverifyBtn));
    this.render();
    this.timer = setInterval(() => this.renderProgress(), 1000);
  }

  status(id) { return this.st[id]?.status; }

  set(id, status, detail) {
    const s = this.st[id];
    if (!s) return;
    if (s.status === status && (detail === undefined || s.detail === detail)) return;
    s.status = status;
    if (detail !== undefined) s.detail = detail;
    this.render();
  }

  render() {
    this.list.replaceChildren(...this.stages.map((s) => {
      const { status, detail } = this.st[s.id];
      return el("li", { class: `st-${status}` }, el("span", { class: "st-ico" }, ICON[status]),
        el("span", { class: "st-label" }, s.label), detail ? el("small", {}, detail) : null);
    }));
    const cur = this.stages.find((s) => this.st[s.id].status === "active");
    if (cur) this.onStatus?.(`provisioning: ${cur.label}`);
    this.renderProgress();
  }

  renderProgress() {
    const w = { done: 1, fail: 1, skip: 1, active: 0.5, pending: 0 };
    const total = this.stages.reduce((a, s) => a + w[this.st[s.id].status], 0);
    const pct = Math.round((100 * total) / this.stages.length);
    const secs = Math.floor((Date.now() - this.t0) / 1000);
    this.bar.style.width = `${pct}%`;
    this.pct.textContent = `${pct}% \u00b7 ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  }

  async probe() {
    try {
      const { stdout } = await this.client.execCapture(this.name, ["sh", "-c", PROBE], 60);
      return parseKv(stdout);
    } catch {
      return null;
    }
  }

  apply(p) {
    const e = this.expect;
    if (!p) {
      if (this.status("boot") !== "done") this.set("boot", "active", "waiting for the guest agent\u2026");
      else if (e.reboot && this.status("firstboot") === "done" && this.status("reboot") !== "done") this.set("reboot", "active", "guest is rebooting\u2026");
      return;
    }
    const boots = Number(p.boots) || 0;
    const ci = p.ci || "";
    this.set("boot", "done", `kernel ${p.kernel}`);
    this.bootAt ??= Date.now();
    if (p.ipv4) this.set("network", "done", p.ipv4);
    else if (Date.now() - this.bootAt > 180000) this.set("network", "fail", "no DHCP lease after 3 min; check the network's DHCP server");
    else this.set("network", "active", "waiting for DHCP\u2026");

    const firstDone = e.reboot ? (p.done_power_state_change === "SUCCESS" || boots >= 2) : (ci === "done" || ci === "error");
    for (const s of this.stages.filter((x) => x.mod)) {
      const r = p[`done_${s.mod}`];
      if (r === "SUCCESS") this.set(s.id, "done", "");
      else if (r === "FAIL") this.set(s.id, "fail", "cloud-init module failed");
      else if (p.mod === s.mod) this.set(s.id, "active", "");
      else if (firstDone) this.set(s.id, "skip", "no log entry");
    }
    if (firstDone) this.set("firstboot", !e.reboot && ci === "error" ? "fail" : "done", !e.reboot && ci === "error" ? "cloud-init reported errors" : "");
    else this.set("firstboot", "active", `cloud-init ${ci || "starting"}`);

    if (e.reboot) {
      if (boots >= 2) {
        this.set("reboot", "done", `now running ${p.kernel}`);
        if (ci === "done") this.set("final", "done", "");
        else if (ci === "error") this.set("final", "fail", "cloud-init reported errors");
        else this.set("final", "active", `cloud-init ${ci || "starting"}`);
      } else if (firstDone) {
        this.rebootWaitAt ??= Date.now();
        this.set("reboot", "active", "waiting for reboot\u2026");
      }
    }
    this.tail.textContent = p.tail || "";
  }

  settled(p) {
    if (!p) return false;
    const ci = p.ci;
    const done = ci === "done" || ci === "error";
    if (!this.expect.reboot) return done;
    if ((Number(p.boots) || 0) >= 2) return done;
    // Reboot was expected but never happened: stop waiting and let verification report it.
    if (this.rebootWaitAt && Date.now() - this.rebootWaitAt > 300000 && done) {
      this.set("reboot", "fail", "no reboot detected within 5 min");
      return true;
    }
    return false;
  }

  async run({ resumed = false } = {}) {
    if (resumed) this.set("create", "done", "already exists");
    const deadline = Date.now() + 60 * 60000;
    while (!this.stopped && Date.now() < deadline) {
      const p = await this.probe();
      if (this.stopped) return;
      this.apply(p);
      if (this.settled(p)) return this.verify();
      await sleep(p ? 4000 : 3000);
    }
    if (!this.stopped) {
      const cur = this.stages.find((s) => this.st[s.id].status === "active");
      if (cur) this.set(cur.id, "fail", "timed out after 60 min");
      this.finish(false, "Bring-up timed out.");
    }
  }

  async verify() {
    this.reverifyBtn.hidden = true;
    this.set("verify", "active", "running checks in the guest\u2026");
    this.checks.replaceChildren();
    let checks;
    try {
      const arg = JSON.stringify({ ...this.expect, marker: BOOT_MARKER });
      const { stdout } = await this.client.execCapture(this.name, ["python3", "-c", VERIFY_PY, arg], 240);
      checks = JSON.parse(stdout.trim().split("\n").pop());
    } catch (err) {
      this.set("verify", "fail", `could not run checks: ${err.message}`);
      return this.finish(false, "Verification could not run.");
    }
    const failed = checks.filter((c) => !c.ok);
    this.checks.replaceChildren(...checks.map((c) => el("li", { class: c.ok ? "ok" : "bad" },
      el("span", { class: "st-ico" }, c.ok ? "\u2713" : "\u2717"), el("span", {}, c.label), c.detail ? el("small", {}, c.detail) : null)));
    this.set("verify", failed.length ? "fail" : "done", `${checks.length - failed.length}/${checks.length} checks passed`);
    const verdict = failed.length ? `fail:${failed.map((c) => c.id).join(",")}` : "pass";
    this.client.setInstanceConfig(this.name, { "user.get-a-box.verified": verdict }).catch(() => {});
    // Runs once, before the shell attaches, so the snapshot captures the untouched machine.
    const post = this.postVerify;
    this.postVerify = null;
    if (post && !failed.length) {
      this.set("cache", "active", "taking snapshot…");
      try {
        this.set("cache", "done", await post());
      } catch (err) {
        this.set("cache", "fail", err.message);
      }
    } else if (this.st.cache?.status === "pending") {
      this.set("cache", "skip", failed.length ? "not cached: verification failed" : "");
    }
    this.finish(!failed.length, failed.length
      ? `${failed.length} check(s) don't match the selected configuration.`
      : "Machine matches the selected configuration.");
  }

  finish(ok, message) {
    clearInterval(this.timer);
    this.renderProgress();
    this.verdict.className = `prov-verdict ${ok ? "ok" : "bad"}`;
    this.verdict.textContent = message;
    this.reverifyBtn.hidden = false;
    this.onStatus?.(ok ? "verified \u2713" : "verify failed \u2717");
    if (ok) this.onReady?.();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }
}
