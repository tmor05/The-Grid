'use strict';
/**
 * sound.js - The Grid's sound effects: which sound plays when, and how often.
 *
 * Setting "Sounds": Off (ships Off) / On. On plays:
 *   opening   The Grid opening, or an identity picked (one sound per identity)
 *   tap       one set sound for every button tap on every screen: the app's buttons, the page
 *             tabs and arrows, and the Settings list (main.js and hud.js call tap())
 *   Engine    the car's answer after a tap: map accepted, flap open / closed / OEM, Max Cooling
 *             on / off, or refused
 *   warnings  oil at the "Oil temp warning" setting, coolant over 112 deg C, gearbox over
 *             115 deg C, a tyre 0.4 bar under its target
 *   Track     a timed run starting, ending, a new best (only while Track is on screen)
 * No throttle or shift sounds (Tyson: "I don't want throttle or shift noises").
 *
 * The sounds are the WAV files in sounds/, made by kit/tools/grid_sfx.js (original, all built
 * from the Rinzler opening, no film audio). Playing them is sound_out.js's job: on the car it plays
 * nothing yet, until the on-car check shows how the head unit lets an app add a sound. The
 * emulator swaps in its own player (WebAudio).
 */
const out = require('./sound_out');

const NAMES = ['boot_rinzler', 'boot_sam', 'boot_flynn', 'boot_ares', 'tap', 'map', 'flap_open', 'flap_close', 'flap_oem',
    'cool_on', 'cool_off', 'refused', 'warn', 'run_go', 'run_done', 'best'];
/** The least time between two plays of one sound (ms). */
const GAP = { tap: 60, warn: 5000, refused: 300, boot: 1500 };
const keyOf = (name) => (/^boot_/.test(name) ? 'boot' : name);
const isNum = (v) => typeof v === 'number' && isFinite(v);
const TY_FLAT = 0.4;                                 // bar under the car's target: the Chassis page's LOW

class GridSound {
    /** ctx: the app's context (settings, log). opts.theme() -> the identity's name. */
    constructor(ctx, opts) {
        this.ctx = ctx;
        this.settings = ctx.settings;
        this.log = ctx.log;
        this.opts = opts || {};
        this.last = {};
        this.warns = {};
        out.init({ log: ctx.log, names: NAMES });
    }

    /** Sounds on? (Older saved values "subtle" / "full" count as on.) */
    on() {
        const v = this.settings.get('sounds');
        return !!v && v !== 'off';
    }

    /** Play one sound if Sounds is on and it has not just played. Returns true when sent. */
    play(name) {
        if (!this.on() || NAMES.indexOf(name) < 0) return false;
        const now = Date.now(), k = keyOf(name), gap = GAP[k] == null ? 120 : GAP[k];
        if (this.last[k] && now - this.last[k] < gap) return false;
        this.last[k] = now;
        try { out.play(name); } catch (e) { this.log.warn('sound ' + name + ': ' + e); }
        return true;
    }

    /** The button-tap sound (any button, any screen). */
    tap() { return this.play('tap'); }

    /** The identity's opening sound (The Grid opens, an identity is picked, Sounds is turned on). */
    boot() {
        const id = this.opts.theme ? this.opts.theme() : 'sam';
        return this.play(NAMES.indexOf('boot_' + id) >= 0 ? 'boot_' + id : 'boot_sam');
    }

    /**
     * Once a second with live data (never demo data): one warning sound when a value crosses its
     * limit; the same value again only after it has been back under it and 2 minutes have passed.
     */
    watchWarnings(d) {
        if (!d) return;
        const oilLim = Number(this.settings.get('oilWarn')) || 125;
        const trans = isNum(d.gearbox) ? d.gearbox : d.egs;
        const tests = [
            ['oil', isNum(d.oil) ? d.oil >= oilLim : null, isNum(d.oil) && d.oil < oilLim - 3],
            ['coolant', isNum(d.coolant) ? d.coolant > 112 : null, isNum(d.coolant) && d.coolant < 109],
            ['trans', isNum(trans) ? trans > 115 : null, isNum(trans) && trans < 112],
        ];
        ['FL', 'FR', 'RL', 'RR'].forEach((c) => {
            const p = d['p' + c], pt = d['pt' + c];
            const ok = isNum(p) && isNum(pt) && pt > 0.5;
            tests.push(['tyre' + c, ok ? p < pt - TY_FLAT : null, ok && p >= pt - TY_FLAT + 0.1]);
        });
        const now = Date.now();
        let fire = false;
        for (const [k, over, clear] of tests) {
            const w = this.warns[k] || (this.warns[k] = { on: false, t: 0 });
            if (over && !w.on) {
                w.on = true;
                if (now - w.t > 120000) { w.t = now; fire = true; }
            } else if (clear) w.on = false;
        }
        if (fire) this.play('warn');
    }
}

module.exports = { GridSound, NAMES };
