// SPDX-License-Identifier: GPL-2.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS = 'org.freedesktop.UPower.PowerProfiles';
const PATH = '/org/freedesktop/UPower/PowerProfiles';

/**
 * power-profiles-daemon client: the active profile, the profiles on offer,
 * and a setter (active-session users need no authorization for this — it's
 * what the Quick Settings toggle does).
 */
export class PowerProfiles {
    constructor(onChange) {
        this.active = null;
        this.available = [];
        this.degraded = '';
        this._onChange = onChange;
        this._cancellable = new Gio.Cancellable();
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null, BUS, PATH, BUS, this._cancellable, (_o, res) => {
            try {
                this._proxy = Gio.DBusProxy.new_for_bus_finish(res);
            } catch {
                return;     // daemon not installed
            }
            this._signal = this._proxy.connect('g-properties-changed', () => this._read());
            this._read();
        });
    }

    _read() {
        const p = this._proxy;
        this.active = p.get_cached_property('ActiveProfile')?.unpack() ?? null;
        this.available = (p.get_cached_property('Profiles')?.recursiveUnpack() ?? []).map(x => x.Profile);
        this.degraded = p.get_cached_property('PerformanceDegraded')?.unpack() ?? '';
        this._onChange?.();
    }

    set(profile) {
        if (!this._proxy || profile === this.active) return;
        this._proxy.call('org.freedesktop.DBus.Properties.Set',
            new GLib.Variant('(ssv)', [BUS, 'ActiveProfile', new GLib.Variant('s', profile)]),
            Gio.DBusCallFlags.NONE, -1, null, (proxy, res) => {
                try {
                    proxy.call_finish(res);
                } catch (e) {
                    console.warn(`TouchyStats: could not set power profile: ${e.message}`);
                }
            });
    }

    destroy() {
        this._cancellable.cancel();
        if (this._signal) this._proxy.disconnect(this._signal);
        this._proxy = null;
        this._onChange = null;
    }
}
