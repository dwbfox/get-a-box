import { LxdClient, fetchProxyRemotes } from "./lxd.js";
import { RELEASES, PRESETS, KERNELS, SERVICES, IMAGE_SERVER, presetOf, kernelOf, codenameOf, kernelPkg, pinnedKernel, presetReason, kernelReason, serviceReason, reconcile, launchBlockers, launchAdvice, buildUserData, redactUserData } from "./cloudinit.js";
import { TerminalSession } from "./terminal.js";
import { Provisioner, expectFor } from "./provision.js";
import { RECIPE, cacheInfo, peekCached, findCached, pruneCache, listCache, deleteImage, cloneUserData, snapshotForBake, bakeFromSnapshot } from "./cache.js";
import { el } from "./dom.js";

const $ = (s) => document.querySelector(s);
const STORE_KEY = "get-a-box.settings.v1";
const LAST_KEY = "get-a-box.last.v1";

const DEFAULTS = {
  mode: "proxy", remote: "", directUrl: "", project: "default",
  proToken: "", alwaysAttach: false, sshIds: "",
  userDataMode: "merge", userData: "",
  cpu: 2, memory: "2GiB", disk: "10GiB", pool: "", shellUser: "root", prefix: "gab",
  cacheEnabled: true, cacheTtlDays: 7,
};

const state = {
  settings: { ...DEFAULTS, ...load(STORE_KEY) },
  last: { release: "24.04", type: "container", preset: "plain", kernel: "default", services: [], ...load(LAST_KEY) },
  client: null,
  remotes: [],
  sessions: new Map(),   // tabId -> { session, tab, pane, instance }
  active: null,
  watch: new Map(),      // instance -> cloud-init status text
  baking: new Set(),     // instances whose snapshot is being turned into a cached image
};

function load(key) { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } }
function save(key, v) { localStorage.setItem(key, JSON.stringify(v)); }

function log(msg, level = "info") {
  const t = new Date().toLocaleTimeString();
  const line = el("div", { class: `log-${level}` }, el("span", { class: "log-t" }, t), " ", msg);
  const box = $("#log");
  box.append(line);
  while (box.childElementCount > 200) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}

/* ---------- connection ---------- */

function setPill(text, kind) {
  const p = $("#conn-pill");
  p.textContent = text;
  p.className = `pill pill-${kind}`;
}

async function connect() {
  const s = state.settings;
  setPill("connecting…", "warn");
  try {
    if (s.mode === "proxy") {
      const r = await fetchProxyRemotes();
      state.remotes = r.remotes;
      if (!s.remote || !r.remotes.some((x) => x.name === s.remote)) s.remote = r.default;
    }
    state.client = new LxdClient({ mode: s.mode, remote: s.remote, directUrl: s.directUrl, project: s.project });
    const info = (await state.client.server()).metadata;
    if (info.auth !== "trusted") {
      setPill(`untrusted by ${s.mode === "proxy" ? s.remote : "server"}`, "err");
      log("Connected but not trusted by LXD. Add your client certificate to the LXD trust store.", "err");
      return false;
    }
    const where = s.mode === "proxy" ? s.remote : new URL(s.directUrl).host;
    setPill(`${where} · LXD ${info.environment?.server_version || "?"}`, "ok");
    await loadProjects();
    await loadNetworks();
    await refreshBoxes();
    pruneCache(state.client, state.settings, state.baking, log).catch(() => {});
    return true;
  } catch (e) {
    state.client = null;
    setPill("not connected", "err");
    log(`Connection failed: ${e.message}`, "err");
    if (s.mode === "proxy" && e.message.startsWith("HTTP")) log("Is this page served by serve.py?", "err");
    return false;
  }
}

async function loadProjects() {
  const sel = $("#project-select");
  sel.replaceChildren();
  let names = [state.settings.project];
  try {
    names = (await state.client.projects()).map((u) => decodeURIComponent(u.split("/").pop()));
  } catch { /* restricted certs may not list projects */ }
  if (!names.includes(state.settings.project)) names.unshift(state.settings.project);
  for (const n of names) sel.append(el("option", { value: n, selected: n === state.settings.project }, n));
}

/* ---------- launch panel ---------- */

// Release and type are primary: always selectable; dependents fall back to defaults.
function choose(patch, primary = false) {
  Object.assign(state.last, patch);
  if (primary) {
    const changes = reconcile(state.last);
    if (changes.length) log(`Ubuntu ${state.last.release} ${state.last.type === "container" ? "container" : "VM"}: ${changes.join(", ")}`, "warn");
  }
  save(LAST_KEY, state.last);
  renderChoices();
}

