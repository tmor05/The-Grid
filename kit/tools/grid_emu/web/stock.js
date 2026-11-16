'use strict';
/**
 * stock.js (emulator page) - what BMW draws round The Grid, simplified so you can see where the
 * app's layers land: the cluster's speedometer and tachometer either side of the map area
 * (1088x480 at 416,120, as on iDrive 7), and the windshield with the stock HUD's speed under the
 * HUD scene (800x480, drawn as light: black adds nothing). Plain greys on purpose: the app's part
 * is the coloured one. No BMW marks are drawn.
 */
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const SANS = '600 {s}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const font = (s, w) => SANS.replace('{s}', s).replace('600', w || '600');

/** An arc gauge: from a0 to a1 (radians, canvas angles), f lit 0..1. */
function gauge(g, cx, cy, r, a0, a1, f, o) {
    g.lineCap = 'butt';
    g.strokeStyle = '#1c1f24'; g.lineWidth = 16;
    g.beginPath(); g.arc(cx, cy, r, a0, a1); g.stroke();
    if (o.red != null) { g.strokeStyle = '#4a1712'; g.beginPath(); g.arc(cx, cy, r, a0 + (a1 - a0) * o.red, a1); g.stroke(); }
    if (f > 0.001) {
        const grad = g.createLinearGradient(cx - r, cy, cx + r, cy);
        grad.addColorStop(0, o.lit0); grad.addColorStop(1, o.lit1);
        g.strokeStyle = grad; g.lineWidth = 16;
        g.beginPath(); g.arc(cx, cy, r, a0, a0 + (a1 - a0) * clamp(f, 0, 1)); g.stroke();
        const a = a0 + (a1 - a0) * clamp(f, 0, 1);
        g.strokeStyle = '#ffffff'; g.lineWidth = 5;
        g.beginPath(); g.moveTo(cx + Math.cos(a) * (r - 26), cy + Math.sin(a) * (r - 26)); g.lineTo(cx + Math.cos(a) * (r + 12), cy + Math.sin(a) * (r + 12)); g.stroke();
    }
    g.fillStyle = '#8b9099'; g.font = font(20, 500); g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let i = 0; i <= o.n; i++) {
        const a = a0 + (a1 - a0) * i / o.n, x = Math.cos(a), y = Math.sin(a);
        g.strokeStyle = o.redTick && i >= o.redTick ? '#c2321f' : '#6d727b'; g.lineWidth = 3;
        g.beginPath(); g.moveTo(cx + x * (r - 18), cy + y * (r - 18)); g.lineTo(cx + x * (r - 32), cy + y * (r - 32)); g.stroke();
        if (o.label) { g.fillStyle = o.redTick && i >= o.redTick ? '#d24a33' : '#9aa0aa'; g.fillText(o.label(i), cx + x * (r - 52), cy + y * (r - 52)); }
    }
}

