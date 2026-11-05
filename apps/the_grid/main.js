'use strict';
/**
 * M Vitals - live engine / thermal / chassis gauges drawn in the HMI's style.
 *
 * Pages (button "Next page"):
 *   engine  - RPM + boost dials, power/torque bars, speed
 *   thermal - coolant / engine oil / gearbox / ambient with 5-minute traces
 *   fuel    - "Fuel & ignition": intake air temperature, high / low pressure fuel, ignition
 *             timing, misfires per cylinder (read from the DME over UDS / OBD, see
 *             config.dme), intake air above outside temperature
 *   (thermal also: gearbox temperature from the EGS when config.dme.egs has a source)
 *   chassis - friction circle (g-g diagram), tyre pressures + temperatures, xDrive split
 *
 * Signals come straight from the car over SOME/IP (see app.json "signals").
 * With no car attached (the VM, or the unit on the bench) demo data can drive
 * the gauges; a DEMO badge is drawn whenever it does.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const Demo = require('./demo');
const Engine = require('./kit/engine');
const { GearGuess, selectionOf } = require('./kit/car');
const { Diag } = require('./kit/diag');
const { DidReader } = require('./kit/dids');

const W = 1600, H = 520;
const PAGES = ['drive', 'vitals', 'track'];
const FUEL = ['iat', 'hpfp', 'lpfp', 'timing', 'boostCtl', 'load', 'ethanol'];   // engine unit values read fast on the Fuel & ignition page
/** Target-vs-actual pairs on the Fuel & ignition page: read together, [target, actual] keys of config.dme. */
const PAIR = { boostCtl: ['boostTarget', 'boostActual'], load: ['loadTarget', 'loadActual'] };
const HIST_SEC = 300;
/*
 * Plausible ranges (deg C / bar). A value outside is the car's "no data" marker or a field this
 * car fills differently (a tyre at 255 deg C, a pressure of 0): shown as no data, never drawn.
 */
const TYRE_T = [-40, 150], TYRE_P = [0.5, 6], TYRE_PT = [1, 6];
const RANGE = {
    rpm: [0, 12000], ethanol: [0, 100], coolant: [-40, 160], oil: [-40, 170], gearbox: [-40, 160], egs: [-40, 160], ambient: [-50, 60], timing: [-64, 64],
    boostFes: [-1, 4], boostDme: [-1, 4], boostTarget: [-1, 4], boostActual: [-1, 4], loadTarget: [0, 250], loadActual: [0, 250], tFL: TYRE_T, tFR: TYRE_T, tRL: TYRE_T, tRR: TYRE_T,
    pFL: TYRE_P, pFR: TYRE_P, pRL: TYRE_P, pRR: TYRE_P, ptFL: TYRE_PT, ptFR: TYRE_PT, ptRL: TYRE_PT, ptRR: TYRE_PT,
};
/*
 * Fields some cars never fill sit at one number (gearbox oil at 0 deg C): they only count once
 * they have changed by this much. Once seen working the car is remembered (seen.json), so the
 * next start shows them straight away.
 */
// (tyre temperatures are not doubtful any more: with the right scaling a car's "no data" is 65535)
/** boostMax setting -> the boost dial's top in bar and in psi */
const BOOST_MAX = { '2.0': [2, 30], '2.5': [2.5, 36], '3.0': [3, 44], '3.5': [3.5, 50] };
const MOVE = { gearbox: 1, egs: 1, boostFes: 0.03, boostDme: 0.03 };
/** Remembered per car: which groups sent real data (the "Auto" setting shows only those). */
const GROUP = { gearbox: 'gearbox', boostFes: 'boost', boostDme: 'boost', tFL: 'tyreTemp', tFR: 'tyreTemp', tRL: 'tyreTemp', tRR: 'tyreTemp',
    pFL: 'tyres', pFR: 'tyres', pRL: 'tyres', pRR: 'tyres', iat: 'iat', hpfp: 'hpfp', lpfp: 'lpfp', timing: 'timing', egs: 'egs',
    boostTarget: 'boostCtl', boostActual: 'boostCtl', loadTarget: 'load', loadActual: 'load' };
/**
 * "Auto / Show / Hide" setting of each group. Auto: shown once the car / engine unit has sent real
 * data for it (remembered), so values a car doesn't have never take space.
 */
const SHOW = { boost: 'showBoost', gearbox: 'showGearbox', tyres: 'showTyres', tyreTemp: 'showTyreTemp',
    iat: 'showIat', hpfp: 'showHpfp', lpfp: 'showLpfp', timing: 'showTiming', misfire: 'showMisfire', egs: 'showEgs',
    boostCtl: 'showBoostCtl', load: 'showLoad' };
const TYRES = ['FL', 'FR', 'RL', 'RR'];
// gearbox enum: names or wire numbers (G1 = 3 ... G10 = 12, R = 1, N_OR_P = 2), as in kit/car.js
const GEARS = { G1: 1, G2: 2, G3: 3, G4: 4, G5: 5, G6: 6, G7: 7, G8: 8, G9: 9, G10: 10, R: -1, N_OR_P: 0 };
const gearOf = (x) => (typeof x === 'number' ? (x >= 3 && x <= 12 ? x - 2 : x === 1 ? -1 : x === 2 ? 0 : undefined) : GEARS[x]);
// selector position (statusActualStageDrive), names or wire numbers (P = 1, R = 2, N = 3, D = 4), as in kit/car.js
const STAGES = { P: 'P', R: 'R', N: 'N', D: 'D', 1: 'P', 2: 'R', 3: 'N', 4: 'D' };
// MDrive.dataDisplayGearbox: the programme the cluster shows next to the gear (names or wire numbers)
const PROGRAMS = { S_MINUS_PROGRAMM: 'S', M_MINUS_PROGRAMM: 'M', 1: 'S', 2: 'M' };

/**
 * Selector programme (D / S / M / P / R / N) from the gearbox status. Field names differ
 * between cars, so look at every selector-like field: enum names or on/off flags.
 */
