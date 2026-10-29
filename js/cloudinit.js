// Release catalog, Pro presets, and cloud-config generation.

export const IMAGE_SERVER = "https://cloud-images.ubuntu.com/releases/";
export const BOOT_MARKER = "/var/lib/get-a-box.boots";

export const RELEASES = [
  { version: "20.04", codename: "focal", label: "Focal Fossa", lts: true },
  { version: "22.04", codename: "jammy", label: "Jammy Jellyfish", lts: true },
  { version: "24.04", codename: "noble", label: "Noble Numbat", lts: true },
  { version: "25.10", codename: "questing", label: "Questing Quokka", lts: false },
  { version: "26.04", codename: "resolute", label: "Resolute Raccoon", lts: true },
];

// vmOnly: needs its own kernel (FIPS) or would harden the host-shared kernel params.
// releases: where the preset is known to be supported (warn otherwise).
export const PRESETS = [
  { id: "plain", label: "Plain", desc: "Stock image, nothing extra", enable: [], needsPro: false },
  { id: "pro", label: "Pro attached", desc: "Attach Ubuntu Pro (default services)", enable: null, needsPro: true },
  {
    id: "fips-updates", label: "FIPS (updates)", desc: "fips-updates + reboot into FIPS kernel",
    enable: ["fips-updates"], needsPro: true, vmOnly: true, reboot: true, installsKernel: true,
    releases: ["20.04", "22.04", "24.04"],
  },
  {
    id: "fips", label: "FIPS (strict)", desc: "Certified fips modules + reboot",
    enable: ["fips"], needsPro: true, vmOnly: true, reboot: true, installsKernel: true,
    releases: ["20.04", "22.04"],
  },
  {
    id: "stig", label: "DISA STIG", desc: "usg fix disa_stig + reboot",
    enable: ["usg"], needsPro: true, vmOnly: true, reboot: true,
    packages: ["usg"], runcmd: [["usg", "fix", "disa_stig"]],
    releases: ["20.04", "22.04", "24.04"],
  },
  {
    id: "stig-fips", label: "STIG + FIPS", desc: "fips-updates, then usg fix disa_stig + reboot",
    enable: ["fips-updates", "usg"], needsPro: true, vmOnly: true, reboot: true, installsKernel: true,
    packages: ["usg"], runcmd: [["usg", "fix", "disa_stig"]],
    releases: ["20.04", "22.04", "24.04"],
  },
  {
    id: "cis", label: "CIS L1 server", desc: "usg fix cis_level1_server + reboot",
    enable: ["usg"], needsPro: true, vmOnly: true, reboot: true,
    packages: ["usg"], runcmd: [["usg", "fix", "cis_level1_server"]],
    releases: ["20.04", "22.04", "24.04"],
  },
];

const LTS = RELEASES.filter((r) => r.lts).map((r) => r.version);

// Kernels are installed by cloud-init and pinned via GRUB_FLAVOUR_ORDER, then the VM reboots.
export const KERNELS = [
  { id: "default", label: "Image default", desc: "As shipped (-kvm on VMs)" },
  { id: "generic", label: "Generic", desc: "linux-generic (GA)", pkg: () => "linux-generic", flavour: "generic" },
  { id: "hwe", label: "HWE", desc: "Hardware enablement", pkg: (r) => `linux-generic-hwe-${r}`, flavour: "generic", releases: ["20.04", "22.04", "24.04"] },
  { id: "lowlatency", label: "Low-latency", desc: "linux-lowlatency", pkg: () => "linux-lowlatency", flavour: "lowlatency" },
  { id: "oem", label: "OEM", desc: "linux-oem-<release>", pkg: (r) => `linux-oem-${r}`, flavour: "oem", releases: LTS },
  { id: "aws", label: "AWS", desc: "linux-aws", pkg: () => "linux-aws", flavour: "aws" },
  { id: "azure", label: "Azure", desc: "linux-azure", pkg: () => "linux-azure", flavour: "azure" },
  { id: "gcp", label: "GCP", desc: "linux-gcp", pkg: () => "linux-gcp", flavour: "gcp" },
  { id: "oracle", label: "Oracle", desc: "linux-oracle", pkg: () => "linux-oracle", flavour: "oracle" },
  { id: "ibm", label: "IBM", desc: "linux-ibm", pkg: () => "linux-ibm", flavour: "ibm" },
  { id: "realtime", label: "Real-time", desc: "Pro realtime-kernel", pro: "realtime-kernel", flavour: "realtime", releases: ["22.04", "24.04"] },
];

