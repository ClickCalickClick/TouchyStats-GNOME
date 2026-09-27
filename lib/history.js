/**
 * A fixed-capacity time series: parallel ring buffers of timestamps (seconds,
 * monotonic) and values. Graphs plot by time, so changing the sample interval
 * never distorts what's already recorded.
 */
export class History {
    constructor(capacity = 660) {
        this.capacity = capacity;
        this.times = new Float64Array(capacity);
        this.values = new Float64Array(capacity);
        this.start = 0;
        this.length = 0;
    }

    push(t, v) {
        const i = (this.start + this.length) % this.capacity;
        this.times[i] = t;
        this.values[i] = v;
        if (this.length < this.capacity) this.length++;
        else this.start = (this.start + 1) % this.capacity;
    }

    clear() {
        this.start = 0;
        this.length = 0;
    }

    /** Visit samples with t >= since, oldest first: fn(t, v). */
    forEachSince(since, fn) {
        for (let k = 0; k < this.length; k++) {
            const i = (this.start + k) % this.capacity;
            if (this.times[i] >= since) fn(this.times[i], this.values[i]);
        }
    }

    maxSince(since) {
        let m = -Infinity;
        this.forEachSince(since, (_t, v) => {
            if (Number.isFinite(v) && v > m) m = v;
        });
        return m;
    }

    get last() {
        return this.length ? this.values[(this.start + this.length - 1) % this.capacity] : NaN;
    }

    /** Linear-interpolated value at time t (NaN outside the recorded span). */
    valueAt(t) {
        let pt = NaN, pv = NaN;
        for (let k = 0; k < this.length; k++) {
            const i = (this.start + k) % this.capacity;
            const ct = this.times[i], cv = this.values[i];
            if (ct >= t) {
                if (!Number.isFinite(pt)) return k === 0 && ct - t > 5 ? NaN : cv;
                return pv + (cv - pv) * (t - pt) / (ct - pt || 1);
            }
            pt = ct;
            pv = cv;
        }
        return NaN;
    }
}
