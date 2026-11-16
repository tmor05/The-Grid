'use strict';
/**
 * grid_sfx.js - renders The Grid's sound effects to apps/the_grid/sounds/*.wav
 * (48 kHz, 16-bit, stereo).
 *
 * The palette is dark sci-fi cinema with a lot of deep bass, and every sound is built from the
 * parts of one: Rinzler's opening (the "Rinzler kit" below: a distorted tritone braam with a
 * ring-modulated growl, a reversed metallic suck, designed impacts with sub drops, a scraping
 * bowed plate, a tight dark room). No struck or mallet-like notes. Everything is made here from oscillators, noise and filters:
 * original sounds, no film, game or sampled audio. The code is deterministic (seeded noise), so
 * the same code renders the same files.
 *
 *   node kit/tools/grid_sfx.js                 # all sounds into apps/the_grid/sounds
 *   node kit/tools/grid_sfx.js out/ map warn   # some sounds into another folder
 *
 * The list (name, when The Grid plays it) is SOUNDS at the bottom; the app's
 * sound.js has the same names.
 */
const fs = require('fs');
const path = require('path');

const SR = 48000;
const TAU = Math.PI * 2;

/* ---------------------------------------------------------------- basics */

/** Note name -> Hz ('A4' = 440, 'C#5', 'Bb3'); numbers pass through. */
function hz(n) {
    if (typeof n === 'number') return n;
    const m = /^([A-G])([#b]?)(-?\d)$/.exec(n);
    const semi = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 }[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    return 440 * Math.pow(2, (semi + (Number(m[3]) - 4) * 12) / 12);
}
const cents = (f, c) => f * Math.pow(2, c / 1200);
/** Exponential glide a -> b over x in 0..1. */
const glide = (a, b, x) => a * Math.pow(b / a, Math.max(0, Math.min(1, x)));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

/** Seeded noise (mulberry32): the same sounds every render. */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function polyblep(t, dt) {
    if (t < dt) { t /= dt; return t + t - t * t - 1; }
    if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
    return 0;
}

/** Band-limited oscillator: sine, saw, square / pulse (width). */
class Osc {
    constructor(type, opts) { this.type = type; this.p = (opts && opts.phase) || 0; this.w = (opts && opts.width) || 0.5; }
    next(f) {
        const dt = Math.min(0.49, Math.abs(f) / SR), p = this.p;
        let v;
        if (this.type === 'sine') v = Math.sin(TAU * p);
        else if (this.type === 'saw') v = 2 * p - 1 - polyblep(p, dt);
        else v = (p < this.w ? 1 : -1) + polyblep(p, dt) - polyblep((p + 1 - this.w) % 1, dt);
        this.p = (p + dt) % 1;
        return v;
    }
}

/** RBJ biquad (lp, hp, bp, hishelf); set() may run every few samples for sweeps. */
class Biquad {
    constructor(type, f, q, gainDb) { this.type = type; this.z1 = 0; this.z2 = 0; this.set(f, q, gainDb); }
    set(f, q, gainDb) {
        f = clamp(f, 10, SR * 0.45); q = q || 0.707;
        const w = TAU * f / SR, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
        const A = Math.pow(10, (gainDb || 0) / 40);
        let b0, b1, b2, a0, a1, a2;
        switch (this.type) {
            case 'lp': b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
            case 'hp': b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
            case 'bp': b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
            case 'hishelf': {
                const sq = 2 * Math.sqrt(A) * al;
                b0 = A * ((A + 1) + (A - 1) * c + sq); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - sq);
                a0 = (A + 1) - (A - 1) * c + sq; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - sq;
                break;
            }
            default: throw new Error('filter ' + this.type);
        }
        this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    }
    run(x) {
        const y = this.b0 * x + this.z1;
        this.z1 = this.b1 * x - this.a1 * y + this.z2;
        this.z2 = this.b2 * x - this.a2 * y;
        return y;
    }
}

/** Envelope at t seconds: attack a, then exponential decay tau, or decay d to sustain s; release r before dur. */
function env(t, e, dur) {
    if (t < 0) return 0;
    const a = e.a == null ? 0.002 : e.a;
    let v;
    if (t < a) v = e.curve === 'exp' ? Math.pow(t / a, 3) : t / a;
    else if (e.tau != null) v = Math.exp(-(t - a) / e.tau);
    else {
        const d = e.d || 0.1, s = e.s == null ? 1 : e.s;
        v = t < a + d ? 1 - (1 - s) * (t - a) / d : s;
    }
    const r = e.r == null ? 0.02 : e.r;
    if (dur != null && t > dur - r) v *= Math.max(0, (dur - t) / r);
    return v;
}

/** Octave-up (or any ratio) pitch shifter: two crossfaded read heads in a delay line. */
class Shifter {
    constructor(ratio, win) {
        this.w = Math.round((win || 0.05) * SR); this.n = this.w * 2 + 4;
        this.b = new Float32Array(this.n); this.k = 0; this.ph = 0; this.inc = (1 - ratio) / this.w;
    }
    _read(d) {
        let p = this.k - d; while (p < 0) p += this.n;
        const i = Math.floor(p), fr = p - i, a = this.b[i % this.n], b = this.b[(i + 1) % this.n];
        return a + (b - a) * fr;
    }
    run(x) {
        this.b[this.k] = x;
        this.ph = (this.ph + this.inc) % 1; if (this.ph < 0) this.ph += 1;
        const p2 = (this.ph + 0.5) % 1;
        const y = Math.sin(Math.PI * this.ph) * this._read(this.ph * this.w + 1) + Math.sin(Math.PI * p2) * this._read(p2 * this.w + 1);
        this.k = (this.k + 1) % this.n;
        return y;
    }
}

/* Partial sets for the resonators: [ratio, amplitude, decay x] (decay x scales the voice's decay). */
const BODY = {
    // a struck body from elsewhere: no two overtones in a harmonic row
    alien: [[1, 1, 1], [1.506, 0.42, 0.85], [2.76, 0.46, 0.6], [3.17, 0.22, 0.45], [5.4, 0.2, 0.3], [8.93, 0.08, 0.18]],
    // thin glass
    glass: [[1, 1, 1], [2.32, 0.55, 0.65], [4.25, 0.35, 0.42], [6.63, 0.18, 0.3], [9.38, 0.08, 0.2]],
    // a heavy plate
    plate: [[1, 1, 1], [1.47, 0.6, 0.8], [2.09, 0.45, 0.6], [2.56, 0.35, 0.5], [3.39, 0.25, 0.35], [4.17, 0.14, 0.25]],
    // nearly a bell: a hum, a minor third, a fifth, an octave a little sharp
    bell: [[0.5, 0.6, 1.4], [1, 1, 1], [1.19, 0.35, 0.7], [1.5, 0.28, 0.6], [2.01, 0.3, 0.5], [2.74, 0.12, 0.3]],
};
const VOWEL = { a: [730, 1090, 2440], e: [530, 1840, 2480], i: [300, 2200, 3000], o: [570, 840, 2410], u: [320, 800, 2240] };
const vowelAt = (seq, x) => {
    const n = seq.length - 1;
    if (n === 0) return VOWEL[seq[0]];
    const p = clamp(x, 0, 1) * n, i = Math.min(n - 1, Math.floor(p)), fr = p - i;
    const a = VOWEL[seq[i]], b = VOWEL[seq[i + 1]], s = smooth(fr);
    return a.map((v, k) => v * Math.pow(b[k] / v, s));
};

/* ---------------------------------------------------------------- a sound */

class Sound {
    constructor(sec) {
        this.n = Math.ceil(sec * SR);
        this.L = new Float32Array(this.n); this.R = new Float32Array(this.n);
        this.AL = new Float32Array(this.n); this.AR = new Float32Array(this.n);    // the send to space()
    }
    /** Write v at sample i, panned (-1..1, equal power), with `send` of it to the space. */
    _put(i, v, pan, send) {
        if (i < 0 || i >= this.n) return;
        const a = (clamp(pan || 0, -1, 1) + 1) * Math.PI / 4, l = v * Math.cos(a), r = v * Math.sin(a);
        this.L[i] += l; this.R[i] += r;
        if (send) { this.AL[i] += l * send; this.AR[i] += r * send; }
    }
    _put2(i, l, r, send) {
        if (i < 0 || i >= this.n) return;
        this.L[i] += l; this.R[i] += r;
        if (send) { this.AL[i] += l * send; this.AR[i] += r * send; }
    }

    /**
     * A tone. o: { at, dur, f (Hz, note or fn(t, x)), wave, width, voices, detune (cents spread),
     * spread (stereo), pan, gain, env, cut (Hz or fn), q, poles, drive, ring {f, mix}, send }.
     */
    tone(o) {
        const at = o.at || 0, dur = o.dur, i0 = Math.round(at * SR), n = Math.round(dur * SR);
        const voices = o.voices || 1, det = o.detune || 0, spread = o.spread == null ? 0.6 : o.spread;
        const fOf = typeof o.f === 'function' ? o.f : () => hz(o.f);
        const cutOf = o.cut == null ? null : typeof o.cut === 'function' ? o.cut : () => o.cut;
        const vs = [];
        for (let k = 0; k < voices; k++) {
            const off = voices === 1 ? 0 : (k / (voices - 1)) * 2 - 1;
            vs.push({ osc: new Osc(o.wave || 'saw', { width: o.width, phase: (k * 0.618) % 1 }), det: off * det, pan: (o.pan || 0) + off * spread,
                fl: cutOf ? new Biquad('lp', cutOf(0, 0), o.q) : null, fl2: cutOf && o.poles === 4 ? new Biquad('lp', cutOf(0, 0), o.q) : null });
        }
        const g = (o.gain == null ? 0.3 : o.gain) / Math.sqrt(voices), e = o.env || { a: 0.003, tau: dur / 4 };
        let rp = 0;
        for (let j = 0; j < n; j++) {
            const t = j / SR, x = j / n, amp = env(t, e, dur) * g;
            const f = fOf(t, x), c = cutOf && j % 8 === 0 ? cutOf(t, x) : null;
            let ring = 1;
            if (o.ring) { ring = 1 - o.ring.mix + o.ring.mix * Math.sin(TAU * rp); rp = (rp + (typeof o.ring.f === 'function' ? o.ring.f(t, x) : o.ring.f) / SR) % 1; }
            for (const v of vs) {
                let s = v.osc.next(cents(f, v.det));
                if (v.fl) { if (c !== null) { v.fl.set(c, o.q); if (v.fl2) v.fl2.set(c, o.q); } s = v.fl.run(s); if (v.fl2) s = v.fl2.run(s); }
                if (o.drive) s = Math.tanh(s * o.drive) / Math.tanh(o.drive);
                this._put(i0 + j, s * amp * ring, v.pan, o.send);
            }
        }
        return this;
    }

    /** A sub: a sine gliding f0 -> f1 over `glide` s, saturated so small speakers hear its overtones. */
    sub(o) {
        const f0 = hz(o.f0), f1 = hz(o.f1 == null ? o.f0 : o.f1), gl = o.glide || 0.3;
        return this.tone({ at: o.at, dur: o.dur, f: (t) => glide(f0, f1, t / gl), wave: 'sine', gain: o.gain == null ? 0.6 : o.gain,
            drive: o.drive == null ? 1.8 : o.drive, env: o.env || { a: o.a || 0.003, tau: o.tau || o.dur / 3, r: 0.05 }, send: o.send == null ? 0.08 : o.send, pan: o.pan });
    }

    /**
     * Bowed metal: noise driving narrow resonances on the partials of `body`, so the body sings
     * instead of ringing like a struck bar. o: { at, dur, f, body, q, gain, env, drift fn(t) -> ratio, spread, send, seed }.
     */
    bowed(o) {
        const at = o.at || 0, dur = o.dur, i0 = Math.round(at * SR), n = Math.round(dur * SR), f = hz(o.f), q = o.q || 80;
        const parts = (typeof o.body === 'string' ? BODY[o.body] : (o.body || BODY.plate)).filter((p) => f * p[0] < 12000);
        const chans = [rng(o.seed || 61), rng((o.seed || 61) + 7)].map((r) => ({ r, bp: parts.map((p) => new Biquad('bp', f * p[0], q)) }));
        const norm = parts.map((p) => Math.sqrt(SR / (2 * f * p[0] / q)) * p[1]);
        const e = o.env || { a: dur * 0.4, d: dur * 0.2, s: 0.8, r: dur * 0.35 }, g = (o.gain == null ? 0.05 : o.gain) / Math.sqrt(parts.length);
        const spread = o.spread == null ? 0.8 : o.spread;
        for (let j = 0; j < n; j++) {
            const t = j / SR, x = j / n;
            if (j % 32 === 0) { const d = o.drift ? o.drift(t, x) : 1; for (const c of chans) c.bp.forEach((b, k) => b.set(f * parts[k][0] * d, q)); }
            const out = chans.map((c) => { const s = c.r() * 2 - 1; let y = 0; c.bp.forEach((b, k) => { y += b.run(s) * norm[k]; }); return y; });
            const a = env(t, e, dur) * g, mid = (out[0] + out[1]) / 2;
            this._put2(i0 + j, (mid + (out[0] - mid) * spread) * a, (mid + (out[1] - mid) * spread) * a, o.send == null ? 0.6 : o.send);
        }
        return this;
    }

    /**
     * A breathing drone: detuned saws per note through three formant filters morphing through
     * vowels. o: { at, dur, notes, vowels ('uao'), voices, detune, q, gain, env, cut (Hz or fn), drive, ring, spread, send, f (fn: pitch ratio) }.
     */
    formant(o) {
        const at = o.at || 0, dur = o.dur, i0 = Math.round(at * SR), n = Math.round(dur * SR);
        const notes = o.notes.map(hz), voices = o.voices || 3, det = o.detune == null ? 12 : o.detune, seq = (o.vowels || 'u').split('');
        const oscs = [];
        notes.forEach((f, k) => { for (let v = 0; v < voices; v++) oscs.push({ osc: new Osc('saw', { phase: (k * 0.31 + v * 0.618) % 1 }), f, det: voices === 1 ? 0 : ((v / (voices - 1)) * 2 - 1) * det, side: (v + k) % 2 ? 1 : -1 }); });
        const q = o.q || 9, chans = [0, 1].map(() => ({ f: [0, 1, 2].map(() => new Biquad('bp', 500, q)), lp: o.cut ? new Biquad('lp', 1000, 0.7) : null }));
        const cutOf = o.cut == null ? null : typeof o.cut === 'function' ? o.cut : () => o.cut;
        const fg = [1, 0.75, 0.45], g = (o.gain == null ? 0.2 : o.gain) * 3.2 / Math.sqrt(oscs.length), e = o.env || { a: dur * 0.3, d: dur * 0.3, s: 0.7, r: dur * 0.3 };
        const spread = o.spread == null ? 0.7 : o.spread;
        let rp = 0;
        for (let j = 0; j < n; j++) {
            const t = j / SR, x = j / n;
            if (j % 16 === 0) {
                const F = vowelAt(seq, x), c = cutOf ? cutOf(t, x) : null;
                for (const ch of chans) { ch.f.forEach((b, k) => b.set(F[k], q)); if (ch.lp && c) ch.lp.set(c, 0.7); }
            }
            const ratio = o.f ? o.f(t, x) : 1;
            let sl = 0, sr = 0;
            for (const v of oscs) { const s = v.osc.next(cents(v.f * ratio, v.det)); if (v.side < 0) sl += s; else sr += s; }
            const out = [sl, sr].map((s, c) => {
                const ch = chans[c];
                let y = ch.f[0].run(s) * fg[0] + ch.f[1].run(s) * fg[1] + ch.f[2].run(s) * fg[2];
                if (ch.lp) y = ch.lp.run(y);
                if (o.drive) y = Math.tanh(y * o.drive) / Math.tanh(o.drive);
                return y;
            });
            let ring = 1;
            if (o.ring) { ring = 1 - o.ring.mix + o.ring.mix * Math.sin(TAU * rp); rp = (rp + o.ring.f / SR) % 1; }
            const a = env(t, e, dur) * g * ring, mid = (out[0] + out[1]) / 2;
            const l = mid + (out[0] - mid) * spread, r = mid + (out[1] - mid) * spread;
            this._put2(i0 + j, l * a, r * a, o.send == null ? 0.6 : o.send);
        }
        return this;
    }

    /** Noise through a filter. o: { at, dur, gain, env, ftype, cut (Hz or fn), q, pan (number or fn), color, seed, send }. */
    noise(o) {
        const at = o.at || 0, dur = o.dur, i0 = Math.round(at * SR), n = Math.round(dur * SR);
        const r = rng(o.seed || 7), cutOf = typeof o.cut === 'function' ? o.cut : () => o.cut || 4000;
        const fl = new Biquad(o.ftype || 'bp', cutOf(0, 0), o.q || 1), fl2 = o.poles === 4 ? new Biquad(o.ftype || 'bp', cutOf(0, 0), o.q || 1) : null;
        const e = o.env || { a: 0.002, tau: dur / 4 };
        let brown = 0;
        for (let j = 0; j < n; j++) {
            const t = j / SR, x = j / n;
            if (j % 8 === 0) { const c = cutOf(t, x); fl.set(c, o.q || 1); if (fl2) fl2.set(c, o.q || 1); }
            let s = r() * 2 - 1;
            if (o.color === 'brown') { brown = (brown + 0.02 * s) / 1.02; s = brown * 3.5; }
            s = fl.run(s); if (fl2) s = fl2.run(s);
            this._put(i0 + j, s * env(t, e, dur) * (o.gain == null ? 0.2 : o.gain), typeof o.pan === 'function' ? o.pan(t, x) : (o.pan || 0), o.send == null ? 0.5 : o.send);
        }
        return this;
    }

    /**
     * A jet: noise through a feedback comb whose delay moves (its pitch is 1 / delay), then a
     * band-pass. o: { at, dur, delay fn(t, x) s, fb, gain, env, cut fn, q, pan fn, send, seed }.
     */
    jet(o) {
        const at = o.at || 0, dur = o.dur, i0 = Math.round(at * SR), n = Math.round(dur * SR), r = rng(o.seed || 23);
        const N = Math.round(0.05 * SR), b = new Float32Array(N), bp = new Biquad('bp', 1000, o.q || 0.8), e = o.env || { a: 0.05, tau: dur / 3 };
        let k = 0;
        for (let j = 0; j < n; j++) {
            const t = j / SR, x = j / n, d = clamp(o.delay(t, x) * SR, 2, N - 2);
            let p = k - d; if (p < 0) p += N;
            const i = Math.floor(p), fr = p - i, y = b[i] + (b[(i + 1) % N] - b[i]) * fr;
            const s = (r() * 2 - 1) * 0.3 + y * o.fb;
            b[k] = Math.tanh(s); k = (k + 1) % N;
            if (j % 8 === 0) bp.set(o.cut ? o.cut(t, x) : 2000, o.q || 0.8);
            this._put(i0 + j, bp.run(s) * env(t, e, dur) * (o.gain == null ? 0.2 : o.gain), o.pan ? o.pan(t, x) : 0, o.send == null ? 0.5 : o.send);
        }
        return this;
    }

    /**
     * Endless glide (Shepard-Risset): sine partials an octave apart sliding up (dir 1) or down (-1)
     * under a bell-shaped window, so it climbs or falls without arriving.
     * o: { at, dur, dir, lo (Hz), octs, rate (octaves/s), parts, gain, env, send }.
     */
    shepard(o) {
        const at = o.at || 0, dur = o.dur, i0 = Math.round(at * SR), n = Math.round(dur * SR);
        const lo = hz(o.lo || 80), octs = o.octs || 6, parts = o.parts || 6, rate = (o.rate || 1) * (o.dir || 1);
        const ph = new Array(parts).fill(0).map((_, k) => k * 0.27), e = o.env || { a: dur * 0.4, tau: dur, r: 0.08 }, g = o.gain == null ? 0.1 : o.gain;
        for (let j = 0; j < n; j++) {
            const t = j / SR;
            let s = 0;
            for (let k = 0; k < parts; k++) {
                let p = (k / parts + rate * t / octs) % 1; if (p < 0) p += 1;
                const f = lo * Math.pow(2, p * octs), w = Math.exp(-Math.pow((p - 0.5) / 0.17, 2) / 2);
                s += Math.sin(TAU * ph[k]) * w;
                ph[k] = (ph[k] + f / SR) % 1;
            }
            const v = s * env(t, e, dur) * g / 2;
            this._put2(i0 + j, v, v, o.send == null ? 0.7 : o.send);
        }
        return this;
    }

    /** Render `make(tmp)` into a sound of `len` s, reverse it, and mix it so it ends at `end` (a swell that rises out of nothing into the hit). */
    reverse(end, len, make, o) {
        const tmp = new Sound(len);
        make(tmp);
        const i0 = Math.round((end - len) * SR), g = (o && o.gain) || 1, send = o && o.send != null ? o.send : 0.25, fade = Math.round(0.03 * SR);
        for (let j = 0; j < tmp.n; j++) {
            const src = tmp.n - 1 - j, f = j < fade ? j / fade : 1;
            this._put2(i0 + j, tmp.L[src] * g * f, tmp.R[src] * g * f, send);
        }
        return this;
    }

    /**
     * The space: an 8-line feedback delay network (Householder mixing, damped, slowly modulated)
     * fed by the sends, with an octave-up shimmer in its loop. Adds `mix` of it to the sound.
     * o: { mix, rt60 (s), size, damp (Hz), shimmer (0..0.5), pre (s), mod (ms) }.
     */
    space(o) {
        const size = o.size || 1, rt = o.rt60 || 3, mix = o.mix == null ? 0.4 : o.mix, sh = o.shimmer || 0;
        const base = [1031, 1327, 1523, 1777, 2011, 2269, 2593, 2903], N = base.length;
        const lens = base.map((l) => Math.round(l * size)), mod = (o.mod == null ? 0.6 : o.mod) * SR / 1000;
        const lines = lens.map((l) => ({ b: new Float32Array(l + Math.ceil(mod) + 4), k: 0, lp: 0, len: l }));
        const gains = lens.map((l) => Math.pow(10, -3 * l / (rt * SR)));
        const da = Math.exp(-TAU * (o.damp || 6000) / SR);
        const dif = [142, 107, 379, 277].map((l) => ({ b: new Float32Array(Math.round(l * size)), k: 0 }));
        const pre = Math.max(1, Math.round((o.pre || 0.015) * SR)), preB = new Float32Array(pre);
        let pk = 0;
        const shifter = sh ? new Shifter(2, 0.06) : null, shLp = new Biquad('lp', 5500, 0.7), shHp = new Biquad('hp', 300, 0.7);
        let shOut = 0;
        const outs = new Float32Array(N), ins = new Float32Array(N);
        for (let i = 0; i < this.n; i++) {
            // pre-delay, then four allpasses to diffuse
            let x = preB[pk]; preB[pk] = (this.AL[i] + this.AR[i]) * 0.5; pk = (pk + 1) % pre;
            x += shOut * sh;
            for (const d of dif) { const y = d.b[d.k]; const v = x + y * 0.6; d.b[d.k] = v; d.k = (d.k + 1) % d.b.length; x = y - v * 0.6; }
            let sum = 0;
            for (let k = 0; k < N; k++) {
                const L = lines[k], dly = L.len + mod * (0.5 + 0.5 * Math.sin(TAU * (0.11 + 0.037 * k) * i / SR + k));
                let p = L.k - dly; while (p < 0) p += L.b.length;
                const a = Math.floor(p), fr = p - a, v0 = L.b[a % L.b.length], v = v0 + (L.b[(a + 1) % L.b.length] - v0) * fr;
                L.lp = v * (1 - da) + L.lp * da;
                outs[k] = L.lp * gains[k];
                sum += outs[k];
            }
            const hh = sum * 2 / N;
            for (let k = 0; k < N; k++) ins[k] = outs[k] - hh + x * (k % 2 ? 0.5 : -0.5);
            for (let k = 0; k < N; k++) { const L = lines[k]; L.b[L.k] = ins[k]; L.k = (L.k + 1) % L.b.length; }
            const wl = outs[0] - outs[2] + outs[4] - outs[6], wr = outs[1] - outs[3] + outs[5] - outs[7];
            if (shifter) shOut = Math.tanh(shHp.run(shLp.run(shifter.run((wl + wr) * 0.5))) * 1.2);
            this.L[i] += wl * mix * 0.6; this.R[i] += wr * mix * 0.6;
        }
        this.AL.fill(0); this.AR.fill(0);
        return this;
    }

    /** Darken: a high shelf (dB, negative cuts) at f for the finished sound. */
    tilt(f, db) {
        const l = new Biquad('hishelf', f, 0.707, db), r = new Biquad('hishelf', f, 0.707, db);
        for (let i = 0; i < this.n; i++) { this.L[i] = l.run(this.L[i]); this.R[i] = r.run(this.R[i]); }
        return this;
    }
}

/* ---------------------------------------------------------------- mastering */

/** Loudness of a short sound: the loudest 50 ms of a roughly K-weighted mono sum, in dBFS. */
function loudness(s) {
    const hp = new Biquad('hp', 60, 0.5), sh = new Biquad('hishelf', 1500, 0.707, 4);
    const w = Math.round(0.05 * SR);
    let best = 0, acc = 0;
    const sq = new Float32Array(s.n);
    for (let i = 0; i < s.n; i++) {
        const v = sh.run(hp.run((s.L[i] + s.R[i]) / 2));
        sq[i] = v * v; acc += sq[i];
        if (i >= w) acc -= sq[i - w];
        if (i >= w - 1) best = Math.max(best, acc / w);
    }
    return 10 * Math.log10(best + 1e-12);
}

/**
 * High-pass at 22 Hz, then the level: up to the loudness target (dBFS), but never past -1.5 dBFS
 * peak, so a heavy sub sets the level instead of being squashed. A soft knee only catches what's left.
 * Fades, trims the tail.
 */
function master(s, target) {
    const hl = new Biquad('hp', 22, 0.6), hr = new Biquad('hp', 22, 0.6);
    let raw = 0;
    for (let i = 0; i < s.n; i++) { s.L[i] = hl.run(s.L[i]); s.R[i] = hr.run(s.R[i]); raw = Math.max(raw, Math.abs(s.L[i]), Math.abs(s.R[i])); }
    const g = Math.min(Math.pow(10, (target - loudness(s)) / 20), 0.84 / (raw || 1)), ceil = 0.89, knee = 0.8;
    let peak = 0, clipped = 0;
    for (let i = 0; i < s.n; i++) {
        for (const ch of [s.L, s.R]) {
            let v = ch[i] * g;
            const a = Math.abs(v);
            if (a > knee) { v = Math.sign(v) * (knee + (ceil - knee) * Math.tanh((a - knee) / (ceil - knee))); clipped++; }
            ch[i] = v; peak = Math.max(peak, Math.abs(v));
        }
    }
    let end = s.n;
    while (end > 0 && Math.abs(s.L[end - 1]) < 3e-4 && Math.abs(s.R[end - 1]) < 3e-4) end--;
    end = Math.min(s.n, end + Math.round(0.01 * SR));
    const fi = Math.round(0.0005 * SR), fo = Math.min(Math.round(0.3 * SR), Math.round(end * 0.15));
    for (let i = 0; i < fi; i++) { s.L[i] *= i / fi; s.R[i] *= i / fi; }
    for (let i = 0; i < fo && end - 1 - i >= 0; i++) { const k = Math.pow(i / fo, 1.5); s.L[end - 1 - i] *= k; s.R[end - 1 - i] *= k; }
    return { end, peakDb: 20 * Math.log10(peak + 1e-12), loud: loudness(s), clipped };
}

function wav(s, end) {
    const n = end, buf = Buffer.alloc(44 + n * 4), r = rng(99);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
    buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
    for (let i = 0; i < n; i++) {
        for (let ch = 0; ch < 2; ch++) {
            const d = (r() - r()) / 32768;                       // TPDF dither
            buf.writeInt16LE(clamp(Math.round(((ch ? s.R : s.L)[i] + d) * 32767), -32768, 32767), 44 + i * 4 + ch * 2);
        }
    }
    return buf;
}

/* ---------------------------------------------------------------- the sounds */

/**
 * A braam: a low brass-like blast. Detuned saws on each note through a resonant 4-pole low-pass
 * that opens and closes, saturated hard, a breath of noise through the same filter, a sub under it.
 * o: { at, dur, notes, cut [from, peak, end] or fn(t), open (s), q, drive, gain, scoop (cents at the
 *      start), bend fn(t) -> cents, env, sub (gain), air, ring, voices, detune, send, seed }.
 */
function braam(s, o) {
    const at = o.at || 0, dur = o.dur, open = o.open || 0.35, c = o.cut || [90, 1500, 400];
    const cut = typeof c === 'function' ? c : (t) => (t < open ? glide(c[0], c[1], smooth(t / open)) : glide(c[1], c[2], (t - open) / Math.max(0.05, dur - open)));
    const e = o.env || { a: 0.05, d: 0.5, s: 0.75, r: dur * 0.4 }, scoop = o.scoop == null ? -45 : o.scoop;
    o.notes.forEach((n, k) => s.tone({ at, dur, f: (t) => cents(hz(n), scoop * Math.exp(-t / 0.07) + (o.bend ? o.bend(t) : 0)),
        wave: 'saw', voices: o.voices || 3, detune: o.detune || 10, spread: 0.7, gain: (o.gain == null ? 0.35 : o.gain) / Math.sqrt(o.notes.length),
        cut, q: o.q || 1.6, poles: 4, drive: o.drive || 3, ring: o.ring, env: e, send: o.send == null ? 0.45 : o.send, pan: k % 2 ? 0.15 : -0.15 }));
    if (o.air !== 0) s.noise({ at, dur, gain: o.air || 0.05, ftype: 'lp', cut: (t) => cut(t) * 1.3, q: 0.8, env: e, send: 0.5, seed: o.seed || 3 });
    if (o.sub) {
        let fs = hz(o.notes[0]); while (fs > 60) fs /= 2;
        s.tone({ at, dur, f: (t) => cents(fs, o.bend ? o.bend(t) : 0), wave: 'sine', gain: o.sub, drive: 1.6, env: e, send: 0.05 });
    }
}

/** A designed impact: a sub falling through the floor, a saturated low thud, a short crack. o: { at, gain, f0, f1, glide, tau, dur, seed }. */
function hit(s, o) {
    const at = o.at || 0, g = o.gain == null ? 1 : o.gain;
    s.sub({ at, f0: o.f0 || 105, f1: o.f1 || 30, glide: o.glide || 0.2, dur: o.dur || 1.6, tau: o.tau || 0.45, gain: 0.85 * g, drive: 2.6, send: 0.12 });
    s.tone({ at, dur: 0.5, f: (t) => glide(160, 50, t / 0.12), wave: 'saw', voices: 2, detune: 15, gain: 0.35 * g, cut: (t) => glide(1400, 90, t / 0.15), q: 0.9, poles: 4,
        drive: 4, env: { a: 0.001, tau: 0.08 }, send: 0.6 });
    s.noise({ at, dur: 0.5, gain: 0.45 * g, ftype: 'lp', cut: (t) => glide(2200, 140, t / 0.25), q: 0.9, env: { a: 0.001, tau: 0.07 }, send: 0.7, seed: o.seed || 9 });
    s.noise({ at, dur: 0.03, gain: 0.18 * g, ftype: 'hp', cut: 2500, q: 0.7, env: { a: 0.0005, tau: 0.004 }, send: 0.3, seed: (o.seed || 9) + 1 });
}

/** A riser: a comb jet climbing and dark noise opening, swelling into at + dur. */
function riser(s, at, dur, o) {
    const g = (o && o.gain) || 0.12, seed = (o && o.seed) || 77, e = { a: dur * 0.92, tau: 1, r: 0.02, curve: 'exp' };
    s.jet({ at, dur, delay: (t, x) => glide(0.02, 0.0016, Math.pow(x, 1.6)), fb: 0.8, gain: g, cut: (t, x) => glide(200, 2600, x), q: 0.8, env: e, send: 0.6,
        pan: (t, x) => Math.sin(x * 9) * 0.4, seed });
    s.noise({ at, dur, gain: g * 0.6, ftype: 'bp', cut: (t, x) => glide(150, 2000, x), q: 1.2, env: e, send: 0.6, seed: seed + 1 });
}

/** The space every sound lives in: big, dark (damped highs), no shimmer unless asked. */
const DARK = (o) => Object.assign({ mix: 0.5, rt60: 5, size: 1.4, damp: 2600, shimmer: 0, pre: 0.025, mod: 1 }, o);

/*
 * The Rinzler kit: every sound is built from the parts of Rinzler's opening (Tyson: "the Rinzler
 * sound should be the basis of all things").
 *   growl   the distorted tritone braam (root, tritone, octave on D1 + `semi`) with a 29 Hz
 *           ring-modulated growl and a sub
 *   suck    a metallic comb drone, reversed so it pulls into the hit
 *   scrape  a bowed plate, wobbling like metal dragged on metal
 *   RZ      its tight dark room
 */
const TRI = Math.pow(2, 6 / 12);
function growl(s, o) {
    const root = cents(hz('D1'), (o.semi || 0) * 100);
    braam(s, Object.assign({ cut: [110, 2000, 220], open: 0.25, q: 2.6, drive: 4.5, gain: 0.44, scoop: -90, ring: { f: 29, mix: 0.4 }, sub: 0.55 },
        o, { notes: o.notes || [root, root * TRI, root * 2] }));
}
function suck(s, end, len, o) {
    o = o || {};
    s.reverse(end, len, (t) => {
        t.jet({ dur: len, delay: () => 1 / (o.f || 46), fb: 0.94, gain: 0.35, cut: () => 700, q: 0.7, env: { a: 0.001, tau: len * 0.36 }, send: 0.8, seed: o.seed || 51 });
        t.space({ mix: 1, rt60: 2, size: 1, damp: 2200, pre: 0.003 });
    }, { gain: o.gain || 0.9, send: 0.2 });
}
function scrape(s, at, dur, o) {
    s.bowed(Object.assign({ at, dur, f: 128, body: 'plate', q: 45, gain: 0.08, drift: (t) => 1 + 0.03 * Math.sin(t * 6.3) * Math.sin(t * 1.7),
        env: { a: 0.3, d: 0.6, s: 0.6, r: Math.min(1, dur * 0.4) }, send: 0.5, seed: 53 }, o || {}));
}
const RZ = (o) => DARK(Object.assign({ mix: 0.42, rt60: 3.5, size: 1.1, damp: 2400 }, o));
const SOUNDS = {
    /* opening The Grid, and changing identity: one per identity, all from Rinzler's opening */
    boot_rinzler: { target: -16, when: 'The Grid opens, or Rinzler is picked', make() {
        // the original: a metallic drone pulled backwards into an impact, the distorted tritone growl, metal scraping
        const s = new Sound(4.4), h = 0.7;
        suck(s, h, 0.7);
        hit(s, { at: h, gain: 1.05, f0: 120, f1: 28, seed: 50 });
        growl(s, { at: h, dur: 2.9, seed: 52 });
        scrape(s, h, 2.8);
        return s.space(RZ()).tilt(3200, -6);
    } },
    boot_sam: { target: -16, when: 'The Grid opens, or Sam is picked', make() {
        // Rinzler, lifted: a riser into the suck, a brighter growl that rises a little as it rings, the scrape climbing
        const s = new Sound(4.8), h = 0.9;
        riser(s, 0, h, { gain: 0.09, seed: 15 });
        suck(s, h, 0.9, { seed: 16 });
        hit(s, { at: h, gain: 1.05, f0: 120, f1: 28, seed: 17 });
        growl(s, { at: h, dur: 3.3, cut: [110, 2500, 260], open: 0.35, bend: (t) => 35 * smooth(t / 3), seed: 18 });
        scrape(s, h, 3.1, { drift: (t) => glide(1, 1.06, t / 3) * (1 + 0.025 * Math.sin(t * 6.3) * Math.sin(t * 1.7)), seed: 19 });
        return s.space(RZ({ rt60: 4.5, mix: 0.48 })).tilt(3400, -5);
    } },
    boot_flynn: { target: -16, when: 'The Grid opens, or Flynn is picked', make() {
        // Rinzler, older and slower: a long suck, a deeper growl two semitones down with a slow growl, a low choir far behind
        const s = new Sound(5.6), h = 1.2;
        suck(s, h, 1.2, { f: 41, seed: 25 });
        hit(s, { at: h, gain: 1, f0: 90, f1: 26, tau: 0.8, dur: 2.4, seed: 26 });
        growl(s, { at: h, semi: -2, dur: 3.8, cut: [80, 1500, 160], open: 0.8, ring: { f: 19, mix: 0.4 }, seed: 27 });
        s.formant({ at: h + 0.3, dur: 3.6, notes: ['C2', 'G2', 'C3'], vowels: 'uoo', voices: 2, detune: 8, q: 9, gain: 0.12, cut: 1400,
            env: { a: 1.2, d: 0.6, s: 0.7, r: 1.3 }, send: 0.9 });
        scrape(s, h, 3.6, { drift: (t) => 0.9 * (1 + 0.02 * Math.sin(t * 3.1) * Math.sin(t * 0.9)), seed: 28 });
        return s.space(RZ({ rt60: 6, mix: 0.55, damp: 2000, size: 1.4 })).tilt(3000, -6);
    } },
    boot_ares: { target: -16, when: 'The Grid opens, or Ares is picked', make() {
        // Rinzler, at its worst: a riser and a long suck, the biggest impact, a harsher faster growl that sinks a semitone
        const s = new Sound(6.0), h = 1.2;
        riser(s, 0.1, h - 0.1, { gain: 0.08, seed: 35 });
        suck(s, h, 1.2, { f: 38, seed: 36 });
        hit(s, { at: h, gain: 1.15, f0: 95, f1: 25, glide: 0.5, tau: 0.9, dur: 3, seed: 37 });
        growl(s, { at: h, dur: 4.0, cut: [70, 1300, 120], open: 0.9, drive: 5.5, ring: { f: 37, mix: 0.45 }, bend: (t) => -110 * smooth(t / 3.5), sub: 0.6, seed: 38 });
        s.formant({ at: h + 0.5, dur: 3.6, notes: ['D2', 'Ab2'], vowels: 'ou', voices: 2, detune: 7, q: 10, gain: 0.1, env: { a: 1.2, d: 0.6, s: 0.7, r: 1.4 }, send: 1 });
        scrape(s, h, 3.8, { drift: (t) => glide(1, 0.9, t / 3.5) * (1 + 0.03 * Math.sin(t * 6.3) * Math.sin(t * 1.7)), seed: 39 });
        return s.space(RZ({ rt60: 7, mix: 0.55, damp: 1800, size: 1.6 })).tilt(2800, -7);
    } },

    /* one set sound for every button tap, on every screen */
    tap: { target: -25, when: 'Any button tap, on every screen (page tabs, Settings, Engine page)', make() {
        // a tiny growl: a short Rinzler blip on D2, a sub knock, a dark click
        const s = new Sound(0.6);
        growl(s, { semi: 12, dur: 0.09, cut: [900, 1800, 150], open: 0.004, gain: 0.32, scoop: 0, drive: 3.5, ring: { f: 29, mix: 0.25 },
            env: { a: 0.001, tau: 0.025, r: 0.02 }, air: 0.03, sub: 0, send: 0.25, seed: 41 });
        s.sub({ f0: 85, f1: 48, glide: 0.04, dur: 0.1, tau: 0.03, gain: 0.5, send: 0 });
        s.noise({ dur: 0.012, gain: 0.12, ftype: 'bp', cut: 2200, q: 1.2, env: { a: 0.0003, tau: 0.003 }, send: 0.2, seed: 42 });
        return s.space(RZ({ mix: 0.18, rt60: 1.0 })).tilt(4000, -4);
    } },

    /* the Engine page */
    map: { target: -17, when: 'Engine map switch accepted', make() {
        // Rinzler, short: suck, impact, growl
        const s = new Sound(3.0), h = 0.3;
        suck(s, h, 0.3, { seed: 71 });
        hit(s, { at: h, gain: 1, f0: 120, f1: 28, seed: 72 });
        growl(s, { at: h, dur: 2.2, seed: 73 });
        scrape(s, h, 2.0, { seed: 74 });
        return s.space(RZ()).tilt(3200, -6);
    } },
    flap_open: { target: -17, when: 'Exhaust flap opened', make() {
        // the growl opens up: its filter opens and its growl speeds up as the flap does
        const s = new Sound(2.2);
        growl(s, { dur: 1.6, cut: (t) => glide(60, 2400, smooth(t / 0.8)) * (t > 1.1 ? glide(1, 0.35, (t - 1.1) / 0.5) : 1), scoop: -150,
            ring: { f: (t) => glide(12, 34, Math.min(1, t / 0.8)), mix: 0.45 }, env: { a: 0.08, d: 0.5, s: 0.85, r: 0.5 }, air: 0.07, seed: 81 });
        scrape(s, 0.1, 1.5, { drift: (t) => glide(0.9, 1.1, t / 1.2) * (1 + 0.03 * Math.sin(t * 6.3)), seed: 82 });
        return s.space(RZ({ mix: 0.38, rt60: 3 })).tilt(3200, -5);
    } },
    flap_close: { target: -17, when: 'Exhaust flap closed', make() {
        // the growl shuts and falls, then an impact
        const s = new Sound(1.8), h = 0.42;
        growl(s, { dur: 0.48, cut: (t) => glide(2400, 70, t / 0.42), scoop: 0, bend: (t) => -200 * smooth(t / 0.42), env: { a: 0.01, d: 0.3, s: 0.8, r: 0.06 }, air: 0.06, sub: 0.4, seed: 91 });
        hit(s, { at: h, gain: 0.95, f0: 95, f1: 26, tau: 0.3, dur: 1.2, seed: 92 });
        return s.space(RZ({ mix: 0.35, rt60: 2.6 })).tilt(3000, -6);
    } },
    flap_oem: { target: -19, when: 'Exhaust flap handed back to the car', make() {
        // let go: a soft growl that swells and sinks away
        const s = new Sound(2.2);
        growl(s, { dur: 1.3, cut: [90, 700, 90], open: 0.35, drive: 3, gain: 0.34, scoop: 0, ring: { f: 29, mix: 0.3 }, bend: (t) => -100 * smooth((t - 0.3) / 1),
            env: { a: 0.15, d: 0.4, s: 0.7, r: 0.6 }, air: 0.03, seed: 101 });
        return s.space(RZ({ mix: 0.45, rt60: 3.8 })).tilt(3000, -6);
    } },
    cool_on: { target: -19, when: 'Max Cooling on', make() {
        // the machine breathes cold: two scrapes high in the dark, the growl slowed to a 7 Hz breath, wind
        const s = new Sound(3.0);
        scrape(s, 0, 2.4, { f: 256, gain: 0.07, drift: (t) => glide(0.97, 1.02, t / 2) * (1 + 0.01 * Math.sin(t * 2.3)), env: { a: 0.8, d: 0.4, s: 0.7, r: 0.8 }, seed: 111 });
        scrape(s, 0.2, 2.2, { f: 191, gain: 0.05, drift: (t) => 1 + 0.015 * Math.sin(t * 1.7), env: { a: 0.9, d: 0.4, s: 0.7, r: 0.8 }, seed: 112 });
        growl(s, { dur: 2.4, cut: [60, 280, 80], open: 1.0, gain: 0.36, scoop: 0, ring: { f: 7, mix: 0.6 }, env: { a: 0.6, d: 0.5, s: 0.7, r: 0.8 }, air: 0.03, seed: 113 });
        s.noise({ dur: 2.4, gain: 0.1, ftype: 'bp', cut: (t, x) => glide(300, 1200, smooth(x * 1.3)), q: 2.5, env: { a: 0.9, d: 0.4, s: 0.6, r: 0.8, curve: 'exp' },
            pan: (t) => Math.sin(t * 2.1) * 0.8, send: 0.7, seed: 114 });
        return s.space(RZ({ mix: 0.55, rt60: 5, damp: 3000 })).tilt(3400, -5);
    } },
    cool_off: { target: -20, when: 'Max Cooling off', make() {
        // the cold collapses: the scrape bends down and the slow growl closes
        const s = new Sound(2.2);
        scrape(s, 0, 1.3, { f: 256, gain: 0.07, drift: (t) => glide(1, 0.6, t / 1.2), env: { a: 0.02, tau: 0.45, r: 0.3 }, seed: 121 });
        growl(s, { dur: 1.2, cut: [300, 300, 60], open: 0.01, gain: 0.34, scoop: 0, ring: { f: 7, mix: 0.6 }, bend: (t) => -300 * smooth(t / 1.1), env: { a: 0.02, tau: 0.45, r: 0.3 }, seed: 122 });
        return s.space(RZ({ mix: 0.45, rt60: 3.5, damp: 2800 })).tilt(3200, -5);
    } },
    refused: { target: -18, when: 'A command the car refused or could not take', make() {
        // denied: two choked growls, falling a semitone
        const s = new Sound(1.2);
        [[0, 0, 0.2], [0.2, -1, 0.34]].forEach(([at, semi, d], k) => growl(s, { at, semi, dur: d, cut: [700, 700, 160], open: 0.005, q: 1.6, drive: 5.5, gain: 0.44, scoop: 0,
            ring: { f: 23, mix: 0.5 }, env: { a: 0.004, tau: d * 0.5, r: 0.04 }, air: 0.04, sub: 0.6, seed: 131 + k }));
        return s.space(RZ({ mix: 0.25, rt60: 1.6 })).tilt(3000, -6);
    } },

    /* warnings */
    warn: { target: -14, when: 'Oil, coolant or gearbox too hot, or a tyre low', make() {
        // klaxon: three growl pulses an octave up so they cut through, the last one sagging
        const s = new Sound(2.6);
        [[0, 0.26], [0.34, 0.26], [0.68, 0.6]].forEach(([at, d], k) => {
            growl(s, { at, semi: 12, dur: d, cut: [400, 2600, 600], open: 0.04, drive: 4.5, gain: 0.46, scoop: -40, ring: { f: 29, mix: 0.45 },
                bend: k === 2 ? (t) => -150 * smooth(t / 0.5) : null, env: { a: 0.01, d: 0.06, s: 0.8, r: 0.06 }, air: 0.04, sub: 0.6, send: 0.35, seed: 141 + k });
        });
        return s.space(RZ({ mix: 0.32, rt60: 2.6 })).tilt(3800, -3);
    } },

    /* the Track page's timed runs */
    run_go: { target: -17, when: 'A timed run starts (Track)', make() {
        // launch: an impact and the growl climbing an octave, a jet rushing past
        const s = new Sound(2.2);
        hit(s, { gain: 1, f0: 120, f1: 30, glide: 0.15, tau: 0.3, dur: 1.2, seed: 151 });
        growl(s, { dur: 1.3, cut: [200, 2400, 300], open: 0.15, scoop: -60, bend: (t) => 1200 * smooth(t / 0.9), env: { a: 0.01, d: 0.3, s: 0.6, r: 0.5 }, gain: 0.38, seed: 152 });
        s.jet({ dur: 0.9, delay: (t, x) => glide(0.012, 0.0009, x), fb: 0.85, gain: 0.15, cut: (t, x) => glide(200, 3000, x), q: 0.8, env: { a: 0.05, d: 0.4, s: 0.6, r: 0.4 },
            pan: (t, x) => -0.6 + 1.2 * x, send: 0.6, seed: 153 });
        return s.space(RZ({ mix: 0.4, rt60: 3 })).tilt(3200, -5);
    } },
    run_done: { target: -18, when: 'A timed run ends (Track)', make() {
        // settle: a soft growl sinking
        const s = new Sound(2.6);
        growl(s, { dur: 1.8, cut: [100, 800, 90], open: 0.25, drive: 3.2, gain: 0.34, scoop: 0, ring: { f: 29, mix: 0.3 }, bend: (t) => -70 * smooth(t / 1.5),
            env: { a: 0.04, d: 0.5, s: 0.6, r: 0.8 }, air: 0.03, seed: 161 });
        return s.space(RZ({ mix: 0.48, rt60: 4.2 })).tilt(3000, -6);
    } },
    best: { target: -15, when: 'A new best 0-60 or quarter mile (Track)', make() {
        // Rinzler at full size: riser, long suck, the biggest impact, the growl doubled an octave up, the scrape climbing
        const s = new Sound(6.0), h = 1.0;
        riser(s, 0, h, { gain: 0.1, seed: 171 });
        suck(s, h, 1.0, { seed: 172 });
        hit(s, { at: h, gain: 1.15, f0: 110, f1: 27, glide: 0.4, tau: 0.8, dur: 3, seed: 173 });
        growl(s, { at: h, dur: 4.2, cut: [90, 2400, 220], open: 0.6, sub: 0.6, seed: 174 });
        growl(s, { at: h + 0.05, semi: 12, dur: 3.8, cut: [120, 2200, 200], open: 0.8, gain: 0.22, sub: 0, scoop: -120, seed: 175 });
        scrape(s, h, 4.0, { drift: (t) => glide(1, 1.08, t / 3.5) * (1 + 0.03 * Math.sin(t * 6.3) * Math.sin(t * 1.7)), seed: 176 });
        return s.space(RZ({ mix: 0.5, rt60: 6, size: 1.4, damp: 2200 })).tilt(3000, -6);
    } },
};

/* ---------------------------------------------------------------- render */

function render(outDir, names) {
    fs.mkdirSync(outDir, { recursive: true });
    const rows = [];
    for (const name of names) {
        const def = SOUNDS[name];
        if (!def) throw new Error('no sound ' + name);
        const s = def.make();
        const m = master(s, def.target);
        fs.writeFileSync(path.join(outDir, name + '.wav'), wav(s, m.end));
        rows.push({ name, sec: +(m.end / SR).toFixed(2), loud: +m.loud.toFixed(1), peak: +m.peakDb.toFixed(1), clipped: m.clipped });
    }
    return rows;
}

module.exports = { SOUNDS, render, SR };

if (require.main === module) {
    const args = process.argv.slice(2);
    const outDir = args[0] && !SOUNDS[args[0]] ? args.shift() : path.join(__dirname, '..', '..', 'apps', 'the_grid', 'sounds');
    const names = args.length ? args : Object.keys(SOUNDS);
    render(outDir, names).forEach((r) => console.log(r.name.padEnd(13), (r.sec + ' s').padStart(8), (r.loud + ' dB').padStart(9), ('peak ' + r.peak).padStart(11), r.clipped ? '  knee x' + r.clipped : ''));
}
