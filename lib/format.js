// SPDX-License-Identifier: GPL-2.0-or-later
/** Short, fixed-ish-width strings for the panel and the cards. */

const ok = v => Number.isFinite(v);

export const Fmt = {
    pct(v) {
        return ok(v) ? `${Math.round(v)}%` : '—';
    },

    /** 1 decimal under 10 GiB, none above; binary units, SI-style labels. */
    bytes(v, {decimals = null} = {}) {
        if (!ok(v)) return '—';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0;
        while (Math.abs(v) >= 1024 && i < units.length - 1) {
            v /= 1024;
            i++;
        }
        const d = decimals ?? (i === 0 ? 0 : v < 10 ? 1 : 0);
        return `${v.toFixed(d)} ${units[i]}`;
    },

    rate(v) {
        return ok(v) ? `${Fmt.bytes(v)}/s` : '—';
    },

    /** Panel-width rate: "1.2M", "340K", "0K". */
    rateShort(v) {
        if (!ok(v)) return '—';
        if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)}G`;
        if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(v >= 10 * 1024 ** 2 ? 0 : 1)}M`;
        return `${Math.round(v / 1024)}K`;
    },

    ghz(v) {
        return ok(v) ? `${v.toFixed(2)} GHz` : '—';
    },

    mhz(v) {
        if (!ok(v)) return '—';
        return v >= 1000 ? `${(v / 1000).toFixed(2)} GHz` : `${Math.round(v)} MHz`;
    },

    watts(v, d = 1) {
        return ok(v) ? `${v.toFixed(d)} W` : '—';
    },

    temp(c, unit = 'celsius', {short = false} = {}) {
        if (!ok(c)) return '—';
        const v = unit === 'fahrenheit' ? c * 9 / 5 + 32 : c;
        return short ? `${Math.round(v)}°` : `${Math.round(v)}°${unit === 'fahrenheit' ? 'F' : 'C'}`;
    },

    hours(h) {
        if (!ok(h) || h <= 0 || h > 99) return '—';
        const hh = Math.floor(h);
        const mm = Math.round((h - hh) * 60);
        if (hh === 0) return `${mm} min`;
        return `${hh} h ${String(mm === 60 ? 59 : mm).padStart(2, '0')} min`;
    },

    duration(s) {
        if (!ok(s)) return '—';
        const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
        if (d > 0) return `${d}d ${h}h`;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    },

    ago(s) {
        s = Math.round(s);
        if (s < 2) return 'now';
        if (s < 60) return `${s}s ago`;
        const m = Math.floor(s / 60), r = s % 60;
        return r ? `${m}m ${r}s ago` : `${m}m ago`;
    },

    load(l) {
        return l.every(ok) ? l.map(x => x.toFixed(2)).join('  ') : '—';
    },

    /** "12.3 / 27.1 GB" sharing the larger value's unit. */
    pair(used, total) {
        if (!ok(used) || !ok(total)) return '—';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0, t = total;
        while (t >= 1024 && i < units.length - 1) {
            t /= 1024;
            i++;
        }
        const u = used / 1024 ** i;
        const d = t < 100 ? 1 : 0;
        return `${u.toFixed(d)} / ${t.toFixed(d)} ${units[i]}`;
    },
};

/** A "nice" axis maximum ≥ v: 1, 2, 5 × 10^n. */
export function niceMax(v, floor) {
    v = Math.max(v, floor);
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
}

/** niceMax for byte rates on binary steps (…, 512K, 1M, 2M, 5M, …). */
export function niceRateMax(v) {
    const floor = 64 * 1024;
    v = Math.max(v, floor);
    let unit = 1024;
    while (v >= unit * 1024) unit *= 1024;
    return niceMax(v / unit, 1) * unit;
}
