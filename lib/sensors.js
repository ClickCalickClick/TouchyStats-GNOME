import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

/**
 * Raw readers for /proc and /sys. Everything here is synchronous and cheap
 * (procfs/sysfs reads never block on disk), and every reader tolerates the
 * file being missing — hardware differs, and hotplug happens.
 */

const decoder = new TextDecoder();

export function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes) : null;
    } catch {
        return null;
    }
}

export function readNum(path) {
    const t = readText(path);
    if (t === null) return NaN;
    const s = t.trim();
    return s === '' ? NaN : Number(s);
}

export function exists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

/** Directory entry names (not paths); [] when the directory is missing. */
export function listDir(path) {
    const out = [];
    try {
        const en = Gio.File.new_for_path(path).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null)) !== null) out.push(info.get_name());
        en.close(null);
    } catch {
        // missing or unreadable: nothing to report
    }
    return out;
}

// ---- CPU -------------------------------------------------------------------

/** /proc/stat → [{busy, total}] with index 0 = aggregate, 1.. = per thread. */
export function readCpuTimes() {
    const text = readText('/proc/stat');
    const out = [];
    if (!text) return out;
    for (const line of text.split('\n')) {
        if (!line.startsWith('cpu')) break;
        const f = line.split(/\s+/).slice(1).map(Number);
        // user nice system idle iowait irq softirq steal (guest is inside user)
        const idle = f[3] + (f[4] || 0);
        const total = f.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
        out.push({busy: total - idle, total});
    }
    return out;
}

export function cpuModel() {
    const text = readText('/proc/cpuinfo') ?? '';
    const m = text.match(/^model name\s*:\s*(.+)$/m);
    return m ? m[1].trim() : 'CPU';
}

/** "AMD Ryzen 7 8840U w/ Radeon 780M Graphics" → {cpu: "Ryzen 7 8840U", igpu: "Radeon 780M"} */
export function splitModel(model) {
    let cpu = model, igpu = null;
    const w = model.match(/^(.*?)\s+w\/\s+(.*?)(?:\s+Graphics)?$/);
    if (w) {
        cpu = w[1];
        igpu = w[2];
    }
    cpu = cpu.replace(/^(AMD|Intel\(R\) Core\(TM\)|Intel)\s+/i, '').replace(/\s+\d+-Core Processor$/i, '').replace(/\s+CPU\s+@.*$/i, '').trim();
    return {cpu, igpu};
}

export function loadAvg() {
    const t = readText('/proc/loadavg');
    if (!t) return [NaN, NaN, NaN];
    return t.split(' ').slice(0, 3).map(Number);
}

export function uptimeSeconds() {
    const t = readText('/proc/uptime');
    return t ? Number(t.split(' ')[0]) : NaN;
}

// ---- memory ----------------------------------------------------------------

/** /proc/meminfo in bytes. */
export function readMeminfo() {
    const text = readText('/proc/meminfo') ?? '';
    const m = {};
    for (const line of text.split('\n')) {
        const r = line.match(/^(\w+(?:\(\w+\))?):\s+(\d+)/);
        if (r) m[r[1]] = Number(r[2]) * 1024;
    }
    return m;
}

/** zram devices: {orig, compr, used} bytes summed over /sys/block/zram*. */
export function readZram() {
    let orig = 0, compr = 0, used = 0, found = false;
    for (const name of listDir('/sys/block')) {
        if (!name.startsWith('zram')) continue;
        const t = readText(`/sys/block/${name}/mm_stat`);
        if (!t) continue;
        const f = t.trim().split(/\s+/).map(Number);
        orig += f[0];
        compr += f[1];
        used += f[2];
        found = true;
    }
    return found ? {orig, compr, used} : null;
}

// ---- GPU -------------------------------------------------------------------

/**
 * amdgpu exposes a ready-made utilization percentage; other drivers don't
 * (i915/xe need perf counters, nvidia needs NVML), so the GPU card simply
 * hides when no card offers gpu_busy_percent.
 */
