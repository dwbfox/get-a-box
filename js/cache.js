// Local LXD image cache of verified, sealed builds ("golden images"), keyed by configuration hash.
import { expectFor } from "./provision.js";
import { BOOT_MARKER, parseSshIds, pinnedKernel } from "./cloudinit.js";

// Bump when the generated user-data or seal procedure changes, invalidating all cached images.
export const RECIPE = "1";
export const CACHE_PREFIX = "gab-cache-";
const BAKE_SNAP = "gab-bake";
const LEFTOVER_AGE_MS = 2 * 3600 * 1000;

const SEAL = [
  "cloud-init status --wait >/dev/null 2>&1",
  "cloud-init clean --logs --machine-id --seed",
  `rm -f ${BOOT_MARKER} /etc/ssh/ssh_host_* /home/ubuntu/.ssh/authorized_keys /etc/netplan/50-cloud-init.yaml`,
  "apt-get clean",
  "sync",
].join("; ");

async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function tokenHash(token) {
  return token ? (await sha256hex(`gab:${token}`)).slice(0, 12) : "";
}

// Everything that changes the contents of the built image goes into the key; SSH keys and
// network choice don't (keys are stripped at seal time and re-imported per launch).
export async function cacheInfo(sel, settings, extraYaml) {
  const expect = expectFor(sel, settings);
  const th = expect.pro ? await tokenHash(settings.proToken) : "";
  const material = JSON.stringify({
    r: RECIPE, release: sel.release, type: sel.type, preset: sel.preset, kernel: sel.kernel,
    kver: pinnedKernel(sel)?.version || "",
    services: [...sel.services].sort(), token: th, attach: !!settings.alwaysAttach,
    udMode: settings.userDataMode, ud: settings.userData || "", extra: extraYaml || "",
  });
  const key = (await sha256hex(material)).slice(0, 20);
  let reason = null;
  if (!settings.cacheEnabled) reason = "image cache is off (Settings)";
  else if (sel.services.includes("livepatch")) reason = "Livepatch registers each machine, so it can't be cloned from an image";
  return { key, alias: CACHE_PREFIX + key, tokenHash: th, reason };
}

const ageMs = (img) => Date.now() - Date.parse(img.created_at);
export const ttlMs = (settings) => Math.max(1, Number(settings.cacheTtlDays) || 7) * 86400000;

export async function listCache(client) {
  const imgs = (await client.get("/1.0/images", { recursion: 1 })).metadata || [];
  return imgs.filter((i) => i.aliases?.some((a) => a.name.startsWith(CACHE_PREFIX)));
}

export async function deleteImage(client, fp) {
  const res = await client.del(`/1.0/images/${encodeURIComponent(fp)}`);
  return client.waitOperationDone(res.operation);
}

function staleReason(img, settings, currentTokenHash) {
  const p = img.properties || {};
  if (p["gab.recipe"] !== RECIPE) return "built by an older recipe";
  if (ageMs(img) > ttlMs(settings)) return `older than ${settings.cacheTtlDays || 7} day(s)`;
  if (p["gab.token"] && p["gab.token"] !== currentTokenHash) return "Pro token changed";
  return null;
}