function renderChoices() {
  const s = state.last;
  s.preset = presetOf(s).id;
  s.kernel = kernelOf(s).id;
  reconcile(s);

  $("#release-grid").replaceChildren(...RELEASES.map((r) => el("button", {
    class: `choice ${s.release === r.version ? "active" : ""}`, type: "button", title: `Ubuntu ${r.version} ${r.label}`,
    onclick: () => choose({ release: r.version }, true),
  }, el("b", {}, r.version, r.lts ? el("span", { class: "tag" }, "LTS") : null), el("small", {}, r.codename))));

  for (const b of document.querySelectorAll("#type-seg button")) b.classList.toggle("active", b.dataset.type === s.type);

  $("#preset-grid").replaceChildren(...PRESETS.map((p) => {
    const why = presetReason(p, s);
    return el("button", {
      class: `choice ${s.preset === p.id ? "active" : ""}`, type: "button", disabled: !!why, title: why || p.desc,
      onclick: () => choose({ preset: p.id }),
    }, el("b", {}, p.label), el("small", {}, p.desc));
  }));

  $("#kernel-grid").replaceChildren(...KERNELS.map((k) => {
    const why = kernelReason(k, s);
    return el("button", {
      class: `choice ${s.kernel === k.id ? "active" : ""}`, type: "button", disabled: !!why, title: why || k.desc,
      onclick: () => choose({ kernel: k.id }),
    }, el("b", {}, k.label), el("small", {}, k.desc));
  }));
  renderKernelVersions();

  $("#service-grid").replaceChildren(...SERVICES.map((svc) => {
    const on = s.services.includes(svc.id);
    const why = on ? null : serviceReason(svc, s);
    return el("button", {
      class: `choice ${on ? "active" : ""}`, type: "button", "aria-pressed": String(on), disabled: !!why, title: why || svc.desc,
      onclick: () => choose({ services: on ? s.services.filter((x) => x !== svc.id) : [...s.services, svc.id] }),
    }, el("b", {}, svc.label), el("small", {}, svc.desc));
  }));
  renderWarnings();
}

let launching = false;

/* ---------- kernel versions (snapshot.ubuntu.com) ---------- */

const kverLists = new Map(); // "series/pkg" -> Promise<versions[]>
let kverSeq = 0;

function fetchKernelVersions(series, pkg) {
  const key = `${series}/${pkg}`;
  if (!kverLists.has(key)) {
    const p = fetch(`/_gab/kernel-versions?${new URLSearchParams({ series, pkg })}`, { credentials: "same-origin" })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}${r.status === 404 ? " (needs serve.py)" : ""}`);
        return body.versions;
      });
    p.catch(() => kverLists.delete(key));
    kverLists.set(key, p);
  }
  return kverLists.get(key);
}

async function renderKernelVersions() {
  const s = state.last;
  const k = kernelOf(s);
  const row = $("#kver-row");
  const sel = $("#l-kver");
  const hint = $("#kver-hint");
  const seq = ++kverSeq;
  row.hidden = k.id === "default";
  if (row.hidden) return;
  const pkg = kernelPkg(s);
  if (!pkg) {
    sel.replaceChildren(el("option", {}, "Latest (Ubuntu Pro archive)"));
    sel.disabled = true;
    hint.textContent = `${k.label} comes from the Pro archive, which snapshot.ubuntu.com doesn't cover.`;
    return;
  }
  const pin = pinnedKernel(s);
  sel.disabled = true;
  sel.replaceChildren(el("option", { value: "" }, `Latest ${pkg} in the archive`),
    ...(pin ? [el("option", { value: "0", selected: true }, pin.version)] : []));
  hint.textContent = `Loading ${pkg} versions for ${codenameOf(s.release)}…`;
  let versions;
  try {
    versions = await fetchKernelVersions(codenameOf(s.release), pkg);
  } catch (e) {
    if (seq === kverSeq) { hint.textContent = `Version list unavailable: ${e.message}`; sel.disabled = !pin; }
    return;
  }
  if (seq !== kverSeq) return;
  sel.replaceChildren(
    el("option", { value: "", selected: !pin }, `Latest ${pkg} in the archive`),
    ...versions.map((v, i) => el("option", { value: String(i), selected: pin?.version === v.version },
      `${v.version}  · ${v.published} · ${v.pocket}${v.current ? " (current)" : ""}`)));
  sel.disabled = false;
  sel.onchange = () => {
    const v = versions[Number(sel.value)];
    choose({ kver: sel.value === "" || !v ? null : { release: s.release, pkg, version: v.version, ts: v.ts, pocket: v.pocket, published: v.published } });
  };
  hint.textContent = pin
    ? `Installed from snapshot.ubuntu.com/ubuntu/${pin.ts} (${pin.pocket}), held, and set as the GRUB default.`
    : `${versions.length} versions available from snapshot.ubuntu.com (published since March 2023).`;
}
function renderWarnings() {
  const blockers = launchBlockers(state.last, state.settings);
  const advice = [...launchAdvice(state.last), ...networkAdvice()];
  $("#launch-warnings").replaceChildren(
    ...blockers.map((m) => el("div", {}, "⚠ ", m)),
    ...advice.map((m) => el("div", { class: "advice" }, "ℹ ", m)));
  $("#launch-btn").disabled = launching || blockers.length > 0;
  refreshCacheHint();
}

