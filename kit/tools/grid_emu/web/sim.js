'use strict';
/**
 * sim.js (emulator page) - the car the app talks to: a 2021 X4 M Competition (G02, S58, ZF 8HP,
 * M xDrive) driven from the page, sending what the app subscribes to in the car's own formats
 * (raw SOME/IP values, scaled as app.json config.scaling says), and a simulated DME / gearbox /
 * transfer case answering the app's diagnostic requests (UDS over InternalTasu) the way the S58
 * does as far as the project knows it (car-apps issue #3, The Grid's tests): the F4xx PIDs and
 * BMW DIDs in config.dme, OBD service 01 and 06, the regulated exhaust flap 611E / 651E, MHD's
 * short 2F controls (map, Max Cooling, flap).
 *
 * Everything here is a model: the numbers are plausible, not your car's.
 */

const G0 = 9.80665;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, f) => a + (b - a) * f;
const approach = (v, target, rate, dt) => v + (target - v) * (1 - Math.exp(-rate * dt));

/* ---------- the car ---------- */
const P = {
    mass: 2050, rw: 0.373, fd: 3.154, eff: 0.9,
    ratios: [5.0, 3.2, 2.143, 1.72, 1.313, 1.0, 0.823, 0.64], rev: 3.478,
    idle: 720, red: 7200, limiter: 7300,
    cda: 0.92, crr: 0.013, inertia: 0.24,
};
/** Simulated MHD maps (boost target in bar, a label for the panel): your real ones live in MHD. */
const MAPS = [
    { boost: 1.70, label: 'stock-ish boost' },
    { boost: 1.95, label: 'more boost' },
    { boost: 2.15, label: 'flex fuel, high boost' },
    { boost: 0.75, label: 'valet / low boost' },
];
/** Naturally aspirated torque shape (Nm) the boost multiplies. */
function tqBase(rpm) {
    const r = rpm / 1000;
    const shape = r < 1 ? 0.55 * r : r < 4.5 ? 0.55 + 0.45 * Math.sin((r - 1) / 3.5 * Math.PI / 2) : 1 - 0.035 * (r - 4.5) * (r - 4.5);
    return 238 * clamp(shape, 0.3, 1);
}
/** How much of the boost target the turbos can make at this rpm. */
const spool = (rpm) => clamp((rpm - 1150) / 1650, 0, 1) * (rpm > 6200 ? 1 - (rpm - 6200) / 9000 : 1);

class Car {
    constructor() {
        this.t = 0;
        this.env = { ambient: 16, ethanol: 30, flex: true, linkUp: true, map: 1, mhd: true, mhdFlap: true, misfireCyl: 0, hotOil: false };
        this.reset(true);
    }

    /** Engine off at the outside temperature (cold), or warmed up. */
    reset(cold) {
        const a = this.env.ambient;
        Object.assign(this, {
            running: false, rpm: 0, v: 0, a: 0, gear: 1, sel: 'P', prog: 'D', shiftT: 0, cutT: 0,
            throttle: 0, brake: 0, steer: 0, boost: 0, torque: 0, launch: 0,
            coolant: cold ? a : 96, oil: cold ? a : 102, trans: cold ? a : 80, iat: a + 3,
            tyreT: [a, a, a, a], awd: '_4WD_STANDARD', rearPct: 100, cooling: false,
            flapOpen: 0, flapCmd: null, mhdFlapCmd: null, misfires: [0, 0, 0, 0, 0, 0], misAvg: [0, 0, 0, 0, 0, 0],
            dist: 0, knock: 0, fuel: 0.72,
        });
    }

    /** A car held still (stills): what was commanded is where it is. */
    settle() {
        if (this.mhdFlapCmd != null) this.flapOpen = this.mhdFlapCmd;
        else if (this.flapCmd) this.flapOpen = this.flapCmd.open;
    }
    /** Crank torque (Nm) the model makes at rpm on boost (bar), full throttle. */
    static torqueAt(rpm, boost) { return tqBase(rpm) * Math.max(0.2, 1 + boost); }

