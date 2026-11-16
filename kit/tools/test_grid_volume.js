'use strict';
/**
 * test_grid_volume.js - The Grid's own volume bar (apps/the_grid/volume.js) without a head unit:
 * the reading from the AudioManager's sink list, the first reading only setting the baseline,
 * a knob turn or mute showing the bar, a source starting or stopping (a jump to or from 0)
 * showing nothing, the fade, the scale growing past 40 and kept, no reads while The Grid is
 * off screen or the setting is Off, backing off when the car doesn't answer, and the drawing
 * on the car's own drawing recorder (kit/runtime/record.js) in every theme.
 *
 *   node kit/tools/test_grid_volume.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'apps', 'the_grid');
// the app's kit folder is staged by the build; point it at the real kit for the test
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
    if (req.startsWith('./kit/') && parent && parent.filename && parent.filename.startsWith(APP)) {
        req = path.join(ROOT, 'kit', 'runtime', req.slice(6));
    }
    return origResolve.call(this, req, parent, ...rest);
};
const { GridVolume, IFACE, SCALE_MIN, SHOW_MS, OUT_MS } = require(path.join(APP, 'volume.js'));
const { Recorder } = require(path.join(ROOT, 'kit', 'runtime', 'record.js'));
const themes = require(path.join(ROOT, 'kit', 'runtime', 'themes.js'));

let clock = 1e7;
Date.now = () => clock;

/** The car's AudioManager as read on 2026-11-16: sink 1 carries the level and the mute. */
function fakeCar() {
    const car = { volume: 27, mute: false, up: true, reads: 0, proxies: 0 };
    car.signals = {
        proxy: async (iface, inst) => {
            assert.strictEqual(iface, IFACE); assert.strictEqual(inst, '1');
            car.proxies++;
            if (!car.up) throw new Error('not available');
            return { iface };
        },
        call: async (p, method, args) => {
            assert.strictEqual(method, 'getListMainSinks');
            assert.deepStrictEqual(args, {});
            car.reads++;
            if (!car.up) throw new Error('timeout');
            return { listMainSinks: [
                { sinkID: 1024, name: 'MediaSink_Front', volume: 0, muteState: 'MS_UNKNOWN' },
                { sinkID: 1, name: 'MainSink', volume: car.volume, muteState: car.mute ? 'MS_MUTED' : 'MS_UNMUTED' },
            ], amError: 'E_OK' };
        },
    };
    return car;
}

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridvol-'));
    const car = fakeCar();
    let shown = true, setting = 'on';
    const warns = [];
    const ctx = { signals: car.signals, ui: { isVisible: (n) => n === 'MAIN' && shown }, log: { info() {}, warn(m) { warns.push(m); } }, dataDir: dir };
    const vol = new GridVolume(ctx, { on: () => setting !== 'off' });
    const read = () => vol.poll();
    const at = (ms) => { clock += ms; };

    // the first reading only sets the baseline: opening The Grid shows no bar
    await read();
    assert.strictEqual(vol.vol, 27);
    assert.strictEqual(vol.visible(), false, 'no bar on the first reading');

    // a knob turn shows it; it holds, then fades out
    car.volume = 31; await read();
    assert.strictEqual(vol.visible(), true, 'knob up shows the bar');
    at(SHOW_MS - 100); assert(vol.level(clock) > 0.99, 'holds');
    at(100 + OUT_MS / 2); const mid = vol.level(clock); assert(mid > 0 && mid < 1, 'fades out');
    at(OUT_MS); assert.strictEqual(vol.visible(), false, 'gone after the fade');

    // turning on while it shows keeps it up (no fade-in again)
    car.volume = 30; await read(); at(1000);
    car.volume = 29; await read();
    assert(vol.level(clock) > 0.99, 'stays up while the knob turns');
    at(SHOW_MS + OUT_MS + 1);

    // nothing playing reads 0: a source stopping or starting shows nothing
    car.volume = 0; await read();
    assert.strictEqual(vol.visible(), false, 'radio off (27 -> 0) shows nothing');
    car.volume = 27; await read();
    assert.strictEqual(vol.visible(), false, 'radio on (0 -> 27) shows nothing');
    // but turning the knob down to 0 does
    car.volume = 1; await read(); at(SHOW_MS + OUT_MS + 1);
    car.volume = 0; await read();
    assert.strictEqual(vol.visible(), true, 'knob 1 -> 0 shows the bar');
    at(SHOW_MS + OUT_MS + 1);
    car.volume = 27; await read(); at(SHOW_MS + OUT_MS + 1);

    // mute and unmute show it
    car.mute = true; await read();
    assert.strictEqual(vol.mute, true); assert.strictEqual(vol.visible(), true, 'mute shows the bar');
    at(SHOW_MS + OUT_MS + 1);
    car.mute = false; await read();
    assert.strictEqual(vol.visible(), true, 'unmute shows the bar');
    at(SHOW_MS + OUT_MS + 1);

    // the scale: 40 until the car shows more, then the highest level seen, kept in the data folder
    assert.strictEqual(vol.top, SCALE_MIN);
    car.volume = 52; await read();
    assert.strictEqual(vol.top, 52);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'volume.json'), 'utf8')).top, 52);
    const again = new GridVolume(ctx, {});
    assert.strictEqual(again.top, 52, 'the scale is kept across starts');
    at(SHOW_MS + OUT_MS + 1);

    // off screen (BMW's own pop-up shows then) or setting Off: no reads, and a fresh baseline on return
    let n = car.reads;
    shown = false; await read(); assert.strictEqual(car.reads, n, 'no reads off screen');
    car.volume = 20; shown = true; await read();
    assert.strictEqual(vol.visible(), false, 'a change made while off screen shows nothing on return');
    setting = 'off'; n = car.reads; await read(); assert.strictEqual(car.reads, n, 'no reads with the setting Off');
    setting = 'on'; await read();

    // the car doesn't answer: warned once, then back off 30 s before building the proxy again
    car.up = false;
    await read(); await read(); await read();
    assert.strictEqual(warns.length, 1, 'one warning');
    n = car.reads; const np = car.proxies;
    await read(); assert.strictEqual(car.reads, n, 'backs off'); assert.strictEqual(car.proxies, np);
    car.up = true; at(30001); await read();
    assert.strictEqual(car.proxies, np + 1, 'tries again after 30 s');

    // drawing on the car's own recorder, every theme, level and mute; nothing drawn when hidden
    for (const id of Object.keys(themes.THEMES || themes).filter((k) => /sam|flynn|rinzler|ares/.test(k))) {
        const t = (themes.get ? themes.get(id) : (themes.THEMES || themes)[id]);
        if (!t || !t.accent) continue;
        for (const st of [{ v: 27, m: false }, { v: 0, m: false }, { v: 52, m: false }, { v: 27, m: true }]) {
            car.volume = st.v; car.mute = st.m;
            vol.vol = null; await read();                      // baseline
            car.volume = st.v + 1; await read();               // a change shows it
            vol.update(st.v, st.m);
            const cv = new Recorder(1600, 520);
            vol.draw(cv, t, 1600);
            assert(cv.n > 50, 'draws (' + id + ' ' + JSON.stringify(st) + ')');
            at(SHOW_MS + OUT_MS + 1);
            const cv2 = new Recorder(1600, 520);
            vol.draw(cv2, t, 1600);
            assert.strictEqual(cv2.n, 0, 'nothing when hidden');
        }
    }
    console.log('test_grid_volume: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
