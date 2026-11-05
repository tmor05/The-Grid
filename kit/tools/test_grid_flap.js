'use strict';
/**
 * test_grid_flap.js - The Grid's exhaust flap on an S58 (apps/the_grid adapters), against a fake DME:
 *   node kit/tools/test_grid_flap.js
 * The fake answers like car-apps issue #3's G80 S58: 22 64FD / 62FD read 00 00, 22 651E reads the
 * regulated position, 2F 60FD is refused (7F 2F 22), 2F 611E is taken; MHD's 2F 02 nn is echoed or
 * refused (7F 2F 13) depending on the case.
 */
const assert = require('assert');
const path = require('path');
const A = path.join(__dirname, '..', '..', 'apps', 'the_grid');
const adapters = require(path.join(A, 'adapters'));
const { Mg1RegAgk, MhdFlap } = require(path.join(A, 'real_adapters'));

function fakeLink(mhdFlap) {
    const sent = [];
    const pos = { v: 90 };
    return {
        sent,
        available: true,
        async readElAgkReg() { return { supported: true, pct: pos.v }; },
        async readElAgk() { return { supported: true, commandedPct: 0, positionRaw: '00 00' }; },
        async sendToDme(sid, data) {
            sent.push([sid].concat(data).map((b) => b.toString(16).padStart(2, '0')).join(' '));
            if (sid === 0x2F && data.length === 2 && data[0] === 0x02) {
                return mhdFlap ? { ok: true, sid: 0x6F, data: data.slice() } : { ok: false, nrc: 0x13, reason: 'bad length' };
            }
            if (sid === 0x2F && data[0] === 0x60 && data[1] === 0xFD) return { ok: false, nrc: 0x22, reason: 'conditions not correct' };
            if (sid === 0x2F && data[0] === 0x61 && data[1] === 0x1E) {
                if (data[2] === 0x03) pos.v = Math.round(((data[3] << 8) | data[4]) / 81.92);
                return { ok: true, sid: 0x6F, data: data.slice(0, 3) };
            }
            return { ok: false, nrc: 0x11, reason: 'service not supported' };
        },
    };
}
const ident = (platform) => ({ present: true, elAgk: { supported: true, commandedPct: 0 }, elAgkReg: { supported: true, pct: 90 }, platform });

(async () => {
    // disarmed: nothing real is picked
    adapters.armReal(false);
    assert.strictEqual(adapters.pick('sim', ident('auto')).adapter.id, 'sim');
    assert.strictEqual(adapters.pick('car', ident('mhd')).blocked, true);

    adapters.armReal(true);
    // no tune picked: the regulated job (not the plain one the S58 refuses)
    let p = adapters.pick('car', ident('auto'));
    assert.strictEqual(p.adapter.id, 'mg1-reg-agk');
    let link = fakeLink(false);
    let r = await p.adapter.open(link);
    assert.deepStrictEqual(link.sent, ['2f 61 1e 03 03 33']);
    assert.strictEqual(r.accepted, true);
    assert.strictEqual((await p.adapter.read(link)).confirmed, 'OPEN');
    r = await p.adapter.closed(link);
    assert.strictEqual(link.sent[1], '2f 61 1e 03 1c cd');
    assert.strictEqual((await p.adapter.read(link)).confirmed, 'CLOSED');
    await p.adapter.oem(link);
    assert.strictEqual(link.sent[2], '2f 61 1e 00');

    // MHD picked and the flash has its own flap control: held by MHD, no BMW job sent
    p = adapters.pick('car', ident('mhd'));
    assert.strictEqual(p.adapter.id, 'mhd-flap');
    assert.strictEqual(MhdFlap.fallback, Mg1RegAgk);
    link = fakeLink(true);
    r = await p.adapter.open(link);
    assert.deepStrictEqual(link.sent, ['2f 02 01']);
    assert.strictEqual(r.detail, 'MHD holds it');

    // MHD picked but the flash refuses 2F 02: BMW's regulated job instead
    link = fakeLink(false);
    r = await p.adapter.closed(link);
    assert.deepStrictEqual(link.sent, ['2f 02 02', '2f 61 1e 03 1c cd']);
    assert.strictEqual(r.accepted, true);
    assert(/no MHD flap control/.test(r.detail));

    // a busy answer to MHD's request is not taken for "no MHD": nothing else is sent
    link = fakeLink(false);
    link.sendToDme = async (sid, data) => { link.sent.push('x'); return { ok: false, nrc: 0x22, reason: 'conditions not correct' }; };
    r = await p.adapter.open(link);
    assert.strictEqual(link.sent.length, 1);
    assert.strictEqual(r.accepted, false);

    // a DME with only the plain flap (no 651E): the plain job, as before
    const plain = { present: true, elAgk: { supported: true, commandedPct: 0 }, elAgkReg: { supported: false }, platform: 'auto' };
    assert.strictEqual(adapters.pick('car', plain).adapter.id, 'mg1-el-agk');
    adapters.armReal(false);
    console.log('grid flap: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