export function discoverGpu() {
    for (const name of listDir('/sys/class/drm').sort()) {
        if (!/^card\d+$/.test(name)) continue;
        const dev = `/sys/class/drm/${name}/device`;
        if (!exists(`${dev}/gpu_busy_percent`)) continue;
        const hwmons = listDir(`${dev}/hwmon`);
        const hwmon = hwmons.length ? `${dev}/hwmon/${hwmons[0]}` : null;
        return {dev, hwmon, integrated: readNum(`${dev}/mem_info_vram_total`) <= 4 * 2 ** 30 || exists(`${dev}/../../../ACPI0010:00`)};
    }
    return null;
}

export function readGpu(g) {
    const hw = g.hwmon;
    const power = hw ? (readNum(`${hw}/power1_average`) || readNum(`${hw}/power1_input`)) : NaN;
    return {
        busy: readNum(`${g.dev}/gpu_busy_percent`),
        vramUsed: readNum(`${g.dev}/mem_info_vram_used`),
        vramTotal: readNum(`${g.dev}/mem_info_vram_total`),
        gttUsed: readNum(`${g.dev}/mem_info_gtt_used`),
        gttTotal: readNum(`${g.dev}/mem_info_gtt_total`),
        freqMHz: hw ? readNum(`${hw}/freq1_input`) / 1e6 : NaN,
        temp: hw ? readNum(`${hw}/temp1_input`) / 1000 : NaN,
        powerW: power / 1e6,
    };
}

export function gpuBusy(g) {
    return readNum(`${g.dev}/gpu_busy_percent`);
}

// ---- power supplies --------------------------------------------------------

function uevent(path) {
    const text = readText(`${path}/uevent`) ?? '';
    const u = {};
    for (const line of text.split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) u[line.slice(0, i).replace(/^POWER_SUPPLY_/, '')] = line.slice(i + 1);
    }
    return u;
}

/** {system: [paths], mains: [paths], peripheral: [paths]} */
export function discoverPowerSupplies() {
    const out = {system: [], mains: [], peripheral: []};
    const base = '/sys/class/power_supply';
    for (const name of listDir(base).sort()) {
        const p = `${base}/${name}`;
        const u = uevent(p);
        if (u.TYPE === 'Mains' || u.TYPE === 'USB' && u.ONLINE !== undefined && u.SCOPE !== 'Device') out.mains.push(p);
        else if (u.TYPE === 'Battery' && u.SCOPE === 'Device') out.peripheral.push(p);
        else if (u.TYPE === 'Battery') out.system.push(p);
    }
    return out;
}

/** One system battery, normalized to Wh / W / V. */
export function readBattery(path) {
    const u = uevent(path);
    const n = k => (u[k] === undefined ? NaN : Number(u[k]));
    const volt = n('VOLTAGE_NOW') / 1e6;
    const voltDesign = (n('VOLTAGE_MIN_DESIGN') || n('VOLTAGE_NOW')) / 1e6;
    let now, full, design, power;
    if (u.ENERGY_NOW !== undefined) {
        now = n('ENERGY_NOW') / 1e6;
        full = n('ENERGY_FULL') / 1e6;
        design = n('ENERGY_FULL_DESIGN') / 1e6;
    } else {
        now = n('CHARGE_NOW') / 1e6 * volt;
        full = n('CHARGE_FULL') / 1e6 * volt;
        design = n('CHARGE_FULL_DESIGN') / 1e6 * voltDesign;
    }
    if (u.POWER_NOW !== undefined) power = Math.abs(n('POWER_NOW')) / 1e6;
    else power = Math.abs(n('CURRENT_NOW')) / 1e6 * volt;
    // Health compares like with like: charge counters are more trustworthy
    // than an energy figure derived from the present voltage.
    const health = u.ENERGY_NOW !== undefined ? full / design : n('CHARGE_FULL') / n('CHARGE_FULL_DESIGN');
    let pct = n('CAPACITY');
    if (!Number.isFinite(pct) && full > 0) pct = now / full * 100;
    return {
        pct,
        status: u.STATUS ?? 'Unknown',
        energyNow: now,
        energyFull: full,
        energyDesign: design,
        healthPct: health * 100,
        powerW: power,
        voltage: volt,
        cycles: n('CYCLE_COUNT'),
        technology: u.TECHNOLOGY ?? '',
        model: (u.MODEL_NAME ?? '').trim(),
    };
}

