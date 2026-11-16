'use strict';
/**
 * test_grid_sound.js - The Grid's sound triggers (apps/the_grid/sound.js) without a head unit:
 * the Sounds setting, one tap sound (repeats within 60 ms dropped), the identity openings,
 * warnings once per crossing, that every name has its WAV in apps/the_grid/sounds and no stray
 * WAVs are left, and that the kit's display reports presses (ctx.onPress) for the tap.
 *
 *   node kit/tools/test_grid_sound.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', '..', 'apps', 'the_grid');
const played = [];
require.cache[require.resolve(path.join(APP, 'sound_out.js'))] = {
    id: 'sound_out', filename: 'sound_out', loaded: true,
    exports: { init() {}, play(n) { played.push(n); } },
};
const { GridSound, NAMES } = require(path.join(APP, 'sound.js'));

let clock = 1e6;
Date.now = () => clock;
const settings = { v: { sounds: 'off', theme: 'sam', oilWarn: 125 }, get(k) { return this.v[k]; } };
const ctx = { settings, log: { info() {}, warn() {} } };
const sfx = new GridSound(ctx, { theme: () => settings.get('theme') });
const take = () => played.splice(0);

// every sound has its file, and nothing else is in sounds/
NAMES.forEach((n) => assert(fs.existsSync(path.join(APP, 'sounds', n + '.wav')), 'missing sounds/' + n + '.wav'));
assert.deepStrictEqual(fs.readdirSync(path.join(APP, 'sounds')).filter((f) => NAMES.indexOf(f.replace(/\.wav$/, '')) < 0), [], 'stray files in sounds/');
// no throttle or shift sounds
['tick_1', 'shift', 'upshift', 'tab'].forEach((n) => assert(NAMES.indexOf(n) < 0, n + ' should be gone'));

// Off sends nothing; On plays; older saved values count as on
assert.strictEqual(sfx.tap(), false);
settings.v.sounds = 'on';
assert.strictEqual(sfx.tap(), true);
clock += 1000; settings.v.sounds = 'full'; assert.strictEqual(sfx.play('map'), true);
settings.v.sounds = 'on';
assert.deepStrictEqual(take(), ['tap', 'map']);

// one tap per press: a second within 60 ms (the kit's press and the page change it causes) drops
clock += 1000; assert(sfx.tap()); clock += 20; assert(!sfx.tap()); clock += 60; assert(sfx.tap());
assert.deepStrictEqual(take(), ['tap', 'tap']);

// the identity's opening sound, not twice within 1.5 s
settings.v.theme = 'ares';
assert(sfx.boot()); assert(!sfx.boot());
assert.deepStrictEqual(take(), ['boot_ares']);

// warnings: once when the oil crosses the setting, not again while hot, not again within 2 minutes
const base = { oil: 110, coolant: 95, gearbox: 80, pFL: 2.6, ptFL: 2.6 };
clock += 1000; sfx.watchWarnings(base);
clock += 1000; sfx.watchWarnings(Object.assign({}, base, { oil: 126 }));
clock += 1000; sfx.watchWarnings(Object.assign({}, base, { oil: 128 }));
assert.deepStrictEqual(take(), ['warn']);
clock += 1000; sfx.watchWarnings(base);
clock += 1000; sfx.watchWarnings(Object.assign({}, base, { oil: 126 }));
assert.deepStrictEqual(take(), [], 'the same warning within 2 minutes');
clock += 130000; sfx.watchWarnings(base);
clock += 1000; sfx.watchWarnings(Object.assign({}, base, { oil: 126 }));
assert.deepStrictEqual(take(), ['warn']);
clock += 10000; sfx.watchWarnings(Object.assign({}, base, { oil: 126, pFL: 2.1 }));
assert.deepStrictEqual(take(), ['warn'], 'a low tyre');
clock += 10000; sfx.watchWarnings({ oil: 100, pRR: 1.0 });
assert.deepStrictEqual(take(), [], 'no target pressure, no tyre warning');

// the kit's display tells the app about every press it handles (the tap's source)
const disp = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'display.js'), 'utf8');
['tab', 'button', 'bar', 'sheet'].forEach((k) => assert(disp.indexOf("this._pressed('" + k + "')") >= 0, 'display.js reports ' + k + ' presses'));
assert(/onPress\(fn\) \{ display\.onPress = fn; \}/.test(fs.readFileSync(path.join(__dirname, '..', 'runtime', 'mgu.js'), 'utf8')), 'ctx.onPress in the kit');

console.log('test_grid_sound: ok (' + NAMES.length + ' sounds)');
