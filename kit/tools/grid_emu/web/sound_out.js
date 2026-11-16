'use strict';
/**
 * sound_out.js (emulator) - stands in for the app's sound_out.js: plays The Grid's sounds with
 * WebAudio. The sounds are the app's own WAVs from apps/the_grid/sounds, embedded in the page
 * (as Opus when the build has ffmpeg, else as the WAVs).
 *
 * Browsers start audio only after a click or a key on the page: unlock() is called on the first
 * one. The app's own calls (play) and the page's sound board both come through here.
 */
const SFX = require('GEN/sfx');

let ac = null, master = null, vol = 0.8, muted = false;
const bufs = {}, listeners = [];

function context() {
    if (ac) return ac;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    try { ac = new AC({ latencyHint: 'interactive' }); } catch (e) { return null; }
    master = ac.createGain();
    master.gain.value = muted ? 0 : vol;
    master.connect(ac.destination);
    return ac;
}

function bytes(b64) {
    const s = atob(b64), u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u.buffer;
}

function decode(name) {
    if (bufs[name]) return bufs[name];
    const c = context(), item = SFX.sounds[name];
    if (!c || !item) return Promise.reject(new Error('no sound ' + name));
    bufs[name] = new Promise((res, rej) => c.decodeAudioData(bytes(item.data), res, rej));
    bufs[name].catch(() => { delete bufs[name]; });
    return bufs[name];
}

const running = () => !!ac && ac.state === 'running';

/** After a click or key: start the audio and decode every sound (so the first play is instant). */
function unlock() {
    const c = context();
    if (!c) return Promise.resolve(false);
    const p = c.state === 'running' ? Promise.resolve() : c.resume();
    return p.then(() => { Object.keys(SFX.sounds).forEach((n) => decode(n).catch(() => {})); return running(); }).catch(() => false);
}

/** Play one sound now (the app's play, or the sound board). heard: false when the browser held it back. */
function play(name) {
    const heard = running() && !muted && vol > 0;
    listeners.forEach((fn) => { try { fn(name, heard); } catch (e) { /* the page's listener */ } });
    if (!running()) return false;
    decode(name).then((b) => {
        const s = ac.createBufferSource();
        s.buffer = b;
        s.connect(master);
        s.start();
    }).catch(() => {});
    return true;
}

function setVolume(v) { vol = Math.max(0, Math.min(1, v)); if (master) master.gain.setTargetAtTime(muted ? 0 : vol, ac.currentTime, 0.01); }
function setMuted(m) { muted = !!m; setVolume(vol); }

module.exports = {
    available: true,
    init() {},
    play,
    unlock,
    running,
    setVolume,
    setMuted,
    get muted() { return muted; },
    get volume() { return vol; },
    onPlay(fn) { listeners.push(fn); },
    list: SFX.list,
    format: SFX.format,
};