/* ---------- image cache ---------- */

const ago = (t) => {
  const m = Math.round((Date.now() - Date.parse(t)) / 60000);
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const mb = (b) => `${Math.round(b / 1048576)} MB`;

let hintSeq = 0;
async function refreshCacheHint() {
  const seq = ++hintSeq;
  const hint = $("#cache-hint");
  const put = (text, cls = "") => { if (seq === hintSeq) { hint.textContent = text; hint.className = `cache-hint ${cls}`; } };
  $("#l-cache").checked = state.last.useCache !== false;
  if (!state.client) return put("");
  try {
    const info = await cacheInfo(state.last, state.settings, $("#l-extra").value);
    if (info.reason) return put(`Not cached: ${info.reason}.`);
    const r = await peekCached(state.client, info, state.last.type, state.settings);
    if (state.last.useCache === false) return put(r && !r.why ? "Cached image exists but is bypassed: fresh build, not cached." : "Fresh build, not cached.");
    if (r && !r.why) return put(`\u26a1 Cached image ready (built ${ago(r.img.created_at)}, ${mb(r.img.size)}): setup steps are skipped.`, "hit");
    put(r ? `Cached image is stale (${r.why}); it will be rebuilt after verification.` : "No cached image yet: this build will be cached after verification.");
  } catch {
    put("");
  }
}

async function startBake(name, snap, info, type, release, what) {
  const label = `Ubuntu ${release} ${type === "container" ? "container" : "VM"} \u00b7 ${what}`;
  const props = {
    "gab.recipe": RECIPE, "gab.key": info.key, "gab.token": info.tokenHash, "gab.summary": label,
    os: "Ubuntu", release, description: `get-a-box cache: ${label}`,
  };
  const status = (s) => { state.watch.set(name, s); updateBoxStatus(name); };
  state.baking.add(name);
  log(`${name}: building cached image ${info.alias} in the background`);
  try {
    await bakeFromSnapshot(state.client, {
      source: name, snap, info, type, props, settings: state.settings, onStep: (s) => status(`verified \u2713 \u00b7 caching: ${s}`),
    });
    status("verified \u2713 \u00b7 image cached");
    log(`Cached image ready (${label}); the next identical launch skips setup`, "ok");
  } catch (e) {
    status("verified \u2713 \u00b7 caching failed");
    log(`${name}: image caching failed: ${e.message}`, "err");
  } finally {
    state.baking.delete(name);
    refreshCacheHint();
  }
}

async function renderCacheList() {
  const ul = $("#s-cache-list");
  if (!state.client) return ul.replaceChildren(el("li", { class: "muted" }, "Not connected."));
  try {
    const imgs = await listCache(state.client);
    ul.replaceChildren(...(imgs.length ? imgs.map((i) => el("li", {},
      el("span", {}, i.properties?.["gab.summary"] || i.aliases[0].name),
      el("small", {}, ` ${ago(i.created_at)} \u00b7 ${mb(i.size)}`),
      el("button", {
        class: "btn btn-sm btn-ghost", type: "button",
        onclick: async () => { await deleteImage(state.client, i.fingerprint).catch((e) => log(e.message, "err")); renderCacheList(); refreshCacheHint(); },
      }, "Delete"))) : [el("li", { class: "muted" }, "No cached images on this remote/project.")]));
  } catch (e) {
    ul.replaceChildren(el("li", { class: "muted" }, `Could not list images: ${e.message}`));
  }
}

/* ---------- networks ---------- */

function netKey() { return `${state.settings.remote || state.settings.directUrl}/${state.settings.project}`; }
function chosenNetwork() { return (state.last.nets || {})[netKey()] || ""; }

function profileNics() {
  return Object.entries(state.profile?.devices || {}).filter(([, d]) => d.type === "nic");
}

async function loadNetworks() {
  state.profile = null;
  state.networks = [];
  try { state.profile = (await state.client.get("/1.0/profiles/default")).metadata; } catch { /* restricted */ }
  try {
    const all = (await state.client.get("/1.0/networks", { recursion: 1 })).metadata;
    state.networks = all.filter((n) => n.managed || n.type === "bridge")
      .filter((n) => !/^(docker\d*|cni\d*|virbr\d*|lo)$/.test(n.name));
  } catch { /* restricted */ }
  if (chosenNetwork() && !state.networks.some((n) => n.name === chosenNetwork())) setNetwork("");
  renderNetworks();
}

function setNetwork(name) {
  state.last.nets = { ...(state.last.nets || {}), [netKey()]: name };
  save(LAST_KEY, state.last);
}

function renderNetworks() {
  const sel = $("#l-net");
  const nics = profileNics().map(([k, d]) => `${d.name || k}: ${d.network || d.parent || "?"}`).join(", ");
  const cur = chosenNetwork();
  sel.replaceChildren(
    el("option", { value: "", selected: !cur }, `Profile default${nics ? ` (${nics})` : ""}`),
    ...state.networks.map((n) => el("option", { value: n.name, selected: n.name === cur },
      `${n.name}${n.managed ? "" : " (unmanaged)"}${n.config?.["ipv4.address"] ? ` · ${n.config["ipv4.address"]}` : ""}`)));
  renderWarnings();
}

// Unmanaged bridges get no DHCP from LXD; Pro attach and ssh-import-id need network access.
function networkAdvice() {
  const byName = Object.fromEntries((state.networks || []).map((n) => [n.name, n]));
  const cur = chosenNetwork();
  const primary = cur || (() => {
    const nics = profileNics();
    const eth0 = nics.find(([k, d]) => (d.name || k) === "eth0") || nics[0];
    return eth0 ? (eth0[1].network || eth0[1].parent) : "";
  })();
  const n = byName[primary];
  if (n && !n.managed) {
    return [`Primary NIC is on unmanaged bridge "${primary}": LXD won't provide DHCP. If nothing else does, Pro attach and ssh-import-id will fail — pick a managed network.`];
  }
  return [];
}

function nicDevices(name) {
  const net = state.networks.find((n) => n.name === name);
  const devices = {};
  // Disable profile NICs so they can't clash with (or shadow) the chosen network.
  for (const [k] of profileNics()) devices[k] = { type: "none" };
  devices.eth0 = net?.managed
    ? { type: "nic", name: "eth0", network: name }
    : { type: "nic", name: "eth0", nictype: "bridged", parent: name };
  return devices;
}

function fillLaunchDefaults() {
  $("#l-cpu").value = state.settings.cpu;
  $("#l-mem").value = state.settings.memory;
  $("#l-disk").value = state.settings.disk;
}

function makeName() {
  const custom = $("#l-name").value.trim().toLowerCase();
  if (custom) return custom;
  const prefix = (state.settings.prefix || "gab").toLowerCase().replace(/[^a-z0-9-]/g, "") || "gab";
  const rel = state.last.release.replace(".", "");
  const rnd = Math.random().toString(36).slice(2, 6);
  const k = state.last.kernel !== "default" ? `-${state.last.kernel}` : "";
  return `${prefix}-${rel}-${state.last.preset}${k}-${rnd}`.slice(0, 63);
}

function summary(sel) {
  const k = kernelOf(sel);
  const pin = pinnedKernel(sel);
  return [presetOf(sel).label, k.id !== "default" ? `${k.label} kernel${pin ? ` ${pin.version}` : ""}` : null, ...sel.services].filter(Boolean).join(", ");
}

function userData() {
  return buildUserData({ sel: state.last, settings: state.settings, extraYaml: $("#l-extra").value });
}

async function rootPool() {
  return state.settings.pool || state.profile?.devices?.root?.pool || "default";
}

async function launch() {
  if (!state.client && !(await connect())) return;
  const btn = $("#launch-btn");
  const sel = { ...state.last, services: [...state.last.services] };
  const { release, type } = sel;
  const what = summary(sel);
  const name = makeName();
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name) || name.endsWith("-")) {
    log(`Invalid instance name "${name}"`, "err");
    return;
  }
  let ud;
  try { ud = userData(); } catch (e) { log(e.message, "err"); return; }
  const blockers = launchBlockers(sel, state.settings);
  if (blockers.length) { blockers.forEach((m) => log(m, "err")); return; }

  const useCache = state.last.useCache !== false;
  let info = null;
  let cached = null;
  try {
    info = await cacheInfo(sel, state.settings, $("#l-extra").value);
    if (useCache && !info.reason) cached = await findCached(state.client, info, type, state.settings, log);
  } catch (e) {
    log(`Image cache lookup failed: ${e.message}`, "warn");
  }
  const bake = !!(useCache && info && !info.reason && !cached);
  const expect = {
    ...expectFor(sel, state.settings),
    // The image already carries the configuration; only per-instance cloud-init runs.
    ...(cached ? { fromImage: true, reboot: false } : {}),
    ...(bake ? { bake: true } : {}),
  };
  if (cached) ud = cloneUserData(state.settings);

  const config = {
    "user.get-a-box": "1",
    "user.get-a-box.preset": sel.preset,
    "user.get-a-box.kernel": sel.kernel,
    "user.get-a-box.kernel-version": pinnedKernel(sel)?.version || "",
    "user.get-a-box.services": sel.services.join(","),
    "user.get-a-box.summary": what,
    "user.get-a-box.expect": JSON.stringify(expect),
    "user.get-a-box.image": cached ? cached.fingerprint.slice(0, 12) : "",
  };
  const cpu = $("#l-cpu").value.trim();
  const mem = $("#l-mem").value.trim();
  const disk = $("#l-disk").value.trim();
  if (cpu) config["limits.cpu"] = cpu;
  if (mem) config["limits.memory"] = mem;
  if (ud) {
    config["cloud-init.user-data"] = ud;
    // 20.04 images render their seed from the legacy key only; newer ones warn if both are set.
    if (release === "20.04") config["user.user-data"] = ud;
  }

  const body = {
    name, type, start: true,
    description: `get-a-box: Ubuntu ${release} ${what}${cached ? " (cached image)" : ""}`,
    source: cached
      ? { type: "image", alias: info.alias }
      : { type: "image", protocol: "simplestreams", server: IMAGE_SERVER, alias: release },
    config,
  };
  // Root size only for VMs: container quotas depend on the storage driver.
  if (type === "virtual-machine" && disk) {
    body.devices = { root: { type: "disk", path: "/", pool: await rootPool(), size: disk } };
  } else if (state.settings.pool) {
    body.devices = { root: { type: "disk", path: "/", pool: state.settings.pool } };
  }
  if (chosenNetwork()) body.devices = { ...(body.devices || {}), ...nicDevices(chosenNetwork()) };

  launching = true;
  btn.disabled = true;
  btn.textContent = "Launching…";
  const box = openBox(name, {
    expect,
    summary: `Ubuntu ${release} ${type === "container" ? "container" : "VM"} \u00b7 ${what}${cached ? " \u00b7 from cached image" : ""}`,
    postVerify: bake ? async () => {
      const snap = await snapshotForBake(state.client, name);
      startBake(name, snap, info, type, release, what);
      return "snapshot taken; the image builds in the background";
    } : null,
  });
  try {
    log(`Creating ${type === "container" ? "container" : "VM"} ${name} (Ubuntu ${release}, ${what})${cached ? " from cached image" : ""}`);
    box.prov.set("create", "active", "requesting…");
    const res = await state.client.createInstance(body);
    let lastMsg = "";
    await state.client.waitOperationDone(res.operation, (op) => {
      const m = op.metadata || {};
      const prog = m.download_progress || m.create_instance_from_image_unpack_progress || m.progress?.stage;
      if (prog && prog !== lastMsg) { lastMsg = prog; box.prov.set("create", "active", String(prog)); }
    });
    box.prov.set("create", "done", "created and started");
    log(`${name} created and started`, "ok");
    refreshBoxes();
    box.prov.run();
    $("#l-name").value = "";
  } catch (e) {
    box.prov.set("create", "fail", e.message);
    box.prov.finish(false, "Launch failed.");
    log(`Launch failed: ${e.message}`, "err");
  } finally {
    launching = false;
    btn.textContent = "Launch & connect";
    renderWarnings();
  }
}