    startEngine() { if (this.running) return; this.running = true; this.rpm = 1350; this.crankT = 1.2; }
    stopEngine() { this.running = false; this.sel = 'P'; }

    /** Gear selector: 'P' | 'R' | 'N' | 'D'. D from D toggles S. */
    select(s) {
        if (s === 'D' && this.sel === 'D' && this.prog !== 'M') { this.prog = this.prog === 'S' ? 'D' : 'S'; return; }
        if ((s === 'R' || s === 'P') && this.v > 1.5) return;          // the gearbox refuses at speed
        this.sel = s;
        if (s === 'D') { this.prog = this.prog === 'M' ? 'M' : this.prog; this.gear = Math.max(1, this.bestGear(this.prog === 'S' ? 'S' : 'D')); }
        if (s === 'R') this.gear = 1;
    }
    manual(on) { if (this.sel !== 'D') this.select('D'); this.prog = on ? 'M' : 'D'; }
    /** Paddle: +1 up, -1 down. In D it drops into M for a moment as BMW's does (kept here). */
    paddle(d) {
        if (this.sel !== 'D') return;
        if (this.prog !== 'M') this.prog = 'M';
        const g = clamp(this.gear + d, 1, 8);
        if (d < 0 && this.rpmAt(g) > P.red - 150) return;              // a downshift that would over-rev is refused
        if (g !== this.gear) { this.gear = g; this.shiftT = 0.12; }
    }

    rpmAt(g) { return this.v / P.rw * P.ratios[g - 1] * P.fd * 60 / (2 * Math.PI); }
    bestGear(mode) {
        for (let g = 1; g <= 8; g++) if (this.rpmAt(g) < (mode === 'S' ? 4200 : 2600)) return g;
        return 8;
    }