function cluster(g, car, map, o) {
    const hu = o.hu, mph = hu.settings.get('speedUnit') === 'mph';
    g.fillStyle = '#000'; g.fillRect(0, 0, 1920, 720);
    const bg = g.createRadialGradient(960, 360, 200, 960, 360, 1100);
    bg.addColorStop(0, '#07080a'); bg.addColorStop(1, '#000');
    g.fillStyle = bg; g.fillRect(0, 0, 1920, 720);
    // speedometer (left) and tachometer (right)
    const sp = Math.abs(car.v) * 3.6 * (mph ? 0.621371 : 1), spMax = mph ? 200 : 320;
    gauge(g, 236, 392, 168, Math.PI * 0.78, Math.PI * 2.02, sp / spMax, { n: 10, label: (i) => String(i * spMax / 10), lit0: '#3b4048', lit1: '#d9dde3' });
    g.fillStyle = '#f2f4f7'; g.font = font(84, 600); g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillText(String(Math.round(sp)), 236, 410);
    g.fillStyle = '#8b9099'; g.font = font(24, 500); g.fillText(mph ? 'mph' : 'km/h', 236, 446);
    const rpm = car.rpm, red = 7200;
    gauge(g, 1684, 392, 168, Math.PI * 0.98, Math.PI * 2.22, rpm / 8000, { n: 8, red: red / 8000, redTick: 8, label: (i) => String(i), lit0: '#5a2a1a', lit1: '#ff5a1f' });
    const gear = !car.running ? '' : car.sel !== 'D' ? car.sel : car.prog === 'M' ? 'M' + car.gear : car.prog === 'S' ? 'S' + car.gear : 'D' + car.gear;
    g.fillStyle = '#f2f4f7'; g.font = font(88, 600); g.fillText(gear, 1684, 418);
    g.fillStyle = '#8b9099'; g.font = font(22, 500); g.fillText('×1000 rpm', 1684, 452);
    // the strip under the map: fuel and range, drive mode, outside air and time
    g.font = font(24, 500); g.textAlign = 'left'; g.fillStyle = '#9aa0aa';
    g.fillText('⛽', 470, 662);
    g.fillStyle = '#1c1f24'; g.fillRect(506, 648, 220, 12);
    g.fillStyle = car.fuel < 0.15 ? '#ff8a00' : '#c9ced6'; g.fillRect(506, 648, 220 * car.fuel, 12);
    g.fillStyle = '#9aa0aa'; g.fillText(Math.round(car.fuel * 340 * (mph ? 1 : 1.609)) + (mph ? ' mi' : ' km'), 740, 662);
    g.textAlign = 'center'; g.fillStyle = car.prog === 'S' || car.prog === 'M' ? '#ff6a3d' : '#c9ced6';
    g.fillText(car.running ? (car.prog === 'D' ? 'COMFORT' : 'SPORT') : 'READY', 960, 662);
    g.fillStyle = '#7d828b'; g.font = font(18, 500);
    g.fillText(car.awd === '_2WD' ? 'M xDRIVE 2WD' : car.awd === '_4WD_SPORT' ? 'M xDRIVE 4WD SPORT' : 'M xDRIVE 4WD', 960, 690);
    g.textAlign = 'right'; g.font = font(24, 500); g.fillStyle = '#9aa0aa';
    const amb = car.env.ambient, f = hu.settings.get('tempUnit') === 'F';
    g.fillText((f ? Math.round(amb * 1.8 + 32) + '°F' : Math.round(amb) + '°C') + '   ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), 1450, 662);
    // the map area: The Grid's scene, or BMW's own map view
    if (o.gridOn) g.drawImage(map, 416, 120);
    else stockMap(g, car);
    g.strokeStyle = 'rgba(120,130,145,0.18)'; g.lineWidth = 1; g.setLineDash([6, 6]);
    g.strokeRect(416.5, 120.5, 1087, 479); g.setLineDash([]);
    // the cluster's warnings sit over everything (the app can't hide them)
    if (car.oil > 140) warn(g, 'Engine oil temperature high', '#ffb000');
    if (car.coolant > 118) warn(g, 'Engine coolant temperature high', '#ff3b1f');
}
function warn(g, s, c) {
    g.fillStyle = 'rgba(0,0,0,0.85)'; g.fillRect(660, 520, 600, 70);
    g.strokeStyle = c; g.lineWidth = 2; g.strokeRect(660, 520, 600, 70);
    g.fillStyle = c; g.font = font(26, 600); g.textAlign = 'center'; g.fillText(s, 960, 565);
}
let mapRot = 0;
function stockMap(g, car) {
    g.save();
    g.beginPath(); g.rect(416, 120, 1088, 480); g.clip();
    g.fillStyle = '#0d1116'; g.fillRect(416, 120, 1088, 480);
    mapRot += car.steer * car.v * 0.0004;
    g.translate(960, 470); g.rotate(-mapRot);
    const off = (car.dist * 1.2) % 160;
    g.strokeStyle = '#1e252e'; g.lineWidth = 26;
    for (let i = -6; i <= 6; i++) { g.beginPath(); g.moveTo(-1200, i * 160 + off); g.lineTo(1200, i * 160 + off); g.stroke(); }
    for (let i = -8; i <= 8; i++) { g.beginPath(); g.moveTo(i * 210, -1200); g.lineTo(i * 210, 1200); g.stroke(); }
    g.strokeStyle = '#3d7bd9'; g.lineWidth = 14;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -900); g.stroke();
    g.restore();
    g.fillStyle = '#e8ecf2'; g.beginPath(); g.moveTo(960, 452); g.lineTo(976, 492); g.lineTo(960, 482); g.lineTo(944, 492); g.closePath(); g.fill();
    g.fillStyle = '#6f7680'; g.font = font(18, 500); g.textAlign = 'center'; g.fillText("BMW's map view (stock)", 960, 150);
}