// Look up the cached image for this configuration without side effects: { img, why } or null.
export async function peekCached(client, info, type, settings) {
  let fp;
  try {
    fp = (await client.get(`/1.0/images/aliases/${encodeURIComponent(info.alias)}`)).metadata.target;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
  const img = (await client.get(`/1.0/images/${encodeURIComponent(fp)}`)).metadata;
  return { img, why: img.type !== type ? "wrong instance type" : staleReason(img, settings, info.tokenHash) };
}

// Returns a usable cached image, deleting it if it has gone stale.
export async function findCached(client, info, type, settings, log) {
  const r = await peekCached(client, info, type, settings);
  if (!r) return null;
  if (r.why) {
    log?.(`Cached image ${info.alias} discarded: ${r.why}`, "warn");
    await deleteImage(client, r.img.fingerprint).catch(() => {});
    return null;
  }
  return r.img;
}

// Drop stale cache images and bake leftovers from interrupted sessions.
export async function pruneCache(client, settings, busy, log) {
  const th = await tokenHash(settings.proToken);
  let n = 0;
  for (const img of await listCache(client)) {
    const why = staleReason(img, settings, th);
    if (!why) continue;
    await deleteImage(client, img.fingerprint).then(() => { n++; }).catch(() => {});
    log?.(`Pruned cached image ${img.aliases[0].name} (${why})`, "warn");
  }
  const insts = await client.instances();
  for (const i of insts) {
    const old = (t) => Date.now() - Date.parse(t) > LEFTOVER_AGE_MS;
    if (i.name.startsWith("gab-bake-") && !busy.has(i.name) && old(i.created_at)) {
      await client.del(`/1.0/instances/${encodeURIComponent(i.name)}`).catch(async () => {
        await client.setState(i.name, "stop", true).catch(() => {});
        await client.deleteInstance(i.name).catch(() => {});
      });
    }
    for (const s of i.snapshots || []) {
      if (s.name.startsWith(BAKE_SNAP) && !busy.has(i.name) && old(s.created_at)) {
        await client.del(`/1.0/instances/${encodeURIComponent(i.name)}/snapshots/${encodeURIComponent(s.name)}`).catch(() => {});
      }
    }
  }
  return n;
}

export function cloneUserData(settings) {
  const ids = parseSshIds(settings.sshIds);
  return ids.length ? `#cloud-config\n${window.jsyaml.dump({ ssh_import_id: ids })}` : "";
}

export async function snapshotForBake(client, name) {
  const res = await client.post(`/1.0/instances/${encodeURIComponent(name)}/snapshots`, { name: BAKE_SNAP, stateful: false });
  await client.waitOperationDone(res.operation);
  return BAKE_SNAP;
}

// Waits for the VM agent; restarts the VM once halfway if it never answers (seen on a busy host).
async function waitAgent(client, name, onStep, timeoutMs = 600000) {
  const t0 = Date.now();
  let restarted = false;
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    try {
      const st = (await client.instanceState(name)).metadata;
      if (st.status === "Running" && st.processes > 0) {
        await client.execCapture(name, ["true"], 30);
        return;
      }
      last = `state ${st.status}, processes ${st.processes}`;
    } catch (e) {
      last = e.message;
    }
    if (!restarted && Date.now() - t0 > timeoutMs / 2) {
      restarted = true;
      onStep?.("guest agent slow, restarting temp copy");
      await client.setState(name, "restart", true).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`guest agent did not come up in ${Math.round(timeoutMs / 60000)} min (${last || "no response"})`);
}

// Copy the pristine snapshot into an offline temp instance, seal it, publish it as an image, clean up.
export async function bakeFromSnapshot(client, { source, snap, info, type, props, settings, onStep }) {
  const tmp = `gab-bake-${info.key.slice(0, 8)}-${Math.random().toString(36).slice(2, 6)}`;
  const inst = (await client.get(`/1.0/instances/${encodeURIComponent(source)}`)).metadata;
  const devices = {};
  for (const [k, d] of Object.entries(inst.expanded_devices || {})) if (d.type === "nic") devices[k] = { type: "none" };
  const empty = "#cloud-config\n{}\n";
  try {
    onStep("copying snapshot");
    let res = await client.post("/1.0/instances", {
      name: tmp, type, source: { type: "copy", source: `${source}/${snap}` },
      config: { "cloud-init.user-data": empty, "user.user-data": empty, "user.get-a-box": "", "user.get-a-box.expect": "" },
      devices,
    });
    await client.waitOperationDone(res.operation);
    onStep("sealing");
    await client.setState(tmp, "start");
    await waitAgent(client, tmp, onStep);
    const seal = await client.execCapture(tmp, ["sh", "-c", SEAL], 300);
    if (seal.rc !== 0) throw new Error(`seal failed (exit ${seal.rc})`);
    await client.setState(tmp, "stop").catch(() => client.setState(tmp, "stop", true));
    onStep("publishing image");
    res = await client.post("/1.0/images", {
      source: { type: "instance", name: tmp },
      aliases: [{ name: info.alias, description: props["gab.summary"] }],
      properties: props,
      expires_at: new Date(Date.now() + ttlMs(settings)).toISOString(),
      public: false,
    });
    await client.waitOperationDone(res.operation);
  } finally {
    await client.deleteInstance(tmp).catch(async () => {
      await client.setState(tmp, "stop", true).catch(() => {});
      await client.deleteInstance(tmp).catch(() => {});
    });
    await client.del(`/1.0/instances/${encodeURIComponent(source)}/snapshots/${encodeURIComponent(snap)}`).catch(() => {});
  }
}
