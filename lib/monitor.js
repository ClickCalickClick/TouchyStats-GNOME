// SPDX-License-Identifier: GPL-2.0-or-later
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as S from './sensors.js';
import {History} from './history.js';

const CLK_TCK = 100;          // USER_HZ — 100 on every mainstream Linux build
const GPU_SUBSAMPLE_MS = 500; // gpu_busy_percent is instantaneous: average it
const POWER_TAU_S = 60;       // smoothing for the time-remaining estimate

const now = () => GLib.get_monotonic_time() / 1e6;

/**
 * Samples the machine on a timer and keeps history for the graphs. The cheap
 * readings (≈30 small procfs/sysfs reads) run every tick so the panel and the
 * graphs are always live; the process table, mounts and zram stats are only
 * read while the popover is open ("detailed" mode).
 */
export class Monitor {
    constructor() {
        this._listeners = new Map();
        this._nextId = 1;
        this._interval = 2;
        this._detailed = false;
        this._timer = 0;
        this._gpuTimer = 0;
        this._gpuSum = 0;
        this._gpuCount = 0;

        this.history = {};
        for (const k of ['cpu', 'gpu', 'memory', 'swap', 'cpuTemp', 'gpuTemp', 'power', 'gpuPower', 'battery', 'netRx', 'netTx', 'diskRead', 'diskWrite'])
            this.history[k] = new History();

        this._discover();

        this.cpu = {pct: NaN, cores: [], freqGHz: NaN, maxGHz: NaN, temp: NaN, load: [NaN, NaN, NaN], ...S.splitModel(S.cpuModel())};
        this.gpu = null;
        this.memory = {};
        this.battery = null;
        this.net = {rx: NaN, tx: NaN, rxSession: 0, txSession: 0, iface: null, wifi: null};
        this.disk = {read: NaN, write: NaN, mounts: []};
        this.temps = [];
        this.processes = [];
        this.uptime = NaN;
        this.hostname = GLib.get_host_name();
        this.time = now();
    }

    _discover() {
        this._gpuDev = S.discoverGpu();
        this._supplies = S.discoverPowerSupplies();
        this._temps = S.discoverTemps();
        this._disks = S.discoverDisks();
        this._freqPaths = [];
        for (const n of S.listDir('/sys/devices/system/cpu')) {
            if (/^cpu\d+$/.test(n) && S.exists(`/sys/devices/system/cpu/${n}/cpufreq/scaling_cur_freq`))
                this._freqPaths.push(`/sys/devices/system/cpu/${n}/cpufreq/scaling_cur_freq`);
        }
        this._maxGHz = S.readNum('/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq') / 1e6;
        this._appCache = new Map();     // app id → Shell.App | null
        this._cgroupCache = new Map();  // pid → app id | null
        this._procPrev = new Map();     // pid → ticks
    }

    get hasGpu() {
        return this._gpuDev !== null;
    }

    get hasBattery() {
        return this._supplies.system.length > 0;
    }

    get interval() {
        return this._interval;
    }

    connect(fn) {
        const id = this._nextId++;
        this._listeners.set(id, fn);
        return id;
    }

    disconnect(id) {
        this._listeners.delete(id);
    }

    /** acInterval / batteryInterval in seconds; the battery one applies while discharging. */
    start(acInterval, batteryInterval) {
        this._acInterval = acInterval;
        this._batteryInterval = batteryInterval;
        this._sample(true);
        this._interval = this._wantedInterval();
        this._schedule();
    }

    stop() {
        this._clearTimers();
        this._listeners.clear();
    }

    setIntervals(acInterval, batteryInterval) {
        this._acInterval = acInterval;
        this._batteryInterval = batteryInterval;
        if (!this._paused) this._reschedule();
    }

    get onBattery() {
        return !!this.battery?.discharging;
    }

    /**
     * Stop sampling entirely (screen locked or blanked): nobody can see it,
     * so the machine gets to idle undisturbed.
     */
    pause() {
        if (this._paused) return;
        this._paused = true;
        this._clearTimers();
    }