/* ---------- the windshield and the HUD ---------- */
let roadPhase = 0, lastDist = 0;
function hud(g, car, scene, o) {
    const W = 1600, H = 560, hy = 210;
    const sky = g.createLinearGradient(0, 0, 0, hy);
    sky.addColorStop(0, '#05070c'); sky.addColorStop(1, '#141b26');
    g.fillStyle = sky; g.fillRect(0, 0, W, hy);
    const ground = g.createLinearGradient(0, hy, 0, H);
    ground.addColorStop(0, '#0d1014'); ground.addColorStop(1, '#050607');
    g.fillStyle = ground; g.fillRect(0, hy, W, H - hy);
    // the road, bending with the steering, its dashes running with the distance driven
    const bend = car.steer * 260 * clamp(Math.abs(car.v) / 20, 0, 1);
    const vx = W / 2 + bend;
    g.fillStyle = '#16191e';
    g.beginPath(); g.moveTo(vx - 30, hy); g.lineTo(vx + 30, hy); g.quadraticCurveTo(W / 2 + bend * 0.3 + 300, hy + 160, W / 2 + 820, H); g.lineTo(W / 2 - 820, H); g.quadraticCurveTo(W / 2 + bend * 0.3 - 300, hy + 160, vx - 30, hy); g.fill();
    roadPhase = (roadPhase + (car.dist - lastDist) / 9) % 1; lastDist = car.dist;
    g.fillStyle = '#c7ccd3';
    for (let k = 0; k < 14; k++) {
        const z = (k + 1 - roadPhase) * 0.7, y = hy + 300 / z;
        if (y > H || y < hy + 3) continue;
        const f = (y - hy) / (H - hy), x = vx + (W / 2 - vx) * f * 1.0 + bend * 0.3 * f * (1 - f) * 4 * 0;
        const w = 2 + 10 * f, h = 3 + 34 * f * f;
        g.globalAlpha = clamp(f * 1.6, 0, 0.9);
        g.fillRect(x - w / 2, y, w, h);
    }
    g.globalAlpha = 1;
    // the hood's edge and the A-pillars
    g.fillStyle = '#020203';
    g.beginPath(); g.moveTo(0, H); g.lineTo(0, H - 40); g.quadraticCurveTo(W / 2, H - 92, W, H - 40); g.lineTo(W, H); g.fill();
    g.beginPath(); g.moveTo(0, 0); g.lineTo(90, 0); g.lineTo(0, 420); g.fill();
    g.beginPath(); g.moveTo(W, 0); g.lineTo(W - 90, 0); g.lineTo(W, 420); g.fill();
    // the HUD's field: the scene as light, then BMW's own speed under it
    const sx = 400, sy = 24;
    g.globalCompositeOperation = 'lighter';
    if (o.gridOn) g.drawImage(scene, sx, sy, 800, 480);
    g.globalCompositeOperation = 'source-over';
    g.strokeStyle = 'rgba(160,170,185,0.10)'; g.setLineDash([5, 7]); g.lineWidth = 1;
    g.strokeRect(sx + 0.5, sy + 0.5, 799, 479); g.setLineDash([]);
    const mph = o.hu.settings.get('speedUnit') === 'mph';
    const sp = Math.round(Math.abs(car.v) * 3.6 * (mph ? 0.621371 : 1));
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = 'rgba(236,242,246,0.92)'; g.font = font(54, 600); g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillText(String(sp), 800, 478);
    g.fillStyle = 'rgba(200,208,216,0.75)'; g.font = font(18, 500); g.fillText(mph ? 'mph' : 'km/h', 800, 500);
    // a speed-limit sign, as BMW's HUD shows one
    g.strokeStyle = 'rgba(230,60,50,0.9)'; g.lineWidth = 5; g.beginPath(); g.arc(680, 462, 26, 0, TAU); g.stroke();
    g.fillStyle = 'rgba(236,242,246,0.9)'; g.font = font(24, 700); g.fillText(mph ? '55' : '90', 680, 471);
    g.globalCompositeOperation = 'source-over';
}

module.exports = { cluster, hud };
