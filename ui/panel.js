// SPDX-License-Identifier: GPL-2.0-or-later
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {Fmt, niceRateMax} from '../lib/format.js';
import {Palette, Ring, Graph, icon, hbox, label, gicon} from './widgets.js';
import {batteryIconName} from './cards.js';

/**
 * What each top-bar metric shows. `fraction` drives the ring, `history` the
 * mini graph, `text` the value label, `hue` the color (may depend on state).
 */
export const METRICS = {
    cpu: {
        name: 'CPU', glyph: 'ts-cpu-symbolic', width: 'pct',
        hue: m => Palette.usageKey(m.cpu.pct / 100, 'cpu'),
        fraction: m => m.cpu.pct / 100,
        text: m => Fmt.pct(m.cpu.pct),
        history: ['cpu'],
    },
    gpu: {
        name: 'GPU', glyph: 'ts-gpu-symbolic', width: 'pct', needs: 'gpu',
        hue: () => 'gpu',
        fraction: m => m.gpu?.busy / 100,
        text: m => Fmt.pct(m.gpu?.busy),
        history: ['gpu'],
    },
    memory: {
        name: 'Memory', glyph: 'ts-memory-symbolic', width: 'pct',
        hue: m => Palette.usageKey(m.memory.pct / 100, 'memory'),
        fraction: m => m.memory.pct / 100,
        text: m => Fmt.pct(m.memory.pct),
        history: ['memory'],
    },
    swap: {
        name: 'Swap', glyph: 'ts-memory-symbolic', width: 'pct',
        hue: () => 'swap',
        fraction: m => m.memory.swapPct / 100,
        text: m => Fmt.pct(m.memory.swapPct),
        history: ['swap'],
    },
    temp: {
        name: 'CPU temperature', glyph: 'ts-temp-symbolic', width: 'temp',
        hue: m => Palette.tempKey(m.cpu.temp),
        fraction: m => m.cpu.temp / 100,
        text: (m, ctx) => Fmt.temp(m.cpu.temp, ctx.unit, {short: true}),
        history: ['cpuTemp'], max: 100,
    },
    power: {
        name: 'Power draw', glyph: 'ts-bolt-symbolic', width: 'watts',
        hue: () => 'power',
        // On battery: whole-system draw. On AC the battery can't see it, so
        // fall back to the SoC package power the GPU driver reports.
        value: m => (m.battery?.discharging ? m.battery.powerW : m.gpu?.powerW),
        fraction: m => METRICS.power.value(m) / 40,
        text: m => {
            const v = METRICS.power.value(m);
            return Number.isFinite(v) ? `${v.toFixed(v < 10 ? 1 : 0)} W` : '—';
        },
        history: m => (m.battery?.discharging ? ['power'] : ['gpuPower']), max: 'auto',
    },
    battery: {
        name: 'Battery', glyph: 'battery-level-80-symbolic', width: 'pct', needs: 'battery',
        hue: m => Palette.batteryKey(m.battery),
        fraction: m => m.battery?.pct / 100,
        text: m => Fmt.pct(m.battery?.pct),
        history: ['battery'],
        dynamicGlyph: m => (m.battery ? batteryIconName(m.battery) : null),
    },
    network: {
        name: 'Network', glyph: 'ts-net-symbolic', width: 'rates', noRing: true,
        hue: () => 'netRx',
        text: m => `↓${Fmt.rateShort(m.net.rx)} ↑${Fmt.rateShort(m.net.tx)}`,
        history: ['netRx', 'netTx'], max: 'rate',
    },
    disk: {
        name: 'Disk activity', glyph: 'ts-disk-symbolic', width: 'rates', noRing: true,
        hue: () => 'diskRead',
        text: m => `R ${Fmt.rateShort(m.disk.read)} W ${Fmt.rateShort(m.disk.write)}`,
        history: ['diskRead', 'diskWrite'], max: 'rate',
    },
};

export const METRIC_ORDER = ['cpu', 'gpu', 'memory', 'swap', 'temp', 'power', 'battery', 'network', 'disk'];

const HISTORY_KEYS = {cpu: 'cpu', gpu: 'gpu', memory: 'memory', swap: 'swap', cpuTemp: 'cpuTemp', power: 'power', gpuPower: 'gpuPower', battery: 'battery', netRx: 'netRx', netTx: 'netTx', diskRead: 'diskRead', diskWrite: 'diskWrite'};

