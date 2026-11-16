'use strict';
/**
 * gfx.js (emulator page) - the car's GPU draw engine (kit/renderd/src/gfx.c compiled to WebAssembly,
 * kit/emu/web/gfx/mgu-gfx-wasm.{js,wasm}, GPL-3.0-or-later like kit/renderd) on a canvas, with the
 * WebAssembly bytes inlined in the page (no fetch). The same calls as kit/emu/web/gfx/mgu-gfx.js.
 */
import createMguGfxWasm from 'GFXDIR/mgu-gfx-wasm.js';

export async function createGfx(canvas, wasmBinary, opts = {}) {
    let lost = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; if (opts.onLost) opts.onLost(); });
    const M = await createMguGfxWasm({
        canvas, locateFile: (p) => p,
        // the module is built without a wasmBinary option: hand it the instance made from the inlined bytes
        instantiateWasm: (imports, done) => { WebAssembly.instantiate(wasmBinary, imports).then((r) => done(r.instance), (e) => console.error('[mgu-gfx] ' + e)); return {}; },
        print: (s) => console.log('[mgu-gfx] ' + s), printErr: (s) => console.warn('[mgu-gfx] ' + s),
    });
    if (M._emu_init(canvas.width, canvas.height) < 0) throw new Error('mgu-gfx: ' + M.UTF8ToString(M._emu_error()));
    let dead = false;
    return {
        feed(u8) {
            if (lost) return -1;
            if (!u8.length) return dead ? -1 : 0;
            const p = M._emu_buf(u8.length);
            if (!p) throw new Error('mgu-gfx: out of memory');
            M.HEAPU8.set(u8, p);
            const r = M._emu_feed(u8.length);
            dead = r < 0;
            return r;
        },
        reset() { dead = false; if (!lost) M._emu_reset(); },
        stats() {
            const p = M._emu_stats(), i = M.HEAP32.subarray(p >> 2, (p >> 2) + 12), f = M.HEAPF64.subarray((p + 48) >> 3, ((p + 48) >> 3) + 2);
            return { frames: i[0], lastMs: f[0], avgMs: f[1], visible: !lost && !!i[1], error: lost ? 'context lost' : i[8] ? M.UTF8ToString(M._emu_error()) : null, atlasFull: !!i[10], lost };
        },
        readPixels() { const p = M._emu_read(); return M.HEAPU8.slice(p, p + canvas.width * canvas.height * 4); },
    };
}
