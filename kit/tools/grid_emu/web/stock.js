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

/** An arc gauge: from a0 to a1 (radians, canvas angles; o.ccw: anticlockwise), f lit 0..1. */
function gauge(g, cx, cy, r, a0, a1, f, o) {
    const ccw = !!o.ccw, at = (k) => a0 + (a1 - a0) * k;
    g.lineCap = 'butt';
    g.strokeStyle = '#1c1f24'; g.lineWidth = 16;
    g.beginPath(); g.arc(cx, cy, r, a0, a1, ccw); g.stroke();
    if (o.red != null) { g.strokeStyle = '#4a1712'; g.beginPath(); g.arc(cx, cy, r, at(o.red), a1, ccw); g.stroke(); }
    if (f > 0.001) {
        const grad = g.createLinearGradient(cx - r, cy, cx + r, cy);
        grad.addColorStop(0, o.lit0); grad.addColorStop(1, o.lit1);
        g.strokeStyle = grad; g.lineWidth = 16;
        g.beginPath(); g.arc(cx, cy, r, a0, at(clamp(f, 0, 1)), ccw); g.stroke();
    }
    // the needle (BMW's rests at the bottom of each dial)
    const a = at(clamp(f, 0, 1));
    g.strokeStyle = '#ff5a2a'; g.lineWidth = 5;
    g.beginPath(); g.moveTo(cx + Math.cos(a) * (r - 120), cy + Math.sin(a) * (r - 120)); g.lineTo(cx + Math.cos(a) * (r + 12), cy + Math.sin(a) * (r + 12)); g.stroke();
    g.fillStyle = '#8b9099'; g.font = font(26, 600); g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let i = 0; i <= o.n; i++) {
        const ai = at(i / o.n), x = Math.cos(ai), y = Math.sin(ai);
        g.strokeStyle = o.redTick && i >= o.redTick ? '#c2321f' : '#6d727b'; g.lineWidth = 3;
        g.beginPath(); g.moveTo(cx + x * (r - 18), cy + y * (r - 18)); g.lineTo(cx + x * (r - 32), cy + y * (r - 32)); g.stroke();
        if (o.label) { g.fillStyle = o.redTick && i >= o.redTick ? '#d24a33' : '#c6cbd3'; g.fillText(o.label(i), cx + x * (r - 56), cy + y * (r - 56)); }
    }
    g.textBaseline = 'alphabetic';
}

/**
 * The cluster as it is on the car (G02 X4 M, iDrive 7, Sport layout; laid out from a photo of
 * Tyson's cluster): big speedometer and tach whose faces reach over the middle, BMW's digital
 * speed and gear drawn over the map area, and the strip along the bottom (fuel, range, clock,
 * street, outside air) with the speed-limit sign in the speedometer's foot.
 *
 * Stacking, as the KOMBI does it: the map area (slot 0x100: BMW's map, or The Grid's middle) is
 * UNDER the gauges; the whole-cluster panel (slot 0x203: The Grid's own dials) is OVER them; the
 * telltales are over everything. Whether Check Control messages draw over the panel is not known
 * yet (drawn over it here).
 */