export function readPeripheral(path) {
    const u = uevent(path);
    const pct = Number(u.CAPACITY);
    // Absent styluses report capacity 0 / status Unknown: skip those.
    if (!Number.isFinite(pct) || (pct === 0 && u.STATUS === 'Unknown')) return null;
    return {name: (u.MODEL_NAME ?? 'Device').trim(), pct, status: u.STATUS ?? 'Unknown'};
}

export function mainsOnline(paths) {
    return paths.some(p => readNum(`${p}/online`) === 1);
}

// ---- temperatures ----------------------------------------------------------

const SENSOR_NAMES = {
    k10temp: {Tctl: 'CPU', Tdie: 'CPU die', Tccd1: 'CCD 1', Tccd2: 'CCD 2'},
    zenpower: {Tdie: 'CPU'},
    coretemp: {'Package id 0': 'CPU'},
    amdgpu: {edge: 'GPU', junction: 'GPU hotspot', mem: 'GPU memory'},
    nvme: {Composite: 'SSD'},
    iwlwifi_1: {'': 'Wi-Fi'},
    mt7921_phy0: {'': 'Wi-Fi'},
    acpitz: {'': 'Chassis'},
    thinkpad: {'': 'Chassis'},
    BAT0: {'': 'Battery'},
    BATT: {'': 'Battery'},
};

// Sensors read from on-die registers are ~10 µs; ACPI thermal zones and NVMe
// (an admin command to the drive) cost ~0.6–0.9 ms each, so those are only
// read while the popover is open.
const FAST_SENSORS = new Set(['k10temp', 'zenpower', 'coretemp', 'amdgpu']);

/** [{id, label, path, kind, slow}] — one per interesting temp*_input. */
export function discoverTemps() {
    const out = [];
    const seen = new Set();
    for (const hw of listDir('/sys/class/hwmon').sort((a, b) => a.localeCompare(b, undefined, {numeric: true}))) {
        const base = `/sys/class/hwmon/${hw}`;
        const name = (readText(`${base}/name`) ?? '').trim();
        const names = SENSOR_NAMES[name] ?? (name.startsWith('iwlwifi') ? {'': 'Wi-Fi'} : null);
        for (const f of listDir(base).sort()) {
            const m = f.match(/^temp(\d+)_input$/);
            if (!m) continue;
            const raw = (readText(`${base}/temp${m[1]}_label`) ?? '').trim();
            let label;
            if (names) {
                label = names[raw] ?? names[''];
                if (!label) continue;       // skip secondary sensors we don't name
            } else {
                label = raw ? `${name} ${raw}` : name;
            }
            if (seen.has(label)) continue;
            seen.add(label);
            const kind = label.startsWith('CPU') ? 'cpu' : label.startsWith('GPU') ? 'gpu' : 'other';
            out.push({id: `${name}/${raw}`, label, path: `${base}/${f}`, kind, slow: !FAST_SENSORS.has(name)});
        }
    }
    const order = ['CPU', 'GPU', 'SSD', 'Wi-Fi', 'Battery', 'Chassis'];
    const rank = l => {
        const i = order.findIndex(o => l.startsWith(o));
        return i < 0 ? order.length : i;
    };
    return out.sort((a, b) => rank(a.label) - rank(b.label));
}

// ---- network ---------------------------------------------------------------

const VIRTUAL_IF = /^(lo|docker|veth|br-|virbr|vnet|tun|tap|wg|zt|tailscale|podman|lxc|cni|flannel)/;

/** {iface: {rx, tx}} for physical-ish interfaces. */
export function readNetDev() {
    const text = readText('/proc/net/dev') ?? '';
    const out = {};
    for (const line of text.split('\n').slice(2)) {
        const m = line.match(/^\s*([^:]+):\s*(.*)$/);
        if (!m || VIRTUAL_IF.test(m[1])) continue;
        const f = m[2].trim().split(/\s+/).map(Number);
        out[m[1]] = {rx: f[0], tx: f[8]};
    }
    return out;
}

/** Wi-Fi link quality 0–100 and signal dBm from /proc/net/wireless. */
export function readWireless() {
    const text = readText('/proc/net/wireless') ?? '';
    for (const line of text.split('\n').slice(2)) {
        const m = line.match(/^\s*([^:]+):\s+\S+\s+([\d.]+)\s+(-?[\d.]+)/);
        if (m) return {iface: m[1], quality: Math.min(100, Number(m[2]) / 70 * 100), dbm: Number(m[3])};
    }
    return null;
}

