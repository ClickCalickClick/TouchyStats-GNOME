// SPDX-License-Identifier: GPL-2.0-or-later
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {Fmt, niceMax, niceRateMax} from '../lib/format.js';
import {
    Palette, Opacity, Ring, Graph, Bar, CoreBars, Segmented,
    label, icon, hbox, vbox, spacer, button, statRow, gicon,
} from './widgets.js';

/**
 * The popover's cards. Each is built once and then updated in place every
 * sample while the popover is open: update(monitor) only sets texts and
 * queues repaints. `ctx` is the popover's shared context:
 *   {monitor, range, unit, isPinned(m), togglePin(m), isCollapsed(id),
 *    setCollapsed(id, v), scrollTo(card), profiles, activateApp(app)}
 */

// ---- card chrome -----------------------------------------------------------

export class Card {
    constructor(ctx, {id, title, iconName, hue, pin = null}) {
        this.ctx = ctx;
        this.id = id;
        this.hue = hue;
        this.pin = pin;
        this.actor = vbox({styleClass: 'ts-card', xExpand: true});

        const header = hbox({styleClass: 'ts-card-header', xExpand: true});
        const toggleBox = hbox({styleClass: 'ts-card-toggle-box', xExpand: true});
        this.titleIcon = icon(iconName, 'ts-card-icon', {opacity: Opacity.secondary});
        toggleBox.add_child(this.titleIcon);
        toggleBox.add_child(label(title.toUpperCase(), 'ts-card-title', {opacity: Opacity.secondary}));
        toggleBox.add_child(spacer());
        this.headline = label('', 'ts-card-headline');
        this.headline.style = `color: ${Palette.css(hue)};`;
        toggleBox.add_child(this.headline);
        const toggle = button({child: toggleBox, styleClass: 'ts-card-toggle', xExpand: true, tooltip: `Collapse or expand ${title}`, onClick: () => this.setCollapsed(!this.collapsed)});
        header.add_child(toggle);

        if (pin) {
            this._pin = button({iconName: 'view-pin-symbolic', styleClass: 'ts-pin', iconClass: 'ts-pin-icon', tooltip: `Show ${title} in the top bar`, onClick: () => {
                ctx.togglePin(pin);
                this._syncPin();
            }});
            header.add_child(this._pin);
            this._syncPin();
        }

        this._chevron = icon('pan-down-symbolic', 'ts-chevron', {opacity: Opacity.tertiary});
        this._chevron.set_pivot_point(0.5, 0.5);
        header.add_child(button({child: this._chevron, styleClass: 'ts-chevron-button', tooltip: `Collapse or expand ${title}`, onClick: () => this.setCollapsed(!this.collapsed)}));
        this.actor.add_child(header);

        this.body = vbox({styleClass: 'ts-card-body', xExpand: true});
        this.actor.add_child(this.body);
        this.collapsed = ctx.isCollapsed(id);
        this._applyCollapsed(false);
    }

    _syncPin() {
        if (!this._pin) return;
        const on = this.ctx.isPinned(this.pin);
        if (on) {
            this._pin.add_style_pseudo_class('checked');
            this._pin.get_child().style = `color: ${Palette.css(this.hue)};`;
        } else {
            this._pin.remove_style_pseudo_class('checked');
            this._pin.get_child().style = null;
        }
    }

    syncPin() {
        this._syncPin();
    }

    setCollapsed(v) {
        this.collapsed = v;
        this.ctx.setCollapsed(this.id, v);
        this._applyCollapsed(true);
        if (!v) this.update(this.ctx.monitor);
    }

