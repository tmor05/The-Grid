'use strict';
/**
 * volume.js - The Grid's own volume bar on the centre screen.
 *
 * The Grid draws on a layer above BMW's HMI, so BMW's volume pop-up is hidden under it
 * (Tyson, 2026-11-16). The car's AudioManager reports the main volume in its sink list:
 * CommandControl.getListMainSinks(), sink 1 "MainSink", fields `volume` and `muteState`.
 * Read on the car the same day, it follows the knob (27 -> 31 -> 26 -> 30 -> 26 with FM on).
 * getVolume() always answers 0 and the volumeChanged event never fires on this car, so the
 * list is read 4 times a second while The Grid is on screen, and the bar shows for a moment
 * after the level or the mute changes.
 *
 * With nothing playing the sink reads 0 (BMW then also says "Mute not possible"), so a jump
 * to or from 0 bigger than a knob turn (a source starting or stopping) shows nothing.
 * The top of the car's scale isn't known: the bar's full scale starts at 40 and grows to
 * the highest level seen (kept in the app's data folder). The number is always shown.
 */
const fs = require('fs');
const path = require('path');
const H = require('./hud');

const IFACE = 'org.genivi.am.commandinterface.CommandControl';
const MAIN_SINK = 1;
const POLL_MS = 250;           // 4 reads a second while The Grid is on screen
const SHOW_MS = 2200;          // how long the bar stays after the last change
const IN_MS = 140, OUT_MS = 380;
const SCALE_MIN = 40;          // full scale until the car shows a higher level
const JUMP = 4;                // a change to/from 0 bigger than this is a source starting/stopping
const SEGS = 32;
const A = H.A;