/* ---------- boxes list ---------- */

let refreshing = false;
async function refreshBoxes() {
  if (!state.client || refreshing) return;
  refreshing = true;
  try {
    const all = await state.client.instances();
    const showAll = $("#show-all").checked;
    const list = all.filter((i) => showAll || i.config?.["user.get-a-box"])
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    $("#box-list").replaceChildren(...(list.length ? list.map(boxRow) : [el("li", { class: "muted" }, "No boxes yet.")]));
  } catch (e) {
    log(`Listing instances failed: ${e.message}`, "err");
  } finally {
    refreshing = false;
  }
}

function ipv4(inst) {
  for (const [dev, n] of Object.entries(inst.state?.network || {})) {
    if (dev === "lo") continue;
    const a = n.addresses?.find((x) => x.family === "inet" && x.scope === "global");
    if (a) return a.address;
  }
  return "";
}

function boxRow(inst) {
  const running = inst.status === "Running";
  const rel = inst.config?.["image.version"] || inst.config?.["image.release"] || "";
  const preset = inst.config?.["user.get-a-box.preset"];
  const busy = (fn) => async (ev) => {
    const b = ev.currentTarget; b.disabled = true;
    try { await fn(); } catch (e) { log(`${inst.name}: ${e.message}`, "err"); }
    b.disabled = false; refreshBoxes();
  };
  return el("li", { class: "box", dataset: { name: inst.name } },
    el("div", { class: "box-main" },
      el("span", { class: `dot ${running ? "dot-on" : "dot-off"}`, title: inst.status }),
      el("b", { class: "box-name", title: inst.description || "" }, inst.name),
      el("span", { class: "tag" }, inst.type === "container" ? "CT" : "VM"),
      rel ? el("span", { class: "tag tag-rel" }, rel) : null,
      preset && preset !== "plain" ? el("span", { class: "tag tag-preset" }, preset) : null,
      (k => k && k !== "default" ? el("span", { class: "tag" }, `${k} kernel${inst.config?.["user.get-a-box.kernel-version"] ? ` ${inst.config["user.get-a-box.kernel-version"]}` : ""}`) : null)(inst.config?.["user.get-a-box.kernel"]),
      inst.config?.["user.get-a-box.image"] ? el("span", { class: "tag tag-cache", title: `image ${inst.config["user.get-a-box.image"]}` }, "from cache") : null,
      ...(inst.config?.["user.get-a-box.services"] || "").split(",").filter(Boolean)
        .map((s) => el("span", { class: "tag" }, s))),
    el("div", { class: "box-sub" },
      el("span", {}, ipv4(inst) || inst.status),
      el("span", { class: "ci" }, boxStatus(inst))),
    el("div", { class: "box-actions" },
      el("button", { class: "btn btn-sm", disabled: !running, onclick: () => openShellFor(inst) }, "Shell"),
      expectOf(inst) ? el("button", { class: "btn btn-sm btn-ghost", disabled: !running, onclick: () => openBox(inst.name, { expect: expectOf(inst), summary: inst.config?.["user.get-a-box.summary"], resumed: true }) }, "Verify") : null,
      running
        ? el("button", { class: "btn btn-sm btn-ghost", onclick: busy(() => state.client.setState(inst.name, "stop", true)) }, "Stop")
        : el("button", { class: "btn btn-sm btn-ghost", onclick: busy(() => state.client.setState(inst.name, "start")) }, "Start"),
      el("button", {
        class: "btn btn-sm btn-danger", onclick: busy(async () => {
          if (!confirm(`Delete ${inst.name}? This cannot be undone.`)) return;
          closeTabsFor(inst.name);
          if (running) await state.client.setState(inst.name, "stop", true);
          await state.client.deleteInstance(inst.name);
          log(`${inst.name} deleted`, "ok");
        }),
      }, "Delete")));
}

