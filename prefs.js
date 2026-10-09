// SPDX-License-Identifier: GPL-2.0-or-later
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const METRICS = [
    ['cpu', 'CPU', 'Processor load'],
    ['gpu', 'GPU', 'Graphics load (AMD)'],
    ['memory', 'Memory', 'RAM in use'],
    ['swap', 'Swap', 'Swap / zram in use'],
    ['temp', 'Temperature', 'CPU temperature'],
    ['power', 'Power', 'System draw on battery, SoC package on AC'],
    ['battery', 'Battery', 'Charge level'],
    ['network', 'Network', 'Download and upload rates'],
    ['disk', 'Disk', 'Read and write rates'],
];

const CARDS = [
    ['cpu', 'Processor'],
    ['gpu', 'Graphics'],
    ['memory', 'Memory'],
    ['battery', 'Battery & Power'],
    ['network', 'Network'],
    ['storage', 'Storage'],
    ['sensors', 'Temperatures'],
    ['processes', 'Top apps'],
];

function comboRow(settings, key, title, subtitle, options) {
    const model = Gtk.StringList.new(options.map(o => o[1]));
    const row = new Adw.ComboRow({title, subtitle, model});
    const sync = () => {
        const i = options.findIndex(o => o[0] === settings.get_string(key));
        row.selected = Math.max(0, i);
    };
    sync();
    row.connect('notify::selected', () => settings.set_string(key, options[row.selected][0]));
    settings.connect(`changed::${key}`, sync);
    return row;
}

export default class TouchyStatsPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 720);

        // ---- Top bar ----
        const bar = new Adw.PreferencesPage({title: 'Top bar', icon_name: 'view-pin-symbolic'});
        const look = new Adw.PreferencesGroup({title: 'Appearance'});
        look.add(comboRow(settings, 'panel-style', 'Style', 'How each metric is drawn', [
            ['rings', 'Rings'], ['graphs', 'Mini graphs'], ['text', 'Icons and numbers'],
        ]));
        const values = new Adw.SwitchRow({title: 'Show numbers', subtitle: 'Next to each ring or graph'});
        settings.bind('panel-show-values', values, 'active', 0);
        look.add(values);
        look.add(comboRow(settings, 'panel-position', 'Position', null, [
            ['left', 'Left'], ['center', 'Center'], ['right', 'Right'],
        ]));
        bar.add(look);

        this._metricsGroup = new Adw.PreferencesGroup({
            title: 'Metrics',
            description: 'Switch metrics on, and use the arrows to order them. You can also pin a card from the popover.',
        });
        bar.add(this._metricsGroup);
        this._metricRows = [];
        this._fillMetrics(settings);
        settings.connect('changed::panel-metrics', () => this._fillMetrics(settings));
        window.add(bar);

        // ---- Popover ----
        const pop = new Adw.PreferencesPage({title: 'Popover', icon_name: 'view-list-symbolic'});
        const general = new Adw.PreferencesGroup({title: 'Sampling'});
        const interval = new Adw.SpinRow({
            title: 'Update every (on AC)',
            subtitle: 'Seconds between samples while plugged in.',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 10, step_increment: 1, page_increment: 1}),
        });
        settings.bind('update-interval', interval, 'value', 0);
        general.add(interval);
        const batt = new Adw.SpinRow({
            title: 'Update every (on battery)',
            subtitle: 'A slower pace on battery lets the CPU stay asleep longer. Sampling always pauses while the screen is locked or off.',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 30, step_increment: 1, page_increment: 5}),
        });
        settings.bind('battery-update-interval', batt, 'value', 0);
        general.add(batt);
        general.add(comboRow(settings, 'temperature-unit', 'Temperature unit', null, [
            ['celsius', 'Celsius'], ['fahrenheit', 'Fahrenheit'],
        ]));
        pop.add(general);

        const cards = new Adw.PreferencesGroup({title: 'Cards', description: 'Cards for hardware this machine lacks are hidden automatically.'});
        for (const [id, title] of CARDS) {
            // Plain text: Adw rows parse titles as markup, and "Battery & Power" isn't valid markup.
            const row = new Adw.SwitchRow({title, use_markup: false});
            row.active = !settings.get_strv('hidden-cards').includes(id);
            row.connect('notify::active', () => {
                const cur = settings.get_strv('hidden-cards').filter(x => x !== id);
                settings.set_strv('hidden-cards', row.active ? cur : [...cur, id]);
            });
            cards.add(row);
        }
        pop.add(cards);
        window.add(pop);
    }

    _fillMetrics(settings) {
        for (const r of this._metricRows) this._metricsGroup.remove(r);
        this._metricRows = [];
        const enabled = settings.get_strv('panel-metrics');
        const ordered = [
            ...enabled.map(id => METRICS.find(m => m[0] === id)).filter(Boolean),
            ...METRICS.filter(m => !enabled.includes(m[0])),
        ];
        for (const [id, title, subtitle] of ordered) {
            const on = enabled.includes(id);
            const row = new Adw.ActionRow({title, subtitle});
            const idx = enabled.indexOf(id);
            const move = delta => {
                const list = [...enabled];
                const j = idx + delta;
                if (j < 0 || j >= list.length) return;
                [list[idx], list[j]] = [list[j], list[idx]];
                settings.set_strv('panel-metrics', list);
            };
            const up = new Gtk.Button({icon_name: 'go-up-symbolic', valign: Gtk.Align.CENTER, sensitive: on && idx > 0, tooltip_text: 'Move left'});
            up.add_css_class('flat');
            up.connect('clicked', () => move(-1));
            const down = new Gtk.Button({icon_name: 'go-down-symbolic', valign: Gtk.Align.CENTER, sensitive: on && idx < enabled.length - 1, tooltip_text: 'Move right'});
            down.add_css_class('flat');
            down.connect('clicked', () => move(1));
            const sw = new Gtk.Switch({active: on, valign: Gtk.Align.CENTER});
            sw.connect('notify::active', () => {
                const cur = settings.get_strv('panel-metrics').filter(x => x !== id);
                settings.set_strv('panel-metrics', sw.active ? [...cur, id] : cur);
            });
            row.add_suffix(up);
            row.add_suffix(down);
            row.add_suffix(sw);
            row.activatable_widget = sw;
            this._metricsGroup.add(row);
            this._metricRows.push(row);
        }
    }
}