// ---- storage ---------------------------------------------------------------

/** Physical block devices (those with a device/ link — no loop, zram, dm). */
export function discoverDisks() {
    return listDir('/sys/block').filter(n => exists(`/sys/block/${n}/device`) && !/^(loop|ram|zram|sr)/.test(n)).sort();
}

/** Summed {read, write} bytes over the given disks. */
export function readDiskBytes(disks) {
    let read = 0, write = 0;
    for (const d of disks) {
        const t = readText(`/sys/block/${d}/stat`);
        if (!t) continue;
        const f = t.trim().split(/\s+/).map(Number);
        read += f[2] * 512;
        write += f[6] * 512;
    }
    return {read, write};
}

const SKIP_MOUNTS = /^\/(boot|efi)(\/|$)/;

/** Distinct block-device mounts with usage, "/" first. */
export function readMounts() {
    const text = readText('/proc/mounts') ?? '';
    const byDev = new Map();
    for (const line of text.split('\n')) {
        const [dev, mnt, fs] = line.split(' ');
        if (!dev?.startsWith('/dev/') || /^\/dev\/(loop|zram)/.test(dev) || fs === 'squashfs') continue;
        const mount = mnt.replace(/\\040/g, ' ');
        if (SKIP_MOUNTS.test(mount)) continue;
        const prev = byDev.get(dev);
        if (!prev || mount.length < prev.mount.length) byDev.set(dev, {dev, mount, fs});
    }
    const out = [];
    for (const m of byDev.values()) {
        try {
            const info = Gio.File.new_for_path(m.mount).query_filesystem_info('filesystem::size,filesystem::free', null);
            const size = info.get_attribute_uint64('filesystem::size');
            const free = info.get_attribute_uint64('filesystem::free');
            if (size > 0) out.push({...m, size, free, used: size - free, label: mountLabel(m.mount)});
        } catch {
            // unmounted between reads
        }
    }
    return out.sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : a.mount.localeCompare(b.mount)));
}

function mountLabel(mount) {
    if (mount === '/') return 'System';
    if (mount === '/home') return 'Home';
    return GLib.path_get_basename(mount);
}

// ---- processes -------------------------------------------------------------

/**
 * One pass over /proc/[pid]/stat → [{pid, ppid, comm, ticks, rss}].
 * utime+stime in clock ticks; rss in bytes.
 */
export function readProcesses(pageSize = 4096) {
    const out = [];
    for (const name of listDir('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        const t = readText(`/proc/${name}/stat`);
        if (!t) continue;
        const open = t.indexOf('(');
        const close = t.lastIndexOf(')');
        const comm = t.slice(open + 1, close);
        const f = t.slice(close + 2).split(' ');
        // f[0] = state (field 3); ppid f[1]; utime f[11]; stime f[12]; rss f[21]
        out.push({
            pid: Number(name),
            ppid: Number(f[1]),
            comm,
            kernel: Number(f[1]) === 2 || Number(name) === 2,
            ticks: Number(f[11]) + Number(f[12]),
            rss: Number(f[21]) * pageSize,
        });
    }
    return out;
}

/**
 * The desktop app id a process was launched as, from its systemd scope:
 * launched apps live in app-[<launcher>-]<appid>-<n>.scope (or an
 * @.service), so helpers and children inherit the app they belong to.
 * Returns the app id, or null for session services, shells, kernel threads.
 */
export function appIdFromCgroup(pid) {
    const t = readText(`/proc/${pid}/cgroup`);
    if (!t) return null;
    const path = t.trim().split('\n').pop().split('::').pop() ?? '';
    for (const u of path.split('/').reverse()) {
        if (!u.startsWith('app-')) continue;
        const core = u.slice(4).replace(/(-\d+\.scope|@[^.]*\.service|\.service|\.scope|\.slice)$/, '');
        if (!core || core === u.slice(4)) continue;
        const id = core.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        return id.replace(/^(gnome|flatpak|snap|kde|gnome-launched)-(?=.)/, '');
    }
    return null;
}