function modeOf(o) {
    for (const k of Object.keys(o || {})) {
        if (k === 'statusActualGearDrive' || /StageDrive/.test(k) || !/select|lever|position|program|mode|range|manual|sport|tip/i.test(k)) continue;
        const v = o[k];
        if (v === true || v === 1) { if (/manual|tip/i.test(k)) return 'M'; if (/sport/i.test(k)) return 'S'; continue; }
        const x = String(v).toUpperCase();
        if (/NOT|INACTIVE|INVALID|SIGNAL|UNKNOWN|OFF|NO_/.test(x)) continue;
        if (/MANU|TIPP|^M$|^M_|_M$|^M\d/.test(x)) return 'M';
        if (/SPORT|^S$|_S$|^DS$/.test(x)) return 'S';
        if (/PARK|^P$/.test(x)) return 'P';
        if (/REVERSE|^R$/.test(x)) return 'R';
        if (/NEUTRAL|^N$/.test(x)) return 'N';
        if (/DRIVE|^D$|^D_|_D$/.test(x)) return 'D';
    }
    return null;
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const S = (ctx.spec.config && ctx.spec.config.scaling) || {};
        const sc = (k, raw) => {
            const c = S[k];
            if (!c || raw === undefined || raw === null || raw === c.invalid || (c.invalidFrom != null && raw >= c.invalidFrom)) return null;
            return raw * c.factor + (c.offset || 0);
        };

        /*
         * The car's display units (Vehicle.statusNewCurrentUnitsStatusExt, as BMW's x_call reads them):
         * the TPMS sends tyre pressures as 0.1 x raw in the car's pressure unit and tyre temperatures
         * as the car's degrees + 40. A car set to psi / deg F read 41 psi as 4.1 bar (59 psi) and
         * 82 deg F as 82 deg C (180 deg F).
         */
        const carUnits = { press: null, temp: null, psiSeen: false };
        const PRESS_UNITS = { 1: 'BAR', 2: 'KPA', 3: 'PSI' }, TEMP_UNITS = { 1: 'C', 2: 'F' };
        const PRESS_TO_BAR = { BAR: 1, KPA: 0.01, PSI: 1 / 14.5038 };
        const unitName = (map, v) => (map[v] || (Object.values(map).indexOf(v) >= 0 ? v : null));
        /**
         * A tyre pressure in bar. Until the car's unit is known: each unit's plausible tyre pressures
         * lie apart (bar 0.5-6, psi 7-60, kPa 60-600), so only one fits; psi also means deg F.
         */
        const tyreP = (raw) => {
            const v = sc('tyrePress', raw);
            if (v === null) return null;
            const k = PRESS_TO_BAR[carUnits.press];
            if (k) return v * k;
            if (v >= TYRE_P[0] && v <= TYRE_P[1]) return v;
            if (v >= 7 && v < 60) { carUnits.psiSeen = true; return v / 14.5038; }
            if (v >= 60 && v <= 600) return v / 100;
            return v;
        };
        /** A tyre temperature in deg C (the car sends deg F when it is set to Fahrenheit). */
        const tyreT = (raw) => {
            const v = sc('tyreTemp', raw), f = carUnits.temp ? carUnits.temp === 'F' : carUnits.psiSeen;
            return v !== null && f ? (v - 32) * 5 / 9 : v;
        };
        /*
         * g-force: an owner's car read 0.6-0.7 g idling (the sport display showed 0). At a
         * standstill the car's acceleration is 0, so whatever an axis reads then is its offset:
         * learned while the car stands (an average, so a door or a blip hardly counts) and taken
         * off. Parked on a slope, the slope is zeroed too until the next stop.
         */
        const G0 = 9.80665, G_ZERO_MAX = 1;
        const gZero = { gLong: { z: 0, n: 0 }, gLat: { z: 0, n: 0 } };
        let stillSince = 0;
        const standing = () => stillSince > 0 && Date.now() - stillSince > 2000;
        const putG = (k, raw) => {
            const a = sc('accel', raw);
            if (a === null) return;
            const g = a / G0, z = gZero[k];
            if (standing() && Math.abs(g) <= G_ZERO_MAX) { z.n = Math.min(z.n + 1, 50); z.z += (g - z.z) / z.n; }
            put(k, g - z.z);
        };

        /* ---------- live data ---------- */
        const live = {}, peak = {}, demoPeak = {}, hist = { coolant: [], oil: [], gearbox: [], egs: [], ambient: [], iat: [], hpfp: [], lpfp: [], iatRise: [], timing: [],
            boostTarget: [], boostActual: [], loadTarget: [], loadActual: [] };
        /*
         * Peak hold: a peak follows new highs, and "peakHold" s after it was last raised it drops back
         * to the current value (0 = until "Reset peaks"). Called per sample and per frame, so it also
         * drops while the car sends nothing new.
         */
        const peakAt = new Map();
        const raise = (o, k, v) => {
            if (!G.isNum(v)) return;
            const at = peakAt.get(o) || peakAt.set(o, {}).get(o), now = Date.now(), hold = settings.get('peakHold') * 1000;
            if (o[k] === undefined || v >= o[k] || (hold > 0 && now - (at[k] || 0) > hold)) { o[k] = v; at[k] = now; }
        };

        // xDrive card: 'auto' shows it once the car has reported all-wheel drive (remembered),
        // so rear-wheel-drive cars never see an empty card
        const AWD_FILE = path.join(ctx.dataDir, 'awd.json');
        let awdSeen = false;
        try { awdSeen = !!JSON.parse(fs.readFileSync(AWD_FILE, 'utf8')).seen; } catch (e) { /* not yet */ }
        const markAwd = () => {
            if (awdSeen) return;
            awdSeen = true; log.info('all-wheel drive detected');
            try { fs.writeFileSync(AWD_FILE, JSON.stringify({ seen: true })); } catch (e) { log.warn('awd save: ' + e); }
        };
        // which groups / sources this car has sent real data for (see MOVE, GROUP)
        const SEEN_FILE = path.join(ctx.dataDir, 'seen.json');
        let seen = {};
        try { seen = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')) || {}; } catch (e) { /* not yet */ }
        const remember = (keys) => {
            const add = keys.filter((x, i) => x && !seen[x] && keys.indexOf(x) === i);
            if (!add.length) return;
            add.forEach((x) => { seen[x] = true; });
            log.info('real data from the car: ' + add.join(', '));
            try { fs.writeFileSync(SEEN_FILE, JSON.stringify(seen)); } catch (e) { log.warn('seen save: ' + e); }
        };
        const bad = {}, first = {}, moved = {};
        /** A MOVE value counts once it changed this session or the car is known to send it. */
        const trusted = (k) => MOVE[k] == null || !!moved[k] || !!seen[k] || (/^t(FL|FR|RL|RR)$/.test(k) && !!seen.tyreTemp);
        /** The first raw values of the doubtful fields go to the log, to calibrate app.json from. */
        const rawLogged = {};
        const logRaw = (name, raw) => {
            const key = JSON.stringify(raw), l = rawLogged[name] || (rawLogged[name] = []);
            if (l.length >= 12 || l.indexOf(key) >= 0) return;
            l.push(key); log.info('raw ' + name + ': ' + key);
        };
        let lastCar = 0, oilCarT = 0;          // oilCarT: last valid oil temperature from the car's own signal
        // xDrive split sources, first one with data wins (see xdriveSplit):
        //   1. BasicDataSet torque split, fresh (< SPLIT_STALE ms), valid qualifier, not 0
        //   2. the drive mode: in 2WD the front axle gets nothing, so 100 % rear
        //   3. none: the bars show no data rather than a made-up number
        const SPLIT_STALE = 10000;
        const SPLIT_OK = (q) => q === undefined || q === null || q === 2 || q === 10 ||
            q === 'SIGNALWERT_IST_GUELTIG' || q === 'SIGNALWERT_IST_GUELTIG__REKALIBRIERUNGSBEDARF';
        let splitAt = 0;
        const xdriveSplit = (d) => {
            if (usingDemo()) return { rear: d.splitRear, from: null };
            const now = Date.now();
            if (G.isNum(live.splitRear) && now - splitAt < SPLIT_STALE) return { rear: live.splitRear, from: null };
            // transfer case: front axle torque against what the gearbox puts out (engine torque x gear ratio)
            if (G.isNum(live.lmvFront) && now - lmvAt < 3000) {
                const nm = live.lmvFront, ratio = xcfg.gearRatios[(live.gear || 0) - 1];
                const input = G.isNum(live.torque) && ratio ? live.torque * ratio : null;
                if (nm <= 5) return { rear: 100, from: 'transfer case: clutch open', nm };
                if (input > 50) return { rear: 100 - Math.max(0, Math.min(100, nm / input * 100)), from: 'transfer case, estimated', nm };
                return { rear: null, from: 'transfer case', nm };
            }
            if (d.awd === '_2WD') return { rear: 100, from: '2WD mode' };
            return { rear: null, from: null };
        };
        const guess = new GearGuess();
        let gearLogs = 0, lastModeKey = '';
        const put = (k, v) => {
            if (v === null || v === undefined || !isFinite(v)) return;
            lastCar = Date.now();
            const r = RANGE[k];
            if (r && (v < r[0] || v > r[1])) { bad[k] = v; return; }
            delete bad[k];
            if (MOVE[k] != null) {
                if (first[k] === undefined) first[k] = v;
                else if (!moved[k] && Math.abs(v - first[k]) >= MOVE[k]) { moved[k] = true; remember([GROUP[k], k]); }
            } else if (GROUP[k]) remember([GROUP[k]]);
            live[k] = v;
            if (k === 'boostFes' || k === 'boostDme') { updBoost(); return; }
            raise(peak, k, v);
            if (k === 'rpm' || k === 'torque') {
                // fallback when the car sends no sport-display power: crankshaft torque x speed (engine only)
                if (G.isNum(live.torque) && G.isNum(live.rpm)) live.powerCalc = Math.max(0, live.torque * live.rpm / 9549);
            }
            if (k === 'speed') stillSince = v < 0.5 ? stillSince || Date.now() : 0;
            if ((k === 'rpm' || k === 'speed') && G.isNum(live.rpm) && G.isNum(live.speed)) {
                const g = guess.feed(live.rpm, live.speed);
                // nothing at a standstill: the guess can't tell P, N or D there (it showed "N" in park / in D)
                live.gearGuess = live.speed < 3 ? null : g;
            }
        };
        // engine profile (diesel / petrol): rpm bar end and the Auto redline
        const engine = new Engine({ settings, dataDir: ctx.dataDir, log });
        const watches = [
            ['de.bmw.infotainment.vehicle.CDS', {
                statusEngineSpeed2: (v) => put('rpm', sc('rpm', v.actualValueRPMEngineCrankshaft)),
                statusEngineTemperature: (v) => {
                    logRaw('engine temperatures', [v.temperatureEngineDrive, v.temperatureEngineOilDrive]);
                    put('coolant', sc('engineTemp', v.temperatureEngineDrive));
                    const oil = sc('engineTemp', v.temperatureEngineOilDrive);
                    if (oil !== null) { oilCarT = Date.now(); put('oil', oil); }
                },
            }],
            ['de.bmw.infotainment.vehicle.CDS2', {
                statusLongitudinalAccelerationMassCenter: (v) => {
                    logRaw('longitudinal acceleration' + (standing() ? ' (standing)' : ''), v.longitudinalAccelerationCentreOfGravity);
                    putG('gLong', v.longitudinalAccelerationCentreOfGravity);
                },
                statusLateralAccelerationMassCenter: (v) => {
                    logRaw('lateral acceleration' + (standing() ? ' (standing)' : ''), v.lateralAccelerationCentreOfGravity);
                    putG('gLat', v.lateralAccelerationCentreOfGravity);
                },
            }],
            ['de.bmw.infotainment.vehicle.Vehicle', {
                statusNewCurrentUnitsStatusExt: (v) => {
                    const press = unitName(PRESS_UNITS, v && v.unitOfMeasurementAirPressure), temp = unitName(TEMP_UNITS, v && v.unitOfMeasurementTemperature);
                    if (press === carUnits.press && temp === carUnits.temp) return;
                    carUnits.press = press; carUnits.temp = temp;
                    log.info('car units: pressure ' + (press || '?') + ', temperature ' + (temp || '?'));
                },
            }],
            ['de.bmw.infotainment.vehicle.Vehicle2', Object.assign({ statusCarSpeed2: (v) => put('speed', sc('speed', v.speedVehicleCentreOfGravity)) }, engine.handlers())],
            ['de.bmw.infotainment.drivingexcitement.FES', {
                statusSwitchDriveDynamicSport2: (v) => {
                    logRaw('FES boost', v.displayBoostPressure);
                    logRaw('FES g [lat, long]', [v.displayLateralAcceleration, v.displayLongitudinalAcceleration]);
                    put('boostFes', sc('boost', v.displayBoostPressure));
                },
                // the HMI's sport display: power / torque in % of the car's maximum
                statusVehicleDynamicEngine: (v) => { put('powerPct', sc('sportPct', v.displaySportEnginePower)); put('torquePct', sc('sportPct', v.displaySportEngineTorque)); },
                // negative = engine braking (falling rpm): shown as 0
                statusActualValueTorque2: (v) => { const tq = sc('torque', v.actualValueTorqueCrankshaft); put('torque', tq === null ? null : Math.max(0, tq)); },
            }],
            ['de.bmw.infrastructure.VehicleInformation', {
                statusGearboxDrive: (v) => {
                    const g = gearOf(v && v.statusActualGearDrive);
                    if (g !== undefined) { live.gear = g; lastCar = Date.now(); }
                    live.stage = STAGES[v && v.statusActualStageDrive];
                    live.gearMode = modeOf(v);
                    // field names / values differ per car: log them so the D/S/M detection can be checked
                    const key = JSON.stringify(Object.keys(v || {}).filter((x) => x !== 'statusActualGearDrive').map((x) => [x, v[x]]));
                    if (key !== lastModeKey && gearLogs < 40) { gearLogs++; lastModeKey = key; log.info('gearbox: ' + JSON.stringify(v) + ' -> ' + (live.gearMode || '?')); }
                },
                // this car never sent statusGearboxDrive (2.8.0 logs): P / R / N / gear from here too
                DataPowerTrain2: (v) => {
                    logRaw('gear selection', v && v.statusGearSelectionDrive);
                    const sel = selectionOf(v && v.statusGearSelectionDrive);
                    if (!sel) return;
                    if (sel.stage !== undefined) live.stage = sel.stage;
                    live.gear = sel.gear; lastCar = Date.now();
                },
            }],
            ['de.bmw.infrastructure.analytics.BasicDataSet', {
                basicDataSet: (v) => {
                    logRaw('gearbox oil', v.valueTemperatureTransmissionOil);
                    put('gearbox', sc('gearboxTemp', v.valueTemperatureTransmissionOil));
                    // xDrive split: the only signal the car has for it. Taken only when its qualifier
                    // says valid (or the car leaves the qualifier out) and it isn't 0 - a car that
                    // doesn't fill the field sends 0 or 65535; xdriveSplit() then falls back.
                    const rawSplit = v.valueDistributionLongitudinalTorqueRearAxisFrontAxis;
                    const q = v.qualifierValueDistributionLongitudinalTorqueRearAxisFrontAxis;
                    logRaw('torque split [value, qualifier]', [rawSplit, q]);
                    const split = SPLIT_OK(q) ? sc('torqueSplitRear', rawSplit) : null;
                    if (G.isNum(split) && split > 0) { put('splitRear', split); splitAt = Date.now(); }
                    if (G.isNum(split) && split > 1 && split < 97) markAwd();     // torque going to the front axle
                },
            }],
            ['de.bmw.infrastructure.EnvironmentalInformation', { ExteriorTemperature: (v) => put('ambient', sc('ambient', v.temperatureExterior)) }],
            ['de.bmw.infotainment.vehicle.TPMS', {
                statusTyreTemperature: (v) => {
                    logRaw('tyre temperature', [v.actualValueTemperatureTyreFLH, v.actualValueTemperatureTyreFRH, v.actualValueTemperatureTyreRLH, v.actualValueTemperatureTyreRRH]);
                    put('tFL', tyreT(v.actualValueTemperatureTyreFLH)); put('tFR', tyreT(v.actualValueTemperatureTyreFRH));
                    put('tRL', tyreT(v.actualValueTemperatureTyreRLH)); put('tRR', tyreT(v.actualValueTemperatureTyreRRH));
                },
                // 0.1 x raw in the car's pressure unit, >= 65532 invalid (BMW x_call's converter); tyreP makes it bar
                statusTyrePressure: (v) => {
                    logRaw('tyre pressure', [v.actualValuePressureTyreFLH, v.actualValuePressureTyreFRH, v.actualValuePressureTyreRLH, v.actualValuePressureTyreRRH]);
                    if (v && v.actualValuePressureTyreFLH === undefined) logRaw('tyre pressure fields', Object.keys(v));
                    put('pFL', tyreP(v.actualValuePressureTyreFLH)); put('pFR', tyreP(v.actualValuePressureTyreFRH));
                    put('pRL', tyreP(v.actualValuePressureTyreRLH)); put('pRR', tyreP(v.actualValuePressureTyreRRH));
                },
                statusTargetTyrePressure: (v) => {
                    logRaw('target tyre pressure', [v.targetPressureTyreFLH, v.targetPressureTyreFRH, v.targetPressureTyreRLH, v.targetPressureTyreRRH]);
                    put('ptFL', tyreP(v.targetPressureTyreFLH)); put('ptFR', tyreP(v.targetPressureTyreFRH));
                    put('ptRL', tyreP(v.targetPressureTyreRLH)); put('ptRR', tyreP(v.targetPressureTyreRRH));
                },
            }],
            ['de.bmw.infotainment.misc.MDrive', {
                statusMSystem: (v) => {
                    live.awd = v.statusAllWheelSetup; live.awdQual = v.qualifierFunctionAllWheel;
                    if (/^_4WD|SAND/.test(String(live.awd))) markAwd();
                },
                // S / M next to the gear: this car sends no selector programme with the gearbox status
                dataDisplayGearbox: (v) => {
                    logRaw('gear programme', v && v.displayProgramGearbox);
                    live.program = PROGRAMS[v && v.displayProgramGearbox] || null;
                },
            }],
        ];
        log.info('subscribing signals');
        // tyre values: also read every 10 s - BMW's own x_call only ever reads them, so a car may not notify them
        const subs = [], startT = Date.now();
        Promise.all(watches.map(([iface, h]) => ctx.signals.watch(iface, '1', h, log, /\.TPMS$/.test(iface) ? { pollMs: 10000 } : undefined)
            .then((s) => { subs.push(s); return s; })))
            .then((all) => log.info('signals: ' + all.map((s) => s.iface.split('.').pop() + (s.error ? '(err)' : '')).join(' ')));

        const demo = new Demo();
        demo.setRedline(engine.redline());
        engine.onChange(() => demo.setRedline(engine.redline()));
        // Auto: demo only until the car answers - a parked car sends nothing new for minutes, which is not "no car"
        const carPresent = () => lastCar > 0 || subs.some((s) => s.available);
        const usingDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !carPresent() && Date.now() - startT > 5000);
        /**
         * What the screen shows: the car's values, with doubtful ones (MOVE) left out until they
         * have proven real; demo data as it is.
         */
        const data = () => {
            if (usingDemo()) return demo.sample();
            const v = Object.assign({}, live);
            Object.keys(MOVE).forEach((k) => { if (!trusted(k)) v[k] = null; });
            return v;
        };
        /** Boost from the source the setting asks for; Auto: the sport display if it works, else the engine unit. */
        function updBoost() {
            const src = settings.get('boostSource');
            const fes = G.isNum(live.boostFes) ? live.boostFes : null, dmeB = G.isNum(live.boostDme) ? live.boostDme : null;
            const v = src === 'fes' ? fes : src === 'dme' ? dmeB
                : fes !== null && trusted('boostFes') ? fes : dmeB !== null && trusted('boostDme') ? dmeB : null;
            live.boost = v;
            if (v !== null) raise(peak, 'boost', v);
        }
        /** Boost still needed from the engine unit (UDS)? */
        const boostFromDme = () => (dme.boost || []).length > 0 && (settings.get('boostSource') === 'dme'
            || (settings.get('boostSource') !== 'fes' && !(G.isNum(live.boostFes) && trusted('boostFes'))));
        /** Auto / Show / Hide: Auto shows a group once the car has sent real data for it (demo: always). */
        const shown = (g) => { const s = settings.get(SHOW[g]); return s === 'on' || (s !== 'off' && (usingDemo() || !!seen[g])); };
        /** Why a temperature is missing, for its tile. */
        function why(k) {
            if (bad[k] !== undefined) return 'car sends ' + G.fmt(T(bad[k]), 0) + tU() + ' - not a real value';
            if (G.isNum(live[k]) && !trusted(k)) return 'stuck at ' + G.fmt(T(live[k]), 0) + tU() + ' - waiting for it to change';
            return 'no data from the car';
        }

        /* ---------- intake + fuel from the DME (UDS 0x22; candidates in app.json config.dme) ----------
         * Fast (~2/s) while the Fuel & ignition page is on screen, every 5 s otherwise so the history
         * keeps filling. A value the DME refuses is only re-tried every 30 s. */
        const dme = Object.assign({ ecu: 18 }, (ctx.spec.config && ctx.spec.config.dme) || {});
        // connect in the background: the screen must not wait for the diagnostic link
        const link = new Diag(ctx.signals, log);
        link.quiet = true;
        link.init();
        const rd = new DidReader(link, { ecu: dme.ecu });
        // xDrive front axle torque from the transfer case unit (config.xdrive), read while the Chassis page is on screen
        const xcfg = Object.assign({ front: [], gearRatios: [] }, (ctx.spec.config && ctx.spec.config.xdrive) || {});
        let chassisSeen = 0, lmvAt = 0;
        const fuelT = {}, fuelFail = {}, fuelTry = {};
        let fuelSeen = 0, engineSeen = 0, fuelTimer = null, fuelBusy = false, fuelLast = 0;
        let baro = 101.3, baroT = 0;                                       // outside air pressure, kPa
        /*
         * Misfires per cylinder (OBD service 06 monitor results, MIDs A2.. = cylinder 1..; test
         * config.dme.misfire.tid, default 0C = this driving cycle). misMode: which request this engine
         * answers (false = service 06, true = UDS F6xx, null = not found yet); misCyl: cylinders found.
         */
        let misMode = null, misCyl = 0;
        async function readMisfire() {
            const m = dme.misfire || {}, ecu = m.ecu == null ? dme.ecu : m.ecu, tid = parseInt(m.tid || '0C', 16);
            if (misMode === null) {
                if (await rd.monitor(ecu, 0xA2, false)) misMode = false;
                else if (await rd.monitor(ecu, 0xA2, true)) misMode = true;
                else return null;
            }
            if (!misCyl) {
                // the engine unit's own list of its misfire monitors (MID A0) gives the cylinder count
                const sup = await rd.supported(ecu, 0xA0, misMode);
                let n = 0;
                while (sup && n < 12 && sup.indexOf(0xA2 + n) >= 0) n++;
                if (n) { misCyl = n; log.info('misfire counter: ' + n + ' cylinders (engine unit list)'); }
            }
            const counts = [];
            for (let c = 0; c < (misCyl || 12); c++) {
                const res = await rd.monitor(ecu, 0xA2 + c, misMode);
                if (!res) {
                    // counting without the list: a refusal past cylinder 1 ends the engine; no reply is
                    // a missed round, not the end (it would cut a 6-cylinder short)
                    if (misCyl || !c || !/^NRC/.test(rd.raws[rd.monitorKey(ecu, 0xA2 + c, misMode)].why)) return null;
                    break;
                }
                const tr = res.find((x) => x.tid === tid) || res[0];
                counts.push(tr.value >= 65535 ? null : tr.value);
            }
            if (!misCyl) { misCyl = counts.length; log.info('misfire counter: ' + misCyl + ' cylinders (counted)'); }
            return counts.length === misCyl ? counts : null;
        }
        /** Boost from the engine unit: charge / manifold pressure (absolute, kPa) minus outside air pressure. */
        async function readBoost() {
            await freshBaro();
            const m = await rd.value('boost', dme.boost);
            return m === null ? null : (m - baro) / 100;
        }
        /** Outside air pressure (kPa), read again once a minute: boost = absolute pressure minus it. */
        async function freshBaro() {
            if (Date.now() - baroT > 60000) { baroT = Date.now(); const b = await rd.value('baro', dme.baro); if (b !== null) baro = b; }
        }
        /**
         * A target-vs-actual pair (PAIR): { target, actual }, or null while the target doesn't answer.
         * Boost comes as absolute kPa and is turned into bar above the outside air pressure;
         * air charge is in % as the engine unit sends it.
         */
        async function readPair(k) {
            const [tk, ak] = PAIR[k];
            let target = await rd.value(tk, dme[tk]);
            if (target === null) return null;
            let actual = await rd.value(ak, dme[ak]);
            if (k === 'boostCtl') {
                await freshBaro();
                target = (target - baro) / 100;
                actual = actual === null ? null : (actual - baro) / 100;
            }
            return { target, actual };
        }
        /** Front axle torque from the transfer case (Nm); the raw reply goes to the log once per new value shape. */
        async function readLmv() {
            const v = await rd.value('lmvFront', xcfg.front);
            const c = xcfg.front[rd.pick.lmvFront || 0], r = c && rd.raws[rd.key(c)];
            if (r) logRaw('xDrive transfer case 22 DB32', r.bytes ? r.bytes.split(' ').slice(3, 11).join(' ') : r.why);
            if (v === null) { fuelFail.lmv = (fuelFail.lmv || 0) + 1; return; }
            fuelFail.lmv = 0;
            live.lmvFront = v; lmvAt = Date.now(); lastCar = lmvAt;
            if (v > 20) markAwd();                    // torque going to the front axle
        }
        /*
         * Fast (~2/s) for the values of the page on screen (Fuel & ignition, or boost on Engine when it
         * comes from the engine unit), all of them every 5 s otherwise so the history keeps filling.
         */
        async function pollFuel() {
            fuelBusy = true; fuelLast = Date.now();
            const now = Date.now(), needBoost = boostFromDme();
            // oil temperature from the engine unit while the car's own signal has none (a 330e sends none)
            const needOil = (dme.oil || []).length > 0 && now - oilCarT > 15000;
            // a value set to Hide is not asked for at all
            const want = (k) => settings.get(SHOW[k]) !== 'off' && (k === 'misfire' ? !!dme.misfire : (dme[PAIR[k] ? PAIR[k][0] : k] || []).length > 0);
            const onFuelPage = now - fuelSeen < 1500;
            // transfer case: only on the Chassis page with the xDrive card shown, and only while the car's own split is missing
            const onChassis = now - chassisSeen < 1500 && xcfg.front.length > 0 && settings.get('xdrive') !== 'off'
                && !(G.isNum(live.splitRear) && now - splitAt < SPLIT_STALE);
            let fast = onFuelPage ? FUEL.filter(want) : now - engineSeen < 1500 && needBoost ? ['boost'] : onChassis ? ['lmv'] : null;
            // misfire counts change slowly: every 4th fast round on its page (~2 s), every slow round otherwise
            pollFuel.n = (pollFuel.n || 0) + 1;
            // The Grid: Drive reads boost fast and the rest every 8th round; Vitals keeps boost fresh too
            if (fast && fast.length === 1 && fast[0] === 'boost' && pollFuel.n % 8 === 0) fast = fast.concat(FUEL.filter(want));
            if (onFuelPage && needBoost && fast) fast = fast.concat(['boost']);
            const misNow = want('misfire') && (!fast || (onFuelPage && pollFuel.n % 4 === 0));
            try {
                if (link.available) {
                    const keys = (fast || FUEL.filter(want).concat(needBoost ? ['boost'] : [], needOil ? ['oil'] : [], want('egs') ? ['egs'] : [])).concat(misNow ? ['misfire'] : []);
                    for (const k of keys) {
                        if ((fuelFail[k] || 0) >= 3 && Date.now() - (fuelTry[k] || 0) < 30000) continue;
                        fuelTry[k] = Date.now();
                        if (k === 'lmv') { await readLmv(); continue; }
                        const v = k === 'boost' ? await readBoost() : k === 'misfire' ? await readMisfire() : PAIR[k] ? await readPair(k) : await rd.value(k, dme[k]);
                        if (k === 'egs' || k === 'timing') { const c = dme[k][rd.pick[k] || 0], r = c && rd.raws[rd.key(c)]; if (r) logRaw(k === 'egs' ? 'EGS' : 'timing', r.bytes || r.why); }
                        // the first replies of the target / actual identifiers go to the log, to check their scaling
                        if (PAIR[k]) PAIR[k].forEach((x) => { const c = (dme[x] || [])[rd.pick[x] || 0], r = c && rd.raws[rd.key(c)]; if (r) logRaw(x + ' ' + DidReader.label(c), r.bytes || r.why); });
                        if (k === 'oil' && v !== null && Date.now() - oilCarT < 15000) continue;      // the car's own value came meanwhile
                        if (v === null) { fuelFail[k] = (fuelFail[k] || 0) + 1; continue; }
                        fuelT[k] = Date.now(); fuelFail[k] = 0;
                        if (k === 'misfire') { logRaw('misfires', v); live.misfire = v; lastCar = Date.now(); remember(['misfire']); }
                        else if (PAIR[k]) { put(PAIR[k][0], v.target); if (v.actual !== null) put(PAIR[k][1], v.actual); else delete live[PAIR[k][1]]; }
                        else put(k === 'boost' ? 'boostDme' : k, v);
                    }
                }
            } catch (e) { log.warn('engine unit poll: ' + e); }
            fuelBusy = false;
            fuelTimer = setTimeout(pollFuel, fast ? 400 : 5000);
        }
        fuelTimer = setTimeout(pollFuel, 1000);
        /** Page opened: don't wait for the slow timer. */
        const kickFuel = () => { if (!fuelBusy && Date.now() - fuelLast > 600) { clearTimeout(fuelTimer); fuelTimer = setTimeout(pollFuel, 0); } };
        /** Why a fuel value is missing, for its tile. */
        function fuelWhy(k) {
            if (!link.p) return 'no diagnostic link';
            if (!link.available) return 'diagnostic link down';
            const r = k === 'misfire' ? Object.keys(rd.raws).filter((x) => /MID A2|F6A2/.test(x)).map((x) => rd.raws[x])
                : (dme[PAIR[k] ? PAIR[k][0] : k] || []).map((c) => rd.raws[rd.key(c)]).filter(Boolean);
            if (!r.length) return 'reading...';
            // plain words on the tile; the reply codes are in the log
            if (r.every((x) => /NRC 31|NRC 11|NRC 12/.test(x.why))) return 'not available on this car';
            if (k === 'misfire' && misMode === null) return 'not available on this car';
            return /NRC|refused|reply/.test(r[0].why) ? 'no reading from the engine unit' : r[0].why || 'no data';
        }

        // 1 Hz history sampler for the thermal traces
        setInterval(() => {
            const d = data();
            const fuelOk = (k) => usingDemo() || (fuelT[k] && Date.now() - fuelT[k] < 15000);
            Object.keys(hist).forEach((k) => {
                let v = d[k] == null ? null : d[k];
                const fk = GROUP[k] && PAIR[GROUP[k]] ? GROUP[k] : k;
                if (FUEL.indexOf(fk) >= 0 && !fuelOk(fk)) v = null;
                if (k === 'iatRise') v = fuelOk('iat') && G.isNum(d.iat) && G.isNum(d.ambient) ? d.iat - d.ambient : null;
                hist[k].push(v); if (hist[k].length > HIST_SEC) hist[k].shift();
            });
        }, 1000);

        /* ---------- units ---------- */
        const T = (c) => (c == null ? null : settings.get('tempUnit') === 'F' ? c * 9 / 5 + 32 : c);
        const tU = () => (settings.get('tempUnit') === 'F' ? '°F' : '°C');
        const Pt = (b) => (b == null ? null : settings.get('pressUnit') === 'psi' ? b * 14.5038 : b);
        const P = (b) => (b == null ? null : settings.get('pressUnit') === 'psi' ? b * 14.5038 : b);
        const V = (k) => (k == null ? null : settings.get('speedUnit') === 'mph' ? k * 0.621371 : k);


        /* ---------- drawing: The Grid ---------- */
        let page = PAGES.indexOf(settings.get('page'));
        if (page < 0) page = 0;
        const A0 = -135, A1 = 135;                     // dial sweep in degrees, 0 = up

        /** { letter, num, est } for the gear readout, or null without any gear information. */
        function gearText(d) {
            const st = d.stage, m = d.gearMode || d.program;
            if (st === 'P' || st === 'R' || st === 'N') return { letter: st, num: '', est: false };
            let g = d.gear, est = false;
            if (!G.isNum(g)) { g = d.gearGuess; est = true; }
            const letter = m === 'S' || m === 'M' ? m : 'D';
            if (!G.isNum(g)) return st === 'D' ? { letter, num: '', est: false } : null;
            if (g < 0) return { letter: 'R', num: '', est };
            if (g === 0) return st === 'D' ? { letter, num: '', est } : { letter: m === 'P' ? 'P' : 'N', num: '', est };
            return { letter, num: String(g), est };
        }
        /** Power in kW: the sport display's % x max power, else torque x rpm. */
        function power(d) {
            const useSport = settings.get('powerSource') !== 'calc' && G.isNum(d.powerPct);
            if (useSport) return { kw: d.powerPct / 100 * settings.get('maxPower'), calc: false };
            return { kw: G.isNum(d.powerCalc) ? d.powerCalc : null, calc: true };
        }
        const PW = (kw) => (G.isNum(kw) ? kw * ({ kw: 1, hp: 1.34102, ps: 1.35962 }[settings.get('powerUnit')] || 1) : null);
        const pwU = () => ({ kw: 'kW', hp: 'hp', ps: 'PS' }[settings.get('powerUnit')] || 'kW');
        const TQ = (nm) => (G.isNum(nm) ? nm * ({ nm: 1, lbft: 0.737562, kgm: 1 / 9.80665 }[settings.get('torqueUnit')] || 1) : null);
        const tqU = () => ({ nm: 'Nm', lbft: 'lb-ft', kgm: 'kgm' }[settings.get('torqueUnit')] || 'Nm');
        const tqMax = () => (settings.get('torqueUnit') === 'kgm' ? (settings.get('maxTorqueKgm') || 100) : TQ(900));
        /** Why boost is missing (Auto: tells which sources were tried). */
        function boostWhy() {
            const src = settings.get('boostSource');
            const dmeMsg = !link.p ? 'no diagnostic link' : !link.available ? 'diagnostic link down' : fuelFail.boost ? 'engine unit: no boost' : 'engine unit: reading...';
            if (src === 'fes') return 'no boost from the sport display';
            if (src === 'dme') return dmeMsg;
            return (G.isNum(live.boostFes) ? 'sport display stuck' : 'no sport display') + ' / ' + dmeMsg;
        }
        const fresh = (k) => usingDemo() || (fuelT[k] && Date.now() - fuelT[k] < 15000);
        const fr = (k, v) => (fresh(k) && G.isNum(v) ? v : null);
        const f0 = (v) => (G.isNum(v) ? G.fmt(v, 0) : null), f1 = (v) => (G.isNum(v) ? G.fmt(v, 1) : null);
        const transT = (d) => (G.isNum(d.gearbox) ? d.gearbox : d.egs);
        const misSum = (d) => (Array.isArray(d.misfire) ? d.misfire.reduce((a, b) => a + (b || 0), 0) : null);
        const psiOn = () => settings.get('pressUnit') === 'psi';
        const boostTop = () => { const b = BOOST_MAX[settings.get('boostMax')] || BOOST_MAX['2.5']; return psiOn() ? b[1] : b[0]; };

        /* ---------- Grid primitives ---------- */
        function floor(cv, t, bottom) {
            const hy = 300, vp = 800, a = (x) => G.withAlpha(t.accent, x);
            for (let i = -12; i <= 12; i++) cv.line(vp + i * 22, hy, vp + i * 150, bottom, 1, a(0.05));
            for (let j = 1; j < 8; j++) { const f = j / 7, y = hy + (bottom - hy) * f * f; cv.line(0, y, 1600, y, 1, a(0.09 * (1 - f) + 0.02)); }
        }
        function shiftLights(cv, t, x, y, w, h, rpm, red) {
            const n = 16, gap = 8, lw = (w - gap * (n - 1)) / n, start = red - 2600, top = red - 250;
            const lit = G.isNum(rpm) ? G.clamp((rpm - start) / (top - start), 0, 1) * n : 0;
            const over = G.isNum(rpm) && rpm >= top, flash = over && Math.floor(Date.now() / 90) % 2 === 0;
            for (let i = 0; i < n; i++) {
                const f = i / (n - 1), col = f < 0.55 ? t.accent : f < 0.8 ? t.warn : t.crit;
                const lx = x + i * (lw + gap), part = G.clamp(lit - i, 0, 1);
                cv.roundRect(lx, y, lw, h, 4, G.withAlpha(col, 0.10));
                if (over) { if (flash) { cv.roundRect(lx - 3, y - 3, lw + 6, h + 6, 6, G.withAlpha(t.crit, 0.35)); cv.roundRect(lx, y, lw, h, 4, t.crit); } }
                else if (part > 0) { cv.roundRect(lx - 3, y - 3, lw + 6, h + 6, 6, G.withAlpha(col, 0.25 * part)); cv.roundRect(lx, y, lw, h, 4, G.withAlpha(col, part)); }
            }
        }
        /** A glowing sweep from A0 to the value's angle; f = 0..1. */
        function sweep(cv, t, cx, cy, r, th, f, hot) {
            cv.arc(cx, cy, r - th, r, A0, A1, t.track, { round: true });
            if (!(f > 0.003)) return;
            const a = A0 + (A1 - A0) * G.clamp(f, 0, 1);
            cv.arc(cx, cy, r - th - 8, r + 8, A0, a, G.withAlpha(hot ? t.crit : t.accent, 0.13), { round: true });
            cv.arc(cx, cy, r - th, r, A0, a, t.accent, { round: true, ramp: t.hotRamp, rampFrom: A0, rampTo: A1 });
        }
        function tach(cv, t, cx, cy, r, d, red, max) {
            const th = 22, rpm = G.smooth('grid|rpm', d.rpm), hot = G.isNum(d.rpm) && d.rpm >= red;
            const ang = (v) => (A0 + (A1 - A0) * G.clamp(v / max, 0, 1)) * Math.PI / 180;
            cv.arc(cx, cy, r + 14, r + 16, A0, A1, G.withAlpha(t.accent, 0.22));
            sweep(cv, t, cx, cy, r, th, G.isNum(rpm) ? rpm / max : 0, hot);
            cv.arc(cx, cy, r - th, r, A0 + (A1 - A0) * G.clamp(red / max, 0, 1), A1, G.withAlpha(t.crit, 0.30));
            for (let k = 0; k <= Math.floor(max / 1000); k++) {
                const a = ang(k * 1000), s = Math.sin(a), c = -Math.cos(a), red2 = k * 1000 >= red;
                cv.line(cx + s * (r - th - 16), cy + c * (r - th - 16), cx + s * (r - th - 5), cy + c * (r - th - 5), 3, red2 ? t.crit : t.tick);
                cv.text(String(k), cx + s * (r - th - 42), cy + c * (r - th - 42) + 10, 28, red2 ? t.crit : t.dim, { align: 'center', font: 'num' });
            }
            const gr = gearText(d);
            if (gr) {
                cv.text(gr.num || gr.letter, cx, cy + 44, 140, hot ? t.crit : t.text, { align: 'center', font: 'gear' });
                if (gr.num && gr.letter !== 'D') cv.text(gr.letter, cx, cy - 72, 30, gr.letter === 'M' ? t.crit : t.accent, { align: 'center', font: 'bold' });
            }
            cv.text(G.isNum(d.rpm) ? G.fmt(d.rpm, 0) : '--', cx, cy + 104, 40, hot ? t.crit : t.accent, { align: 'center', font: 'num' });
            cv.text('RPM', cx, cy + 134, 20, t.dim, { align: 'center', font: 'bold', spacing: 3 });
        }
        function ringGauge(cv, t, cx, cy, r, label, v, unit, top, dec, why) {
            const sv = G.smooth('grid|' + label, v);
            cv.text(label, cx, cy - r - 16, 22, t.dim, { align: 'center', font: 'bold', spacing: 3 });
            sweep(cv, t, cx, cy, r, 18, G.isNum(sv) ? sv / top : 0, false);
            cv.arc(cx, cy, r - 18, r, A0 + (A1 - A0) * 0.85, A1, G.withAlpha(t.warn, 0.28));
            cv.text(G.isNum(v) ? G.fmt(v, dec) : '--', cx, cy + 22, 66, G.isNum(v) ? t.text : t.dim, { align: 'center', font: 'num' });
            cv.text(unit, cx, cy + 56, 22, t.dim, { align: 'center' });
            if (!G.isNum(v) && why) cv.text(why, cx, cy + r + 22, 16, t.dim, { align: 'center' });
        }
        function miniStat(cv, t, x, y, w, label, val, unit, frac, col) {
            cv.text(label, x, y, 20, t.dim, { font: 'bold', spacing: 2 });
            const vw = cv.text(G.isNum(val) ? G.fmt(val, 0) : '--', x, y + 54, 52, G.isNum(val) ? col : t.dim, { font: 'num' });
            cv.text(unit, x + vw + 8, y + 54, 22, t.dim);
            cv.roundRect(x, y + 70, w, 6, 3, t.track);
            if (G.isNum(frac) && frac > 0) cv.roundRect(x, y + 70, w * G.clamp(frac, 0, 1), 6, 3, col);
        }
        /** Grid card: label, big value + unit, a bar (frac) or why the value is missing. */
        function card(cv, t, x, y, w, h, label, val, unit, col, frac, why, size) {
            cv.roundRect(x, y, w, h, 12, t.panelBottom);
            cv.strokeRoundRect(x, y, w, h, 12, 1, t.panelEdge);
            cv.fillRect(x + 14, y, w - 28, 2, G.withAlpha(t.accent, 0.35));
            cv.text(label, x + 18, y + 32, 20, t.dim, { font: 'bold', spacing: 2 });
            const has = val != null && val !== '', vs = size || 54;
            const vw = cv.text(has ? String(val) : '--', x + 18, y + h - 34, vs, has ? col : t.dim, { font: 'num' });
            if (unit) cv.text(unit, x + 26 + vw, y + h - 34, 22, t.dim);
            if (!has && why && !usingDemo()) cv.text(String(why).slice(0, 30), x + 18, y + h - 12, 15, t.dim);
            else if (G.isNum(frac)) {
                cv.roundRect(x + 18, y + h - 20, w - 36, 6, 3, t.track);
                if (frac > 0) cv.roundRect(x + 18, y + h - 20, (w - 36) * G.clamp(frac, 0, 1), 6, 3, col);
            }
        }

        /* ---------- Drive ---------- */
        function drawDrive(cv, t, d) {
            engineSeen = Date.now();
            if (boostFromDme()) kickFuel();
            const red = engine.redline(), max = engine.scaleMax(), bottom = G.pageBottom(cv), tu = tU();
            floor(cv, t, bottom);
            shiftLights(cv, t, 460, 60, 680, 14, d.rpm, red);
            tach(cv, t, 270, 300, 196, d, red, max);
            const sp = V(G.hold('speed', d.speed, 1000 / settings.get('speedRate')));
            cv.text(G.isNum(sp) ? G.fmt(sp, 0) : '--', 790, 292, 200, G.isNum(sp) ? t.text : t.dim, { align: 'center', font: 'num' });
            cv.text(settings.get('speedUnit') === 'mph' ? 'MPH' : 'KM/H', 790, 342, 34, t.accent, { align: 'center', font: 'bold', spacing: 4 });
            ringGauge(cv, t, 1190, 250, 126, 'BOOST', P(d.boost), psiOn() ? 'psi' : 'bar', boostTop(), psiOn() ? 1 : 2, usingDemo() ? null : boostWhy());
            const pw = power(d), pmax = PW(settings.get('maxPower')), tq = TQ(d.torque);
            miniStat(cv, t, 1380, 128, 196, 'POWER', PW(pw.kw), pwU(), G.isNum(PW(pw.kw)) ? PW(pw.kw) / pmax : null, t.warn);
            miniStat(cv, t, 1380, 246, 196, 'TORQUE', tq, tqU(), G.isNum(tq) ? tq / tqMax() : null, t.warn);
            const ch = 112, y = bottom - ch - 4, x0 = 512, x1 = 1576, n = 5, gap = 14, w = (x1 - x0 - gap * (n - 1)) / n;
            const iat = fr('iat', d.iat), eth = fr('ethanol', d.ethanol), tr = transT(d);
            [
                ['OIL', f0(T(d.oil)), tu, t.oil, G.isNum(d.oil) ? (d.oil - 60) / 80 : null],
                ['COOLANT', f0(T(d.coolant)), tu, t.accent, G.isNum(d.coolant) ? (d.coolant - 60) / 70 : null],
                ['TRANS', f0(T(tr)), tu, t.warn, G.isNum(tr) ? (tr - 40) / 90 : null],
                ['INTAKE', f0(T(iat)), tu, t.accent, G.isNum(iat) ? iat / 80 : null, fuelWhy('iat')],
                ['ETHANOL', f0(eth), '% E', t.accent, G.isNum(eth) ? eth / 85 : null, fuelWhy('ethanol')],
            ].forEach((g, i) => card(cv, t, x0 + i * (w + gap), y, w, ch, g[0], g[1], g[2], g[3], g[4], g[5], 46));
        }

        /* ---------- Vitals ---------- */
        function drawVitals(cv, t, d) {
            fuelSeen = Date.now();
            kickFuel();
            const bottom = G.pageBottom(cv), cols = 4, rows = 3, gap = 14, x0 = 24, y0 = G.TOP + 14;
            const w = (1552 - gap * (cols - 1)) / cols, h = (bottom - y0 - gap * (rows - 1) - 4) / rows;
            const psi = psiOn(), pu = psi ? 'psi' : 'bar', tu = tU();
            const hp = fr('hpfp', d.hpfp), lp = fr('lpfp', d.lpfp), iat = fr('iat', d.iat), eth = fr('ethanol', d.ethanol), tim = fr('timing', d.timing);
            const pwv = PW(power(d).kw), tq = TQ(d.torque), mis = fresh('misfire') ? misSum(d) : null, tr = transT(d);
            [
                ['BOOST', G.isNum(P(d.boost)) ? G.fmt(P(d.boost), psi ? 1 : 2) : null, pu, t.accent, G.isNum(d.boost) ? P(d.boost) / boostTop() : null, boostWhy()],
                ['ETHANOL', f0(eth), '% E', t.accent, G.isNum(eth) ? eth / 85 : null, fuelWhy('ethanol')],
                ['OIL TEMP', f0(T(d.oil)), tu, t.oil, G.isNum(d.oil) ? (d.oil - 60) / 80 : null],
                ['COOLANT', f0(T(d.coolant)), tu, t.accent, G.isNum(d.coolant) ? (d.coolant - 60) / 70 : null],
                ['TRANS / ZF8', f0(T(tr)), tu, t.warn, G.isNum(tr) ? (tr - 40) / 90 : null],
                ['INTAKE / IAT', f0(T(iat)), tu, t.accent, G.isNum(iat) ? iat / 80 : null, fuelWhy('iat')],
                ['HPFP', G.isNum(hp) ? G.fmt(P(hp), 0) : null, pu, t.accent, G.isNum(hp) ? hp / 350 : null, fuelWhy('hpfp')],
                ['LPFP', G.isNum(lp) ? G.fmt(P(lp), psi ? 0 : 1) : null, pu, t.accent, G.isNum(lp) ? lp / 8 : null, fuelWhy('lpfp')],
                ['IGN TIMING', f1(tim), 'deg', t.accent, G.isNum(tim) ? (tim + 10) / 50 : null, fuelWhy('timing')],
                ['POWER', f0(pwv), pwU(), t.warn, G.isNum(pwv) ? pwv / PW(settings.get('maxPower')) : null],
                ['TORQUE', f0(tq), tqU(), t.warn, G.isNum(tq) ? tq / tqMax() : null],
                ['MISFIRES', G.isNum(mis) ? String(mis) : null, '', mis > 0 ? t.crit : t.accent, null, fuelWhy('misfire')],
            ].forEach((g, i) => {
                const c = i % cols, r = Math.floor(i / cols);
                card(cv, t, x0 + c * (w + gap), y0 + r * (h + gap), w, h, g[0], g[1], g[2], g[3], g[4], g[5], 50);
            });
        }

        /* ---------- Track: 0-60 / quarter mile from the car's speed signal ---------- */
        const RUNS_FILE = path.join(ctx.dataDir, 'runs.json');
        const runs = { state: 'stop', t0: 0, dist: 0, top: 0, cur: {}, last: {}, best: {} };
        try { Object.assign(runs.best, JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8'))); } catch (e) { /* no runs yet */ }
        function finishRun() {
            runs.last = Object.assign({}, runs.cur);
            const b = runs.best, c = runs.cur;
            let changed = false;
            if (G.isNum(c.t60) && !(b.t60 <= c.t60)) { b.t60 = c.t60; changed = true; }
            if (G.isNum(c.tq) && !(b.tq <= c.tq)) { b.tq = c.tq; b.trap = c.trap; changed = true; }
            if (changed) fs.writeFile(RUNS_FILE, JSON.stringify(b), () => {});
        }
        let runT = Date.now();
        setInterval(() => {
            const now = Date.now(), dt = (now - runT) / 1000;
            runT = now;
            if (usingDemo()) return;
            const v = data().speed;
            if (!G.isNum(v)) return;
            const target = settings.get('speedUnit') === 'mph' ? 96.5606 : 100;      // 60 mph or 100 km/h, in km/h
            if (v < 1) { if (runs.state === 'run') finishRun(); runs.state = 'armed'; return; }
            if (runs.state === 'armed' && v >= 1.5) { runs.state = 'run'; runs.t0 = now; runs.dist = 0; runs.top = v; runs.cur = {}; }
            if (runs.state !== 'run') return;
            runs.dist += (v / 3.6) * dt;
            runs.top = Math.max(runs.top, v);
            const el = (now - runs.t0) / 1000;
            if (runs.cur.t60 == null && v >= target) runs.cur.t60 = el;
            if (runs.cur.tq == null && runs.dist >= 402.336) { runs.cur.tq = el; runs.cur.trap = v; finishRun(); runs.state = 'done'; }
            else if (v < runs.top - 15) { finishRun(); runs.state = 'done'; }        // lifted: the run is over
        }, 50);
        function bigCard(cv, t, x, y, w, h, label, val, unit, sub, col, frac, badge) {
            cv.roundRect(x, y, w, h, 14, t.panelBottom);
            cv.strokeRoundRect(x, y, w, h, 14, 1, t.panelEdge);
            cv.fillRect(x + 16, y, w - 32, 2, G.withAlpha(t.accent, 0.35));
            cv.text(label, x + 24, y + 38, 24, t.dim, { font: 'bold', spacing: 3 });
            if (badge) {
                const bw = cv.textWidth(badge, 18, { font: 'bold' }) + 28;
                cv.roundRect(x + w - bw - 20, y + 14, bw, 34, 17, G.withAlpha(col, 0.18));
                cv.text(badge, x + w - 20 - bw / 2, y + 37, 18, col, { align: 'center', font: 'bold' });
            }
            const has = val != null;
            const vw = cv.text(has ? String(val) : '--', x + 24, y + h - 52, 96, has ? col : t.dim, { font: 'num' });
            cv.text(unit, x + 36 + vw, y + h - 52, 28, t.dim);
            if (G.isNum(frac)) {
                cv.roundRect(x + 24, y + h - 26, w - 48, 8, 4, t.track);
                if (frac > 0) cv.roundRect(x + 24, y + h - 26, (w - 48) * G.clamp(frac, 0, 1), 8, 4, col);
                if (sub) cv.text(sub, x + w - 24, y + 38, 22, t.dim, { align: 'right' });
            } else if (sub) cv.text(sub, x + 24, y + h - 20, 22, t.dim);
        }
        function drawTrack(cv, t, d) {
            engineSeen = Date.now();
            if (boostFromDme()) kickFuel();
            const bottom = G.pageBottom(cv), gap = 18, x0 = 24, y0 = G.TOP + 14, w = (1552 - gap) / 2, h = (bottom - y0 - gap - 4) / 2;
            const mph = settings.get('speedUnit') === 'mph', demoRun = usingDemo();
            const best = demoRun ? { t60: 3.4, tq: 11.6, trap: 196.3 } : runs.best, last = demoRun ? { t60: 3.6 } : runs.last;
            const status = demoRun ? 'DEMO' : runs.state === 'run' ? 'RUNNING' : runs.state === 'armed' ? 'ARMED' : 'STOP TO ARM';
            bigCard(cv, t, x0, y0, w, h, mph ? '0-60 MPH' : '0-100 KM/H', G.isNum(best.t60) ? G.fmt(best.t60, 2) : null, 's',
                'last ' + (G.isNum(last.t60) ? G.fmt(last.t60, 2) + ' s' : '--'), t.accent, null, status);
            bigCard(cv, t, x0 + w + gap, y0, w, h, '1/4 MILE', G.isNum(best.tq) ? G.fmt(best.tq, 2) : null, 's',
                G.isNum(best.trap) ? 'trap ' + G.fmt(V(best.trap), 0) + (mph ? ' mph' : ' km/h') : 'trap --', t.accent, null);
            const pk = demoRun ? demoPeak : peak, pw = power(d);
            raise(pk, 'power', pw.kw);
            raise(pk, 'torque', d.torque);
            const pv = PW(pw.kw), tq = TQ(d.torque);
            bigCard(cv, t, x0, y0 + h + gap, w, h, 'POWER', f0(pv), pwU(), 'peak ' + (G.isNum(pk.power) ? G.fmt(PW(pk.power), 0) : '--'), t.warn,
                G.isNum(pv) ? pv / PW(settings.get('maxPower')) : 0);
            bigCard(cv, t, x0 + w + gap, y0 + h + gap, w, h, 'TORQUE', f0(tq), tqU(), 'peak ' + (G.isNum(pk.torque) ? G.fmt(TQ(pk.torque), 0) : '--'), t.warn,
                G.isNum(tq) ? tq / tqMax() : 0);
        }

        /* ---------- frame + loop ---------- */
        function header(cv, t) {
            G.frame(cv, t, ['Drive', 'Vitals', 'Track'], page, [usingDemo() && { text: 'DEMO' }]);
        }
        async function render() {
            const t = ctx.theme(), d = data();
            const cv = ctx.canvas(W, H).clear(t.bg);
            [drawDrive, drawVitals, drawTrack][page](cv, t, d);
            header(cv, t);
            if (!render.n) { render.n = 1; log.info('first frame drawn'); }
            await ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; return render(); });
        ui.onClick('BTN_PREV', () => { page = (page + PAGES.length - 1) % PAGES.length; return render(); });
        ctx.onTab((i) => { page = i; return render(); });
        ctx.loop('MAIN', 10, render);
        settings.onChange((k) => {
            if (k === 'maxPower' || k === 'powerSource') { delete peak.power; delete demoPeak.power; }
            if (k === 'boostSource') { delete peak.boost; updBoost(); }
            if (k === 'page') page = Math.max(0, PAGES.indexOf(settings.get('page')));
        });
        log.info('first render');
        const t0 = Date.now();
        render().then(() => log.info('first frame done ' + (Date.now() - t0) + ' ms')).catch((e) => log.warn('first render: ' + e));
    },
});