    step(dt) {
        this.t += dt;
        const e = this.env, mp = MAPS[clamp(e.map, 1, 4) - 1];
        const th = this.running ? this.throttle : 0;
        // shifting automatically (D / S); M holds the gear
        if (this.running && this.sel === 'D' && this.shiftT <= 0) {
            const s = this.prog === 'S';
            const up = s ? lerp(3200, P.red - 150, Math.pow(th, 0.9)) : lerp(1900, P.red - 250, Math.pow(th, 1.25));
            const down = s ? lerp(1900, 4600, th) : lerp(1150, 3400, th * th);
            if (this.prog !== 'M') {
                if (this.rpm > up && this.gear < 8 && this.rpmAt(this.gear + 1) > 1100) { this.gear++; this.shiftT = 0.14; this.cutT = th > 0.5 ? 0.09 : 0.03; }
                else if (this.gear > 1 && this.rpmAt(this.gear) < down && this.rpmAt(this.gear - 1) < up - 300) { this.gear--; this.shiftT = 0.18; }
            } else if (this.gear > 1 && this.rpmAt(this.gear) < 900) { this.gear--; this.shiftT = 0.18; }
        }
        this.shiftT = Math.max(0, this.shiftT - dt);
        this.cutT = Math.max(0, this.cutT - dt);

        // engine speed: in gear it follows the wheels (the converter slips at launch), else it revs free
        const inGear = this.running && (this.sel === 'D' || this.sel === 'R');
        const ratio = this.sel === 'R' ? P.rev : P.ratios[this.gear - 1];
        const kin = this.v / P.rw * ratio * P.fd * 60 / (2 * Math.PI);
        const stall = P.idle + th * 2300 + th * this.boost * 200;
        let rpm;
        if (!this.running) rpm = approach(this.rpm, 0, 6, dt);
        else if (!inGear) {
            const target = th > 0.02 ? lerp(P.idle, P.limiter, Math.pow(th, 1.3)) : P.idle;
            rpm = approach(this.rpm, target, th > this.rpm / P.limiter ? 5.5 : 3.2, dt);
        } else {
            const lock = this.gear > 1 || kin > stall ? 1 : clamp(kin / Math.max(1, stall), 0, 1);
            const free = Math.max(stall, P.idle);
            rpm = approach(this.rpm, lock >= 1 ? Math.max(kin, P.idle * 0.95) : Math.max(kin, free), this.shiftT > 0 ? 9 : 14, dt);
        }
        if (this.crankT > 0) { this.crankT -= dt; rpm = Math.max(rpm, lerp(P.idle, 1350, clamp(this.crankT, 0, 1))); }
        const limited = rpm >= P.limiter;
        this.rpm = clamp(rpm, 0, P.limiter + 40);

        // boost: the target from the map, throttle and spool; vacuum off throttle
        const tgt = this.running ? (th > 0.04 ? mp.boost * Math.pow(th, 0.85) * spool(this.rpm) - 0.55 * (1 - th) * (1 - spool(this.rpm)) : (this.rpm > 1100 ? -0.78 : -0.62)) : 0;
        this.boostTarget = tgt;
        this.boost = approach(this.boost, tgt, tgt > this.boost ? 3.4 : 7, dt);
        // torque at the crank: base x charge, timing pulled when hot / knocking, cut while shifting or on the limiter
        const charge = clamp(1 + this.boost, 0.2, 3.4);
        const heatPull = clamp((this.iat - 45) / 60, 0, 0.12) + clamp((this.oil - 135) / 40, 0, 0.2);
        // off throttle: idle creep through the converter near idle, engine braking above it
        const offTq = inGear && kin < P.idle * 1.15 ? 32 : -(35 + this.rpm / 200);
        let tq = this.running ? (th > 0.02 ? tqBase(this.rpm) * charge * (1 - heatPull) : offTq) : 0;
        if (this.cutT > 0 || limited) tq = Math.min(tq, 20);
        this.torque = tq;
        this.power = Math.max(0, tq) * this.rpm / 9549;

        // longitudinal: drive force (traction limited), drag, rolling, brakes
        const grip = (this.awd === '_2WD' ? 0.86 : 1.02) * G0 * P.mass;
        let fDrive = 0;
        if (inGear && this.shiftT < 0.08) {
            const mult = this.gear === 1 && kin < stall ? 1 + 0.7 * (1 - clamp(kin / stall, 0, 1)) : 1;
            fDrive = tq * ratio * P.fd * P.eff * mult / P.rw * (this.sel === 'R' ? -1 : 1);
        }
        fDrive = clamp(fDrive, -grip, grip);
        const dir = Math.sign(this.v) || 0;
        const fRes = dir * (P.cda * this.v * this.v + P.crr * P.mass * G0) + (this.sel === 'P' ? this.v * 4000 : 0);
        const fBrake = this.brake * 1.12 * G0 * P.mass * (Math.abs(this.v) > 0.05 ? dir : 0);
        let acc = (fDrive - fRes - fBrake) / P.mass;
        if (Math.abs(this.v) < 0.15 && Math.abs(fDrive) < Math.abs(fRes) + Math.abs(this.brake * 5000) + 260) { acc = 0; this.v = 0; }
        this.a = acc;
        this.v = clamp(this.v + acc * dt, -12, 85);
        this.dist += Math.abs(this.v) * dt;

        // cornering: lateral g from the steering and the speed, limited by the tyres
        const latWant = this.steer * this.v * this.v / 38;
        this.gLat = clamp(latWant / G0, -1.12, 1.12);
        this.gLong = acc / G0;

        // M xDrive split: rear-biased, more to the front under hard acceleration (4WD), Sport keeps the rear
        const pull = clamp(this.gLong / 0.6, 0, 1);
        const rearTarget = this.awd === '_2WD' ? 100 : this.awd === '_4WD_SPORT' ? 100 - 22 * pull : 100 - 42 * pull - (this.v < 8 ? 6 * th : 0);
        this.rearPct = approach(this.rearPct, rearTarget, 4, dt);

        // temperatures: coolant held by the thermostat, oil and the gearbox lag, intake heat-soaks when slow
        const load = this.running ? clamp(this.power / 420, 0, 1) : 0;
        const warm = this.running ? 0.012 + 0.05 * load + 0.004 * this.rpm / 1000 : 0;
        const cTarget = this.cooling ? 86 : 100 + 12 * load;
        this.coolant += this.running ? (this.coolant < cTarget ? warm * 9 : -(this.coolant - cTarget) * 0.08) * dt * 6 : -(this.coolant - e.ambient) * 0.0006 * dt * 6;
        const oTarget = (this.env.hotOil ? 138 : 104) + 26 * load;
        this.oil += this.running ? (this.oil < oTarget ? warm * 5 + 0.04 * load : -(this.oil - oTarget) * 0.02) * dt * 6 : -(this.oil - e.ambient) * 0.0004 * dt * 6;
        const tTarget = 78 + 30 * load;
        this.trans += (this.running ? (this.trans < tTarget ? warm * 3.2 : -(this.trans - tTarget) * 0.015) : -(this.trans - e.ambient) * 0.0004) * dt * 6;
        const iTarget = e.ambient + 6 + Math.max(0, this.boost) * 9 + (this.v < 4 && this.running ? 14 : 0) - clamp(this.v / 30, 0, 1) * 4;
        this.iat = approach(this.iat, iTarget, this.boost > 0.5 ? 0.25 : 0.06, dt);
        // tyres: heat from speed and cornering, cool toward the air
        for (let i = 0; i < 4; i++) {
            const work = Math.abs(this.gLat) * (i % 2 === (this.gLat > 0 ? 0 : 1) ? 1.3 : 0.8) + Math.abs(this.gLong) * (i < 2 ? 0.6 : 1) * 0.8 + this.v / 60;
            const tT = e.ambient + 12 + work * 32;
            this.tyreT[i] = approach(this.tyreT[i], tT, 0.012, dt);
        }
        // exhaust flap (how far open, 0..100): the DME's own choice (open with load in Sport), or what was commanded
        const own = this.prog === 'S' || this.prog === 'M' ? (load > 0.15 || this.rpm > 3500 ? 100 : 30) : load > 0.5 ? 100 : 0;
        const want = this.mhdFlapCmd != null ? this.mhdFlapCmd : this.flapCmd != null && this.flapCmd.until > this.t && this.v < 1 ? this.flapCmd.open : own;
        if (this.flapCmd && (this.flapCmd.until <= this.t || this.v >= 1)) this.flapCmd = null;      // BMW's job ends after ~20 s or once moving
        this.flapOpen = approach(this.flapOpen, want, 6, dt);
        // misfires: none, unless the page asks for one on a cylinder
        if (e.misfireCyl && this.running && Math.random() < dt * (0.4 + load * 3)) this.misfires[e.misfireCyl - 1]++;
        this.knock = approach(this.knock, this.boost > 1.6 && e.ethanol < 15 ? 2.5 : 0, 0.5, dt);
        this.fuel = Math.max(0.05, this.fuel - this.power * dt * 2.2e-7);
    }