function expectOf(inst) {
  try { return JSON.parse(inst.config?.["user.get-a-box.expect"] || "null"); } catch { return null; }
}

function boxStatus(inst) {
  if (state.watch.has(inst.name)) return state.watch.get(inst.name);
  const v = inst.config?.["user.get-a-box.verified"];
  if (!v) return expectOf(inst) ? "not verified" : "";
  return v === "pass" ? "verified \u2713" : `verify failed \u2717 (${v.slice(5)})`;
}

// Unverified boxes resume their bring-up panel instead of dropping straight into a shell.
function openShellFor(inst) {
  const expect = expectOf(inst);
  if (expect && !inst.config?.["user.get-a-box.verified"]) {
    openBox(inst.name, { expect, summary: inst.config?.["user.get-a-box.summary"], resumed: true });
  } else {
    openBox(inst.name);
  }
}

function updateBoxStatus(name) {
  const li = [...document.querySelectorAll("#box-list li.box")].find((x) => x.dataset.name === name);
  const ci = li?.querySelector(".ci");
  if (ci) ci.textContent = state.watch.get(name) || "";
}

/* ---------- terminals ---------- */

let tabSeq = 0;
// A tab shows the bring-up panel (when `expect` is given) and attaches a shell once ready.
function openBox(instance, { expect, summary, resumed = false, postVerify = null } = {}) {
  if (expect) {
    for (const [id, s] of state.sessions) if (s.instance === instance && s.prov && !s.session) { activate(id); return s; }
  }
  $("#empty-state").hidden = true;
  const id = `t${++tabSeq}`;
  const provDiv = el("div", { class: "prov", hidden: !expect });
  const termDiv = el("div", { class: "term-host", hidden: !!expect });
  const pane = el("div", { class: "term-pane" }, provDiv, termDiv);
  $("#terms").append(pane);
  const tab = el("div", { class: "tab", onclick: () => activate(id) },
    el("span", {}, instance),
    el("button", { class: "tab-x", title: "Close", onclick: (e) => { e.stopPropagation(); closeTab(id); } }, "\u00d7"));
  $("#tabs").append(tab);
  const entry = { tab, pane, instance, provDiv, termDiv, session: null, prov: null };
  state.sessions.set(id, entry);
  if (expect) {
    const setStatus = (s) => { state.watch.set(instance, s); updateBoxStatus(instance); };
    entry.prov = new Provisioner({
      client: state.client, name: instance, expect, summary, container: provDiv, postVerify,
      onStatus: setStatus,
      onReady: () => { log(`${instance}: verified, opening shell`, "ok"); setTimeout(() => attachShell(id), 1200); },
      onShell: () => attachShell(id),
    });
    if (resumed) entry.prov.run({ resumed: true });
  } else {
    attachShell(id);
  }
  activate(id);
  return entry;
}

