import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import Cairo from 'cairo';

import {Fmt} from '../lib/format.js';

/**
 * Shared visual vocabulary (same idiom as TouchyWeather's widgets.js): St
 * builders for the card chrome, plus Cairo-drawn rings, graphs and bars that
 * update in place — the popover never rebuilds while it's open.
 */

// ---- palette ---------------------------------------------------------------

function hex(h, a = 1) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255, a];
}

/** Each metric owns one hue: a bright variant for dark surfaces, a deep one for light. */
const HUES = {
    cpu: ['#62a0ea', '#1c71d8'],
    gpu: ['#c061cb', '#813d9c'],
    memory: ['#57e389', '#26a269'],
    swap: ['#a8f0c0', '#2ec27e'],
    battery: ['#f6d32d', '#b37f00'],
    power: ['#f6d32d', '#b37f00'],
    netRx: ['#4dd0e1', '#0b7f93'],
    netTx: ['#ffa348', '#c64600'],
    diskRead: ['#ff7eb6', '#c01c5c'],
    diskWrite: ['#ffbe6f', '#a05000'],
    green: ['#57e389', '#26a269'],
    yellow: ['#f6d32d', '#b37f00'],
    orange: ['#ffa348', '#c64600'],
    red: ['#ff6b6b', '#c01c28'],
};

export const Palette = {
    dark: true,

    get(key, alpha = 1, dark = this.dark) {
        const h = HUES[key] ?? HUES.cpu;
        return hex(dark ? h[0] : h[1], alpha);
    },

    css(key, dark = this.dark) {
        const h = HUES[key] ?? HUES.cpu;
        return dark ? h[0] : h[1];
    },

    /** Temperatures: calm green → warm yellow → orange → red. */
    tempKey(c) {
        if (!Number.isFinite(c) || c < 55) return 'green';
        if (c < 72) return 'yellow';
        if (c < 88) return 'orange';
        return 'red';
    },

    /** Battery ring: its own hue, warming as it drains, green on the charger. */
    batteryKey(b) {
        if (!b) return 'battery';
        if (b.charging || (b.acOnline && b.pct >= 99)) return 'green';
        if (b.pct <= 10) return 'red';
        if (b.pct <= 20) return 'orange';
        return 'battery';
    },

    usageKey(fraction, base) {
        if (fraction >= 0.95) return 'red';
        if (fraction >= 0.85) return 'orange';
        return base;
    },
};

export const Opacity = {primary: 255, secondary: 168, tertiary: 110};

// ---- icons -----------------------------------------------------------------

let iconDir = null;

/** Called from enable(): our own symbolic glyphs live in <ext>/icons. */
export function setIconDir(dir) {
    iconDir = dir;
}

/** Theme icon name, or one of ours when prefixed "ts-". */
export function gicon(name) {
    if (name.startsWith('ts-') && iconDir)
        return Gio.FileIcon.new(Gio.File.new_for_path(`${iconDir}/${name}.svg`));
    return Gio.ThemedIcon.new(name);
}

// ---- basic builders --------------------------------------------------------

export function label(text, styleClass = '', {opacity = Opacity.primary, wrap = false, align = null, xExpand = false, yAlign = Clutter.ActorAlign.CENTER, ellipsize = false} = {}) {
    const l = new St.Label({text: text ?? '', style_class: styleClass, x_expand: xExpand});
    l.opacity = opacity;
    if (wrap) {
        l.clutter_text.line_wrap = true;
        l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    } else if (ellipsize) {
        l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    }
    if (align !== null) l.x_align = align;
    if (yAlign !== null) l.y_align = yAlign;
    return l;
}

export function icon(name, styleClass = '', {opacity = Opacity.primary, yAlign = Clutter.ActorAlign.CENTER} = {}) {
    const i = new St.Icon({gicon: gicon(name), style_class: styleClass, y_align: yAlign});
    i.opacity = opacity;
    return i;
}

export function hbox({styleClass = '', xExpand = false, yExpand = false, xAlign = null, yAlign = null, style = null} = {}) {
    const b = new St.BoxLayout({orientation: Clutter.Orientation.HORIZONTAL, style_class: styleClass, x_expand: xExpand, y_expand: yExpand});
    if (xAlign !== null) b.x_align = xAlign;
    if (yAlign !== null) b.y_align = yAlign;
    if (style) b.style = style;
    return b;
}

