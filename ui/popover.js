import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Palette, Opacity, label, hbox, vbox, button} from './widgets.js';
import {
    OverviewCard, CpuCard, GpuCard, MemoryCard, BatteryCard,
    NetworkCard, StorageCard, SensorsCard, ProcessesCard,
} from './cards.js';

const MONITOR_APPS = ['net.nokyan.Resources.desktop', 'io.missioncenter.MissionCenter.desktop', 'org.gnome.SystemMonitor.desktop', 'gnome-system-monitor.desktop'];

/**
 * The popover: the overview rings, then a scrollable stack of collapsible
 * cards, then a footer. Built once per open (so a theme switch or a card
 * visibility change is picked up) and updated in place on every sample.
 */
export class Popover {
    constructor({monitor, settings, profiles, onOpenPrefs, closeMenu}) {
        this.monitor = monitor;
        this.settings = settings;
        this.profiles = profiles;
        this.onOpenPrefs = onOpenPrefs;
        this.closeMenu = closeMenu;
        this._cards = new Map();
        this._built = false;

        this._root = vbox({styleClass: 'ts-root', xExpand: true});
        this._section = new PopupMenu.PopupMenuSection();
        this._section.actor.add_child(this._root);

        const self = this;
        this.ctx = {
            monitor,
            profiles,
            get range() {
                return settings.get_uint('graph-range');
            },
            get unit() {
                return settings.get_string('temperature-unit');
            },
            get processSort() {
                return settings.get_string('process-sort');
            },
            setProcessSort: v => settings.set_string('process-sort', v),
            isPinned: m => settings.get_strv('panel-metrics').includes(m),
            togglePin: m => {
                const cur = settings.get_strv('panel-metrics');
                settings.set_strv('panel-metrics', cur.includes(m) ? cur.filter(x => x !== m) : [...cur, m]);
            },
            isCollapsed: id => settings.get_strv('collapsed-cards').includes(id),
            setCollapsed: (id, v) => {
                const cur = settings.get_strv('collapsed-cards').filter(x => x !== id);
                settings.set_strv('collapsed-cards', v ? [...cur, id] : cur);
            },
            scrollTo: card => self._scrollTo(card),
            activateApp: app => {
                self.closeMenu();
                app.activate();
            },
        };
    }

    get menuSection() {
        return this._section;
    }

    destroy() {
        this._section.destroy();
        this._cards.clear();
    }

    setOpen(open) {
        this._open = open;
        if (!open) return;
        const dark = Main.getStyleVariant?.() !== 'light';
        if (!this._built || dark !== Palette.dark) {
            Palette.dark = dark;
            this._build();
        }
        this.refresh();
    }

    /** Settings that change the card set force a rebuild on next open. */
    invalidate() {
        this._built = false;
        if (this._open) {
            this._build();
            this.refresh();
        }
    }

