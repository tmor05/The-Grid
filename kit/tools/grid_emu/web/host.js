'use strict';
/**
 * host.js (emulator page) - the head unit as the app sees it, in the browser: the RHMI ui, the
 * real Settings class and settings sheet wiring (taken from the app's own kit/mgu.js at build
 * time), ctx, the loop paced by the renderer's ticks, and SOME/IP signals fed by the page's car
 * (sim.js), with the diagnostic transport (InternalTasu) answered by a simulated DME.
 *
 * A browser port of kit/tools/hu-stub.js's live mode (what kit/tools/emu.js runs the app with).
 */
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { Buffer } = require('buffer');
const { Display, HMI } = require('APPDIR/kit/display');
const themes = require('APPDIR/kit/themes');
const { listSheet } = require('APPDIR/kit/sheet');
const mguParts = require('GEN/mgu-parts');
const SPEC = require('APPDIR/kit/app-spec.json');

const DATA = '/data';
const TASU = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';

/**
 * ctx.signals: watch() keeps the handlers; feed(iface, field, value) calls them as a SOME/IP
 * notification would. The InternalTasu proxy takes sendTasuRequest and answers with
 * sendTasuResponse frames from ecu(target, sid, data) -> reply bytes | null (no reply).
 */
function makeSignals(log) {
    const subs = Object.create(null);
    const tasu = { cbs: [], avail: [], ecu: null, up: true, sent: 0 };
    const feed = (iface, field, value) => (subs[iface] || []).forEach((s) => {
        if (!s.h[field]) return;
        s.res.available = true;
        try { s.h[field](value); } catch (e) { log.warn(iface + '.' + field + ': ' + (e && e.stack || e)); }
    });
    const no = () => Promise.reject(new Error('emulator: no such SOME/IP service'));
    const respond = (ecu, bytes) => {
        const frame = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, ecu & 0xff, 0xF2, 0x00].concat(bytes));
        tasu.cbs.forEach((fn) => { try { fn({ udsResponse: frame, errorCode: 'NO_ERROR' }); } catch (e) { log.warn('TASU listener: ' + e); } });
    };
    const api = {
        watch: async (iface, inst, handlers) => {
            const res = { iface, available: false, proxy: null, error: null, shutdown: () => Promise.resolve() };
            (subs[iface] = subs[iface] || []).push({ h: handlers || {}, res });
            return res;
        },
        proxy: async (iface, inst) => {
            if (iface !== TASU) return no();
            return { iface, inst, isAvailable: () => tasu.up };
        },
        on: async (p, name, fn) => { if (p && p.iface === TASU && name === 'sendTasuResponse') tasu.cbs.push(fn); },
        onAvailable: async (p, fn) => { if (p && p.iface === TASU) { tasu.avail.push(fn); setTimeout(() => fn(tasu.up), 300); } },
        call: async (p, method, req) => {
            if (!p || p.iface !== TASU || method !== 'sendTasuRequest') return no();
            if (!tasu.up) return { TasuErrorEnum: 'APP_REQUEST_NOT_ACCEPTED' };
            tasu.sent++;
            const target = req.targetAddress, sid = req.serviceID, data = Array.prototype.slice.call(req.udsData || []);
            // a DME answers in a few ms over the car's internal link; a busy one a little later
            setTimeout(() => {
                let reply = null;
                try { reply = tasu.ecu ? tasu.ecu(target, sid, data) : null; } catch (e) { log.warn('sim ECU: ' + (e && e.stack || e)); }
                if (reply && reply.then) reply.then((r) => { if (r) respond(target, r); });
                else if (reply) respond(target, reply);
            }, 8 + Math.random() * 14);
            return { TasuErrorEnum: 'NO_ERROR' };
        },
        set: no,
        hasNative: () => false,
        loadConfig: () => { throw new Error('emulator: no SOME/IP configs'); },
    };
    return {
        api, feed, tasu,
        setEcu(fn) { tasu.ecu = fn; },
        /** The diagnostic link up or down (the page's "DME link" switch). */
        link(up) { tasu.up = !!up; tasu.avail.forEach((fn) => { try { fn(tasu.up); } catch (e) { /* app's */ } }); },
    };
}

/**
 * The head unit. hu.start(loadApp) loads the app (its mgu.run(impl) gets hu.ctx).
 * Events: 'screens' (the screen stack), 'hmiscreen' (an HMI screen the emulator does not draw).
 */