// Add-on Pro services that combine with any preset.
export const SERVICES = [
  { id: "esm-infra", label: "ESM Infra", desc: "Security updates for main" },
  { id: "esm-apps", label: "ESM Apps", desc: "Security updates for universe" },
  { id: "livepatch", label: "Livepatch", desc: "Kernel patches without reboot", needsKernel: true },
];

const byId = (list, id) => list.find((x) => x.id === id) || list[0];
export const presetOf = (sel) => byId(PRESETS, sel.preset);
export const kernelOf = (sel) => byId(KERNELS, sel.kernel);
export const codenameOf = (release) => RELEASES.find((r) => r.version === release)?.codename;

export function kernelPkg(sel) {
  const k = kernelOf(sel);
  return k.pkg ? k.pkg(sel.release) : null;
}

// sel.kver = { release, pkg, version, ts, ... } picked from snapshot.ubuntu.com; null means latest.
// Values end up in a shell script, so they are validated strictly.
export function pinnedKernel(sel) {
  const v = sel.kver;
  const pkg = kernelPkg(sel);
  if (!v || !pkg || v.pkg !== pkg || v.release !== sel.release) return null;
  if (!/^[0-9][A-Za-z0-9.+~:-]{0,60}$/.test(v.version) || !/^\d{8}T\d{6}Z$/.test(v.ts)) return null;
  return v;
}

// Installs an exact kernel meta version (and its exact-version linux-* deps) from an archive
// snapshot, holds it, and makes GRUB boot that kernel even if a newer one of the flavour exists.
function pinKernelScript(pin, series) {
  return String.raw`set -eu
F=/etc/default/grub.d/99-get-a-box-kernel.cfg
L=/etc/apt/sources.list.d/get-a-box-snapshot.list
trap 'rm -f $L' EXIT
# Bounded retries/timeouts so a stalled snapshot fetch can't hang cloud-init forever.
A="-o Acquire::Retries=5 -o Acquire::http::Timeout=60 -o Acquire::http::Pipeline-Depth=0"
S=https://snapshot.ubuntu.com/ubuntu/${pin.ts}
for p in ${series} ${series}-updates ${series}-security; do echo "deb $S $p main restricted universe multiverse"; done > $L
timeout 900 apt-get update -q $A
want="${pin.pkg}=${pin.version}"; todo="$want"
while [ -n "$todo" ]; do
  next=""
  for pv in $todo; do
    for d in $(apt-cache show "$pv" | sed -n 's/^Depends: //p' | head -n1 | tr ',' '\n' | sed -n -e 's/^ *\(linux-[^ ]*\) (= \([^)]*\)).*/\1=\2/p' -e 's/^ *\(linux-image-\(unsigned-\)\{0,1\}[0-9][^ =]*\)\( .*\)\{0,1\}$/\1/p'); do
      case " $want " in *" $d "*) ;; *) want="$want $d"; next="$next $d";; esac
    done
  done
  todo="$next"
done
echo "get-a-box: installing $want"
DEBIAN_FRONTEND=noninteractive timeout 1800 apt-get install -y -q --allow-downgrades $A $want
apt-mark hold ${pin.pkg}
rm -f $L
timeout 600 apt-get update -q $A || true
REL=$(echo "$want" | tr ' ' '\n' | cut -d= -f1 | grep -E '^linux-image-(unsigned-)?[0-9]' | head -n1 | sed -E 's/^linux-image-(unsigned-)?//')
# Cloud images boot initrd-less first; submenu entries lack that fallback, so force the initrd.
if [ -n "$REL" ]; then printf '%s\n' "GRUB_FORCE_PARTUUID=" "GRUB_DEFAULT=\"Advanced options for Ubuntu>Ubuntu, with Linux $REL\"" >> $F; update-grub; fi
`;
}

