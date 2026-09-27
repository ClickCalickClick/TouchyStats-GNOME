// SPDX-License-Identifier: GPL-2.0-or-later
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Monitor} from './lib/monitor.js';
import {PowerProfiles} from './lib/powerProfiles.js';
import {DevScreenshots} from './lib/devScreenshots.js';
import {setIconDir} from './ui/widgets.js';
import {TouchyStatsButton} from './ui/panel.js';
import {Popover} from './ui/popover.js';

/**
 * TouchyStats: a top-bar system monitor. The Monitor samples on a timer;
 * the panel button redraws its pinned metrics on every sample and the
 * popover (built on first open) updates its cards in place while open.
 */
export default class TouchyStatsExtension extends Extension {
    enable() {
        setIconDir(`${this.path}/icons`);
        this._settings = this.getSettings();

        this._monitor = new Monitor();
        this._profiles = new PowerProfiles(() => this._popover?.onProfilesChanged());
        this._createUi();

        this._monitor.connect(m => {
            this._button?.update(m);
            if (this._button?.menu.isOpen) this._popover.refresh();
        });
        this._monitor.start(this._settings.get_uint('update-interval'), this._settings.get_uint('battery-update-interval'));

        // Nothing to show while the lock screen or a blanked display is up.
        this._shieldId = Main.screenShield?.connect('active-changed', shield => {
            if (shield.active) this._monitor.pause();
            else this._monitor.resume();
        });

        const on = (key, fn) => this._settings.connect(`changed::${key}`, fn);
        this._settingsIds = [
            on('panel-metrics', () => {
                this._rebuildPanel();
                this._popover.onPinsChanged();
            }),
            on('panel-style', () => this._rebuildPanel()),
            on('panel-show-values', () => this._rebuildPanel()),
            on('panel-position', () => {
                this._destroyUi();
                this._createUi();
            }),
            on('update-interval', () => this._applyIntervals()),
            on('battery-update-interval', () => this._applyIntervals()),
            on('temperature-unit', () => {
                this._button.update(this._monitor);
                this._popover.refresh();
            }),
            on('hidden-cards', () => this._popover.invalidate()),
        ];

        this._dev = DevScreenshots.maybeStart(this);
    }

    disable() {
        this._dev?.destroy();
        this._dev = null;
        if (this._shieldId) Main.screenShield.disconnect(this._shieldId);
        this._shieldId = 0;
        for (const id of this._settingsIds ?? []) this._settings.disconnect(id);
        this._settingsIds = null;
        this._monitor?.stop();
        this._destroyUi();
        this._monitor = null;
        this._profiles?.destroy();
        this._profiles = null;
        this._settings = null;
    }

    _createUi() {
        const settings = this._settings;
        this._popover = new Popover({
            monitor: this._monitor,
            settings,
            profiles: this._profiles,
            onOpenPrefs: () => {
                this._button?.menu.close();
                this.openPreferences();
            },
            closeMenu: () => this._button?.menu.close(),
        });
        this._button = new TouchyStatsButton({
            monitor: this._monitor,
            get unit() {
                return settings.get_string('temperature-unit');
            },
        });
        this._button.menu.addMenuItem(this._popover.menuSection);
        this._button.menu.box.add_style_class_name('ts-menu');
        this._button.menu.connect('open-state-changed', (_menu, open) => {
            this._monitor.setDetailed(open);
            this._popover.setOpen(open);
        });
        this._rebuildPanel();
        const pos = settings.get_string('panel-position');
        Main.panel.addToStatusArea(this.uuid, this._button, pos === 'right' ? 0 : -1, pos);
    }

    _destroyUi() {
        this._monitor?.setDetailed(false);
        this._popover?.destroy();
        this._popover = null;
        this._button?.destroy();
        this._button = null;
    }

    _applyIntervals() {
        this._monitor.setIntervals(this._settings.get_uint('update-interval'), this._settings.get_uint('battery-update-interval'));
        this._popover.refresh();
    }

    _rebuildPanel() {
        this._button.rebuild({
            metrics: this._settings.get_strv('panel-metrics'),
            style: this._settings.get_string('panel-style'),
            showValue: this._settings.get_boolean('panel-show-values'),
        });
    }
}