class GridVolume {
    /**
     * ctx: the app's ctx (signals, ui, log, dataDir). o.on(): whether the bar is wanted (setting).
     * o.onChange(): called when the bar appears or its value changes, to draw without waiting.
     */
    constructor(ctx, o) {
        this.ctx = ctx;
        this.log = ctx.log;
        this.o = o || {};
        this.vol = null;           // last level read (null until the first reading)
        this.mute = false;
        this.shownAt = 0;          // when the bar (re)appeared
        this.changedAt = 0;        // last change that shows the bar
        this.proxy = null;
        this.retryAt = 0;
        this.fails = 0;
        this.warned = false;
        this.busy = false;
        this.timer = null;
        this.file = ctx.dataDir ? path.join(ctx.dataDir, 'volume.json') : null;
        this.top = SCALE_MIN;
        try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (j.top > SCALE_MIN) this.top = j.top; } catch (e) { /* first run */ }
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => this.poll(), POLL_MS);
        this.poll();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /** The Grid's centre screen is up (only then is BMW's pop-up hidden). */
    onScreen() {
        const ui = this.ctx.ui;
        return !ui || !ui.isVisible || ui.isVisible('MAIN');
    }

    async poll() {
        if (this.busy) return;
        if (!this.onScreen() || (this.o.on && !this.o.on())) { this.vol = null; return; }   // fresh baseline when it comes back
        if (!this.proxy && Date.now() < this.retryAt) return;
        this.busy = true;
        try {
            const sig = this.ctx.signals;
            if (!this.proxy) this.proxy = await sig.proxy(IFACE, '1');
            const r = await sig.call(this.proxy, 'getListMainSinks', {}, 1000);
            const s = ((r && r.listMainSinks) || []).filter((x) => x && x.sinkID === MAIN_SINK)[0];
            if (s) this.update(Number(s.volume), s.muteState === 'MS_MUTED');
            this.fails = 0;
        } catch (e) {
            if (!this.warned) { this.warned = true; this.log.warn('volume: ' + (e && e.message || e)); }
            if (++this.fails >= 3) { this.proxy = null; this.fails = 0; this.retryAt = Date.now() + 30000; }   // try again later
        } finally {
            this.busy = false;
        }
    }

    /** A reading: vol (number), mute (bool). The first one after coming on screen only sets the baseline. */
    update(vol, mute) {
        if (!isFinite(vol)) return;
        const prev = this.vol, prevMute = this.mute;
        this.vol = vol; this.mute = mute;
        if (prev === null) { if (!this.firstLogged) { this.firstLogged = true; this.log.info('volume: reading the car\'s level (' + vol + (mute ? ', muted' : '') + ')'); } return; }
        if (vol > this.top) { this.top = vol; this.save(); }
        const sourceJump = (prev === 0 || vol === 0) && Math.abs(vol - prev) > JUMP;
        const show = mute !== prevMute || (vol !== prev && !sourceJump);
        if (!show) return;
        this.log.info('volume: ' + prev + (prevMute ? ' muted' : '') + ' -> ' + vol + (mute ? ' muted' : ''));
        const now = Date.now();
        if (!this.visible(now)) this.shownAt = now;
        this.changedAt = now;
        if (this.o.onChange) { try { this.o.onChange(); } catch (e) { /* the app's */ } }
    }

    save() {
        if (!this.file) return;
        try { fs.writeFileSync(this.file, JSON.stringify({ top: this.top })); } catch (e) { /* read-only data dir: keep it in memory */ }
    }

    /** The bar is up (from a change until its fade-out ends). */
    visible(now) {
        const t = now || Date.now();
        return this.changedAt > 0 && t - this.changedAt < SHOW_MS + OUT_MS;
    }

    /** 0..1: how much of the bar shows now (fades in from a quarter, holds, fades out). */
    level(now) {
        if (!this.visible(now)) return 0;
        const since = now - this.changedAt, inK = Math.min(1, 0.25 + 0.75 * (now - this.shownAt) / IN_MS);
        const outK = since <= SHOW_MS ? 1 : 1 - (since - SHOW_MS) / OUT_MS;
        return H.ease(Math.max(0, Math.min(inK, outK)));
    }

    /** Draw the bar over the page (cv 1600 x 520), in the theme's colours. */
    draw(cv, t, cw) {
        const k = this.level(Date.now());
        if (k <= 0 || this.vol === null) return;
        const W = cw || cv.w || 1600;
        const w = 620, h = 96, x = Math.round((W - w) / 2), y = 64 - Math.round((1 - k) * 14), cut = 16;
        const c = this.mute ? t.crit : t.accent;
        // over whatever the page left set: no transform, no clip (display.js does the same before its own marks)
        if (cv.xf) cv.xf();
        if (cv.noclip) cv.noclip();
        cv.alpha(k);
        H.fillCut(cv, x, y, w, h, cut, A('#000000', 0.78));
        H.fillCut(cv, x, y, w, h, cut, A(c, 0.06));
        cv.gradientRect(x + cut, y + 1, w - cut, 28, [[0, A(c, 0.12)], [1, A(c, 0)]]);
        H.neon(cv, H.cutBox(x, y, w, h, cut), 1.4, A(c, 0.7), 0.7);
        // bright corner accents on the cuts, as the panels have
        cv.line(x, y + cut + 18, x, y + cut, 3, c); cv.line(x, y + cut, x + cut, y, 3, c); cv.line(x + cut, y, x + cut + 34, y, 3, c);
        cv.line(x + w, y + h - cut - 18, x + w, y + h - cut, 3, c); cv.line(x + w, y + h - cut, x + w - cut, y + h, 3, c); cv.line(x + w - cut, y + h, x + w - cut - 34, y + h, 3, c);
        H.mono(cv, this.mute ? 'AUDIO // MUTED' : 'AUDIO // VOLUME', x + cut + 12, y + 21, 15, A(c, 0.95));
        H.mono(cv, 'SNK.01', x + w - 14, y + 21, 12, A(c, 0.5), 'right');
        // the bar: 32 slanted segments, lit up to the level on the scale seen so far
        const bx = x + 26, by = y + 46, bw = w - 26 - 150, bh = 26;
        const frac = this.mute ? 0 : Math.max(0, Math.min(1, this.vol / this.top));
        H.segBar(cv, bx, by, bw, bh, SEGS, frac, () => c, A(c, this.mute ? 0.16 : 0.1));
        // the edge of the lit part gets a light line, as the gauges' leading edges do
        if (frac > 0) H.lightLine(cv, bx, by + bh + 8, bw * frac, c, '#ffffff');
        // the level
        const nx = x + w - 22, ny = y + 82;
        if (this.mute) H.head(cv, 'MUTE', nx, ny - 8, 30, t.crit, 'right', 2);
        else H.num(cv, String(Math.round(this.vol)), nx, ny, 52, t.text, 'right', c);
        cv.alpha(1);
    }
}

module.exports = { GridVolume, IFACE, MAIN_SINK, SCALE_MIN, SHOW_MS, OUT_MS };
