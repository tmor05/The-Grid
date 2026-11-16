'use strict';
/**
 * sound_out.js - where The Grid's sounds go.
 *
 * On the car: nowhere yet. The head unit plays all of the car's audio (music, navigation, BMW's
 * own chimes) through BMW's audio software, and how an app may add a short sound to that is not
 * known yet. It is checked on the car first, read-only; then this file plays the WAVs from
 * sounds/ (packed by the build as sounds.pack) that way. Until then it plays nothing and says so
 * once in the log.
 *
 * The emulator replaces this file with its WebAudio player (kit/tools/grid_emu/web/sound_out.js).
 */
let log = null, said = false;

module.exports = {
    available: false,
    init(o) { log = (o && o.log) || null; },
    play(name) {
        if (said || !log) return;
        said = true;
        log.info('sound: no sound output on this head unit yet (' + name + ' not played); see the README');
    },
};