// Each *Reason returns why an option can't be used with the rest of `sel`, or null.
export function presetReason(p, sel) {
  if (p.vmOnly && sel.type === "container") return `${p.label} needs its own kernel; containers share the host kernel. Use a VM.`;
  if (p.releases && !p.releases.includes(sel.release)) return `${p.label} is only available on ${p.releases.join(", ")}.`;
  if (p.installsKernel && sel.kernel !== "default") return `${p.label} installs its own kernel; pick the Image default kernel.`;
  if (p.id === "fips" && sel.services.includes("livepatch")) return "FIPS (strict) can't be combined with Livepatch.";
  return null;
}

export function kernelReason(k, sel) {
  if (k.id === "default") return null;
  if (sel.type === "container") return "Containers share the host kernel. Use a VM.";
  if (k.releases && !k.releases.includes(sel.release)) return `${k.label} kernel is only available on ${k.releases.join(", ")}.`;
  const p = presetOf(sel);
  if (p.installsKernel) return `${p.label} installs its own kernel.`;
  if (k.id === "realtime" && sel.services.includes("livepatch")) return "Real-time kernel can't be combined with Livepatch.";
  return null;
}

export function serviceReason(s, sel) {
  if (!LTS.includes(sel.release)) return `${s.label} is only available on LTS releases.`;
  if (s.needsKernel && sel.type === "container") return `${s.label} patches the kernel; containers share the host kernel. Use a VM.`;
  if (s.id === "livepatch" && sel.preset === "fips") return "Livepatch can't be combined with FIPS (strict).";
  if (s.id === "livepatch" && sel.kernel === "realtime") return "Livepatch can't be combined with the Real-time kernel.";
  return null;
}

// After a release/type change, fall back to defaults for anything that no longer fits.
export function reconcile(sel) {
  const changes = [];
  const p = presetOf(sel);
  if (presetReason(p, sel)) { changes.push(`profile ${p.label} -> Plain`); sel.preset = "plain"; }
  const k = kernelOf(sel);
  if (kernelReason(k, sel)) { changes.push(`kernel ${k.label} -> Image default`); sel.kernel = "default"; }
  const kept = sel.services.filter((id) => SERVICES.some((s) => s.id === id && !serviceReason(s, sel)));
  for (const id of sel.services) if (!kept.includes(id)) changes.push(`dropped ${byId(SERVICES, id).label}`);
  sel.services = kept;
  return changes;
}

export function launchBlockers(sel, settings) {
  const p = presetOf(sel);
  const k = kernelOf(sel);
  const b = [presetReason(p, sel), kernelReason(k, sel),
    ...sel.services.map((id) => serviceReason(byId(SERVICES, id), sel))].filter(Boolean);
  if ((p.needsPro || k.pro || sel.services.length) && !settings.proToken) b.push("This selection needs an Ubuntu Pro token (Settings).");
  return b;
}

export function launchAdvice(sel) {
  const a = [];
  const p = presetOf(sel);
  const k = kernelOf(sel);
  // Stock VM images boot linux-kvm; neither it nor OEM is covered by Livepatch.
  if (sel.type === "virtual-machine" && sel.services.includes("livepatch")
      && ((k.id === "default" && !p.installsKernel && sel.release !== "26.04") || k.id === "oem")) {
    a.push(`Livepatch will enable, but it doesn't cover the ${k.id === "oem" ? "OEM" : "-kvm"} kernel.`);
  }
  return a;
}

export function parseSshIds(text) {
  return (text || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (/^(gh|lp):/.test(s) ? s : `gh:${s}`));
}