    resume() {
        if (!this._paused) return;
        this._paused = false;
        // Fresh baselines, so the first rates aren't averaged over the pause.
        this._cpuPrev = this._netPrev = this._diskPrev = null;
        this._gpuSum = this._gpuCount = 0;
        this._sample(true);
        this._interval = this._wantedInterval();
        this._schedule();
        this._emit();
    }

    _wantedInterval() {
        return this.onBattery ? this._batteryInterval : this._acInterval;
    }

    _reschedule() {
        this._interval = this._wantedInterval();
        this._schedule();
    }

    _clearTimers() {
        if (this._timer) GLib.source_remove(this._timer);
        if (this._gpuTimer) GLib.source_remove(this._gpuTimer);
        this._timer = this._gpuTimer = 0;
    }

    /** Detailed mode = popover open: sample processes & mounts, and sample now. */
    setDetailed(on) {
        if (on === this._detailed) return;
        this._detailed = on;
        if (on) {
            this._procPrevTime = 0;
            this._sampleDetails(now());
            this._emit();
        } else {
            this._procPrev.clear();
            this._cgroupCache.clear();
        }
    }

    _schedule() {
        this._clearTimers();
        // Whole-second timers are batched with the rest of the process's
        // second-granularity timers, so they rarely cost a wakeup of their own.
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._interval, () => {
            this._sample(false);
            return GLib.SOURCE_CONTINUE;
        });
        // The GPU sub-sampler smooths gpu_busy_percent on AC; on battery the
        // extra 2 wakeups/s aren't worth it — one reading per tick will do.
        if (this._gpuDev && !this.onBattery) {
            this._gpuTimer = GLib.timeout_add(GLib.PRIORITY_LOW, GPU_SUBSAMPLE_MS, () => {
                const b = S.gpuBusy(this._gpuDev);
                if (Number.isFinite(b)) {
                    this._gpuSum += b;
                    this._gpuCount++;
                }
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    _emit() {
        for (const fn of this._listeners.values()) {
            try {
                fn(this);
            } catch (e) {
                console.error(`TouchyStats: listener failed: ${e.message}\n${e.stack}`);
            }
        }
    }

    _sample(first) {
        const t = now();
        const dt = first ? 0 : t - this.time;
        this.time = t;
        const H = this.history;

        // CPU
        const times = S.readCpuTimes();
        if (this._cpuPrev && times.length) {
            const pct = (cur, prev) => {
                const dTotal = cur.total - prev.total;
                return dTotal > 0 ? Math.min(100, Math.max(0, (cur.busy - prev.busy) / dTotal * 100)) : 0;
            };
            this.cpu.pct = pct(times[0], this._cpuPrev[0]);
            this.cpu.cores = times.slice(1).map((c, i) => (this._cpuPrev[i + 1] ? pct(c, this._cpuPrev[i + 1]) : 0));
            H.cpu.push(t, this.cpu.pct);
        }
        this._cpuPrev = times;
        this.cpu.threads = Math.max(1, times.length - 1);
        if (this._freqPaths.length) {
            let sum = 0, n = 0;
            for (const p of this._freqPaths) {
                const f = S.readNum(p);
                if (Number.isFinite(f)) {
                    sum += f;
                    n++;
                }
            }
            this.cpu.freqGHz = n ? sum / n / 1e6 : NaN;
        }
        this.cpu.maxGHz = this._maxGHz;
        this.cpu.load = S.loadAvg();
        this.uptime = S.uptimeSeconds();

        // Temperatures
        this._readTemps(this._detailed);
        this.cpu.temp = this.temps.find(s => s.kind === 'cpu')?.c ?? NaN;
        if (Number.isFinite(this.cpu.temp)) H.cpuTemp.push(t, this.cpu.temp);

        // GPU
        if (this._gpuDev) {
            const g = S.readGpu(this._gpuDev);
            if (this._gpuCount > 0) {
                g.busy = this._gpuSum / this._gpuCount;
                this._gpuSum = this._gpuCount = 0;
            }
            this.gpu = g;
            if (Number.isFinite(g.busy)) H.gpu.push(t, g.busy);
            if (Number.isFinite(g.powerW)) H.gpuPower.push(t, g.powerW);
            if (Number.isFinite(g.temp)) H.gpuTemp.push(t, g.temp);
        }

        // Memory
        const m = S.readMeminfo();
        const total = m.MemTotal ?? NaN;
        const available = m.MemAvailable ?? NaN;
        const cache = (m.Buffers ?? 0) + (m.Cached ?? 0) + (m.SReclaimable ?? 0) - (m.Shmem ?? 0);
        const swapTotal = m.SwapTotal ?? 0;
        const swapUsed = swapTotal - (m.SwapFree ?? 0);
        this.memory = {
            ...this.memory,
            total,
            available,
            used: total - available,
            cache: Math.max(0, Math.min(cache, available)),
            free: m.MemFree ?? NaN,
            pct: (total - available) / total * 100,
            swapTotal,
            swapUsed,
            swapPct: swapTotal > 0 ? swapUsed / swapTotal * 100 : 0,
        };
        H.memory.push(t, this.memory.pct);
        H.swap.push(t, this.memory.swapPct);

        // Battery & power
        this._sampleBattery(t, dt);

        // Network
        const net = S.readNetDev();
        let rx = 0, tx = 0, best = null, bestBytes = -1;
        for (const [iface, c] of Object.entries(net)) {
            rx += c.rx;
            tx += c.tx;
            if (c.rx + c.tx > bestBytes) {
                best = iface;
                bestBytes = c.rx + c.tx;
            }
        }
        if (this._netPrev && dt > 0) {
            const drx = Math.max(0, rx - this._netPrev.rx), dtx = Math.max(0, tx - this._netPrev.tx);
            this.net.rx = drx / dt;
            this.net.tx = dtx / dt;
            this.net.rxSession += drx;
            this.net.txSession += dtx;
            H.netRx.push(t, this.net.rx);
            H.netTx.push(t, this.net.tx);
        }
        this._netPrev = {rx, tx};
        this.net.iface = best;

        // Disk I/O
        const d = S.readDiskBytes(this._disks);
        if (this._diskPrev && dt > 0) {
            this.disk.read = Math.max(0, d.read - this._diskPrev.read) / dt;
            this.disk.write = Math.max(0, d.write - this._diskPrev.write) / dt;
            H.diskRead.push(t, this.disk.read);
            H.diskWrite.push(t, this.disk.write);
        }
        this._diskPrev = d;

        if (this._detailed) this._sampleDetails(t);
        // Plugging in or unplugging switches between the AC and battery pace.
        if (!first && this._wantedInterval() !== this._interval) this._reschedule();
        if (!first) this._emit();
    }

    _sampleBattery(t, dt) {
        const sys = this._supplies.system.map(p => S.readBattery(p));
        // The AC adapter is an ACPI read (~0.7 ms); the battery's own status
        // already says whether it's on the charger, so ask the adapter only
        // when that's ambiguous.
        const known = sys.map(b => b.status).find(st => st !== 'Unknown');
        const acOnline = known ? known !== 'Discharging' : S.mainsOnline(this._supplies.mains);
        if (!sys.length) {
            this.battery = null;
            return;
        }
        const sum = k => sys.reduce((a, b) => a + (Number.isFinite(b[k]) ? b[k] : 0), 0);
        const energyNow = sum('energyNow'), energyFull = sum('energyFull'), energyDesign = sum('energyDesign');
        const powerW = sum('powerW');
        const statuses = sys.map(b => b.status);
        const status = statuses.includes('Discharging') ? 'Discharging'
            : statuses.includes('Charging') ? 'Charging'
                : statuses.includes('Full') ? 'Full'
                    : acOnline ? 'Not charging' : statuses[0];
        const pct = sys.length === 1 ? sys[0].pct : energyNow / energyFull * 100;

        // Smooth the draw for the estimate; restart smoothing when the state flips.
        const prev = this.battery;
        let avg = powerW;
        if (prev && prev.status === status && Number.isFinite(prev.avgPowerW) && dt > 0)
            avg = prev.avgPowerW + (powerW - prev.avgPowerW) * (1 - Math.exp(-dt / POWER_TAU_S));

        let hoursLeft = NaN;
        if (status === 'Discharging' && avg > 0.3) hoursLeft = energyNow / avg;
        else if (status === 'Charging' && avg > 0.3) hoursLeft = Math.max(0, energyFull - energyNow) / avg;

        this.battery = {
            pct,
            status,
            acOnline,
            charging: status === 'Charging',
            discharging: status === 'Discharging',
            powerW,
            avgPowerW: avg,
            hoursLeft,
            energyNow,
            energyFull,
            energyDesign,
            healthPct: sys.length === 1 ? sys[0].healthPct : energyDesign > 0 ? energyFull / energyDesign * 100 : NaN,
            cycles: sys[0].cycles,
            voltage: sys[0].voltage,
            technology: sys[0].technology,
            peripherals: this._supplies.peripheral.map(p => S.readPeripheral(p)).filter(Boolean),
        };
        const H = this.history;
        H.battery.push(t, pct);
        // Battery current only equals system draw off the charger.
        if (status === 'Discharging' && Number.isFinite(powerW)) H.power.push(t, powerW);
    }

    /** Fast sensors every tick; slow ones (ACPI, NVMe) only when detailed. */
    _readTemps(includeSlow) {
        const prev = new Map(this.temps.map(s => [s.label, s.c]));
        this.temps = this._temps
            .map(s => ({label: s.label, kind: s.kind, c: s.slow && !includeSlow ? prev.get(s.label) ?? NaN : S.readNum(s.path) / 1000}))
            .filter(s => Number.isFinite(s.c));
    }

    _sampleDetails(t) {
        this._readTemps(true);
        this.net.wifi = S.readWireless();
        this.disk.mounts = S.readMounts();
        this.memory.zram = S.readZram();
        this._sampleProcesses(t);
    }

    _lookupApp(id) {
        if (!id) return null;
        if (this._appCache.has(id)) return this._appCache.get(id);
        const sys = Shell.AppSystem.get_default();
        const app = sys.lookup_app(`${id}.desktop`) ?? sys.lookup_app(`${id.toLowerCase()}.desktop`) ?? null;
        this._appCache.set(id, app);
        return app;
    }

    _sampleProcesses(t) {
        const procs = S.readProcesses();
        const elapsed = this._procPrevTime ? t - this._procPrevTime : 0;
        const cores = this.cpu.threads || 1;
        const groups = new Map();
        const seen = new Map();
        for (const p of procs) {
            seen.set(p.pid, p.ticks);
            const prevTicks = this._procPrev.get(p.pid);
            const cpu = elapsed > 0 && prevTicks !== undefined ? Math.max(0, p.ticks - prevTicks) / (elapsed * CLK_TCK * cores) * 100 : 0;

            let key, name, app = null;
            if (p.kernel) {
                key = 'kernel';
                name = 'Kernel';
            } else {
                let id = this._cgroupCache.get(p.pid);
                if (id === undefined) {
                    id = S.appIdFromCgroup(p.pid);
                    this._cgroupCache.set(p.pid, id);
                }
                app = this._lookupApp(id);
                if (app) {
                    key = `app:${app.get_id()}`;
                    name = app.get_name();
                } else {
                    key = `comm:${p.comm}`;
                    name = p.comm;
                }
            }
            let g = groups.get(key);
            if (!g) {
                g = {key, name, app, cpu: 0, mem: 0, count: 0, pids: []};
                groups.set(key, g);
            }
            g.cpu += cpu;
            g.mem += p.kernel ? 0 : p.rss;
            g.count++;
        }
        // Forget pids that exited so reused pids don't inherit stale state.
        for (const pid of this._cgroupCache.keys())
            if (!seen.has(pid)) this._cgroupCache.delete(pid);
        this._procPrev = seen;
        this._procPrevTime = t;
        this.processes = [...groups.values()];
        this.processesReady = elapsed > 0;
    }
}
