import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot');

/**
 * Development aid, inert unless TS_DEV_SCREENSHOT_DIR is set in the Shell's
 * environment (a headless `gnome-shell --headless` dev session): walks the
 * panel styles and the popover and writes stage screenshots. In-process
 * Shell.Screenshot sidesteps the D-Bus screenshot allow-list.
 */
export class DevScreenshots {
    static maybeStart(extension) {
        const dir = GLib.getenv('TS_DEV_SCREENSHOT_DIR');
        if (!dir) return null;
        const d = new DevScreenshots(extension, dir);
        d.run().catch(e => console.error(`TouchyStats dev: ${e.message}\n${e.stack}`));
        return d;
    }

    constructor(extension, dir) {
        this.ext = extension;
        this.dir = dir;
        this._ids = [];
        GLib.mkdir_with_parents(dir, 0o755);
    }

    async run() {
        const s = this.ext._settings;
        await this._sleep(4000);
        Main.overview.hide();
        await this._sleep(9000);   // collect some history
        for (const style of ['graphs', 'text', 'rings']) {
            s.set_string('panel-style', style);
            await this._sleep(2500);
            await this.shoot(`01-panel-${style}`);
        }
        this.ext._button.menu.open();
        await this._sleep(2500);
        await this.shoot('02-popover-top');

        const scroll = this.ext._popover._scroll;
        const adj = scroll.get_vadjustment();
        const pages = Math.max(1, Math.ceil((adj.upper - adj.page_size) / (adj.page_size * 0.85)));
        for (let i = 1; i <= pages; i++) {
            adj.value = Math.min(adj.upper - adj.page_size, i * adj.page_size * 0.85);
            await this._sleep(2200);
            await this.shoot(`03-popover-page${i}`);
        }

        // Scrub readout on the CPU graph.
        adj.value = 0;
        const cpu = this.ext._popover._cards.get('cpu');
        await this._sleep(500);
        cpu.graph._hoverX = cpu.graph._area.width * 0.6;
        cpu.graph.update();
        await this._sleep(400);
        await this.shoot('04-hover');
        cpu.graph._hoverX = null;

        // Collapse two cards, sort apps by memory.
        this.ext._popover._cards.get('cpu').setCollapsed(true);
        this.ext._popover._cards.get('gpu')?.setCollapsed(true);
        s.set_string('process-sort', 'memory');
        await this._sleep(2500);
        await this.shoot('05-collapsed');
        this.ext._popover._cards.get('cpu').setCollapsed(false);
        this.ext._popover._cards.get('gpu')?.setCollapsed(false);
        s.set_string('process-sort', 'cpu');
        this.ext._button.menu.close();
        this.ext.openPreferences();
        await this._sleep(5000);
        await this.shoot('06-prefs');
        console.log('TouchyStats dev: screenshots done');
    }

    _sleep(ms) {
        return new Promise(resolve => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._ids = this._ids.filter(x => x !== id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._ids.push(id);
        });
    }

    async shoot(name) {
        const path = GLib.build_filenamev([this.dir, `${name}.png`]);
        const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
        await new Shell.Screenshot().screenshot(false, stream);
        stream.close(null);
        console.log(`TouchyStats dev: wrote ${path}`);
    }

    destroy() {
        for (const id of this._ids) GLib.source_remove(id);
        this._ids = [];
    }
}