export function vbox({styleClass = '', xExpand = false, yExpand = false, xAlign = null, yAlign = null, style = null} = {}) {
    const b = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: styleClass, x_expand: xExpand, y_expand: yExpand});
    if (xAlign !== null) b.x_align = xAlign;
    if (yAlign !== null) b.y_align = yAlign;
    if (style) b.style = style;
    return b;
}

export function spacer() {
    return new St.Widget({x_expand: true});
}

export function button({child = null, styleClass = 'ts-icon-button', tooltip = null, onClick = null, iconName = null, iconClass = 'ts-button-icon', xExpand = false} = {}) {
    const b = new St.Button({style_class: styleClass, can_focus: true, reactive: true, track_hover: true, x_expand: xExpand});
    if (iconName) b.set_child(icon(iconName, iconClass));
    else if (child) b.set_child(child);
    if (tooltip) b.accessible_name = tooltip;
    if (onClick) b.connect('clicked', () => onClick());
    return b;
}

/** A St.DrawingArea with a paint callback (cr, w, h, area). */
export function drawingArea(width, height, paint, {xExpand = false, yExpand = false, reactive = false} = {}) {
    const area = new St.DrawingArea({x_expand: xExpand, y_expand: yExpand, reactive});
    if (width) area.set_width(width);
    if (height) area.set_height(height);
    area.connect('repaint', a => {
        const cr = a.get_context();
        const [w, h] = a.get_surface_size();
        try {
            paint(cr, w, h, a);
        } catch (e) {
            console.error(`TouchyStats: paint failed: ${e.message}`);
        } finally {
            cr.$dispose();
        }
    });
    return area;
}

/** The theme's foreground color as Cairo RGBA — adapts to light/dark shells. */
export function foreground(actor, alpha = 1) {
    try {
        const c = actor.get_theme_node().get_foreground_color();
        return [c.red / 255, c.green / 255, c.blue / 255, alpha];
    } catch {
        return Palette.dark ? [1, 1, 1, alpha] : [0, 0, 0, alpha];
    }
}

export function setSource(cr, rgba) {
    cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], rgba[3]);
}

export function roundedRect(cr, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

const clamp01 = v => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);

// ---- ring ------------------------------------------------------------------

/**
 * A progress ring with an optional centered actor (a glyph in the top bar,
 * the big number in the overview). Changes ease over ~450 ms when animated.
 */
export class Ring {
    constructor(size, {lineWidth = 3, animate = false, center = null, glow = false, dark = () => Palette.dark} = {}) {
        this.fraction = 0;
        this._shown = 0;
        this.colorKey = 'cpu';
        this._animate = animate;
        this._glow = glow;
        this.actor = new St.Widget({layout_manager: new Clutter.BinLayout(), width: size, height: size, y_align: Clutter.ActorAlign.CENTER});
        this._area = drawingArea(size, size, (cr, w, h, a) => {
            const r = Math.min(w, h) / 2 - lineWidth / 2 - 0.5;
            const cx = w / 2, cy = h / 2;
            cr.setLineWidth(lineWidth);
            cr.setLineCap(Cairo.LineCap.ROUND);
            const isDark = dark();
            setSource(cr, foreground(a, isDark ? 0.2 : 0.13));
            cr.arc(cx, cy, r, 0, 2 * Math.PI);
            cr.stroke();
            const f = clamp01(this._shown);
            if (f <= 0.004) return;
            const end = -Math.PI / 2 + 2 * Math.PI * f;
            if (this._glow) {
                cr.setLineWidth(lineWidth * 2.2);
                setSource(cr, Palette.get(this.colorKey, 0.16, isDark));
                cr.arc(cx, cy, r, -Math.PI / 2, end);
                cr.stroke();
                cr.setLineWidth(lineWidth);
            }
            setSource(cr, Palette.get(this.colorKey, 1, isDark));
            cr.arc(cx, cy, r, -Math.PI / 2, end);
            cr.stroke();
        });
        this.actor.add_child(this._area);
        if (center) {
            center.x_align = Clutter.ActorAlign.CENTER;
            center.y_align = Clutter.ActorAlign.CENTER;
            this.actor.add_child(center);
        }
    }

