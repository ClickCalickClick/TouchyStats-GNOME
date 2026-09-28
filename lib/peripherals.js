// SPDX-License-Identifier: GPL-2.0-or-later
import Gio from 'gi://Gio';

const BUS = 'org.freedesktop.UPower';
const PATH = '/org/freedesktop/UPower';
const DEVICE = 'org.freedesktop.UPower.Device';
// UPower's State enum, in the same words sysfs uses.
const STATES = ['Unknown', 'Charging', 'Discharging', 'Empty', 'Full', 'Not charging', 'Discharging'];

/**
 * Peripheral batteries (Bluetooth keyboards, mice, styluses…) from UPower.
 *
 * These can't be read from sysfs on the shell's thread: for a Bluetooth HID
 * device, reading its power_supply makes the kernel send a GET_REPORT and
 * wait for the device to answer — up to ~2 s while it dozes, and the whole
 * shell freezes meanwhile. upowerd does that waiting in its own process; here
 * we only read its cached properties, kept current by PropertiesChanged.
 */
export class Peripherals {
    constructor() {
        this._devices = new Map();  // object path → {proxy}
        this._cancellable = new Gio.Cancellable();
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES, null, BUS, PATH, BUS, this._cancellable, (_o, res) => {
            try {
                this._manager = Gio.DBusProxy.new_for_bus_finish(res);
            } catch {
                return;     // UPower not installed
            }
            this._signal = this._manager.connect('g-signal', (_p, _sender, name, params) => {
                if (name === 'DeviceAdded') this._add(params.deepUnpack()[0]);
                else if (name === 'DeviceRemoved') this._devices.delete(params.deepUnpack()[0]);
            });
            this._manager.call('EnumerateDevices', null, Gio.DBusCallFlags.NONE, -1, this._cancellable, (proxy, r) => {
                try {
                    proxy.call_finish(r).deepUnpack()[0].forEach(path => this._add(path));
                } catch {}
            });
        });
    }

    _add(path) {
        if (this._devices.has(path)) return;
        const entry = {proxy: null};
        this._devices.set(path, entry);
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.DO_NOT_CONNECT_SIGNALS, null, BUS, path, DEVICE, this._cancellable, (_o, res) => {
            try {
                entry.proxy = Gio.DBusProxy.new_for_bus_finish(res);
            } catch {
                this._devices.delete(path);
            }
        });
    }

    /** [{name, pct, status}] — only UPower's cache, so it's free to call every tick. */
    get list() {
        const out = [];
        for (const {proxy} of this._devices.values()) {
            if (!proxy) continue;
            const get = k => proxy.get_cached_property(k)?.unpack();
            // The laptop's own battery and the AC adapter power the system.
            if (get('PowerSupply') !== false) continue;
            const pct = get('Percentage'), state = get('State') ?? 0;
            // Absent styluses report 0 % / state Unknown: skip those.
            if (!Number.isFinite(pct) || (pct === 0 && state === 0)) continue;
            out.push({name: (get('Model') || 'Device').trim(), pct, status: STATES[state] ?? 'Unknown'});
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
    }

    destroy() {
        this._cancellable.cancel();
        if (this._signal) this._manager.disconnect(this._signal);
        this._manager = null;
        this._devices.clear();
    }
}