    /* ---- what the DME's values read ---- */
    get hpfp() { return this.running ? 52 + 290 * clamp(this.torque / 700, 0, 1) + 6 * Math.sin(this.t * 3) : 4; }   // bar
    get lpfp() { return this.running ? 5.6 - 0.8 * clamp(this.torque / 700, 0, 1) + 0.05 * Math.sin(this.t * 2) : 4.9; }
    get timing() { return this.running ? (this.throttle < 0.05 ? 14 + 2 * Math.sin(this.t) : clamp(36 - 9 * Math.max(0, this.boost) - this.knock * 2, 2, 40)) : 0; }
    get load() { return this.running ? clamp(16 + 52 * (1 + this.boost) * this.throttle, 12, 190) : 0; }
}

/* ---------- the car's signals, raw as the car sends them ---------- */
/** feed(iface, field, value) for every subscribed field; cfg = app.json config.scaling */
function signals(car, feed, cfg) {
    const S = cfg || {};
    const raw = (k, v) => Math.round((v - ((S[k] && S[k].offset) || 0)) / ((S[k] && S[k].factor) || 1));
    let n = 0;
    return () => {
        n++;
        const c = car;
        const gear = !c.running || c.sel === 'P' || c.sel === 'N' ? 'N_OR_P' : c.sel === 'R' ? 'R' : 'G' + c.gear;
        if (c.running || n % 5 === 0) {
            feed('de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: raw('rpm', c.rpm) });
            feed('de.bmw.infotainment.vehicle.Vehicle2', 'statusCarSpeed2', { speedVehicleCentreOfGravity: raw('speed', Math.abs(c.v) * 3.6) });
            feed('de.bmw.infotainment.vehicle.CDS2', 'statusLongitudinalAccelerationMassCenter', { longitudinalAccelerationCentreOfGravity: raw('accel', c.gLong * G0) });
            feed('de.bmw.infotainment.vehicle.CDS2', 'statusLateralAccelerationMassCenter', { lateralAccelerationCentreOfGravity: raw('accel', c.gLat * G0) });
            feed('de.bmw.infotainment.drivingexcitement.FES', 'statusActualValueTorque2', { actualValueTorqueCrankshaft: raw('torque', c.torque) });
            feed('de.bmw.infotainment.drivingexcitement.FES', 'statusSwitchDriveDynamicSport2', { displayBoostPressure: Math.round(Math.max(-0.99, c.boost) * 100), displayLateralAcceleration: 0, displayLongitudinalAcceleration: 0 });
            feed('de.bmw.infotainment.drivingexcitement.FES', 'statusVehicleDynamicEngine', { displaySportEnginePower: Math.round(clamp(c.power / 375, 0, 1.6) * 100), displaySportEngineTorque: Math.round(clamp(Math.max(0, c.torque) / 600, 0, 1.6) * 100) });
            const prog = c.sel !== 'D' ? 'NOT_ACTIVE' : c.prog === 'M' ? 'MANUELL' : c.prog === 'S' ? 'SPORT' : 'DRIVE';
            feed('de.bmw.infrastructure.VehicleInformation', 'statusGearboxDrive', { statusActualGearDrive: gear, statusActualStageDrive: c.running ? c.sel : 'P', statusGearProgramDrive: prog });
            feed('de.bmw.infotainment.misc.MDrive', 'dataDisplayGearbox', { displayProgramGearbox: c.sel !== 'D' ? 'KEIN_PROGRAMM' : c.prog === 'M' ? 'M_MINUS_PROGRAMM' : c.prog === 'S' ? 'S_MINUS_PROGRAMM' : 'D_PROGRAMM' });
        }
        if (n % 10 === 1) {
            feed('de.bmw.infotainment.vehicle.CDS', 'statusEngineTemperature', { temperatureEngineDrive: raw('engineTemp', c.coolant), temperatureEngineOilDrive: raw('engineTemp', c.oil) });
            feed('de.bmw.infrastructure.analytics.BasicDataSet', 'basicDataSet', {
                valueTemperatureTransmissionOil: raw('gearboxTemp', c.trans),
                valueDistributionLongitudinalTorqueRearAxisFrontAxis: raw('torqueSplitRear', c.rearPct),
                qualifierValueDistributionLongitudinalTorqueRearAxisFrontAxis: 'SIGNALWERT_IST_GUELTIG',
            });
            feed('de.bmw.infrastructure.EnvironmentalInformation', 'ExteriorTemperature', { temperatureExterior: raw('ambient', c.env.ambient) });
            feed('de.bmw.infotainment.misc.MDrive', 'statusMSystem', { statusAllWheelSetup: c.awd, qualifierFunctionAllWheel: 'FUNKTION_VERFUEGBAR_AKTIV' });
            feed('de.bmw.infotainment.vehicle.Vehicle2', 'statusVehiclePartType', { typeEngine: 'BENZIN_DIREKTEINSPRITZUNG' });
            feed('de.bmw.infotainment.vehicle.Vehicle', 'statusNewCurrentUnitsStatusExt', { unitOfMeasurementAirPressure: 3, unitOfMeasurementTemperature: 2 });
        }
        if (n % 50 === 2) {
            // TPMS in the car's units (psi x 10, deg F + 40), targets front 2.5 / rear 2.7 bar cold
            const tF = (cdeg) => Math.round(cdeg * 9 / 5 + 32 + 40);
            const press = (i) => { const cold = i < 2 ? 2.5 : 2.7; return cold * (1 + (c.tyreT[i] - c.env.ambient) / 290) * 14.5038; };
            feed('de.bmw.infotainment.vehicle.TPMS', 'statusTyrePressure', { actualValuePressureTyreFLH: Math.round(press(0) * 10), actualValuePressureTyreFRH: Math.round(press(1) * 10), actualValuePressureTyreRLH: Math.round(press(2) * 10), actualValuePressureTyreRRH: Math.round(press(3) * 10) });
            feed('de.bmw.infotainment.vehicle.TPMS', 'statusTargetTyrePressure', { targetPressureTyreFLH: 363, targetPressureTyreFRH: 363, targetPressureTyreRLH: 392, targetPressureTyreRRH: 392 });
            feed('de.bmw.infotainment.vehicle.TPMS', 'statusTyreTemperature', { actualValueTemperatureTyreFLH: tF(c.tyreT[0]), actualValueTemperatureTyreFRH: tF(c.tyreT[1]), actualValueTemperatureTyreRLH: tF(c.tyreT[2]), actualValueTemperatureTyreRRH: tF(c.tyreT[3]) });
            // the KOMBI's tank and range: litres in the 65 l tank, km at ~10.7 l/100 km
            feed('de.bmw.infotainment.KombiIF', 'statusRangeTankStatus', { fluidLevelFuelTank: Math.round(c.fuel * 65), fluidLevelFuelTankLeftHand: Math.round(c.fuel * 32), fluidLevelFuelTankRightHand: Math.round(c.fuel * 33), range: Math.round(c.fuel * 65 / 10.7 * 100), mileageKilometre: 23817 + Math.round(c.dist / 1000) });
        }
    };
}

/* ---------- the DME (0x12), the gearbox (0x18) and the transfer case (0x19) ---------- */
const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const nrc = (sid, code) => [0x7F, sid, code];
/** Encode value v for a config.dme candidate (the inverse of kit/dids.js read()). */
function encode(c, v) {
    let raw = Math.round((v - (c.offset || 0)) / (c.factor == null ? 1 : c.factor));
    const n = c.bytes || 1, max = Math.pow(256, n) - 1;
    if (raw < 0) raw = c.signed ? raw + Math.pow(2, 8 * n) : 0;
    raw = clamp(raw, 0, max);
    const out = new Array((c.at || 0) + n).fill(0);
    for (let i = n - 1; i >= 0; i--) { out[(c.at || 0) + i] = raw & 0xff; raw = Math.floor(raw / 256); }
    return out;
}

/**
 * dme(car, dmeCfg, xdriveCfg, log) -> (target, sid, data) => reply bytes | null
 * log(entry): every request that changes something on a car (0x2F, 0x31, 0x2E) and what it answered,
 * for the page's "sent to the car" list.
 */
function ecus(car, dmeCfg, xCfg, onWrite) {
    const dme = dmeCfg || {}, xd = xCfg || {};
    const kpaAbs = (bar) => 101.3 + bar * 100;
    // the engine values the config's candidates read, in its own units
    const values = () => ({
        iat: car.iat, hpfp: car.hpfp, lpfp: car.lpfp, oil: car.oil, timing: car.timing,
        boost: kpaAbs(car.boost), baro: 101.3, boostTarget: kpaAbs(car.boostTarget || 0), boostActual: kpaAbs(car.boost),
        loadTarget: car.load * 1.03, loadActual: car.load, ethanol: car.env.flex ? car.env.ethanol : null,
    });
    // DID -> [candidate, key], first candidate per DID (they are tried in order)
    const byDid = {}, byPid = {};
    Object.keys(dme).forEach((k) => {
        if (!Array.isArray(dme[k])) return;
        dme[k].forEach((c) => {
            if (c.ecu != null && c.ecu !== 18) return;
            if (c.did && !byDid[c.did.toUpperCase()]) byDid[c.did.toUpperCase()] = [c, k];
            if (c.obd && !byPid[c.obd.toUpperCase()]) byPid[c.obd.toUpperCase()] = [c, k];
        });
    });
    const egs = (dme.egs || []).filter((c) => c.ecu === 24);
    const note = (o) => { if (onWrite) onWrite(o); };

    return (target, sid, data) => {
        if (!car.env.linkUp) return null;
        if (target === 0x12) return dmeReply(sid, data);
        if (target === 0x18) {
            if (sid === 0x22 && data.length >= 2) {
                const did = hex2(data[0]) + hex2(data[1]), c = egs.find((x) => x.did.toUpperCase() === did);
                if (c) return [0x62, data[0], data[1]].concat(encode(c, car.trans));
                return nrc(0x22, 0x31);
            }
            return nrc(sid, 0x11);
        }
        if (target === 0x19) {
            if (sid === 0x22 && data[0] === 0xDB && data[1] === 0x32) {
                // LMV_MOMENT: front axle torque (Nm x 4), qualifier, target
                const ratio = P.ratios[car.gear - 1] || 1, front = Math.max(0, car.torque) * ratio * (100 - car.rearPct) / 100;
                const r = Math.round(front * 4) & 0xffff;
                return [0x62, 0xDB, 0x32, r >> 8, r & 0xff, 0x00, 0x02, r >> 8, r & 0xff];
            }
            return nrc(sid, 0x31);
        }
        return null;                                // nobody at that address
    };

    function dmeReply(sid, d) {
        const v = values();
        if (sid === 0x22) {
            const did = hex2(d[0]) + hex2(d[1]);
            if (did === 'F150') return [0x62, 0xF1, 0x50, 0x00, 0x00, 0x86, 0x10];
            if (did === 'F190') return [0x62, 0xF1, 0x90].concat(Array.from('EMULATED00S58G02').map((ch) => ch.charCodeAt(0)), [0x30]);
            if (did === 'F191') return [0x62, 0xF1, 0x91, 0x00, 0x00, 0x15, 0x86, 0x01, 0x00];
            if (did === 'F195') return [0x62, 0xF1, 0x95, 0x00, 0x26, 0x07, 0x01, 0x00];
            if (did === '62FD' || did === '64FD') return [0x62, d[0], d[1], 0x00, 0x00];          // the plain flap channel: S58 reads 00 00
            // the regulated flap's position, both banks: % as its argument counts it (10 = open, 90 = closed) x 81.92
            if (did === '651E') { const r = Math.round((100 - car.flapOpen) * 81.92); return [0x62, 0x65, 0x1E, r >> 8, r & 0xff, r >> 8, r & 0xff]; }
            if (/^F6A[0-9A-F]$/.test(did)) return nrc(0x22, 0x31);                              // misfires over service 06 only
            const hit = byDid[did];
            if (!hit) return nrc(0x22, 0x31);
            const val = v[hit[1]];
            if (val == null) return nrc(0x22, 0x31);                                             // no flex fuel sensor: the DME has no ethanol PID
            return [0x62, d[0], d[1]].concat(encode(hit[0], val));
        }
        if (sid === 0x01) {
            const pid = hex2(d[0]), hit = byPid[pid];
            if (!hit || v[hit[1]] == null) return nrc(0x01, 0x31);
            return [0x41, d[0]].concat(encode(hit[0], v[hit[1]]));
        }
        if (sid === 0x06) {
            const mid = d[0];
            if (mid === 0xA0) return [0x46, 0xA0, 0xFE, 0x00, 0x00, 0x01];                    // A1..A7: general + 6 cylinders
            if (mid >= 0xA2 && mid <= 0xA7) {
                const cyl = mid - 0xA2, now = car.misfires[cyl], avg = Math.round(car.misAvg[cyl]);
                const rec = (tid, val) => [mid, tid, 0x24, val >> 8, val & 0xff, 0x00, 0x00, 0xFF, 0xFF];
                return [0x46].concat(rec(0x0B, avg), rec(0x0C, now));
            }
            return nrc(0x06, 0x31);
        }
        if (sid === 0x2F) {
            const req = '2F ' + d.map(hex2).join(' ');
            // MHD's own short controls: 01 map, 02 flap, 03 Max Cooling (only on an MHD flash)
            if (d.length === 2 && d[0] <= 0x03) {
                if (!car.env.mhd) { note({ req, reply: '7F 2F 13', what: 'refused: not an MHD flash' }); return nrc(0x2F, 0x13); }
                if (d[0] === 0x01 && d[1] <= 3) { car.env.map = d[1] + 1; note({ req, reply: '6F 01 ' + hex2(d[1]), what: 'MHD: engine map ' + (d[1] + 1) }); return [0x6F, 0x01, d[1]]; }
                if (d[0] === 0x03) {
                    if (car.rpm < 500) { note({ req, reply: '7F 2F 22', what: 'Max Cooling refused: engine off' }); return nrc(0x2F, 0x22); }
                    car.cooling = !!d[1]; note({ req, reply: '6F 03 ' + hex2(d[1]), what: 'MHD: Max Cooling ' + (d[1] ? 'on' : 'off') }); return [0x6F, 0x03, d[1]];
                }
                if (d[0] === 0x02) {
                    if (!car.env.mhdFlap) { note({ req, reply: '7F 2F 13', what: 'refused: this flash has no MHD flap control' }); return nrc(0x2F, 0x13); }
                    car.mhdFlapCmd = d[1] === 1 ? 100 : d[1] === 2 ? 0 : null;
                    note({ req, reply: '6F 02 ' + hex2(d[1]), what: 'MHD: exhaust flap ' + (d[1] === 1 ? 'open' : d[1] === 2 ? 'closed' : 'to the DME') });
                    return [0x6F, 0x02, d[1]];
                }
            }
            if (d[0] === 0x60 && d[1] === 0xFD) { note({ req, reply: '7F 2F 22', what: 'plain flap job refused (S58 has the regulated flap)' }); return nrc(0x2F, 0x22); }
            if (d[0] === 0x61 && d[1] === 0x1E) {
                if (car.v >= 1) { note({ req, reply: '7F 2F 22', what: 'flap job refused: car moving' }); return nrc(0x2F, 0x22); }
                if (d[2] === 0x03 && d.length >= 5) {
                    const pct = Math.round(((d[3] << 8) | d[4]) / 81.92);
                    car.flapCmd = { open: 100 - pct, until: car.t + 20 };
                    note({ req, reply: '6F 61 1E 03', what: 'BMW regulated flap to ' + pct + ' % (' + (pct <= 20 ? 'open' : pct >= 80 ? 'closed' : 'part open') + '; the DME ends it after ~20 s or when the car moves)' });
                    return [0x6F, 0x61, 0x1E, 0x03];
                }
                if (d[2] === 0x00) { car.flapCmd = null; note({ req, reply: '6F 61 1E 00', what: 'flap back to the DME' }); return [0x6F, 0x61, 0x1E, 0x00]; }
            }
            note({ req, reply: '7F 2F 31', what: 'refused: unknown control' });
            return nrc(0x2F, 0x31);
        }
        if (sid === 0x2E || sid === 0x31) { note({ req: hex2(sid) + ' ' + d.map(hex2).join(' '), reply: '7F ' + hex2(sid) + ' 33', what: 'refused (security access)' }); return nrc(sid, 0x33); }
        if (sid === 0x10) return [0x50, d[0] || 1, 0x00, 0x32, 0x01, 0xF4];
        if (sid === 0x3E) return [0x7E, 0x00];
        return nrc(sid, 0x11);
    }
}

module.exports = { Car, MAPS, P, signals, ecus };