    set(fraction, colorKey = this.colorKey) {
        fraction = clamp01(fraction);
        const colorChanged = colorKey !== this.colorKey;
        this.colorKey = colorKey;
        if (!this._animate || !this.actor.mapped) {
            // Under half a degree of arc is invisible: don't redraw for it.
            if (Math.abs(fraction - this.fraction) < 0.0015 && !colorChanged) return;
            this.fraction = this._shown = fraction;
            this._area.queue_repaint();
            return;
        }
        if (Math.abs(fraction - this.fraction) < 0.002 && !colorChanged) return;
        const from = this._shown;
        this.fraction = fraction;
        this._timeline?.stop();
        this._timeline = new Clutter.Timeline({actor: this._area, duration: 450});
        this._timeline.set_progress_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
        this._timeline.connect('new-frame', tl => {
            this._shown = from + (fraction - from) * tl.get_progress();
            this._area.queue_repaint();
        });
        this._timeline.connect('completed', () => {
            this._shown = fraction;
            this._area.queue_repaint();
        });
        this._timeline.start();
    }

    repaint() {
        this._area.queue_repaint();
    }
}

// ---- graph -----------------------------------------------------------------

/**
 * A time-series graph over the shared range: smooth filled areas (first
 * series) and lines, a faint grid, an auto-scale caption, and a scrub
 * readout on hover or touch that shows every series at that moment.
 */