function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }

// Objects merge recursively, lists concatenate (deduped), scalars from `b` win.
export function deepMerge(a, b) {
  if (isObj(a) && isObj(b)) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (k === "__proto__") continue;
      out[k] = Object.hasOwn(a, k) ? deepMerge(a[k], v) : v;
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const seen = new Set(a.map((x) => JSON.stringify(x)));
    return [...a, ...b.filter((x) => !seen.has(JSON.stringify(x)))];
  }
  return b === undefined ? a : b;
}

export function parseCloudConfig(text, label) {
  const t = (text || "").trim();
  if (!t) return {};
  let v;
  try {
    v = window.jsyaml.load(t);
  } catch (e) {
    throw new Error(`${label}: invalid YAML (${e.reason || e.message})`);
  }
  if (v == null) return {};
  if (!isObj(v)) throw new Error(`${label}: must be a YAML mapping (cloud-config)`);
  return v;
}

export function buildUserData({ sel, settings, extraYaml }) {
  // Replace mode: settings override is used verbatim.
  if (settings.userDataMode === "replace" && (settings.userData || "").trim()) {
    const raw = settings.userData.trim();
    const hasHeader = /^(#cloud-config|#!|#include|#cloud-boothook|#part-handler|#cloud-config-archive|Content-Type:)/i.test(raw);
    return hasHeader ? raw + "\n" : `#cloud-config\n${raw}\n`;
  }

  const preset = presetOf(sel);
  const kernel = kernelOf(sel);
  const services = sel.services;
  const cfg = {};
  const ids = parseSshIds(settings.sshIds);
  if (ids.length) cfg.ssh_import_id = ids;

  const wantsPro = preset.needsPro || kernel.pro || services.length || (settings.alwaysAttach && settings.proToken);
  if (wantsPro && settings.proToken) {
    cfg.ubuntu_pro = { token: settings.proToken };
    // No enable list means pro's defaults; an explicit list enables only those.
    const enable = [...new Set([...(preset.enable || []), ...(kernel.pro ? [kernel.pro] : []), ...services])];
    if (enable.length) cfg.ubuntu_pro.enable = enable;
  }
  const pin = pinnedKernel(sel);
  const packages = [...(preset.packages || []), ...(kernel.pkg && !pin ? [kernel.pkg(sel.release)] : [])];
  if (packages.length) cfg.packages = packages;
  if (kernel.flavour) {
    cfg.write_files = [{ path: "/etc/default/grub.d/99-get-a-box-kernel.cfg", content: `GRUB_FLAVOUR_ORDER="${kernel.flavour}"\n` }];
  }
  const runcmd = [...(pin ? [["sh", "-c", pinKernelScript(pin, codenameOf(sel.release))]] : []), ...(preset.runcmd || []).map((c) => [...c])];
  if (runcmd.length) cfg.runcmd = runcmd;
  const kernelReboot = kernel.id !== "default";
  if (preset.reboot || kernelReboot) {
    const what = [preset.reboot ? preset.label : null, kernelReboot ? `${kernel.label} kernel` : null].filter(Boolean).join(" + ");
    cfg.bootcmd = [["sh", "-c", `date +%s >> ${BOOT_MARKER}`]];
    cfg.power_state = { mode: "reboot", message: `get-a-box: rebooting to apply ${what}`, condition: true };
  }

  let merged = deepMerge(cfg, parseCloudConfig(settings.userData, "Settings user-data override"));
  merged = deepMerge(merged, parseCloudConfig(extraYaml, "Per-launch cloud-config"));
  if (!Object.keys(merged).length) return "";
  return "#cloud-config\n" + window.jsyaml.dump(merged, { lineWidth: -1, noRefs: true });
}

export function redactUserData(text) {
  return text.replace(/(token:\s*)(\S+)/g, (_, k, v) => k + (v.length > 6 ? v.slice(0, 3) + "…" + v.slice(-2) : "…"));
}