function attachShell(id) {
  const s = state.sessions.get(id);
  if (!s || s.session) return;
  s.provDiv.hidden = true;
  s.termDiv.hidden = false;
  s.session = new TerminalSession({
    client: state.client, instance: s.instance, container: s.termDiv, user: state.settings.shellUser || "root",
  });
  if (state.active === id) activate(id);
  s.session.connect().catch((e) => {
    s.session.term.write(`\r\n\x1b[31m[get-a-box] ${e.message} \u2014 press Enter to retry\x1b[0m\r\n`);
  });
}

function activate(id) {
  state.active = id;
  for (const [k, s] of state.sessions) {
    const on = k === id;
    s.tab.classList.toggle("active", on);
    s.pane.classList.toggle("active", on);
    if (on && s.session) requestAnimationFrame(() => { s.session.fit.fit(); s.session.term.focus(); });
  }
}

function closeTab(id) {
  const s = state.sessions.get(id);
  if (!s) return;
  s.prov?.stop();
  s.session?.dispose();
  s.tab.remove();
  s.pane.remove();
  state.sessions.delete(id);
  if (state.active === id) {
    const next = [...state.sessions.keys()].pop();
    if (next) activate(next); else $("#empty-state").hidden = false;
  }
}

function closeTabsFor(instance) {
  for (const [id, s] of state.sessions) if (s.instance === instance) closeTab(id);
}