    _applyCollapsed(animate) {
        this.body.visible = !this.collapsed;
        if (this.collapsed) this.actor.add_style_class_name('ts-card-collapsed');
        else this.actor.remove_style_class_name('ts-card-collapsed');
        const angle = this.collapsed ? -90 : 0;
        if (animate) this._chevron.ease({rotation_angle_z: angle, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        else this._chevron.rotation_angle_z = angle;
    }

    /** Headline is refreshed even while collapsed; the body only when open. */
    refresh(m) {
        this.updateHeadline(m);
        if (!this.collapsed) this.update(m);
    }

    updateHeadline(_m) {}

    update(_m) {}
}

function graphFor(ctx, series, opts = {}) {
    return new Graph({ctx, series, ...opts});
}

const rateScale = {auto: v => niceRateMax(v), format: v => Fmt.rate(v)};

// ---- overview --------------------------------------------------------------

/**
 * The hero: a ring per headline metric (tap one to jump to its card), with
 * the host/uptime line and the graph-range picker above.
 */
export class OverviewCard {
    constructor(ctx, {cards, onRange}) {
        this.ctx = ctx;
        this.id = 'overview';
        this.actor = vbox({styleClass: 'ts-card ts-hero', xExpand: true});

        const top = hbox({styleClass: 'ts-hero-top', xExpand: true});
        const who = vbox({xExpand: true, yAlign: Clutter.ActorAlign.CENTER});
        this._host = label(ctx.monitor.hostname, 'ts-hero-host', {ellipsize: true});
        this._uptime = label('', 'ts-caption', {opacity: Opacity.secondary});
        who.add_child(this._host);
        who.add_child(this._uptime);
        top.add_child(who);
        this._range = new Segmented([
            {id: 60, label: '1m', tooltip: 'Graphs show the last minute'},
            {id: 300, label: '5m', tooltip: 'Graphs show the last 5 minutes'},
            {id: 600, label: '10m', tooltip: 'Graphs show the last 10 minutes'},
        ], id => onRange(id), {styleClass: 'ts-seg-small'});
        this._range.select(ctx.range);
        top.add_child(this._range.actor);
        this.actor.add_child(top);

        const row = hbox({styleClass: 'ts-hero-rings', xExpand: true});
        this._tiles = [];
        const defs = [
            {key: 'cpu', name: 'CPU', card: 'cpu'},
            ctx.monitor.hasGpu ? {key: 'gpu', name: 'GPU', card: 'gpu'} : null,
            {key: 'memory', name: 'Memory', card: 'memory'},
            ctx.monitor.hasBattery ? {key: 'battery', name: 'Battery', card: 'battery'} : {key: 'temp', name: 'CPU temp', card: 'sensors'},
        ].filter(Boolean);
        for (const d of defs) {
            const value = label('—', 'ts-hero-value');
            const ring = new Ring(70, {lineWidth: 6.5, animate: true, center: value, glow: true});
            const name = label(d.name, 'ts-hero-name', {align: Clutter.ActorAlign.CENTER});
            const sub = label('', 'ts-hero-sub', {opacity: Opacity.secondary, align: Clutter.ActorAlign.CENTER});
            const tile = vbox({styleClass: 'ts-hero-tile', xAlign: Clutter.ActorAlign.CENTER});
            tile.add_child(ring.actor);
            ring.actor.x_align = Clutter.ActorAlign.CENTER;
            tile.add_child(name);
            tile.add_child(sub);
            const b = button({child: tile, styleClass: 'ts-hero-button', xExpand: true, tooltip: `Show ${d.name} details`, onClick: () => {
                const card = cards.get(d.card);
                if (card) ctx.scrollTo(card);
            }});
            row.add_child(b);
            this._tiles.push({...d, ring, value, sub});
        }
        this.actor.add_child(row);
    }

    setRange(r) {
        this._range.select(r);
    }

    refresh(m) {
        this._uptime.text = `Up ${Fmt.duration(m.uptime)} · ${m.cpu.cpu}`;
        for (const t of this._tiles) {
            switch (t.key) {
            case 'cpu':
                t.ring.set(m.cpu.pct / 100, Palette.usageKey(m.cpu.pct / 100, 'cpu'));
                t.value.text = Fmt.pct(m.cpu.pct);
                t.sub.text = Fmt.ghz(m.cpu.freqGHz);
                break;
            case 'gpu':
                t.ring.set(m.gpu?.busy / 100, 'gpu');
                t.value.text = Fmt.pct(m.gpu?.busy);
                t.sub.text = Fmt.mhz(m.gpu?.freqMHz);
                break;
            case 'memory':
                t.ring.set(m.memory.pct / 100, Palette.usageKey(m.memory.pct / 100, 'memory'));
                t.value.text = Fmt.pct(m.memory.pct);
                t.sub.text = `${Fmt.bytes(m.memory.used)}`;
                break;
            case 'battery': {
                const b = m.battery;
                t.ring.set(b?.pct / 100, Palette.batteryKey(b));
                t.value.text = Fmt.pct(b?.pct);
                t.sub.text = b ? batteryShort(b) : '—';
                break;
            }
            case 'temp':
                t.ring.set(m.cpu.temp / 100, Palette.tempKey(m.cpu.temp));
                t.value.text = Fmt.temp(m.cpu.temp, this.ctx.unit, {short: true});
                t.sub.text = '';
                break;
            }
        }
    }

    syncPin() {}
}

function batteryShort(b) {
    if (b.discharging) return Number.isFinite(b.hoursLeft) ? Fmt.hours(b.hoursLeft).replace(' min', 'm').replace(' h ', 'h ') : 'On battery';
    if (b.charging) return 'Charging';
    return b.pct >= 99 ? 'Full' : 'Plugged in';
}

// ---- CPU -------------------------------------------------------------------

export class CpuCard extends Card {
    constructor(ctx) {
        super(ctx, {id: 'cpu', title: 'Processor', iconName: 'ts-cpu-symbolic', hue: 'cpu', pin: 'cpu'});
        const m = ctx.monitor;
        this.body.add_child(label(`${m.cpu.cpu} · ${m.cpu.threads} threads`, 'ts-caption', {opacity: Opacity.secondary, ellipsize: true}));
        this.graph = graphFor(ctx, [{history: m.history.cpu, key: 'cpu'}]);
        this.body.add_child(this.graph.actor);
        const s = statRow([['freq', 'Clock'], ['temp', 'Temperature'], ['load', 'Load 1 · 5 · 15']]);
        this.tiles = s.tiles;
        this.body.add_child(s.actor);
        const coreHeader = hbox({xExpand: true});
        coreHeader.add_child(label('PER THREAD', 'ts-stat-caption', {opacity: Opacity.secondary, xExpand: true}));
        this._busiest = label('', 'ts-stat-caption', {opacity: Opacity.secondary});
        coreHeader.add_child(this._busiest);
        this.body.add_child(coreHeader);
        this.cores = new CoreBars(34);
        this.body.add_child(this.cores.actor);
    }

    updateHeadline(m) {
        this.headline.text = Fmt.pct(m.cpu.pct);
    }

    update(m) {
        this.graph.update();
        this.tiles.freq.text = Number.isFinite(m.cpu.maxGHz) ? `${m.cpu.freqGHz.toFixed(2)} / ${m.cpu.maxGHz.toFixed(1)} GHz` : Fmt.ghz(m.cpu.freqGHz);
        this.tiles.temp.text = Fmt.temp(m.cpu.temp, this.ctx.unit);
        this.tiles.temp.style = Number.isFinite(m.cpu.temp) ? `color: ${Palette.css(Palette.tempKey(m.cpu.temp))};` : null;
        this.tiles.load.text = m.cpu.load.map(x => (Number.isFinite(x) ? x.toFixed(1) : '—')).join(' · ');
        this.cores.set(m.cpu.cores);
        const top = Math.max(0, ...m.cpu.cores);
        this._busiest.text = m.cpu.cores.length ? `busiest ${Math.round(top)}%` : '';
    }
}

// ---- GPU -------------------------------------------------------------------

export class GpuCard extends Card {
    constructor(ctx) {
        super(ctx, {id: 'gpu', title: 'Graphics', iconName: 'ts-gpu-symbolic', hue: 'gpu', pin: 'gpu'});
        const m = ctx.monitor;
        const name = m.cpu.igpu ? `${m.cpu.igpu} · integrated` : 'AMD GPU';
        this.body.add_child(label(name, 'ts-caption', {opacity: Opacity.secondary, ellipsize: true}));
        this.graph = graphFor(ctx, [{history: m.history.gpu, key: 'gpu'}]);
        this.body.add_child(this.graph.actor);
        const s = statRow([['freq', 'Clock'], ['temp', 'Temperature'], ['power', 'Package power']]);
        this.tiles = s.tiles;
        this.body.add_child(s.actor);
        this.vram = this._memRow('VRAM (carve-out)');
        this.gtt = this._memRow('Shared memory (GTT)');
    }

    _memRow(caption) {
        const box = vbox({styleClass: 'ts-meter', xExpand: true});
        const row = hbox({xExpand: true});
        row.add_child(label(caption.toUpperCase(), 'ts-stat-caption', {opacity: Opacity.secondary, xExpand: true}));
        const value = label('—', 'ts-meter-value');
        row.add_child(value);
        box.add_child(row);
        const bar = new Bar({height: 6});
        box.add_child(bar.actor);
        this.body.add_child(box);
        return {value, bar};
    }

    updateHeadline(m) {
        this.headline.text = Fmt.pct(m.gpu?.busy);
    }

    update(m) {
        const g = m.gpu;
        if (!g) return;
        this.graph.update();
        this.tiles.freq.text = Fmt.mhz(g.freqMHz);
        this.tiles.temp.text = Fmt.temp(g.temp, this.ctx.unit);
        this.tiles.temp.style = Number.isFinite(g.temp) ? `color: ${Palette.css(Palette.tempKey(g.temp))};` : null;
        this.tiles.power.text = Fmt.watts(g.powerW);
        this.vram.value.text = Fmt.pair(g.vramUsed, g.vramTotal);
        this.vram.bar.set([{fraction: g.vramUsed / g.vramTotal, key: 'gpu'}]);
        this.gtt.value.text = Fmt.pair(g.gttUsed, g.gttTotal);
        this.gtt.bar.set([{fraction: g.gttUsed / g.gttTotal, key: 'gpu', alpha: 0.7}]);
    }
}

// ---- memory ----------------------------------------------------------------

export class MemoryCard extends Card {
    constructor(ctx) {
        super(ctx, {id: 'memory', title: 'Memory', iconName: 'ts-memory-symbolic', hue: 'memory', pin: 'memory'});
        const m = ctx.monitor;
        this.bar = new Bar({height: 12});
        this.body.add_child(this.bar.actor);
        const legend = hbox({styleClass: 'ts-legend', xExpand: true});
        this.legend = {};
        for (const [key, name, hue, alpha] of [['used', 'In use', 'memory', 1], ['cache', 'Cached', 'memory', 0.4], ['free', 'Free', null, 0]]) {
            const item = hbox({styleClass: 'ts-legend-item', xExpand: true});
            const dot = new St.Widget({style_class: 'ts-dot', y_align: Clutter.ActorAlign.CENTER});
            dot.style = hue ? `background-color: ${Palette.css(hue)}; opacity: ${alpha};` : '';
            if (!hue) dot.add_style_class_name('ts-dot-track');
            dot.opacity = hue ? Math.round(255 * alpha) : 255;
            item.add_child(dot);
            const v = vbox();
            v.add_child(label(name.toUpperCase(), 'ts-stat-caption', {opacity: Opacity.secondary}));
            this.legend[key] = label('—', 'ts-stat-value');
            v.add_child(this.legend[key]);
            item.add_child(v);
            legend.add_child(item);
        }
        this.body.add_child(legend);
        this.graph = graphFor(ctx, [
            {history: m.history.memory, key: 'memory', label: 'RAM'},
            {history: m.history.swap, key: 'swap', label: 'Swap', fill: false, dash: true},
        ]);
        this.body.add_child(this.graph.actor);
        const s = statRow([['total', 'Installed'], ['swap', 'Swap'], ['zram', 'zram saving']]);
        this.tiles = s.tiles;
        this.body.add_child(s.actor);
    }

    updateHeadline(m) {
        this.headline.text = Fmt.pct(m.memory.pct);
    }

    update(m) {
        const mem = m.memory;
        this.bar.set([
            {fraction: (mem.used) / mem.total, key: Palette.usageKey(mem.pct / 100, 'memory'), gap: true},
            {fraction: mem.cache / mem.total, key: 'memory', alpha: 0.4},
        ]);
        this.legend.used.text = Fmt.bytes(mem.used);
        this.legend.cache.text = Fmt.bytes(mem.cache);
        this.legend.free.text = Fmt.bytes(mem.available - mem.cache);
        this.graph.update();
        this.tiles.total.text = Fmt.bytes(mem.total, {decimals: 1});
        this.tiles.swap.text = mem.swapTotal > 0 ? Fmt.pair(mem.swapUsed, mem.swapTotal) : 'None';
        const z = mem.zram;
        if (z && z.orig > 0 && z.used > 0)
            this.tiles.zram.text = `${Fmt.bytes(z.orig)} → ${Fmt.bytes(z.used)}`;
        else
            this.tiles.zram.text = z ? 'Idle' : '—';
    }
}

// ---- battery & power -------------------------------------------------------

const PROFILE_DEFS = [
    {id: 'power-saver', label: 'Saver', icon: 'power-profile-power-saver-symbolic', tooltip: 'Power saver'},
    {id: 'balanced', label: 'Balanced', icon: 'power-profile-balanced-symbolic', tooltip: 'Balanced'},
    {id: 'performance', label: 'Performance', icon: 'power-profile-performance-symbolic', tooltip: 'Performance'},
];

export class BatteryCard extends Card {
    constructor(ctx) {
        super(ctx, {id: 'battery', title: 'Battery & Power', iconName: 'battery-level-80-symbolic', hue: 'battery', pin: 'battery'});
        const m = ctx.monitor;

        const top = hbox({styleClass: 'ts-battery-top', xExpand: true});
        this.big = label('—', 'ts-big-number');
        top.add_child(this.big);
        const lines = vbox({xExpand: true, yAlign: Clutter.ActorAlign.CENTER});
        this.status = label('', 'ts-subheadline');
        this.detail = label('', 'ts-caption', {opacity: Opacity.secondary});
        lines.add_child(this.status);
        lines.add_child(this.detail);
        top.add_child(lines);
        this.body.add_child(top);

        const series = [{history: m.history.power, key: 'power', label: 'System'}];
        if (m.hasGpu) series.push({history: m.history.gpuPower, key: 'gpu', label: 'SoC', fill: false});
        this.graph = graphFor(ctx, series, {scale: {auto: v => niceMax(v, 10), format: v => `${v} W`}, format: v => Fmt.watts(v)});
        this.body.add_child(this.graph.actor);
        this.graphNote = label('', 'ts-caption2', {opacity: Opacity.tertiary, wrap: true});
        this.body.add_child(this.graphNote);

        const r1 = statRow([['draw', 'System draw'], ['soc', 'SoC package'], ['health', 'Health']]);
        const r2 = statRow([['energy', 'Energy'], ['cycles', 'Cycles'], ['volt', 'Voltage']]);
        this.tiles = {...r1.tiles, ...r2.tiles};
        this.body.add_child(r1.actor);
        this.body.add_child(r2.actor);

        this.periph = vbox({xExpand: true, styleClass: 'ts-periph'});
        this.body.add_child(this.periph);

        this.profileBox = vbox({styleClass: 'ts-profile-box', xExpand: true});
        this.profileBox.add_child(label('POWER MODE', 'ts-stat-caption', {opacity: Opacity.secondary}));
        this.profiles = new Segmented(PROFILE_DEFS, id => ctx.profiles.set(id), {styleClass: 'ts-seg-wide'});
        this.profileBox.add_child(this.profiles.actor);
        this.degraded = label('', 'ts-caption2', {opacity: Opacity.secondary, wrap: true});
        this.profileBox.add_child(this.degraded);
        this.body.add_child(this.profileBox);
        this.syncProfiles();
    }

    syncProfiles() {
        const p = this.ctx.profiles;
        this.profileBox.visible = !!p?.active;
        if (!p?.active) return;
        this.profiles.select(p.active);
        this.degraded.text = p.degraded ? `Performance limited: ${p.degraded.replace(/-/g, ' ')}` : '';
        this.degraded.visible = !!p.degraded;
    }

    updateHeadline(m) {
        const b = m.battery;
        this.headline.text = b ? Fmt.pct(b.pct) : '';
        this.headline.style = `color: ${Palette.css(Palette.batteryKey(b))};`;
        if (b) this.titleIcon.gicon = gicon(batteryIconName(b));
    }

    update(m) {
        const b = m.battery;
        const g = m.gpu;
        this.graph.update();
        this.tiles.soc.text = Fmt.watts(g?.powerW);
        if (!b) return;
        this.big.text = Fmt.pct(b.pct);
        this.big.style = `color: ${Palette.css(Palette.batteryKey(b))};`;
        if (b.discharging) {
            this.status.text = 'On battery';
            this.detail.text = Number.isFinite(b.hoursLeft) ? `${Fmt.hours(b.hoursLeft)} left at ${Fmt.watts(b.avgPowerW)}` : 'Estimating time left…';
        } else if (b.charging) {
            this.status.text = 'Charging';
            this.detail.text = Number.isFinite(b.hoursLeft) ? `Full in ${Fmt.hours(b.hoursLeft)} · +${Fmt.watts(b.powerW)}` : `+${Fmt.watts(b.powerW)}`;
        } else {
            this.status.text = b.pct >= 99 ? 'Fully charged' : 'Plugged in';
            this.detail.text = b.pct >= 99 ? 'Running on AC power' : 'Not charging (charge limit or hold)';
        }
        this.tiles.draw.text = b.discharging ? Fmt.watts(b.powerW) : 'On AC';
        this.tiles.health.text = Number.isFinite(b.healthPct) ? `${Math.round(b.healthPct)}%` : '—';
        this.tiles.energy.text = Number.isFinite(b.energyFull) ? `${b.energyNow.toFixed(1)} / ${b.energyFull.toFixed(1)} Wh` : '—';
        this.tiles.cycles.text = Number.isFinite(b.cycles) && b.cycles > 0 ? String(b.cycles) : '—';
        this.tiles.volt.text = Number.isFinite(b.voltage) ? `${b.voltage.toFixed(2)} V` : '—';
        this.graphNote.text = b.discharging ? '' : 'System draw is measured on battery; on AC the line shows only the SoC package.';
        this.graphNote.visible = !b.discharging;

        this.periph.destroy_all_children();
        for (const p of b.peripherals) {
            const row = hbox({styleClass: 'ts-periph-row', xExpand: true});
            row.add_child(icon(p.pct <= 20 ? 'battery-level-20-symbolic' : 'battery-level-80-symbolic', 'ts-small-icon', {opacity: Opacity.secondary}));
            row.add_child(label(p.name, 'ts-caption', {xExpand: true, ellipsize: true}));
            row.add_child(label(`${Math.round(p.pct)}%`, 'ts-caption'));
            this.periph.add_child(row);
        }
    }
}

export function batteryIconName(b) {
    const level = Math.min(100, Math.max(0, Math.round(b.pct / 10) * 10));
    if (b.acOnline && level === 100 && !b.charging) return 'battery-level-100-charged-symbolic';
    return `battery-level-${level}${b.charging ? '-charging' : ''}-symbolic`;
}

// ---- network ---------------------------------------------------------------

function ratePair(ctx, {down, up, downKey, upKey}) {
    const row = hbox({styleClass: 'ts-rate-row', xExpand: true});
    const mk = (arrow, caption, key) => {
        const box = vbox({xExpand: true});
        const top = hbox();
        const a = label(arrow, 'ts-rate-arrow');
        a.style = `color: ${Palette.css(key)};`;
        top.add_child(a);
        const v = label('—', 'ts-rate-value');
        top.add_child(v);
        box.add_child(top);
        box.add_child(label(caption.toUpperCase(), 'ts-stat-caption', {opacity: Opacity.secondary}));
        row.add_child(box);
        return v;
    };
    return {actor: row, down: mk('↓', down, downKey), up: mk('↑', up, upKey)};
}

export class NetworkCard extends Card {
    constructor(ctx) {
        super(ctx, {id: 'network', title: 'Network', iconName: 'network-transmit-receive-symbolic', hue: 'netRx', pin: 'network'});
        const m = ctx.monitor;
        this.rates = ratePair(ctx, {down: 'Download', up: 'Upload', downKey: 'netRx', upKey: 'netTx'});
        this.body.add_child(this.rates.actor);
        this.graph = graphFor(ctx, [
            {history: m.history.netRx, key: 'netRx', label: '↓'},
            {history: m.history.netTx, key: 'netTx', label: '↑', fill: false},
        ], {scale: rateScale, format: v => Fmt.rate(v)});
        this.body.add_child(this.graph.actor);
        const s = statRow([['iface', 'Interface'], ['signal', 'Wi-Fi signal'], ['session', 'This session']]);
        this.tiles = s.tiles;
        this.body.add_child(s.actor);
    }

    updateHeadline(m) {
        this.headline.text = `↓ ${Fmt.rateShort(m.net.rx)}`;
    }

    update(m) {
        const n = m.net;
        this.rates.down.text = Fmt.rate(n.rx);
        this.rates.up.text = Fmt.rate(n.tx);
        this.graph.update();
        this.tiles.iface.text = n.iface ?? '—';
        this.tiles.signal.text = n.wifi ? `${Math.round(n.wifi.quality)}% · ${Math.round(n.wifi.dbm)} dBm` : '—';
        this.tiles.session.text = `${Fmt.bytes(n.rxSession + n.txSession)}`;
    }
}

// ---- storage ---------------------------------------------------------------

export class StorageCard extends Card {
    constructor(ctx) {
        super(ctx, {id: 'storage', title: 'Storage', iconName: 'drive-harddisk-solidstate-symbolic', hue: 'diskRead', pin: 'disk'});
        const m = ctx.monitor;
        this.rates = ratePair(ctx, {down: 'Read', up: 'Write', downKey: 'diskRead', upKey: 'diskWrite'});
        this.body.add_child(this.rates.actor);
        this.graph = graphFor(ctx, [
            {history: m.history.diskRead, key: 'diskRead', label: 'R'},
            {history: m.history.diskWrite, key: 'diskWrite', label: 'W', fill: false},
        ], {scale: rateScale, format: v => Fmt.rate(v)});
        this.body.add_child(this.graph.actor);
        this.mounts = vbox({styleClass: 'ts-mounts', xExpand: true});
        this.body.add_child(this.mounts);
        this._mountRows = new Map();
    }

    updateHeadline(m) {
        const root = m.disk.mounts.find(x => x.mount === '/');
        this.headline.text = root ? `${Fmt.bytes(root.free)} free` : '';
    }

    update(m) {
        this.rates.down.text = Fmt.rate(m.disk.read);
        this.rates.up.text = Fmt.rate(m.disk.write);
        this.graph.update();
        const keys = new Set(m.disk.mounts.map(x => x.dev));
        for (const [k, row] of this._mountRows) {
            if (!keys.has(k)) {
                row.box.destroy();
                this._mountRows.delete(k);
            }
        }
        for (const mt of m.disk.mounts) {
            let row = this._mountRows.get(mt.dev);
            if (!row) {
                const box = vbox({styleClass: 'ts-meter', xExpand: true});
                const line = hbox({xExpand: true});
                const name = label('', 'ts-meter-name', {xExpand: true, ellipsize: true});
                const value = label('', 'ts-meter-value');
                line.add_child(name);
                line.add_child(value);
                box.add_child(line);
                const bar = new Bar({height: 6});
                box.add_child(bar.actor);
                this.mounts.add_child(box);
                row = {box, name, value, bar};
                this._mountRows.set(mt.dev, row);
            }
            const f = mt.used / mt.size;
            row.name.text = `${mt.label}  ·  ${mt.fs}`;
            row.value.text = `${Fmt.bytes(mt.free)} free of ${Fmt.bytes(mt.size)}`;
            row.bar.set([{fraction: f, key: Palette.usageKey(f, 'diskRead')}]);
        }
    }
}

// ---- sensors ---------------------------------------------------------------

export class SensorsCard extends Card {
    constructor(ctx) {
        super(ctx, {id: 'sensors', title: 'Temperatures', iconName: 'ts-temp-symbolic', hue: 'orange', pin: 'temp'});
        this.rows = vbox({styleClass: 'ts-sensor-rows', xExpand: true});
        this.body.add_child(this.rows);
        this._rows = new Map();
    }

    updateHeadline(m) {
        this.headline.text = Fmt.temp(m.cpu.temp, this.ctx.unit);
        this.headline.style = `color: ${Palette.css(Palette.tempKey(m.cpu.temp))};`;
    }

    update(m) {
        for (const s of m.temps) {
            let row = this._rows.get(s.label);
            if (!row) {
                const box = hbox({styleClass: 'ts-sensor-row', xExpand: true});
                const name = label(s.label, 'ts-sensor-name');
                const bar = new Bar({height: 6});
                const value = label('', 'ts-sensor-value');
                box.add_child(name);
                box.add_child(bar.actor);
                box.add_child(value);
                this.rows.add_child(box);
                row = {value, bar};
                this._rows.set(s.label, row);
            }
            row.value.text = Fmt.temp(s.c, this.ctx.unit);
            row.value.style = `color: ${Palette.css(Palette.tempKey(s.c))};`;
            row.bar.set([{fraction: s.c / 100, key: Palette.tempKey(s.c)}]);
        }
    }
}

// ---- processes -------------------------------------------------------------

const PROCESS_ROWS = 6;

export class ProcessesCard extends Card {
    constructor(ctx) {
        super(ctx, {id: 'processes', title: 'Top apps', iconName: 'view-list-symbolic', hue: 'cpu'});
        const bar = hbox({xExpand: true, styleClass: 'ts-proc-bar'});
        bar.add_child(label('Grouped by app · click to switch to it', 'ts-caption2', {opacity: Opacity.tertiary, xExpand: true}));
        this.sort = new Segmented([
            {id: 'cpu', label: 'CPU'},
            {id: 'memory', label: 'Memory'},
        ], id => {
            ctx.setProcessSort(id);
            this.sort.select(id);
            this.update(ctx.monitor);
        }, {styleClass: 'ts-seg-small'});
        this.sort.select(ctx.processSort);
        bar.add_child(this.sort.actor);
        this.body.add_child(bar);

        this.list = vbox({styleClass: 'ts-proc-list', xExpand: true});
        this.body.add_child(this.list);
        this._rows = [];
        for (let i = 0; i < PROCESS_ROWS; i++) this._rows.push(this._makeRow());
        this.waiting = label('Measuring…', 'ts-caption', {opacity: Opacity.secondary});
        this.body.add_child(this.waiting);
    }

    _makeRow() {
        const content = hbox({styleClass: 'ts-proc-row-content', xExpand: true});
        const ic = new St.Icon({style_class: 'ts-proc-icon', y_align: Clutter.ActorAlign.CENTER});
        const name = label('', 'ts-proc-name', {ellipsize: true});
        const count = label('', 'ts-caption2', {opacity: Opacity.tertiary, xExpand: true, ellipsize: true});
        const value = label('', 'ts-proc-value');
        content.add_child(ic);
        content.add_child(name);
        content.add_child(count);
        content.add_child(value);

        const stack = vbox({styleClass: 'ts-proc-stack', xExpand: true});
        const bar = new Bar({height: 3});
        stack.add_child(content);
        stack.add_child(bar.actor);

        const row = {group: null};
        const b = button({child: stack, styleClass: 'ts-proc-row', xExpand: true, onClick: () => {
            if (row.group?.app) this.ctx.activateApp(row.group.app);
        }});
        this.list.add_child(b);
        Object.assign(row, {button: b, icon: ic, name, count, value, bar});
        return row;
    }

    updateHeadline(m) {
        const top = [...m.processes].sort((a, b) => b.cpu - a.cpu)[0];
        this.headline.text = top && m.processesReady ? top.name : '';
    }

    update(m) {
        const byMem = this.ctx.processSort === 'memory';
        const groups = [...m.processes].sort((a, b) => (byMem ? b.mem - a.mem : b.cpu - a.cpu)).slice(0, PROCESS_ROWS);
        this.waiting.visible = !m.processesReady && !byMem;
        const maxV = byMem ? m.memory.total : 100;
        this._rows.forEach((row, i) => {
            const g = groups[i];
            row.button.visible = !!g && (byMem || m.processesReady);
            if (!g) return;
            row.group = g;
            if (g.app) row.icon.gicon = g.app.get_icon();
            else row.icon.gicon = gicon(g.key === 'kernel' ? 'ts-cpu-symbolic' : 'application-x-executable-symbolic');
            row.icon.opacity = g.app ? 255 : Opacity.secondary;
            row.name.text = g.name;
            row.count.text = g.count > 1 ? `${g.count} processes` : '';
            row.value.text = byMem ? Fmt.bytes(g.mem) : `${g.cpu < 10 ? g.cpu.toFixed(1) : Math.round(g.cpu)}%`;
            const f = byMem ? g.mem / maxV : g.cpu / maxV;
            row.bar.set([{fraction: byMem ? f : Math.min(1, f), key: byMem ? 'memory' : 'cpu', alpha: 0.8}]);
            row.button.reactive = !!g.app;
        });
    }
}