function cluster(g, car, map, o) {
    const hu = o.hu, mph = hu.settings.get('speedUnit') === 'mph';
    g.fillStyle = '#000'; g.fillRect(0, 0, 1920, 720);
    const bg = g.createRadialGradient(960, 360, 200, 960, 360, 1100);
    bg.addColorStop(0, '#07080a'); bg.addColorStop(1, '#000');
    g.fillStyle = bg; g.fillRect(0, 0, 1920, 720);
    // the map area, under the gauges: The Grid's middle, or BMW's own map view
    if (o.gridOn) g.drawImage(map, 416, 120);
    else stockMap(g, car);
    // the dial faces reach over the map area, as on the car
    g.fillStyle = 'rgba(40,44,52,0.55)';
    g.beginPath(); g.arc(520, 400, 300, 0, TAU); g.fill();
    g.beginPath(); g.arc(1400, 400, 300, 0, TAU); g.fill();
    const sp = Math.abs(car.v) * 3.6 * (mph ? 0.621371 : 1), spMax = mph ? 200 : 320;
    gauge(g, 520, 400, 330, Math.PI * 0.70, Math.PI * 1.67, sp / spMax, { n: 10, label: (i) => String(i * spMax / 10), lit0: '#3b4048', lit1: '#d9dde3' });
    const rpm = car.rpm, red = 7200;
    gauge(g, 1400, 400, 330, Math.PI * 0.30, -Math.PI * 0.67, rpm / 7000, { ccw: true, n: 7, red: 5 / 7, redTick: 6, label: (i) => String(i), lit0: '#5a2a1a', lit1: '#ff5a1f' });
    // BMW's digital speed and gear: drawn over the map area (what showed through The Grid's middle on the car)
    g.fillStyle = '#f2f4f7'; g.font = font(96, 600); g.textAlign = 'center';
    g.fillText(String(Math.round(sp)), 560, 400);
    g.fillStyle = '#c6cbd3'; g.font = font(28, 500); g.fillText(mph ? 'mph' : 'km/h', 650, 400);
    g.fillRect(400, 412, 330, 3);
    const gear = !car.running ? '' : car.sel !== 'D' ? car.sel : car.prog === 'M' ? 'M' + car.gear : car.prog === 'S' ? 'S' + car.gear : 'D' + car.gear;
    g.fillStyle = '#f2f4f7'; g.font = font(96, 700); g.fillText(gear, 1490, 390);
    g.fillRect(1250, 400, 330, 3);
    g.fillStyle = '#8b9099'; g.font = font(22, 500); g.fillText('1/min ×1000', 1560, 590);
    // fuel (bottom left) and the engine temperature gauge (bottom right)
    const fuel = clamp(car.fuel, 0, 1);
    g.lineCap = 'butt'; g.lineWidth = 10;
    g.strokeStyle = '#1c1f24'; g.beginPath(); g.arc(215, 500, 140, Math.PI * 0.57, Math.PI * 1.11); g.stroke();
    g.strokeStyle = fuel < 0.15 ? '#ff8a00' : '#c9ced6'; g.beginPath(); g.arc(215, 500, 140, Math.PI * 0.57, Math.PI * (0.57 + 0.54 * fuel)); g.stroke();
    g.fillStyle = '#c6cbd3'; g.font = font(22, 600); g.textAlign = 'center';
    g.fillText('1', 82, 450); g.fillText('½', 92, 568); g.fillText('0', 190, 622);
    g.strokeStyle = '#1c1f24'; g.beginPath(); g.arc(1705, 500, 140, -Math.PI * 0.11, Math.PI * 0.43); g.stroke();
    g.strokeStyle = '#c9ced6'; g.beginPath(); g.arc(1705, 500, 140, Math.PI * 0.20, Math.PI * 0.43); g.stroke();
    // the dials' feet, as in Tyson's photos: red needle stubs at the bottom of each dial (y ~615-645),
    // the grey "mph", and the white frame line along their bottoms (y ~641-658); the strip's text from ~663
    g.fillStyle = '#c0141a';
    g.beginPath(); g.moveTo(330, 640); g.lineTo(420, 618); g.lineTo(430, 630); g.lineTo(345, 648); g.fill();
    g.beginPath(); g.moveTo(560, 642); g.lineTo(640, 616); g.lineTo(648, 628); g.lineTo(572, 650); g.fill();
    g.beginPath(); g.moveTo(1500, 640); g.lineTo(1560, 615); g.lineTo(1570, 628); g.lineTo(1512, 648); g.fill();
    g.fillStyle = '#7d828b'; g.font = font(30, 500); g.textAlign = 'left'; g.fillText('mph', 690, 650); g.textAlign = 'center';
    g.strokeStyle = '#d9dde3'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(150, 640); g.quadraticCurveTo(200, 656, 300, 656); g.lineTo(760, 652); g.lineTo(800, 664); g.lineTo(1120, 664); g.lineTo(1160, 652); g.lineTo(1620, 656); g.quadraticCurveTo(1720, 656, 1770, 640); g.stroke();
    // the speed-limit sign in the speedometer's foot (a stand-in value)
    g.fillStyle = '#f4f4f4'; g.fillRect(527, 577, 62, 82);
    g.strokeStyle = '#111'; g.lineWidth = 2; g.strokeRect(531, 581, 54, 74);
    g.fillStyle = '#111'; g.font = font(12, 700); g.fillText('SPEED', 558, 597); g.fillText('LIMIT', 558, 611);
    g.font = font(30, 700); g.fillText('45', 558, 645);
    // the bottom strip: range, clock, street, outside air
    g.font = font(36, 500); g.textAlign = 'left'; g.fillStyle = '#e8ecf2';
    g.fillText('⛽', 140, 704);
    g.fillText(Math.round(car.fuel * 340 * (mph ? 1 : 1.609)) + (mph ? ' mi' : ' km'), 190, 702);
    g.fillText(new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase(), 380, 702);
    g.fillText('Main St', 750, 702);
    const amb = car.env.ambient, f = hu.settings.get('tempUnit') === 'F';
    g.textAlign = 'right';
    g.fillText((f ? '+' + Math.round(amb * 1.8 + 32) + '°F' : Math.round(amb) + '°C'), 1700, 690);
    // The Grid over the whole cluster (slot 0x203): over the gauges, under the telltales
    if (o.panelOn && o.panel) g.drawImage(o.panel, 0, 0);
    else g.strokeStyle = 'rgba(120,130,145,0.18)', g.lineWidth = 1, g.setLineDash([6, 6]), g.strokeRect(416.5, 120.5, 1087, 479), g.setLineDash([]);
    // telltales: over everything (the seat-belt light while stopped, as in the photo)
    if (Math.abs(car.v) < 0.3) seatbelt(g, 630, 690);
    // the cluster's Check Control messages (over the panel here: not yet checked on the car)
    if (car.oil > 140) warn(g, 'Engine oil temperature high', '#ffb000');
    if (car.coolant > 118) warn(g, 'Engine coolant temperature high', '#ff3b1f');
}
function seatbelt(g, x, y) {
    g.fillStyle = '#e0241b';
    g.beginPath(); g.arc(x, y - 30, 6, 0, TAU); g.fill();
    g.fillRect(x - 8, y - 22, 16, 22); g.fillRect(x - 12, y, 24, 6);
    g.strokeStyle = '#e0241b'; g.lineWidth = 3; g.beginPath(); g.moveTo(x - 10, y - 24); g.lineTo(x + 10, y - 4); g.stroke();
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