/* ---------- settings dialog ---------- */

function showModeFields() {
  const mode = document.querySelector('input[name="mode"]:checked')?.value || "proxy";
  for (const d of document.querySelectorAll("[data-mode]")) d.hidden = d.dataset.mode !== mode;
}

async function openSettings() {
  const s = state.settings;
  document.querySelector(`input[name="mode"][value="${s.mode}"]`).checked = true;
  document.querySelector(`input[name="udmode"][value="${s.userDataMode}"]`).checked = true;
  $("#s-url").value = s.directUrl;
  $("#s-project").value = s.project;
  $("#s-pro").value = s.proToken;
  $("#s-always-attach").checked = s.alwaysAttach;
  $("#s-ssh").value = s.sshIds;
  $("#s-userdata").value = s.userData;
  $("#s-cpu").value = s.cpu;
  $("#s-mem").value = s.memory;
  $("#s-disk").value = s.disk;
  $("#s-pool").value = s.pool;
  $("#s-user").value = s.shellUser;
  $("#s-prefix").value = s.prefix;
  $("#s-cache").checked = s.cacheEnabled;
  $("#s-cache-ttl").value = s.cacheTtlDays;
  renderCacheList();
  $("#s-test-out").textContent = "";
  showModeFields();
  const sel = $("#s-remote");
  sel.replaceChildren();
  try {
    const r = await fetchProxyRemotes();
    for (const x of r.remotes) sel.append(el("option", { value: x.name, selected: x.name === s.remote }, `${x.name} (${x.addr})`));
  } catch {
    sel.append(el("option", { value: "" }, "serve.py not detected"));
  }
  $("#settings").showModal();
}