    _build() {
        this._built = true;
        this._root.destroy_all_children();
        this._cards.clear();
        this._root.remove_style_class_name('ts-dark');
        this._root.remove_style_class_name('ts-light');
        this._root.add_style_class_name(Palette.dark ? 'ts-dark' : 'ts-light');

        const m = this.monitor;
        const hidden = new Set(this.settings.get_strv('hidden-cards'));
        const ctors = [
            ['cpu', CpuCard],
            ['gpu', m.hasGpu ? GpuCard : null],
            ['memory', MemoryCard],
            ['battery', m.hasBattery ? BatteryCard : null],
            ['network', NetworkCard],
            ['storage', StorageCard],
            ['sensors', SensorsCard],
            ['processes', ProcessesCard],
        ];
        const detail = [];
        for (const [id, Ctor] of ctors) {
            if (!Ctor || hidden.has(id)) continue;
            const card = new Ctor(this.ctx);
            this._cards.set(id, card);
            detail.push(card);
        }

        this._overview = new OverviewCard(this.ctx, {
            cards: this._cards,
            onRange: r => {
                this.settings.set_uint('graph-range', r);
                this._overview.setRange(r);
                this.refresh();
            },
        });

        this._scroll = new St.ScrollView({
            style_class: 'ts-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        this._scroll.style = `max-height: ${Popover.popoverHeight()}px;`;
        enableTouchScroll(this._scroll);
        this._stack = vbox({styleClass: 'ts-cards', xExpand: true});
        this._stack.add_child(this._overview.actor);
        for (const c of detail) this._stack.add_child(c.actor);
        this._scroll.set_child(this._stack);
        this._root.add_child(this._scroll);
        this._root.add_child(new St.Widget({style_class: 'ts-divider', x_expand: true}));
        this._root.add_child(this._footer());
    }

    refresh() {
        if (!this._open || !this._built) return;
        const m = this.monitor;
        this._overview.refresh(m);
        for (const c of this._cards.values()) c.refresh(m);
        this._footerNote.text = `Every ${m.interval} s · ${m.cpu.threads} threads`;
    }

    onProfilesChanged() {
        this._cards.get('battery')?.syncProfiles();
    }

    onPinsChanged() {
        for (const c of this._cards.values()) c.syncPin();
    }

    _scrollTo(card) {
        if (card.collapsed) card.setCollapsed(false);
        const adj = this._scroll.get_vadjustment();
        // Let the (possibly just expanded) card allocate before measuring.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            const target = Math.min(adj.upper - adj.page_size, Math.max(0, card.actor.y - 8));
            adj.ease(target, {duration: 350, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            return GLib.SOURCE_REMOVE;
        });
    }

    _footer() {
        const bar = hbox({styleClass: 'ts-footer', xExpand: true, yAlign: Clutter.ActorAlign.CENTER});
        this._footerNote = label('', 'ts-caption', {opacity: Opacity.secondary, xExpand: true});
        bar.add_child(this._footerNote);
        const monitorApp = Popover._systemMonitorApp();
        if (monitorApp) {
            bar.add_child(button({
                child: Popover._footerChild(monitorApp.get_icon(), `Open ${monitorApp.get_name()}`),
                styleClass: 'ts-footer-button',
                tooltip: `Open ${monitorApp.get_name()}`,
                onClick: () => {
                    this.closeMenu();
                    monitorApp.activate();
                },
            }));
        }
        bar.add_child(button({iconName: 'preferences-system-symbolic', styleClass: 'ts-footer-button', iconClass: 'ts-footer-icon', tooltip: 'Preferences', onClick: () => this.onOpenPrefs()}));
        return bar;
    }

    static _footerChild(gicon, text) {
        const box = hbox({styleClass: 'ts-footer-content'});
        box.add_child(new St.Icon({gicon, style_class: 'ts-footer-icon', y_align: Clutter.ActorAlign.CENTER}));
        box.add_child(label(text, 'ts-caption'));
        return box;
    }

    static _systemMonitorApp() {
        const sys = Shell.AppSystem.get_default();
        for (const id of MONITOR_APPS) {
            const app = sys.lookup_app(id);
            if (app) return app;
        }
        return null;
    }

    /** Most of the usable display, clamped so it stays comfortable. */
    static popoverHeight() {
        const monitor = Main.layoutManager.primaryMonitor;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        const usable = (monitor?.height ?? 900) / scale - (Main.panel?.height ?? 32) / scale;
        return Math.floor(Math.min(Math.max(usable * 0.78, 420), usable - 48));
    }
}

/**
 * Finger-drag scrolling for an St.ScrollView (St only handles wheel and
 * touchpad scrolling): a PanGesture drives the adjustment 1:1, then a short
 * ease-out fling. Same approach as TouchyWeather's popover.
 */
function enableTouchScroll(scrollView) {
    const gesture = new Clutter.PanGesture({pan_axis: Clutter.PanAxis.Y, begin_threshold: 8});
    const adj = () => scrollView.get_vadjustment();
    let lastTime = 0;
    let velocity = 0;
    gesture.connect('recognize', () => {
        adj().remove_transition('value');
        lastTime = GLib.get_monotonic_time();
        velocity = 0;
    });
    gesture.connect('pan-update', g => {
        const d = g.get_delta().get_y();
        const a = adj();
        a.value = Math.max(a.lower, Math.min(a.upper - a.page_size, a.value - d));
        const t = GLib.get_monotonic_time();
        const dt = Math.max(1, (t - lastTime) / 1000);
        velocity = 0.6 * (-d / dt) + 0.4 * velocity;
        lastTime = t;
    });
    gesture.connect('end', () => {
        const a = adj();
        if (Math.abs(velocity) < 0.05) return;
        const target = Math.max(a.lower, Math.min(a.upper - a.page_size, a.value + velocity * 320));
        a.ease(target, {duration: 640, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
    });
    gesture.connect('cancel', () => {
        velocity = 0;
    });
    scrollView.add_action(gesture);
}
