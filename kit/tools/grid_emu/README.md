# The Grid emulator

One self-contained web page that runs **The Grid's own code** in a browser, so every page, setting
and button can be tried before the app goes on the car.

```sh
npm i --no-save esbuild pako buffer events path-browserify   # once (or point NODE_PATH at them)
node kit/tools/grid_emu/build.js                              # -> dist/grid-emu/index.html
```

Open `dist/grid-emu/index.html` in Chrome, Edge or Safari (WebGL 2 needed). Nothing is installed and
nothing talks to a car.

## What is real and what is simulated

| Part | In the page |
|---|---|
| The Grid (`apps/the_grid`, the kit) | **Real.** The staged build `build.py --preview-only` makes, the same files the Store compiles on the head unit, bundled for the browser with small shims (`web/shims`: a memory file system, Unix sockets between page services, zlib via pako). |
| The centre screen's renderer | **Real.** `kit/renderd/src/gfx.c` compiled to WebAssembly (`kit/emu/web/gfx`), fed the app's own protocol stream. `web/renderd.js` is the daemon side (HELLO, READY, TICK, touch claims, the controller grab), ported from `kit/tools/emu.js`. |
| The head unit (RHMI, settings, signals) | **The kit's own code** where it exists: the Settings class and settings wiring come from the app's `kit/mgu.js` at build time; `web/host.js` is `kit/tools/hu-stub.js`'s live mode for the browser. |
| cluster-render (cluster and HUD) | **Stand-in** (`web/clusterd.js`): the protocol's layers, assets, frames, uniforms, binds, rotate and uniform animations, drawn with WebGL 1 in the stack's order, as `kit/tools/grid_cluster_preview.js` does, but live and per client. The KOMBI's slot arbitration is not modelled: a layer that wants a target is shown. |
| BMW's gauges, map view, HUD speed, windshield | **Drawn by the page** (`web/stock.js`), plain and grey on purpose, so the app's part stands out. No BMW marks. |
| The car | **Simulated** (`web/sim.js`): an X4 M Competition (S58, ZF 8HP, M xDrive) with a converter, traction, aero, spool, heat soak and warm-up, sent as the raw SOME/IP values the app subscribes to (scaled by `app.json` `config.scaling`, in a US car's units). |
| The DME, gearbox and transfer case | **Simulated** behind the diagnostic link: the F4xx PIDs and BMW DIDs of `config.dme`, OBD services 01 and 06 (misfires), the regulated exhaust flap (2F 611E, 22 651E; 2F 60FD refused as on the S58), MHD's 2F 01 / 02 / 03. The page lists every command that would change something on a car, with the simulated answer. |
| The Grid's sounds | **Real files, the page's player.** The app's own trigger code (`sound.js`) and WAVs (`apps/the_grid/sounds`), played with WebAudio (`web/sound_out.js` stands in for the app's `sound_out.js`, which plays nothing on the car yet). Embedded as Opus when the build has ffmpeg. The page's Sounds box sets the app's setting (Off / On; the emulator starts On, the app ships Off) and has a board to hear each one. Every press the kit handles (tabs, buttons, the bar, the Settings sheet) plays the app's tap. Browsers play sound only after a click on the page. |

The car and DME numbers are a model (a launch on the simulated "map 1" runs 0-60 in about 3.3 s and
the quarter in about 11.8 s at 116 mph), not your car.

## Driving

`↑` throttle (held), `↓` or `Space` brake, `←` `→` steer, `P` `R` `N` `D` (again: S) `M` gears,
`Q` `E` paddles. The center screen takes the mouse or a finger as touch; the iDrive knob turns with
the mouse wheel or `[` `]`, `Enter` presses, `Backspace` is BACK. The autopilot drives a launch,
cruise, highway, back roads or track laps. Cold start puts every fluid at the outside temperature.

## Files

- `build.js`: stages the app, extracts the Settings code, bundles `web/main.js` with esbuild,
  inlines the fonts, the WebAssembly and the styles into one HTML file.
- `web/main.js`: boots the services, then the app (`require('APPDIR/app.js')`), and runs the page.
- `web/host.js`, `web/mgu-stub.js`: the head unit; `kit/mgu` in the app resolves to the stub.
- `web/renderd.js`, `web/gfx.js`: the renderer daemon and the WebAssembly draw engine.
- `web/clusterd.js`: cluster-render's stand-in. `web/stock.js`: what BMW draws round it, laid out
  from a photo of the car's cluster (Sport layout): the map area under BMW's dials, digital speed
  and gear; The Grid's whole-cluster panel over them; the telltales over everything.
- `web/sim.js`: the car and its control units.

The page carries the renderer (GPL-3.0-or-later, as `kit/renderd`) next to The Grid and the kit (MIT).