function readSettingsForm() {
  return {
    ...state.settings,
    mode: document.querySelector('input[name="mode"]:checked').value,
    userDataMode: document.querySelector('input[name="udmode"]:checked').value,
    remote: $("#s-remote").value,
    directUrl: $("#s-url").value.trim(),
    project: $("#s-project").value.trim() || "default",
    proToken: $("#s-pro").value.trim(),
    alwaysAttach: $("#s-always-attach").checked,
    sshIds: $("#s-ssh").value.trim(),
    userData: $("#s-userdata").value,
    cpu: $("#s-cpu").value.trim(),
    memory: $("#s-mem").value.trim(),
    disk: $("#s-disk").value.trim(),
    pool: $("#s-pool").value.trim(),
    shellUser: $("#s-user").value.trim() || "root",
    prefix: $("#s-prefix").value.trim() || "gab",
    cacheEnabled: $("#s-cache").checked,
    cacheTtlDays: Math.min(90, Math.max(1, Number($("#s-cache-ttl").value) || 7)),
  };
}

function formClient() {
  const f = readSettingsForm();
  return new LxdClient({ mode: f.mode, remote: f.remote, directUrl: f.directUrl, project: f.project });
}

/* ---------- wiring ---------- */

function init() {
  renderChoices();
  fillLaunchDefaults();

  for (const b of document.querySelectorAll("#type-seg button")) {
    b.addEventListener("click", () => choose({ type: b.dataset.type }, true));
  }
  $("#launch-btn").addEventListener("click", launch);
  $("#l-net").addEventListener("change", (e) => { setNetwork(e.target.value); renderWarnings(); });
  $("#l-cache").addEventListener("change", (e) => { state.last.useCache = e.target.checked; save(LAST_KEY, state.last); refreshCacheHint(); });
  $("#l-extra").addEventListener("change", refreshCacheHint);
  $("#s-cache-clear").addEventListener("click", async () => {
    if (!state.client || !confirm("Delete all cached images on this remote/project?")) return;
    for (const i of await listCache(state.client)) await deleteImage(state.client, i.fingerprint).catch(() => {});
    renderCacheList();
    refreshCacheHint();
  });
  $("#refresh-btn").addEventListener("click", refreshBoxes);
  $("#show-all").addEventListener("change", refreshBoxes);
  $("#l-preview").addEventListener("click", () => {
    const out = $("#l-preview-out");
    try { out.textContent = redactUserData(userData()) || "(no user-data)"; } catch (e) { out.textContent = e.message; }
    out.hidden = false;
  });
  $("#project-select").addEventListener("change", (e) => {
    state.settings.project = e.target.value;
    save(STORE_KEY, state.settings);
    connect();
  });

  $("#open-settings").addEventListener("click", openSettings);
  for (const r of document.querySelectorAll('input[name="mode"]')) r.addEventListener("change", showModeFields);
  $("#settings-form").addEventListener("submit", (e) => {
    if (e.submitter?.value !== "save") return;
    const next = readSettingsForm();
    if (next.mode === "direct" && !/^https:\/\//.test(next.directUrl)) {
      e.preventDefault();
      $("#s-test-out").textContent = "Direct mode needs an https:// API URL.";
      return;
    }
    state.settings = next;
    save(STORE_KEY, state.settings);
    fillLaunchDefaults();
    renderWarnings();
    connect();
  });
  $("#s-test").addEventListener("click", async () => {
    const out = $("#s-test-out");
    out.textContent = "testing…";
    try {
      const info = (await formClient().server()).metadata;
      out.textContent = `OK: LXD ${info.environment?.server_version || "?"}, auth=${info.auth}`;
    } catch (e) { out.textContent = `Failed: ${e.message}`; }
  });
  $("#s-trust-btn").addEventListener("click", async () => {
    const out = $("#s-test-out");
    try {
      await formClient().addTrustToken($("#s-trust").value);
      out.textContent = "Certificate trusted.";
      $("#s-trust").value = "";
    } catch (e) { out.textContent = `Trust failed: ${e.message}`; }
  });
  $("#s-reset").addEventListener("click", () => {
    if (!confirm("Forget all stored settings (including the Pro token) in this browser?")) return;
    localStorage.removeItem(STORE_KEY);
    localStorage.removeItem(LAST_KEY);
    location.reload();
  });

  setInterval(() => { if (!document.hidden) refreshBoxes(); }, 10000);
  connect();
}

init();