export class Graph {
    /**
     * series: [{history, key, fill = true, label}]
     * scale: {max: number} fixed, or {auto: v => niceMax, format: v => str}
     * format: v => readout string
     */
    constructor({series, height = 56, scale = {max: 100}, format = Fmt.pct, ctx, mini = false, dark = () => Palette.dark}) {
        this.series = series;
        this._dark = dark;
        this.scale = scale;
        this.format = format;
        this.ctx = ctx;           // {monitor, range: seconds}
        this.mini = mini;
        this._hoverX = null;
        this._max = scale.max ?? 1;

        this.actor = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: !mini, height, style_class: mini ? '' : 'ts-graph'});
        this._area = drawingArea(0, height, (cr, w, h, a) => this._paint(cr, w, h, a), {xExpand: true, yExpand: true, reactive: !mini});
        this.actor.add_child(this._area);

        if (!mini) {
            // Overlays are boxes filling the graph: BinLayout doesn't honor a
            // child's START/END alignment here, a BoxLayout's packing does.
            const scaleRow = hbox({xExpand: true, yExpand: true});
            scaleRow.add_child(spacer());
            this._scaleLabel = label('', 'ts-graph-scale', {opacity: Opacity.tertiary, yAlign: Clutter.ActorAlign.START});
            scaleRow.add_child(this._scaleLabel);
            this.actor.add_child(scaleRow);

            const tipRow = hbox({xExpand: true, yExpand: true});
            this._tip = label('', 'ts-graph-tip', {yAlign: Clutter.ActorAlign.START});
            this._tip.visible = false;
            tipRow.add_child(this._tip);
            this.actor.add_child(tipRow);

            this._area.connect('motion-event', (_a, ev) => this._pointer(ev));
            this._area.connect('leave-event', () => this._setHover(null));
            this._area.connect('touch-event', (_a, ev) => {
                const type = ev.type();
                if (type === Clutter.EventType.TOUCH_BEGIN || type === Clutter.EventType.TOUCH_UPDATE) {
                    this._pointer(ev);
                } else {
                    if (this._touchClear) GLib.source_remove(this._touchClear);
                    this._touchClear = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1600, () => {
                        this._touchClear = 0;
                        this._setHover(null);
                        return GLib.SOURCE_REMOVE;
                    });
                }
                return Clutter.EVENT_PROPAGATE;
            });
            this.actor.connect('destroy', () => {
                if (this._touchClear) GLib.source_remove(this._touchClear);
            });
        }
    }

    _pointer(ev) {
        const [sx, sy] = ev.get_coords();
        const [ok, x] = this._area.transform_stage_point(sx, sy);
        if (ok) this._setHover(x);
        return Clutter.EVENT_PROPAGATE;
    }

    _setHover(x) {
        this._hoverX = x;
        this.update();
    }

    update() {
        const range = this.ctx.range;
        const since = this.ctx.monitor.time - range;
        if (this.scale.auto) {
            let m = 0;
            for (const s of this.series) m = Math.max(m, s.history.maxSince(since));
            this._max = this.scale.auto(Number.isFinite(m) ? m : 0);
            if (this._scaleLabel) this._scaleLabel.text = this.scale.format(this._max);
        }
        if (this._tip) this._updateTip();
        this._area.queue_repaint();
    }

    _updateTip() {
        const w = this._area.width;
        if (this._hoverX === null || w <= 0) {
            this._tip.visible = false;
            if (this._scaleLabel) this._scaleLabel.visible = true;
            return;
        }
        const x = Math.min(Math.max(this._hoverX, 0), w);
        const ago = (1 - x / w) * this.ctx.range;
        const t = this.ctx.monitor.time - ago;
        const parts = [];
        for (const s of this.series) {
            const v = s.history.valueAt(t);
            if (!Number.isFinite(v)) continue;
            parts.push(`${s.label ? `${s.label} ` : ''}${this.format(v)}`);
        }
        if (!parts.length) {
            this._tip.visible = false;
            return;
        }
        this._tip.text = `${parts.join('  ·  ')}   ${Fmt.ago(ago)}`;
        this._tip.visible = true;
        if (this._scaleLabel) this._scaleLabel.visible = false;
        const [, natW] = this._tip.get_preferred_width(-1);
        this._tip.translation_x = Math.round(Math.min(Math.max(x - natW / 2, 0), Math.max(0, w - natW)));
    }

    _paint(cr, w, h, a) {
        const monitor = this.ctx.monitor;
        const range = this.ctx.range;
        const tNow = monitor.time;
        const since = tNow - range - monitor.interval;
        const top = this.mini ? 1 : 3, bottom = h - 1;
        const max = this._max || 1;
        const X = t => w * (1 - (tNow - t) / range);
        const Y = v => bottom - (bottom - top) * Math.min(Math.max(v / max, 0), 1);

        if (!this.mini) {
            cr.setLineWidth(1);
            setSource(cr, foreground(a, 0.07));
            for (const f of [0.25, 0.5, 0.75]) {
                const y = Math.round(bottom - (bottom - top) * f) + 0.5;
                cr.moveTo(0, y);
                cr.lineTo(w, y);
            }
            cr.stroke();
            setSource(cr, foreground(a, 0.14));
            cr.moveTo(0, bottom + 0.5);
            cr.lineTo(w, bottom + 0.5);
            cr.stroke();
        }

        this.series.forEach((s, idx) => {
            const pts = [];
            s.history.forEachSince(since, (t, v) => {
                if (Number.isFinite(v)) pts.push([X(t), Y(v)]);
            });
            if (pts.length < 2) return;
            const path = () => {
                cr.moveTo(pts[0][0], pts[0][1]);
                for (let i = 1; i < pts.length; i++) {
                    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
                    const mx = (x0 + x1) / 2;
                    cr.curveTo(mx, y0, mx, y1, x1, y1);
                }
            };
            const color = Palette.get(s.key, 1, this._dark());
            if (s.fill ?? idx === 0) {
                path();
                cr.lineTo(pts[pts.length - 1][0], bottom);
                cr.lineTo(pts[0][0], bottom);
                cr.closePath();
                const grad = new Cairo.LinearGradient(0, top, 0, bottom);
                grad.addColorStopRGBA(0, color[0], color[1], color[2], this.mini ? 0.45 : 0.38);
                grad.addColorStopRGBA(1, color[0], color[1], color[2], 0.04);
                cr.setSource(grad);
                cr.fill();
            }
            path();
            setSource(cr, color);
            cr.setLineWidth(this.mini ? 1.2 : 1.6);
            cr.setLineJoin(Cairo.LineJoin.ROUND);
            if (s.dash) cr.setDash([3, 3], 0);
            cr.stroke();
            cr.setDash([], 0);
        });

        if (this._hoverX !== null && !this.mini) {
            const x = Math.min(Math.max(this._hoverX, 0), w);
            const t = tNow - (1 - x / w) * range;
            setSource(cr, foreground(a, 0.35));
            cr.setLineWidth(1);
            cr.moveTo(Math.round(x) + 0.5, top);
            cr.lineTo(Math.round(x) + 0.5, bottom);
            cr.stroke();
            for (const s of this.series) {
                const v = s.history.valueAt(t);
                if (!Number.isFinite(v)) continue;
                cr.arc(x, Y(v), 3.2, 0, 2 * Math.PI);
                setSource(cr, Palette.get(s.key));
                cr.fillPreserve();
                setSource(cr, Palette.dark ? [0.12, 0.12, 0.14, 1] : [1, 1, 1, 1]);
                cr.setLineWidth(1.2);
                cr.stroke();
            }
        }
    }
}

