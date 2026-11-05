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
const H = require('./hud');
const { Controller } = require('./controller');
const { TuneControl } = require('./tune');
const { GridCluster } = require('./cluster');

const W = 1600, HGT = 520;
const PAGES = ['drive', 'vitals', 'track', 'engine'];
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
            boostTarget: [], boostActual: [], loadTarget: [], loadActual: [], boost: [], ethanol: [] };
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

        /* ---------- The Grid's look (hud.js) ---------- */
        const A = H.A;
        const HY = 334;                                         // the horizon
        const VERSION = ctx.spec.version || '';
        const rampCache = {};
        /** Static colour ramps per theme (the renderer keeps each ramp: never build one per frame). */
        function ramps(t) {
            if (!rampCache[t.name]) {
                rampCache[t.name] = {
                    trail: [A(t.accent, 0), A(t.accent2 || t.accent, 1)],
                    trailHot: [A(t.crit, 0), A(t.crit, 1)],
                };
            }
            return rampCache[t.name];
        }
        const textC = (t) => t.text;
        const dimC = (t, a) => A(t.accent, a == null ? 0.45 : a);
        /** Status of a temperature (deg C): [word, colour]. */
        const LIMITS = { oil: [70, 130], coolant: [70, 112], trans: [40, 115], iat: [-60, 55] };
        function tState(t, k, c) {
            if (!G.isNum(c)) return null;
            const L = LIMITS[k];
            if (c < L[0]) return ['COLD', t.cold || t.accent];
            if (c > L[1]) return ['HOT', t.crit];
            return ['NOMINAL', A(t.accent, 0.75)];
        }
        /** Bar colour by position: accent, then warn, crit at the top. */
        const zone3 = (t, warnAt, critAt) => (f) => (f >= critAt ? t.crit : f >= warnAt ? t.warn : t.accent);

        /**
         * One holo readout: label tab, value, unit, status word, segment bar, and the last five
         * minutes as a trace when there is a history. Missing values say why (not in demo).
         */
        function readout(cv, t, x, y, w, h, o) {
            const st = o.state, hot = st && st[0] === 'HOT';
            const p = H.panel(cv, t, x, y, w, h, o.label, { code: o.code, delay: o.delay, hot });
            const b = H.boot((o.delay || 0) + 150, 400);
            if (b <= 0) return;
            cv.alpha(b);
            const has = o.val != null && o.val !== '';
            const vs = o.size || 46, vy = p.y + Math.min(p.h - 22, vs + 6);
            const vw = H.num(cv, has ? String(o.val) : '--', p.x, vy, vs, has ? (o.col || textC(t)) : dimC(t, 0.25), 'left', has && vs > 50 ? t.accent : null);
            if (o.unit) H.lbl(cv, o.unit, p.x + vw + 8, vy, Math.max(18, vs * 0.38), dimC(t, 0.8), 'left', 1);
            if (st) H.mono(cv, st[0], x + w - 14, vy, 13, st[1], 'right');
            if (o.hist && w > 300) {
                const tw = Math.min(150, w * 0.36), tx = x + w - 14 - tw, ty = p.y + 4, th = vy - p.y - 34;
                if (th > 14) { cv.fillRect(tx, ty + th, tw, 1, dimC(t, 0.15)); H.trace(cv, tx, ty, tw, th, o.hist, o.lo, o.hi, t.accent); }
            }
            const by = y + h - 16;
            if (!has && o.why && !usingDemo()) H.mono(cv, String(o.why).slice(0, Math.floor(w / 9)), p.x, by + 6, 12, dimC(t, 0.4));
            else if (G.isNum(o.frac)) H.segBar(cv, p.x, by, w - 32, 7, o.segs || 18, o.frac, o.zone || (() => t.accent), dimC(t, 0.08));
            cv.alpha(1);
        }

        /* ---------- Drive ---------- */
        function rpmZone(t, red, max) { return (f) => (f * max >= red ? t.crit : f * max >= red - 1200 ? t.warn : t.accent); }

        function tachReactor(cv, t, cx, cy, R, d, red, max) {
            const rpm = G.smooth('grid|rpm', d.rpm), hot = G.isNum(d.rpm) && d.rpm >= red;
            const zone = rpmZone(t, red, max), rp = ramps(t);
            H.reactor(cv, t, cx, cy, R, {
                a0: -135, a1: 135, f: G.isNum(rpm) ? rpm / max : null, zone, spin: G.isNum(rpm) ? rpm / max : 0,
                segments: 56, ticks: Math.round(max / 250), major: 4, redFrom: red / max, trailRamp: hot ? rp.trailHot : rp.trail,
            });
            // the thousands, outside the scale
            const b = H.boot(300, 600);
            for (let k = 0; k <= Math.floor(max / 1000); k++) {
                const f = k * 1000 / max, a = -135 + 270 * f;
                if (f > b) break;
                const p = H.pol(cx, cy, R * 1.1, a);
                H.head(cv, String(k), p[0], p[1] + 7, 18, k * 1000 >= red ? t.crit : dimC(t, 0.7), 'center', 0);
            }
            // gear in the core
            const gr = gearText(d);
            const mode = gr && gr.letter === 'S' ? 'SPORT' : gr && gr.letter === 'M' ? 'MANUAL' : gr && gr.letter === 'D' && gr.num ? 'DRIVE' : '';
            if (gr) {
                H.num(cv, gr.num || gr.letter, cx, cy + 44, 118, hot ? t.crit : textC(t), 'center', hot ? t.crit : t.accent);
                if (mode) H.mono(cv, mode, cx, cy - 58, 14, gr.letter === 'M' ? t.crit : dimC(t, 0.8), 'center');
            }
            // engine speed in the gap at the bottom of the dial
            H.num(cv, G.isNum(d.rpm) ? G.fmt(d.rpm, 0) : '--', cx, cy + R * 0.86, 40, hot ? t.crit : textC(t), 'center');
            H.mono(cv, 'RPM', cx, cy + R * 0.86 + 22, 13, dimC(t, 0.6), 'center');
        }

        function boostReticle(cv, t, cx, cy, r, d) {
            const psi = psiOn(), lo = psi ? -15 : -1, top = boostTop(), b = H.boot(150, 800), tn = Date.now() / 1000;
            const a0 = -125, a1 = 125, ang = (v) => a0 + (a1 - a0) * G.clamp((v - lo) / (top - lo), 0, 1);
            const v = P(d.boost), sv = G.smooth('grid|boost', v), z = ang(0);
            // crosshair core
            cv.circle(cx, cy, r * 0.7, A(t.bg, 0.85));
            H.spinner(cv, cx, cy, r * 0.71, r * 0.73, -(tn * 12) % 360, Array.from({ length: 24 }, (_, i) => [i * 15, 9]), dimC(t, 0.3 * b));
            const rot = (tn * 25) % 360;
            [0, 90, 180, 270].forEach((k) => H.radial(cv, cx, cy, r * 0.76, r * 0.84, rot + k, 2, dimC(t, 0.7 * b)));
            // scale: vacuum dim, boost lit in segments
            const step = psi ? 1 : 0.1, maj = psi ? 5 : 0.5;
            for (let x = lo; x <= top + 1e-6; x += step) {
                const isMaj = Math.abs(x / maj - Math.round(x / maj)) < 1e-6, a = ang(x);
                if ((a - a0) / (a1 - a0) > b) break;
                H.radial(cv, cx, cy, r * (isMaj ? 0.86 : 0.9), r * 0.95, a, isMaj ? 2.5 : 1, isMaj ? dimC(t, 0.8) : dimC(t, 0.3));
                if (isMaj) { const p = H.pol(cx, cy, r * 1.27, a); H.mono(cv, G.fmt(x, psi ? 0 : 1), p[0], p[1] + 5, 13, dimC(t, 0.6), 'center'); }
            }
            cv.arc(cx, cy, r * 0.99, r * 1.13, a0, z, A(t.cold || t.accent, 0.08 * b));
            const n = 30, f = G.isNum(sv) ? G.clamp((sv) / top, 0, 1) : 0;
            H.segArc(cv, cx, cy, r * 0.99, r * 1.13, z, z + (a1 - z) * b, n, 1.6, f * n, (i, ff) => (ff > 0.85 ? t.crit : ff > 0.6 ? t.warn : t.accent), dimC(t, 0.07));
            if (G.isNum(sv) && sv < 0) cv.arc(cx, cy, r * 0.99, r * 1.13, ang(sv), z, A(t.cold || t.accent, 0.5));
            H.radial(cv, cx, cy, r * 0.95, r * 1.18, z, 2, dimC(t, 0.9));
            // peak and the pointer
            const pk = usingDemo() ? demoPeak.boost : peak.boost;
            if (G.isNum(pk) && pk > 0) H.radial(cv, cx, cy, r * 0.97, r * 1.15, ang(P(pk)), 3, t.warn);
            if (G.isNum(sv) && b > 0.9) H.pointer(cv, cx, cy, r * 1.16, ang(sv), 9, '#ffffff');
            // readout
            H.mono(cv, 'BOOST', cx, cy - 34, 15, dimC(t, 0.8), 'center');
            H.num(cv, G.isNum(v) ? G.fmt(v, psi ? 1 : 2) : '--', cx, cy + 22, 52, G.isNum(v) ? textC(t) : dimC(t, 0.3), 'center', G.isNum(v) ? t.accent : null);
            H.lbl(cv, psi ? 'PSI' : 'BAR', cx, cy + 48, 18, dimC(t, 0.8), 'center', 4);
            if (G.isNum(pk)) H.mono(cv, 'PK ' + G.fmt(P(pk), psi ? 1 : 2), cx, cy + r * 0.62, 12, A(t.warn, 0.8), 'center');
            if (!G.isNum(v) && !usingDemo()) H.mono(cv, boostWhy(), cx, cy + r + 44, 12, dimC(t, 0.45), 'center');
        }

        function linkStatus(cv, t, x, y) {
            const on = usingDemo() || (link.p && link.available);
            cv.circle(x + 5, y - 5, 4, on ? t.accent : t.crit);
            if (on) cv.circle(x + 5, y - 5, 8, A(t.accent, 0.18 + 0.12 * Math.sin(Date.now() / 300)));
            return H.mono(cv, usingDemo() ? 'DEMO FEED' : on ? 'DME 0x12 LINKED' : 'DME LINK DOWN', x + 18, y, 13, on ? dimC(t, 0.75) : t.crit);
        }

        const discRot = { a: 0, t: 0 };
        function drawDrive(cv, t, d) {
            engineSeen = Date.now();
            if (boostFromDme()) kickFuel();
            const red = engine.redline(), max = engine.scaleMax(), bottom = G.pageBottom(cv), tu = tU();
            H.backdrop(cv, t, bottom, HY, G.isNum(d.speed) ? d.speed : null);
            H.mono(cv, 'GRID//OS ' + VERSION, 24, 72, 13, dimC(t, 0.55));
            H.mono(cv, 'ID // ' + t.name, 24, 90, 13, dimC(t, 0.35));

            tachReactor(cv, t, 292, 288, 200, d, red, max);

            // velocity on the identity disc
            const sp = V(G.hold('speed', d.speed, 1000 / settings.get('speedRate'))), dcx = 800, dcy = 236, dR = 146;
            const tn = Date.now(), dts = Math.min(0.2, (tn - (discRot.t || tn)) / 1000);
            discRot.t = tn;
            discRot.a = (discRot.a + (8 + (G.isNum(d.speed) ? d.speed : 0) * 1.4) * dts) % 360;
            const shiftStart = red - 2600, shiftTop = red - 200;
            H.disc(cv, t, dcx, dcy, dR, {
                id: (t.name || 'sam').toLowerCase(), rot: discRot.a,
                shift: G.isNum(d.rpm) ? (d.rpm - shiftStart) / (shiftTop - shiftStart) : 0, over: G.isNum(d.rpm) && d.rpm >= shiftTop,
            });
            const sb = H.boot(400, 500);
            cv.alpha(sb);
            H.mono(cv, 'VELOCITY', dcx, dcy - 52, 13, dimC(t, 0.7), 'center');
            H.num(cv, G.isNum(sp) ? G.fmt(sp, 0) : '--', dcx, dcy + 38, 104, G.isNum(sp) ? textC(t) : dimC(t, 0.3), 'center', t.accent);
            H.head(cv, settings.get('speedUnit') === 'mph' ? 'MPH' : 'KM/H', dcx, dcy + 74, 18, t.accent, 'center', 8);
            cv.alpha(1);

            boostReticle(cv, t, 1168, 206, 104, d);
            // flow chevrons either side of the disc (they run faster with speed) and a data line to the column
            const cph = (Date.now() / 1000) * (0.6 + (G.isNum(d.speed) ? d.speed : 0) / 60);
            H.chevrons(cv, 578, dcy, 3, 15, 8, 'right', t.accent, cph % 1);
            H.chevrons(cv, 1022, dcy, 3, 15, 8, 'left', t.accent, cph % 1);
            H.leader(cv, [[1168, 336], [1168, 392], [1326, 392]], t.accent, 'B-07');

            // right column: ethanol, power, torque
            const rx = 1340, rw = 236;
            linkStatus(cv, t, rx, 66);
            const eth = fr('ethanol', d.ethanol);
            readout(cv, t, rx, 80, rw, 96, { label: 'ETHANOL', code: 'E-CONTENT', val: f0(eth), unit: '% E', frac: G.isNum(eth) ? eth / 100 : null, segs: 20, why: fuelWhy('ethanol'), delay: 250, size: 50 });
            const pw = power(d), pv = PW(pw.kw), tq = TQ(d.torque);
            readout(cv, t, rx, 188, rw, 82, { label: 'POWER', code: pwU(), val: f0(pv), unit: pwU(), frac: G.isNum(pv) ? pv / PW(settings.get('maxPower')) : null, zone: zone3(t, 0.75, 0.95), delay: 320, size: 40 });
            readout(cv, t, rx, 282, rw, 82, { label: 'TORQUE', code: tqU(), val: f0(tq), unit: tqU(), frac: G.isNum(tq) ? tq / tqMax() : null, zone: zone3(t, 0.75, 0.95), delay: 390, size: 40 });

            // bottom row: temperatures
            const ch = 92, y = bottom - ch - 6, x0 = 546, x1 = 1576, n = 4, gap = 16, w = (x1 - x0 - gap * (n - 1)) / n;
            const iat = fr('iat', d.iat), tr = transT(d);
            [
                ['OIL', 'ENG.OIL', d.oil, 'oil', (d.oil - 40) / 110],
                ['COOLANT', 'H2O', d.coolant, 'coolant', (d.coolant - 40) / 90],
                ['TRANS', 'ZF8HP', tr, 'trans', (tr - 20) / 110],
                ['INTAKE', 'IAT', iat, 'iat', iat / 80, fuelWhy('iat')],
            ].forEach((g, i) => readout(cv, t, x0 + i * (w + gap), y, w, ch, {
                label: g[0], code: g[1], val: f0(T(g[2])), unit: tu, state: tState(t, g[3], g[2]),
                frac: G.isNum(g[2]) ? g[4] : null, zone: zone3(t, 0.7, 0.88), why: g[5], delay: 450 + i * 70, size: 40,
            }));
        }

        /* ---------- Vitals ---------- */
        function drawVitals(cv, t, d) {
            fuelSeen = Date.now();
            kickFuel();
            const bottom = G.pageBottom(cv);
            H.backdrop(cv, t, bottom, HY + 60, G.isNum(d.speed) ? d.speed : null);
            const cols = 4, rows = 3, gap = 16, x0 = 24, y0 = G.TOP + 22;
            const w = (1552 - gap * (cols - 1)) / cols, h = (bottom - y0 - gap * (rows - 1) - 6) / rows;
            const psi = psiOn(), pu = psi ? 'psi' : 'bar', tu = tU();
            const hp = fr('hpfp', d.hpfp), lp = fr('lpfp', d.lpfp), iat = fr('iat', d.iat), eth = fr('ethanol', d.ethanol), tim = fr('timing', d.timing);
            const pwv = PW(power(d).kw), tq = TQ(d.torque), mis = fresh('misfire') ? misSum(d) : null, tr = transT(d);
            const hT = (k) => (hist[k] || []).map(T), hP = (k) => (hist[k] || []).map(P);
            const zt = zone3(t, 0.7, 0.88);
            [
                { label: 'BOOST', code: 'MAP.KPA', val: G.isNum(P(d.boost)) ? G.fmt(P(d.boost), psi ? 1 : 2) : null, unit: pu, frac: G.isNum(d.boost) ? P(d.boost) / boostTop() : null, why: boostWhy(), hist: hP('boost'), lo: psi ? -15 : -1, hi: boostTop(), zone: zone3(t, 0.6, 0.85) },
                { label: 'ETHANOL', code: 'E%', val: f0(eth), unit: '% E', frac: G.isNum(eth) ? eth / 100 : null, why: fuelWhy('ethanol'), hist: hist.ethanol, lo: 0, hi: 100 },
                { label: 'OIL TEMP', code: 'ENG.OIL', val: f0(T(d.oil)), unit: tu, state: tState(t, 'oil', d.oil), frac: G.isNum(d.oil) ? (d.oil - 40) / 110 : null, hist: hT('oil'), lo: T(40), hi: T(150), zone: zt },
                { label: 'COOLANT', code: 'H2O', val: f0(T(d.coolant)), unit: tu, state: tState(t, 'coolant', d.coolant), frac: G.isNum(d.coolant) ? (d.coolant - 40) / 90 : null, hist: hT('coolant'), lo: T(40), hi: T(130), zone: zt },
                { label: 'TRANS / ZF8', code: 'EGS', val: f0(T(tr)), unit: tu, state: tState(t, 'trans', tr), frac: G.isNum(tr) ? (tr - 20) / 110 : null, hist: hT(G.isNum(d.gearbox) ? 'gearbox' : 'egs'), lo: T(20), hi: T(130), zone: zt },
                { label: 'INTAKE / IAT', code: 'IAT', val: f0(T(iat)), unit: tu, state: tState(t, 'iat', iat), frac: G.isNum(iat) ? iat / 80 : null, why: fuelWhy('iat'), hist: hT('iat'), lo: T(0), hi: T(80), zone: zt },
                { label: 'HPFP', code: 'RAIL', val: G.isNum(hp) ? G.fmt(P(hp), 0) : null, unit: pu, frac: G.isNum(hp) ? hp / 350 : null, why: fuelWhy('hpfp'), hist: hP('hpfp'), lo: 0, hi: P(350) },
                { label: 'LPFP', code: 'FEED', val: G.isNum(lp) ? G.fmt(P(lp), psi ? 0 : 1) : null, unit: pu, frac: G.isNum(lp) ? lp / 8 : null, why: fuelWhy('lpfp'), hist: hP('lpfp'), lo: 0, hi: P(8) },
                { label: 'IGN TIMING', code: 'DEG', val: f1(tim), unit: 'deg', frac: G.isNum(tim) ? (tim + 10) / 50 : null, why: fuelWhy('timing'), hist: hist.timing, lo: -20, hi: 40 },
                { label: 'POWER', code: pwU(), val: f0(pwv), unit: pwU(), frac: G.isNum(pwv) ? pwv / PW(settings.get('maxPower')) : null, zone: zone3(t, 0.75, 0.95) },
                { label: 'TORQUE', code: tqU(), val: f0(tq), unit: tqU(), frac: G.isNum(tq) ? tq / tqMax() : null, zone: zone3(t, 0.75, 0.95) },
                { label: 'MISFIRES', code: 'OBD.06', val: G.isNum(mis) ? String(mis) : null, unit: 'cycle', col: mis > 0 ? t.warn : null, why: fuelWhy('misfire'), state: G.isNum(mis) ? (mis > 0 ? ['WATCH', t.warn] : ['CLEAN', A(t.accent, 0.75)]) : null },
            ].forEach((o, i) => {
                const c = i % cols, r = Math.floor(i / cols);
                readout(cv, t, x0 + c * (w + gap), y0 + r * (h + gap), w, h, Object.assign({ delay: 60 * i, size: 46 }, o));
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

        function drawTrack(cv, t, d) {
            engineSeen = Date.now();
            if (boostFromDme()) kickFuel();
            const bottom = G.pageBottom(cv);
            H.backdrop(cv, t, bottom, HY, G.isNum(d.speed) ? d.speed : null);
            const gap = 18, x0 = 24, y0 = G.TOP + 22, w = (1552 - gap) / 2, h = (bottom - y0 - gap - 6) / 2;
            const mph = settings.get('speedUnit') === 'mph', demoRun = usingDemo();
            const best = demoRun ? { t60: 3.4, tq: 11.6, trap: 196.3 } : runs.best, last = demoRun ? { t60: 3.6 } : runs.last;
            const status = demoRun ? 'DEMO' : runs.state === 'run' ? 'RUNNING' : runs.state === 'armed' ? 'ARMED' : 'STOP TO ARM';
            const live = runs.state === 'run' && !demoRun;
            const timer = (x, y, label, code, val, sub, delay, chip) => {
                const p = H.panel(cv, t, x, y, w, h, label, { code, delay, hot: live });
                const b = H.boot(delay + 150, 400);
                if (b <= 0) return;
                cv.alpha(b);
                const has = G.isNum(val), vy = y + h - 46;
                const vw = H.num(cv, has ? G.fmt(val, 2) : '--.--', p.x, vy, 104, has ? textC(t) : dimC(t, 0.25), 'left', has ? t.accent : null);
                H.lbl(cv, 'SEC', p.x + vw + 10, vy, 26, dimC(t, 0.8), 'left', 3);
                H.mono(cv, sub, p.x, y + h - 14, 14, dimC(t, 0.6));
                if (chip) {
                    const cw = cv.textWidth(chip, 14, { font: H.F.mono, spacing: 2, literal: true }) + 30, cx = x + w - cw - 16, cy = y + 34;
                    const on = chip === 'ARMED' || chip === 'RUNNING';
                    const pulse = on ? 0.5 + 0.5 * Math.sin(Date.now() / 180) : 0;
                    cv.quad([[cx + 8, cy], [cx + cw, cy], [cx + cw - 8, cy + 26], [cx, cy + 26]], on ? A(chip === 'RUNNING' ? t.crit : t.accent, 0.35 + 0.4 * pulse) : dimC(t, 0.12));
                    H.mono(cv, chip, cx + cw / 2, cy + 18, 14, on ? '#ffffff' : dimC(t, 0.7), 'center');
                }
                cv.alpha(1);
            };
            timer(x0, y0, mph ? '0-60 MPH' : '0-100 KM/H', 'LAUNCH', best.t60, 'BEST  //  LAST ' + (G.isNum(last.t60) ? G.fmt(last.t60, 2) + ' S' : '--'), 0, status);
            timer(x0 + w + gap, y0, 'QUARTER MILE', '402 M', best.tq, 'BEST  //  TRAP ' + (G.isNum(best.trap) ? G.fmt(V(best.trap), 0) + (mph ? ' MPH' : ' KM/H') : '--'), 80);
            const pk = demoRun ? demoPeak : peak, pw = power(d);
            raise(pk, 'power', pw.kw);
            raise(pk, 'torque', d.torque);
            const pv = PW(pw.kw), tq = TQ(d.torque);
            readout(cv, t, x0, y0 + h + gap, w, h, { label: 'POWER', code: 'PEAK ' + (G.isNum(pk.power) ? G.fmt(PW(pk.power), 0) : '--') + ' ' + pwU(), val: f0(pv), unit: pwU(), frac: G.isNum(pv) ? pv / PW(settings.get('maxPower')) : 0, zone: zone3(t, 0.75, 0.95), delay: 160, size: 90, segs: 30 });
            readout(cv, t, x0 + w + gap, y0 + h + gap, w, h, { label: 'TORQUE', code: 'PEAK ' + (G.isNum(pk.torque) ? G.fmt(TQ(pk.torque), 0) : '--') + ' ' + tqU(), val: f0(tq), unit: tqU(), frac: G.isNum(tq) ? tq / tqMax() : 0, zone: zone3(t, 0.75, 0.95), delay: 240, size: 90, segs: 30 });
        }
        /* ---------- Engine: exhaust flap, engine map, Max Cooling ----------
         * Engine Config's car-tested command layer (controller.js / tune.js and the adapters behind
         * them, unchanged): nothing leaves the head unit until a button is pressed, the flap stays
         * simulated until "Exhaust Flap" is armed, and the tune sends nothing while "Tuning software"
         * is Off. Map names: config.mapNames in app.json. */
        const exhaust = new Controller(ctx);
        const tune = new TuneControl(ctx, { rpm: () => (usingDemo() || !G.isNum(live.rpm) ? null : live.rpm) });
        const MAP_NAMES = ((ctx.spec.config && ctx.spec.config.mapNames) || []).slice(0, 4);
        const mapName = (n) => MAP_NAMES[n - 1] || 'Map ' + n;
        let exAngle = 0.18;
        const exPress = (mode) => () => Promise.resolve(exhaust.setMode(mode)).catch((e) => log.error('exhaust', e));
        const tuneAct = (fn) => () => Promise.resolve(fn()).catch((e) => log.error('tune', e));
        (async () => {
            await exhaust.start();               // read-only: finds the DME; disarmed sends nothing at all
            await tune.start(exhaust.link);      // nothing at all while "Tuning software" is Off
            if (exhaust.link) exhaust.link.onAvailable(() => exhaust.refresh().then(() => tune.refresh()).catch((e) => log.error('link', e)));
        })().catch((e) => log.warn('engine controls: ' + e));

        /** One tailpipe seen end-on: neon bezel, dark bore, the butterfly turning (open 0..1). */
        function tip(cv, t, cx, cy, r, open, hot) {
            const c = t.accent;
            cv.circle(cx, cy, r + 14, A(c, 0.05));
            H.neonArc(cv, cx, cy, r, 4, 0, 360, c);
            H.neonArc(cv, cx, cy, r - 9, 1.2, 0, 360, A(c, 0.5), 0.3);
            const rb = r - 14;
            cv.circle(cx, cy, rb, '#020306');
            if (open > 0.35) {
                const g = (open - 0.35) / 0.65;
                cv.circle(cx, cy, rb * 0.8, A(hot, 0.12 * g)); cv.circle(cx, cy, rb * 0.45, A(hot, 0.22 * g));
            }
            const pw = Math.max(4, 2 * rb * Math.cos(open * Math.PI / 2 * 0.95));
            cv.roundRect(cx - pw / 2, cy - rb, pw, 2 * rb, Math.min(pw / 2, rb), A(c, 0.16));
            cv.strokeRoundRect(cx - pw / 2, cy - rb, pw, 2 * rb, Math.min(pw / 2, rb), 1.5, A(c, 0.85));
            cv.line(cx, cy - rb - 6, cx, cy + rb + 6, 1.5, A(c, 0.5));
            cv.circle(cx, cy, 4, '#ffffff');
        }
        /** The cooling fan face-on: neon shroud, seven blades turning (fast when on). */
        let fanRot = 0, fanT = Date.now();
        function fan(cv, t, cx, cy, r, on) {
            const c = on ? (t.accent2 || t.accent) : A(t.accent, 0.55), tn = Date.now();
            fanRot = (fanRot + (on ? 540 : 12) * Math.min(0.2, (tn - fanT) / 1000)) % 360; fanT = tn;
            cv.circle(cx, cy, r + 18, A(t.accent, on ? 0.08 : 0.03));
            H.neonArc(cv, cx, cy, r + 6, 3, 0, 360, c, on ? 1 : 0.4);
            H.spinner(cv, cx, cy, r + 14, r + 16, -fanRot * 0.1, Array.from({ length: 36 }, (_, i) => [i * 10, 5]), A(t.accent, 0.35));
            for (let i = 0; i < 7; i++) {
                const a = fanRot + i * 360 / 7, p0 = H.pol(cx, cy, r * 0.22, a), p1 = H.pol(cx, cy, r * 0.62, a + 14), p2 = H.pol(cx, cy, r * 0.92, a + 34);
                H.neon(cv, [p0, p1, p2], 5, A(c, on ? 0.95 : 0.6), on ? 0.8 : 0.3);
            }
            cv.circle(cx, cy, r * 0.2, '#04070b');
            H.neonArc(cv, cx, cy, r * 0.2, 2, 0, 360, c, 0.5);
        }
        /** The map hexagon: six panels round the active map's number, lit in turn while a switch is sent. */
        function mapHex(cv, t, cx, cy, Ro, Ri, m) {
            const rot = (Date.now() / 1000 * 6) % 360, busyStep = Math.floor(Date.now() / 110) % 6;
            for (let k = 0; k < 6; k++) {
                const a0 = rot + k * 60 + 2, a1 = rot + (k + 1) * 60 - 2;
                const pts = [H.pol(cx, cy, Ri, a0 + 1.5), H.pol(cx, cy, Ro, a0), H.pol(cx, cy, Ro, a1), H.pol(cx, cy, Ri, a1 - 1.5)];
                const lit = m.busy ? (k === busyStep ? 0.75 : 0.1) : m.map ? 0.2 + (k % 2 ? 0.08 : 0) : 0.06;
                cv.quad(pts, A(t.accent, lit));
                H.neon(cv, pts.concat([pts[0]]), 1.2, A(t.accent, 0.7), 0.3);
            }
            H.neon(cv, H.ngon(cx, cy, Ro + 12, 6, 30), 2, A(t.accent, 0.6), 0.5);
            H.neon(cv, H.ngon(cx, cy, Ri - 8, 6, 30), 1, A(t.accent, 0.4), 0);
            cv.circle(cx, cy, Ri - 10, A(t.bg, 0.9));
        }

        function drawEngine(cv, t, d) {
            const bottom = G.pageBottom(cv), v = exhaust.view(), m = tune.view();
            H.backdrop(cv, t, bottom, HY + 96, G.isNum(d.speed) ? d.speed : null);
            const y0 = G.TOP + 22, h = bottom - y0 - 8, gap = 18, wl = 470, wc = 1552 - 2 * wl - 2 * gap;
            const xl = 24, xc = xl + wl + gap, xr = xc + wc + gap, by = y0 + h - 76;
            const tuner = m.tuner, mhd = tuner === 'mhd';

            // exhaust flap
            const want = v.confirmed !== 'UNKNOWN' ? v.confirmed : v.requested;
            const tgt = want === 'OPEN' ? 1 : want === 'CLOSED' ? 0 : want === 'OEM' ? 0.18 : 0.5;
            exAngle += (tgt - exAngle) * 0.15; if (Math.abs(tgt - exAngle) < 0.003) exAngle = tgt;
            const exPath = v.simulated ? 'SIMULATED' : /^MHD/.test(v.adapterName) ? 'MHD 2F02' : /regulated/.test(v.adapterName) ? 'DME 611E'
                : /MG1/.test(v.adapterName) ? 'DME 60FD' : 'NOT AVAILABLE';
            H.panel(cv, t, xl, y0, wl, h, 'EXHAUST FLAP', { code: exPath, delay: 0 });
            const hot = want === 'OPEN' ? (t.accent2 || t.accent) : t.crit;
            tip(cv, t, xl + wl / 2 - 82, y0 + 128, 66, exAngle, hot);
            tip(cv, t, xl + wl / 2 + 82, y0 + 128, 66, exAngle, hot);
            const wcol = want === 'OPEN' ? (t.accent2 || t.accent) : want === 'CLOSED' ? t.crit : textC(t);
            H.head(cv, want === 'CLOSED' ? 'CLOSED' : want, xl + wl / 2, y0 + 252, 32, wcol, 'center', 6);
            const exSub = v.error ? v.error : v.busy ? 'SENDING…' : v.simulated ? 'SIMULATED · ARM "EXHAUST FLAP" IN SETTINGS'
                : want === 'OEM' ? 'THE DME IS IN CONTROL' : v.confirmed === v.requested ? 'CONFIRMED BY THE DME' : v.accepted ? 'ACCEPTED BY THE DME' : '';
            H.mono(cv, exSub, xl + wl / 2, y0 + 282, 13, v.error ? t.crit : v.simulated ? t.warn : dimC(t, 0.7), 'center');
            if (/^DME/.test(exPath)) H.mono(cv, "BMW'S TEST JOB · PARKED ONLY · THE DME ENDS IT AFTER ~20 S", xl + wl / 2, y0 + 304, 12, dimC(t, 0.5), 'center');
            else if (exPath === 'MHD 2F02') H.mono(cv, "MHD'S OWN FLAP CONTROL · HOLDS WHILE DRIVING", xl + wl / 2, y0 + 304, 12, dimC(t, 0.5), 'center');
            [['OPEN', 'OPEN'], ['CLOSE', 'CLOSED'], ['OEM', 'OEM']].forEach(([label, mode], i) => {
                H.button(cv, t, xl + 25 + i * 146, by, 132, 54, label, exPress(mode), { on: v.requested === mode, busy: v.busy && mode !== 'OEM', key: 'grid_ex_' + mode });
            });

            // engine map
            H.panel(cv, t, xc, y0, wc, h, 'ENGINE MAP', { code: mhd ? 'MHD' : tuner === 'bm3' ? 'BM3' : 'TUNER OFF', delay: 80 });
            const hx = xc + wc / 2, hy2 = y0 + 132;
            mapHex(cv, t, hx, hy2, 96, 58, m);
            if (m.map) H.num(cv, String(m.map), hx, hy2 + 30, 84, textC(t), 'center', t.accent);
            H.head(cv, m.map ? mapName(m.map) : tuner === 'off' ? 'TUNING SOFTWARE OFF' : 'PICK A MAP', hx, y0 + 268, 22, m.map ? t.accent : dimC(t, 0.6), 'center', 4);
            const mapSub = m.note ? m.note : m.map ? (m.mapConfirmed ? 'ACTIVE · READ FROM THE DME' : 'ACCEPTED BY THE DME')
                : tuner === 'off' ? 'SET "TUNING SOFTWARE" TO MHD IN SETTINGS' : mhd ? 'THE ENGINE LIGHT MAY FLASH WHILE THE MAP CHANGES' : '';
            H.mono(cv, mapSub, hx, y0 + 296, 13, m.noteType === 'warn' ? t.warn : m.noteType === 'go' ? A(t.accent, 0.9) : dimC(t, 0.6), 'center');
            const mw = (wc - 50 - 3 * 12) / 4;
            [1, 2, 3, 4].forEach((n, i) => {
                const nm = mapName(n), sub = nm === 'Map ' + n ? '' : nm.toUpperCase().slice(0, 14);
                H.button(cv, t, xc + 25 + i * (mw + 12), by, mw, 54, 'MAP ' + n, tuner === 'off' ? null : tuneAct(() => tune.setMap(n)),
                    { on: m.map === n, busy: m.busy || tuner === 'off', key: 'grid_map' + n, sub });
            });

            // max cooling
            const on = m.cooling === 'ON';
            H.panel(cv, t, xr, y0, wl, h, 'MAX COOLING', { code: mhd ? 'MHD 2F03' : 'MHD ONLY', delay: 160 });
            fan(cv, t, xr + wl / 2, y0 + 128, 66, on);
            H.head(cv, mhd ? (m.cooling || 'OFF') : 'MHD ONLY', xr + wl / 2, y0 + 252, 32, on ? (t.accent2 || t.accent) : textC(t), 'center', 6);
            const rpm = m.rpm;
            const coolSub = !mhd ? 'SET "TUNING SOFTWARE" TO MHD IN SETTINGS' : rpm == null ? 'ENGINE SPEED UNKNOWN'
                : rpm > m.minCoolingRpm ? 'ENGINE RUNNING · ' + Math.round(rpm) + ' RPM' : 'START THE ENGINE · NEEDS OVER ' + m.minCoolingRpm + ' RPM';
            H.mono(cv, coolSub, xr + wl / 2, y0 + 282, 13, dimC(t, 0.7), 'center');
            const tu = tU();
            H.mono(cv, 'H2O ' + (G.isNum(d.coolant) ? G.fmt(T(d.coolant), 0) + tu : '--') + '   OIL ' + (G.isNum(d.oil) ? G.fmt(T(d.oil), 0) + tu : '--'),
                xr + wl / 2, y0 + 304, 13, dimC(t, 0.5), 'center');
            [['ON', true], ['OFF', false]].forEach(([label, val], i) => {
                H.button(cv, t, xr + 52 + i * 194, by, 172, 54, label, mhd ? tuneAct(() => tune.setCooling(val)) : null,
                    { on: mhd && m.cooling === label, busy: m.busy || !mhd, key: 'grid_cool_' + label });
            });
        }

        /* ---------- the cluster: The Grid in the map area between BMW's gauges (cluster.js) ---------- */
        const CL_LIMITS = { oil: [70, 130], coolant: [70, 112], trans: [40, 115], iat: [-60, 55] };
        const clState = (k, c) => (!G.isNum(c) ? null : c < CL_LIMITS[k][0] ? 'COLD' : c > CL_LIMITS[k][1] ? 'HOT' : 'OK');
        const cluster = new GridCluster(ctx, {
            theme: () => ctx.theme(),
            values() {
                const d = data(), red = engine.redline(), psi = psiOn(), lo = psi ? -15 : -1, top = boostTop();
                const at = (x) => (G.isNum(x) ? G.clamp((x - lo) / (top - lo), 0, 1) : null);
                const temp = (k, c, lo2, span) => ({ text: f0(T(c)), frac: G.isNum(c) ? (c - lo2) / span : null, state: clState(k, c) });
                const iat = fr('iat', d.iat), eth = fr('ethanol', d.ethanol), bv = P(d.boost);
                const pk = usingDemo() ? demoPeak.boost : peak.boost;
                if (clusterShown) engineSeen = Date.now();          // keeps boost (and the slow values) coming from the DME
                return {
                    ethanol: { text: f0(eth), frac: G.isNum(eth) ? eth / 100 : null },
                    iat: temp('iat', iat, 0, 80),
                    oil: temp('oil', d.oil, 40, 110),
                    coolant: temp('coolant', d.coolant, 40, 90),
                    trans: temp('trans', transT(d), 20, 110),
                    boost: { text: G.isNum(bv) ? G.fmt(bv, psi ? 1 : 2) : null, zero: at(0), pos: at(bv), peak: at(P(pk)) },
                    shift: G.isNum(d.rpm) ? (d.rpm - (red - 2600)) / 2400 : 0, over: G.isNum(d.rpm) && d.rpm >= red - 200,
                    kmh: d.speed, units: { temp: tU(), press: psi ? 'psi' : 'bar' },
                };
            },
        });
        let clusterShown = false;
        cluster.onShown = (on) => { clusterShown = on; };
        const clusterOn = () => settings.get('cluster') !== 'off';
        if (clusterOn()) cluster.start();

        /* ---------- frame + loop ---------- */
        function header(cv, t) {
            G.frame(cv, t, ['Drive', 'Vitals', 'Track', 'Engine'], page, [usingDemo() && { text: 'DEMO' }]);
        }
        async function render() {
            const t = ctx.theme(), d = data();
            const cv = ctx.canvas(W, HGT).clear(t.bg);
            [drawDrive, drawVitals, drawTrack, drawEngine][page](cv, t, d);
            header(cv, t);
            if (!render.n) { render.n = 1; log.info('first frame drawn'); }
            await ui.image('MAIN_GFX', cv);
        }

        const go = (p) => { if (p !== page) H.reboot(); page = p; return render(); };
        ui.onClick('BTN_PAGE', () => go((page + 1) % PAGES.length));
        ui.onClick('BTN_PREV', () => go((page + PAGES.length - 1) % PAGES.length));
        ctx.onTab((i) => go(i));
        ctx.loop('MAIN', 10, render);
        settings.onChange((k) => {
            if (k === 'maxPower' || k === 'powerSource') { delete peak.power; delete demoPeak.power; }
            if (k === 'boostSource') { delete peak.boost; updBoost(); }
            if (k === 'cluster') { if (clusterOn()) cluster.start(); else { cluster.stop(); clusterShown = false; } }
            if (['theme', 'tempUnit', 'pressUnit', 'boostMax'].indexOf(k) >= 0) cluster.refresh();
            if (k === 'arm') exhaust.refresh().catch((e) => log.error('exhaust', e));
            if (k === 'tuner') exhaust.refresh().then(() => tune.refresh()).catch((e) => log.error('tune', e));
            if (k === 'page') { page = Math.max(0, PAGES.indexOf(settings.get('page'))); H.reboot(); }
        });
        log.info('first render');
        const t0 = Date.now();
        render().then(() => log.info('first frame done ' + (Date.now() - t0) + ' ms')).catch((e) => log.warn('first render: ' + e));
    },
});
