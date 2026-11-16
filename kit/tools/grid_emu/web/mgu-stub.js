'use strict';
/** kit/mgu for the app in the emulator: mgu.run(impl) starts it on the page's head unit (host.js). */
const hu = () => globalThis.__GRID_HU__;
module.exports = {
    run: (impl) => hu().run(impl),
    get log() { return hu().log; },
    get SPEC() { return hu().spec; },
    get Settings() { return hu().Settings; },
};