// ---- bars ------------------------------------------------------------------

/** A rounded horizontal bar built from segments [{fraction, key, alpha}]. */
export class Bar {
    constructor({height = 6, xExpand = true, width = 0} = {}) {
        this.segments = [];
        this.actor = drawingArea(width, height, (cr, w, h, a) => {
            roundedRect(cr, 0, 0, w, h, h / 2);
            setSource(cr, foreground(a, Palette.dark ? 0.12 : 0.1));
            cr.fill();
            let x = 0;
            cr.save();
            roundedRect(cr, 0, 0, w, h, h / 2);
            cr.clip();
            for (const s of this.segments) {
                const sw = w * clamp01(s.fraction);
                if (sw <= 0) continue;
                setSource(cr, Palette.get(s.key, s.alpha ?? 1));
                // Tiny gap between segments reads as a divider on both themes.
                cr.rectangle(x, 0, Math.max(0, sw - (s.gap ? 1.5 : 0)), h);
                cr.fill();
                x += sw;
            }
            cr.restore();
        }, {xExpand});
        this.actor.y_align = Clutter.ActorAlign.CENTER;
    }

    set(segments) {
        this.segments = segments;
        this.actor.queue_repaint();
    }
}

/** Per-thread vertical bars (one DrawingArea for all of them). */
export class CoreBars {
    constructor(height = 34) {
        this.values = [];
        this.actor = drawingArea(0, height, (cr, w, h, a) => {
            const n = this.values.length || 1;
            const gap = n > 24 ? 2 : 3;
            const bw = (w - gap * (n - 1)) / n;
            this.values.forEach((v, i) => {
                const x = i * (bw + gap);
                roundedRect(cr, x, 0, bw, h, Math.min(3, bw / 2));
                setSource(cr, foreground(a, Palette.dark ? 0.09 : 0.08));
                cr.fill();
                const f = clamp01(v / 100);
                if (f <= 0) return;
                const bh = Math.max(2, h * f);
                roundedRect(cr, x, h - bh, bw, bh, Math.min(3, bw / 2));
                setSource(cr, Palette.get(v >= 90 ? 'orange' : 'cpu', 0.35 + 0.65 * f));
                cr.fill();
            });
        }, {xExpand: true});
    }

    set(values) {
        this.values = values;
        this.actor.queue_repaint();
    }
}

// ---- segmented control -----------------------------------------------------

/** A pill row of mutually exclusive options: [{id, label?, icon?, tooltip?}]. */
export class Segmented {
    constructor(options, onSelect, {styleClass = ''} = {}) {
        this.actor = hbox({styleClass: `ts-seg ${styleClass}`, yAlign: Clutter.ActorAlign.CENTER});
        this._buttons = new Map();
        for (const o of options) {
            const child = hbox({styleClass: 'ts-seg-content', xAlign: Clutter.ActorAlign.CENTER});
            if (o.icon) child.add_child(icon(o.icon, 'ts-seg-icon'));
            if (o.label) child.add_child(label(o.label, 'ts-seg-label'));
            const b = button({child, styleClass: 'ts-seg-button', tooltip: o.tooltip ?? o.label, xExpand: true, onClick: () => onSelect(o.id)});
            this._buttons.set(o.id, b);
            this.actor.add_child(b);
        }
    }

    select(id) {
        for (const [k, b] of this._buttons) {
            if (k === id) b.add_style_pseudo_class('checked');
            else b.remove_style_pseudo_class('checked');
        }
    }
}

// ---- stat tiles ------------------------------------------------------------

/** A caption-over-value tile; returns {actor, value}. */
export function stat(caption, {xExpand = true} = {}) {
    const box = vbox({styleClass: 'ts-stat', xExpand});
    box.add_child(label(caption.toUpperCase(), 'ts-stat-caption', {opacity: Opacity.secondary}));
    const value = label('—', 'ts-stat-value');
    box.add_child(value);
    return {actor: box, value};
}

/** A row of stat tiles; returns {actor, tiles: {key: valueLabel}}. */
export function statRow(defs) {
    const row = hbox({styleClass: 'ts-stat-row', xExpand: true});
    const tiles = {};
    for (const [key, caption] of defs) {
        const s = stat(caption);
        row.add_child(s.actor);
        tiles[key] = s.value;
    }
    return {actor: row, tiles};
}