function headUnit(o) {
    const log = o.log;
    fs.__persist(DATA);
    const { Settings, wireSettings } = mguParts(fs, path, DATA, log, SPEC, listSheet);
    const hu = new EventEmitter();
    const settings = hu.settings = new Settings(SPEC.settings);
    if (!fs.existsSync(settings.file)) {
        settings.values.demo = 'auto';
        Object.assign(settings.values, o.sets || {});
    }
    hu.spec = SPEC; hu.log = log;
    const main = (SPEC.screens && SPEC.screens[0] && SPEC.screens[0].name) || 'MAIN';

    /* ---- the RHMI: components are event emitters, the screens a stack (hu-stub.js liveUi) ---- */
    const comps = Object.create(null), vis = Object.create(null), visH = [], focusH = [];
    const comp = (n) => comps[n] || (comps[n] = Object.assign(new EventEmitter(), { name: n }));
    const stack = hu.stack = [];
    const setVis = (n, on) => {
        if (!!vis[n] === on) return;
        vis[n] = on;
        visH.forEach((fn) => { try { fn(n, on); } catch (e) { log.error(e); } });
    };
    const changed = () => hu.emit('screens', stack.slice());
    let display = null;
    const ui = hu.ui = {
        rhmi: { getByName: comp },
        comp,
        // software path (setting "Renderer: Software", or an HMI layout the renderer leaves): the HMI's own image
        image: (name, img) => display.present(name, img, (n, cv) => { if (o.onSoft && cv && cv.d) o.onSoft(cv); return Promise.resolve(); }),
        _image: () => Promise.resolve(),
        text: async (n, t, row, cell) => { if (!row && (!cell || cell === 'Text')) display.label(n, t); },
        cells: async () => {}, rows: async () => {}, selected: async () => {},
        visible: async () => {}, enabled: async () => {}, checked: async () => {},
        onClick: (n, fn) => comp(n).on('action', (ev) => {
            log.info('click ' + n);
            Promise.resolve().then(() => fn(ev || {})).catch((e) => log.error('click ' + n, e));
        }),
        open: async (n) => {
            if (n === 'SETTINGS' || !(SPEC.screens || []).some((s) => s.name === n)) { hu.emit('hmiscreen', n); return; }
            const top = stack[stack.length - 1];
            if (top === n) return;
            if (stack.indexOf(n) >= 0) stack.splice(stack.indexOf(n), 1);
            stack.push(n);
            if (top) setVis(top, false);
            setVis(n, true);
            changed();
        },
        close: async (n) => {
            const i = stack.indexOf(n);
            if (i < 0) return;
            const top = i === stack.length - 1;
            stack.splice(i, 1);
            if (top) { setVis(n, false); if (stack.length) setVis(stack[stack.length - 1], true); }
            changed();
        },
        home: () => { const s = stack.splice(0); s.forEach((n) => setVis(n, false)); changed(); },
        isVisible: (n) => !!vis[n],
        onVisible: (fn) => visH.push(fn),
        hasFocus: () => true,
        onFocus: (fn) => focusH.push(fn),
        _invalidate: () => {},
        timing: { png: 0, push: 0 },
    };
    const themeFn = () => themes.theme(settings.get('theme'));
    display = hu.display = new Display(ui, log, SPEC, settings, themeFn);
    ui.display = display;

    /* ---- ctx.loop: once per renderer tick while the GPU renderer shows the screen (hu-stub.js liveLoop) ---- */
    const loop = (stateName, fps, fn) => {
        let timer = null, on = false, running = false;
        const gpuOn = () => display.active(stateName);
        const tick = async () => {
            timer = null;
            if (!on || running) return;
            running = true;
            const t0 = performance.now();
            try { await fn(); } catch (e) { log.error('loop ' + stateName, e); }
            running = false;
            hu.jsMs = hu.jsMs * 0.9 + (performance.now() - t0) * 0.1;
            schedule();
        };
        const schedule = () => {
            if (!on || timer !== null || running) return;
            if (gpuOn()) timer = setTimeout(tick, display.gpu && display.gpu.waiting ? 250 : 16);
            else timer = setTimeout(tick, Math.max(15, 1000 / fps));
        };
        display.onTick(() => {
            if (!on || running) return;
            if (timer !== null) { clearTimeout(timer); timer = null; }
            if (gpuOn()) tick(); else schedule();
        });
        const set = (v) => {
            on = v;
            if (on && timer === null && !running) timer = setTimeout(tick, 0);
            if (!on && timer !== null) { clearTimeout(timer); timer = null; }
        };
        ui.onVisible((name, v) => { if (name === stateName) set(v); });
        if (ui.isVisible(stateName)) set(true);
        return { stop: () => set(false), kick: () => { if (on && !running) { if (timer !== null) clearTimeout(timer); timer = setTimeout(tick, 0); } } };
    };
    hu.jsMs = 0;

    const sig = hu.sig = makeSignals(log);
    const ctx = hu.ctx = {
        ui, settings, spec: SPEC, dataDir: DATA, log, display,
        canvas: (w, h) => display.canvas(w, h),
        onTab(fn) { display.onTab = fn; },
        onTap(fn) { display.onTap = fn; },
        sheet: (sh) => display.openSheet(sh),
        hideButton(id) { display.hideButton(id); },
        onScroll(fn) { display.onScroll = fn; },
        onLayout(fn) { display.onLayout(fn); },
        controller: { grab(on) { display.grab(on); }, onInput(fn) { display.onCcu = fn; } },
        signals: sig.api,
        theme: themeFn,
        loop,
        widget: { ready: false, active: () => false, instances: () => [], onChange() {}, onTap() {}, set: async () => {}, image() {}, loop() {} },
    };

    /** mgu.run(impl) for the app (kit/mgu is this host in the bundle). */
    hu.run = async (impl) => {
        try { await wireSettings(ctx); } catch (e) { log.error('settings screen', e); }
        try { await impl.start(ctx); } catch (e) { log.error('app start', e); }
        log.info('initialized');
        ui.open(main);
        return ctx;
    };
    hu.Settings = Settings;
    hu.HMI = HMI;
    /** A tap the HMI got (outside the app's claims): its bar button under it is pressed (hu-stub.js hmiTap). */
    hu.hmiTap = (x, y) => {
        const d = display, sc = d.screen;
        if (!sc || stack[stack.length - 1] !== sc.name || d.hmiBarHidden || y < HMI.barTop + 4) return false;
        const b = d.buttons().find((q) => x >= q.x - d.barOff && x < q.x - d.barOff + q.w);
        if (!b) return false;
        log.info('HMI: ' + b.id + ' tapped');
        comp(b.id).emit('action', {});
        return true;
    };
    /** HMI back / home / open (the page's HMI buttons, the HMI column) */
    hu.hmi = (a) => {
        if (a === 'back') { const top = stack[stack.length - 1]; if (top) ui.close(top); }
        else if (a === 'home') ui.home();
        else if (a === 'open') ui.open(stack[stack.length - 1] || main);
    };
    return hu;
}

module.exports = { headUnit, makeSignals, DATA };