/** One metric in the top bar, drawn in the chosen style. */
class Indicator {
    constructor(id, {style, showValue, ctx, panelDark}) {
        this.id = id;
        this.def = METRICS[id];
        this.ctx = ctx;
        this.actor = hbox({styleClass: `ts-ind ts-ind-${style}`, yAlign: Clutter.ActorAlign.CENTER});
        this.actor.accessible_name = this.def.name;

        const useRing = style === 'rings' && !this.def.noRing;
        if (useRing) {
            this._glyph = icon(this.def.glyph, 'ts-ind-ring-glyph');
            this.ring = new Ring(20, {lineWidth: 2.2, center: this._glyph, dark: panelDark});
            this.actor.add_child(this.ring.actor);
        } else {
            this._glyph = icon(this.def.glyph, 'ts-ind-glyph');
            this.actor.add_child(this._glyph);
        }
        if (style === 'graphs') {
            const keys = typeof this.def.history === 'function' ? ['power'] : this.def.history;
            this._graphCtx = {monitor: ctx.monitor, range: 60};
            this.graph = new Graph({
                ctx: this._graphCtx, mini: true, height: 18, dark: panelDark,
                series: keys.map((k, i) => ({history: ctx.monitor.history[HISTORY_KEYS[k]], key: i === 0 ? this.def.hue(ctx.monitor) : 'netTx', fill: i === 0})),
                scale: this.def.max === 'rate' ? {auto: v => niceRateMax(v), format: () => ''}
                    : this.def.max === 'auto' ? {auto: v => Math.max(10, v * 1.15), format: () => ''}
                        : {max: this.def.max ?? 100},
            });
            this.graph.actor.width = 34;
            this.graph.actor.y_align = Clutter.ActorAlign.CENTER;
            this.graph.actor.add_style_class_name('ts-ind-graph');
            this.actor.add_child(this.graph.actor);
            if (id === 'network' || id === 'disk') this.graph.series[1].key = id === 'network' ? 'netTx' : 'diskWrite';
        }
        if (showValue) {
            this.value = label('', `ts-ind-value ts-w-${this.def.width}`);
            this.actor.add_child(this.value);
        }
    }

    update(m) {
        const d = this.def;
        const hue = d.hue(m);
        if (this.ring) this.ring.set(d.fraction(m), hue);
        if (this.graph) {
            if (typeof d.history === 'function') {
                const k = d.history(m)[0];
                this.graph.series[0].history = m.history[k];
            }
            if (d.id !== 'network' && d.id !== 'disk') this.graph.series[0].key = hue;
            this.graph.update();
        }
        if (d.dynamicGlyph) {
            const name = d.dynamicGlyph(m);
            if (name && name !== this._glyphName) {
                this._glyph.gicon = gicon(name);
                this._glyphName = name;
            }
        }
        if (this.value) {
            // Re-setting identical text still relayouts the top bar; skip it.
            const text = d.text(m, this.ctx);
            if (text !== this.value.text) this.value.text = text;
        }
    }
}

/** The top-bar button: a row of pinned metric indicators. */
export const TouchyStatsButton = GObject.registerClass(
class TouchyStatsButton extends PanelMenu.Button {
    _init(ctx) {
        super._init(0.5, 'TouchyStats', false);
        this._ctx = ctx;
        this._box = hbox({styleClass: 'ts-panel-box', yAlign: Clutter.ActorAlign.CENTER});
        this.add_child(this._box);
        this.accessible_name = 'TouchyStats system monitor';
        this._indicators = [];
    }

    /** Rebuild the indicator row for the current settings. */
    rebuild({metrics, style, showValue}) {
        this._box.destroy_all_children();
        this._indicators = [];
        const m = this._ctx.monitor;
        const ids = metrics.filter(id => METRICS[id] && (METRICS[id].needs === 'gpu' ? m.hasGpu : METRICS[id].needs === 'battery' ? m.hasBattery : true));
        const panelDark = () => this._panelIsDark();
        for (const id of ids) {
            const ind = new Indicator(id, {style, showValue, ctx: this._ctx, panelDark});
            this._indicators.push(ind);
            this._box.add_child(ind.actor);
        }
        if (!ids.length) {
            // Nothing pinned: a single pulse glyph keeps the menu reachable.
            this._box.add_child(icon('ts-pulse-symbolic', 'system-status-icon'));
        }
        this.update(m);
    }

    _panelIsDark() {
        try {
            const c = this.get_theme_node().get_foreground_color();
            return (0.2126 * c.red + 0.7152 * c.green + 0.0722 * c.blue) / 255 > 0.5;
        } catch {
            return true;
        }
    }

    update(m) {
        for (const ind of this._indicators) ind.update(m);
    }
});

// Indicator.update checks d.id; give each def its own id.
for (const [id, def] of Object.entries(METRICS)) def.id = id;
