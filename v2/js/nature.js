// nature.js — builder B: the SITE around the house.
// Terrain (TSL blend of lawn / forest floor / dry grass / gravel), dry-stone retaining walls, flagstone terrace,
// stone step paths, parking stair, boardwalk + dock, lake (WaterMesh), motorboat, pickup, grass, flowers,
// shrubs, ferns, rocks, trees (light procedural cards — "con los pinos no te vuelvas loco").
// Everything goes into groups.site. Walkable pieces are registered in physics.
import { THREE, TSL, terrainH, mulberry32, srgb, planarUV, mergeGeometries, mergeGroup, loadTexSet, loadTexMaps, loadModel, modelEntry, WATER_Y } from './shared.js';
import { WaterMesh } from 'three/addons/objects/WaterMesh.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// Objects under this node are hidden while the lake's reflector renders (its mirrored camera is below the water).
// isLOD makes the renderer call update(camera) for every camera it projects the scene for (main, shadow, reflection).
class NoReflect extends THREE.Object3D {
  constructor() { super(); this.isLOD = true; this.autoUpdate = true; this.name = 'site_no_reflection'; }
  update(camera) { const v = camera.matrixWorld.elements[13] > WATER_Y + 0.02; for (const c of this.children) c.visible = v; }
}
function rockGeo(seed) {
  const N = perlin(500 + seed), g0 = new THREE.IcosahedronGeometry(1, 3); g0.deleteAttribute('uv'); g0.deleteAttribute('normal');
  const g = mergeVertices(g0), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + N(x * 1.3 + seed, z * 1.3 + y) * 0.35 + N(x * 3.1, y * 3.1 + z) * 0.1; let yy = y * 0.62 * k; if (yy < -0.15) yy = -0.15 + (yy + 0.15) * 0.3;
    p.setXYZ(i, x * k * (1 + seed * 0.08), yy, z * k * 0.85); }
  g.computeVertexNormals(); g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(p.count * 2), 2)); return g;
}

const { texture, uv, attribute, vec2, vec3, vec4, float, mix, smoothstep, normalMap, positionWorld, positionLocal,
  instanceIndex, hash, time, sin, cos, uniform, cameraPosition, color, luminance, clamp, max, triplanarTexture, normalWorld, normalLocal, transformNormalToView,
  normalize, reflect, pow, dot } = TSL;

// ------------------------------------------------------------------ small utils
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = t => Math.max(0, Math.min(1, t));
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
function perlin(seed) {
  const R = mulberry32(seed), p = new Uint8Array(512), perm = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(R() * (i + 1)); const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  const grad = (h, x, y) => { switch (h & 7) { case 0: return x + y; case 1: return -x + y; case 2: return x - y; case 3: return -x - y; case 4: return x; case 5: return -x; case 6: return y; default: return -y; } };
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), X = xi & 255, Y = yi & 255, xf = x - xi, yf = y - yi, u = fade(xf), v = fade(yf);
    const aa = p[p[X] + Y], ab = p[p[X] + Y + 1], ba = p[p[X + 1] + Y], bb = p[p[X + 1] + Y + 1];
    return lerp(lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u), lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u), v) * 0.75; };
}
const N1 = perlin(11), N2 = perlin(23), N3 = perlin(37);
const fbm = (x, z) => N1(x, z) * 0.6 + N2(x * 2.07, z * 2.07) * 0.28 + N3(x * 4.3, z * 4.3) * 0.12;

// ------------------------------------------------------------------ visual terrain = terrainH + terraces behind the parking/house
// The terraces are VISUAL + PHYSICS (floorRect/ramp registered below), so walking matches what you see.
const TER_Z = 18.95;                         // back face of the big walls; the fill starts here
function fillY(x, z) {
  if (z < TER_Z) return -Infinity;
  if (x >= -25 && x < -11) return 7.2 - Math.max(0, z - 24) * 0.6;   // terrace A, behind the parking (4.2 m wall)
  if (x >= -11 && x < 24) return 5.0 - Math.max(0, z - 22) * 0.6;    // terrace B, behind the house (2 m wall)
  return -Infinity;
}
// far away (beyond the walls) the 3 m plateau cliffs of terrainH become natural banks — visual only, far from the house
function terrainV(x, z) {
  let y = terrainH(x, z);
  const e = x > 41 ? Math.min(1, (x - 41) / 5) : x < -48 ? Math.min(1, (-48 - x) / 5) : 0;
  if (e > 0) { let s = 0; for (const dz of [-2.6, -1.3, 0, 1.3, 2.6]) s += terrainH(x, z + dz); y = y * (1 - e) + (s / 5) * e; }
  const f = fillY(x, z); return f > y ? f : y;
}

// ------------------------------------------------------------------ geometry batching (one mesh per material)
class Batch {
  constructor(mat, { color = false, cast = true } = {}) { this.mat = mat; this.color = color; this.cast = cast; this.geos = []; }
  add(geo, rgb) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', g.attributes.position);
    if (!g.attributes.normal) g.computeVertexNormals();
    out.setAttribute('normal', g.attributes.normal);
    out.setAttribute('uv', g.attributes.uv || new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (this.color) {
      const n = g.attributes.position.count, c = new Float32Array(n * 3), col = rgb || [1, 1, 1];
      if (g.attributes.color) c.set(g.attributes.color.array); else for (let i = 0; i < n; i++) c.set(col, i * 3);
      out.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    this.geos.push(out); return out;
  }
  build(group) {
    if (!this.geos.length) return null;
    const m = new THREE.Mesh(mergeGeometries(this.geos, false), this.mat);
    m.castShadow = this.cast; m.receiveShadow = true; m.userData.noMerge = true; group.add(m); return m;
  }
}
function boxGeo(x0, x1, y0, y1, z0, z1, tile) {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0); g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  if (tile) planarUV(g, tile); return g;
}
// oriented box: center, direction along (unit xz), sizes; y range. Optional pitch (rise over length).
function orientedBox(cx, cz, dx, dz, len, wid, y0, y1, tile, rise = 0) {
  const g = new THREE.BoxGeometry(len, y1 - y0, wid);
  if (rise) { const p = g.attributes.position; for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) + (p.getX(i) / len) * rise); g.computeVertexNormals(); }
  g.rotateY(-Math.atan2(dz, dx)); g.translate(cx, (y0 + y1) / 2, cz);
  if (tile) planarUV(g, tile); return g;
}
// irregular stone slab (rounded polygon), world coords, top at yTop, extruded down by thick
function slabGeo(poly, yTop, thick, tile, bevel = 0.025) {
  const sh = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: thick, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 1, curveSegments: 1 });
  g.rotateX(-Math.PI / 2); g.translate(0, yTop - thick - bevel, 0);
  planarUV(g, tile); return g;
}
function irregularPoly(cx, cz, rx, rz, rot, R, n = 9, jit = 0.18, sq = 0.55) {
  const pts = [], c = Math.cos(rot), s = Math.sin(rot);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (R() - 0.5) * 0.35, ca = Math.cos(a), sa = Math.sin(a);
    const k = 1 / Math.pow(Math.pow(Math.abs(ca), 2 / sq) + Math.pow(Math.abs(sa), 2 / sq), sq / 2);   // superellipse → squarish
    const r = k * (1 - jit + R() * jit);
    const lx = ca * rx * r, lz = sa * rz * r;
    pts.push([cx + lx * c - lz * s, cz + lx * s + lz * c]);
  }
  return pts;
}
// Dry-stone wall along a polyline. The exposed face points to n = side*(dz,-dx). Top/bottom are functions of (x,z,s).
function dryWall(batch, pts, o) {
  const { top, bot, thick = 0.6, batter = 0.1, both = false, tile = 4.2, amp = 0.05, step = 0.33, side = 1, capBack = true, seed = 1 } = o;
  const Nw = perlin(1000 + seed);
  // resample the polyline
  const segs = []; let L = 0;
  for (let i = 0; i < pts.length - 1; i++) { const [ax, az] = pts[i], [bx, bz] = pts[i + 1], l = Math.hypot(bx - ax, bz - az); segs.push({ ax, az, bx, bz, l, s0: L }); L += l; }
  const ns = Math.max(1, Math.ceil(L / step)), st = [];
  for (let i = 0; i <= ns; i++) {
    const s = (i / ns) * L; let sg = segs.find(q => s <= q.s0 + q.l + 1e-9) || segs[segs.length - 1];
    const t = (s - sg.s0) / sg.l, x = lerp(sg.ax, sg.bx, t), z = lerp(sg.az, sg.bz, t);
    const dx = (sg.bx - sg.ax) / sg.l, dz = (sg.bz - sg.az) / sg.l; let nx = side * dz, nz = -side * dx;
    // smooth normal at interior vertices
    const k = segs.indexOf(sg); if (Math.abs(s - (sg.s0 + sg.l)) < step * 0.5 && k < segs.length - 1) { const q = segs[k + 1]; const ex = (q.bx - q.ax) / q.l, ez = (q.bz - q.az) / q.l; nx += side * ez; nz -= side * ex; const ln = Math.hypot(nx, nz); nx /= ln; nz /= ln; }
    const yt = top(x, z, s), yb = Math.min(bot(x, z, s), yt - 0.02);
    st.push({ s, x, z, nx, nz, yt, yb });
  }
  const maxH = Math.max(...st.map(q => q.yt - q.yb)); const nr = Math.max(2, Math.ceil(maxH / step));
  const face = (sgn, extraOff) => {           // sgn +1 front face, -1 back face
    const pos = [], uvs = [], idx = [], W = nr + 1;
    for (const q of st) for (let j = 0; j <= nr; j++) {
      const f = j / nr, y0 = q.yb + (q.yt - q.yb) * f;
      const d = Nw(q.s * 1.6, y0 * 1.6 + (sgn < 0 ? 40 : 0)) * amp + Nw(q.s * 5.1, y0 * 5.1) * amp * 0.35;
      const y = j === nr ? y0 + Nw(q.s * 2.3, 9) * amp * 1.2 : y0;
      const off = sgn * (batter * (q.yt - y0) + d) + (sgn < 0 ? -extraOff : 0);
      pos.push(q.x + q.nx * off, y, q.z + q.nz * off); uvs.push(q.s / tile * sgn, y / tile);
    }
    for (let i = 0; i < st.length - 1; i++) for (let j = 0; j < nr; j++) {
      const a = i * W + j, b = (i + 1) * W + j;
      if (sgn * side > 0 || true) { if (sgn > 0) idx.push(a, b, a + 1, b, b + 1, a + 1); else idx.push(a, a + 1, b, b, a + 1, b + 1); }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); g.setIndex(idx);
    // winding depends on the side sign: fix by checking the first normal against the face direction
    g.computeVertexNormals();
    const n0 = new THREE.Vector3().fromBufferAttribute(g.attributes.normal, Math.floor(nr / 2)); const want = sgn;
    if ((n0.x * st[0].nx + n0.z * st[0].nz) * want < 0) { const ix = g.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } g.computeVertexNormals(); }
    batch.add(g);
  };
  face(1, 0);
  if (both) face(-1, thick);
  // top cap: front top edge → back top edge, slightly domed
  { const pos = [], uvs = [], idx = [];
    for (const q of st) {
      const yF = q.yt + Nw(q.s * 2.3, 9) * amp * 1.2;
      const dF = Nw(q.s * 1.6, q.yt * 1.6) * amp; const dB = both ? Nw(q.s * 1.6, q.yt * 1.6 + 40) * amp : 0;
      const pF = dF, pM = -thick * 0.5, pB = -thick - dB;
      const yM = q.yt + 0.05 + Nw(q.s * 3.1, 5) * 0.03, yB = both ? q.yt + Nw(q.s * 2.3, 19) * amp : q.yt - (capBack ? 0.02 : 0);
      for (const [p, y] of [[pF, yF], [pM, yM], [pB, yB]]) { pos.push(q.x + q.nx * p, y, q.z + q.nz * p); uvs.push(q.s / tile, p / tile); }
    }
    for (let i = 0; i < st.length - 1; i++) for (let j = 0; j < 2; j++) { const a = i * 3 + j, b = (i + 1) * 3 + j; idx.push(a, a + 1, b, b, a + 1, b + 1); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); g.setIndex(idx); g.computeVertexNormals();
    if (g.attributes.normal.getY(1) < 0) { const ix = g.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } g.computeVertexNormals(); }
    batch.add(g);
  }
  // end caps
  for (const q of [st[0], st[st.length - 1]]) {
    const off0 = batter * (q.yt - q.yb), offB = both ? -(thick + batter * (q.yt - q.yb)) : -thick;
    const P = [[off0, q.yb], [0, q.yt], [-thick, q.yt], [offB, q.yb]].map(([o, y]) => [q.x + q.nx * o, y, q.z + q.nz * o]);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([...P[0], ...P[1], ...P[2], ...P[0], ...P[2], ...P[3]], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, P[0][1] / tile, 0.2, P[1][1] / tile, 0.35, P[2][1] / tile, 0, P[0][1] / tile, 0.35, P[2][1] / tile, 0.2, P[3][1] / tile], 2));
    g.computeVertexNormals(); const nn = new THREE.Vector3().fromBufferAttribute(g.attributes.normal, 0);
    const tx = -q.nz, tz = q.nx, dir = q === st[0] ? -1 : 1;
    if ((nn.x * tx + nn.z * tz) * dir < 0) { const a = g.attributes.position.array; for (let i = 0; i < a.length; i += 9) for (let k = 0; k < 3; k++) { const t = a[i + 3 + k]; a[i + 3 + k] = a[i + 6 + k]; a[i + 6 + k] = t; } g.attributes.uv.needsUpdate = true; g.computeVertexNormals(); }
    batch.add(g);
  }
  return st;
}

// ------------------------------------------------------------------ occupancy mask (what grass/flowers/shrubs avoid)
class Mask {
  constructor(x0, x1, z0, z1, c = 0.25) { this.x0 = x0; this.z0 = z0; this.c = c; this.w = Math.ceil((x1 - x0) / c); this.h = Math.ceil((z1 - z0) / c); this.a = new Uint8Array(this.w * this.h); }
  _set(i, j, v) { if (i >= 0 && j >= 0 && i < this.w && j < this.h) this.a[j * this.w + i] = Math.max(this.a[j * this.w + i], v); }
  rect(x0, x1, z0, z1, v = 1) { const c = this.c; for (let j = Math.floor((z0 - this.z0) / c); j <= Math.floor((z1 - this.z0) / c); j++) for (let i = Math.floor((x0 - this.x0) / c); i <= Math.floor((x1 - this.x0) / c); i++) this._set(i, j, v); }
  disk(x, z, r, v = 1) { const c = this.c; for (let j = Math.floor((z - r - this.z0) / c); j <= Math.floor((z + r - this.z0) / c); j++) for (let i = Math.floor((x - r - this.x0) / c); i <= Math.floor((x + r - this.x0) / c); i++) { const px = this.x0 + (i + 0.5) * c, pz = this.z0 + (j + 0.5) * c; if ((px - x) ** 2 + (pz - z) ** 2 <= r * r) this._set(i, j, v); } }
  poly(pts, v = 1) { let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const c = this.c; for (let j = Math.floor((z0 - this.z0) / c); j <= Math.floor((z1 - this.z0) / c); j++) for (let i = Math.floor((x0 - this.x0) / c); i <= Math.floor((x1 - this.x0) / c); i++) { const px = this.x0 + (i + 0.5) * c, pz = this.z0 + (j + 0.5) * c; if (inPoly(px, pz, pts)) this._set(i, j, v); } }
  get(x, z) { const i = Math.floor((x - this.x0) / this.c), j = Math.floor((z - this.z0) / this.c); if (i < 0 || j < 0 || i >= this.w || j >= this.h) return 0; return this.a[j * this.w + i]; }
}
function inPoly(x, z, pts) { let ins = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, zi] = pts[i], [xj, zj] = pts[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) ins = !ins; } return ins; }
function distSeg(px, pz, ax, az, bx, bz) { const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz; let t = L2 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0; t = clamp01(t); return Math.hypot(px - ax - dx * t, pz - az - dz * t); }

// ------------------------------------------------------------------ procedural foliage atlas (no downloads)
// regions in UV (DataTexture: v=0 is the first row we write = canvas top, we flip when copying)
const ATL = { spray: [0, 0.5, 0.5, 1], top: [0.5, 0.5, 0.75, 1], pbark: [0.75, 0.5, 0.875, 1], bbark: [0.875, 0.5, 1, 1], leaf: [0, 0, 0.5, 0.5], shrub: [0.5, 0, 1, 0.5] };
function makeAtlas() {
  const S = 1024, cv = document.createElement('canvas'); cv.width = cv.height = S; const g = cv.getContext('2d'), R = mulberry32(99);
  const rgb = (r, gg, b, a = 1) => `rgba(${r | 0},${gg | 0},${b | 0},${a})`;
  // canvas y grows down; ATL v grows up → region [u0,v0,u1,v1] ↔ canvas rect x=u0*S, y=(1-v1)*S
  const rect = k => { const [u0, v0, u1, v1] = ATL[k]; return [u0 * S, (1 - v1) * S, (u1 - u0) * S, (v1 - v0) * S]; };
  const needles = (x, y, ang, len, dens, width, shade) => {
    const n = Math.floor(len / dens);
    for (let i = 0; i < n; i++) { const t = i / n, px = x + Math.cos(ang) * len * t, py = y + Math.sin(ang) * len * t;
      for (const sgn of [-1, 1]) { const a = ang + sgn * (0.9 + R() * 0.5) - 0.25 * sgn * t, l = width * (1 - t * 0.55) * (0.7 + R() * 0.5);
        const k = shade * (0.75 + R() * 0.5); g.strokeStyle = rgb(28 * k + R() * 14, 52 * k + R() * 20, 26 * k + R() * 10); g.lineWidth = 2.2 + R() * 1.4;
        g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l); g.stroke(); } }
  };
  // --- conifer branch spray: twig axis along +u (left→right), centered on v=0.5
  { const [x, y, w, h] = rect('spray'); g.lineCap = 'round';
    for (let layer = 0; layer < 2; layer++) {
      const shade = layer ? 1.25 : 0.8, cy = y + h / 2;
      for (let b = 0; b < 11; b++) { const t = 0.06 + b * 0.085, bx = x + t * w, side = b % 2 ? 1 : -1, bl = (1 - t) * h * 0.42 + 20;
        const a = side * (0.75 + R() * 0.35) + (R() - 0.5) * 0.2; needles(bx, cy, a, bl, 5.5, 26 - t * 10, shade); needles(bx, cy, -a * 0.35, bl * 0.4, 6, 20, shade); }
      needles(x + 4, cy, 0, w * 0.97, 5, 30, shade);
      g.strokeStyle = rgb(62, 46, 30); g.lineWidth = 5; g.beginPath(); g.moveTo(x + 2, cy); g.lineTo(x + w * 0.7, cy); g.stroke();
    } }
  // --- conifer leader/top: vertical, conical outline
  { const [x, y, w, h] = rect('top'); g.lineCap = 'round'; const cx = x + w / 2;
    for (let layer = 0; layer < 2; layer++) { const shade = layer ? 1.2 : 0.8;
      for (let i = 0; i < 16; i++) { const t = i / 16, py = y + h * (0.1 + t * 0.88), half = (t * 0.9 + 0.1) * w * 0.5;
        needles(cx, py, Math.PI - 0.5, half * 1.1, 5.5, 18, shade); needles(cx, py, -0.5 + 0, half * 1.1, 5.5, 18, shade); }
      needles(cx, y + h, -Math.PI / 2, h * 0.97, 5, 22, shade); } }
  // --- bark strips
  { const [x, y, w, h] = rect('pbark'); g.fillStyle = rgb(62, 50, 42); g.fillRect(x, y, w, h);
    for (let i = 0; i < 260; i++) { g.fillStyle = rgb(34 + R() * 40, 28 + R() * 30, 24 + R() * 22, 0.8); g.fillRect(x + R() * w, y + R() * h, 3 + R() * 12, 6 + R() * 26); } }
  { const [x, y, w, h] = rect('bbark'); g.fillStyle = rgb(226, 222, 212); g.fillRect(x, y, w, h);
    for (let i = 0; i < 150; i++) { g.fillStyle = rgb(40 + R() * 30, 38 + R() * 25, 34 + R() * 20, 0.85); g.fillRect(x + R() * w, y + R() * h, 6 + R() * 26, 1.5 + R() * 3); }
    g.fillStyle = rgb(60, 55, 48, 0.8); g.fillRect(x, y + h * 0.93, w, h * 0.07); }
  // --- leaf clusters: birch (light, open) and shrub (dense, darker)
  // lumpy clusters: several sub-blobs of small leaves → irregular silhouette, holes, a few twigs
  const cluster = (k, blobs, per, cols, lr, spread) => { const [x, y, w, h] = rect(k), cx = x + w / 2, cy = y + h / 2;
    g.strokeStyle = rgb(78, 66, 50); g.lineCap = 'round';
    const B = []; for (let b = 0; b < blobs; b++) { const a = R() * 6.28, r = Math.sqrt(R()) * spread; B.push([cx + Math.cos(a) * r * w, cy + Math.sin(a) * r * h * 0.9, (0.1 + R() * 0.07) * w]); }
    for (const [bx, by] of B) { g.lineWidth = 2 + R() * 2; g.beginPath(); g.moveTo(cx + (R() - 0.5) * 20, y + h * 0.97); g.quadraticCurveTo((cx + bx) / 2 + (R() - 0.5) * 40, (cy + by) / 2 + 30, bx, by); g.stroke(); }
    for (const [bx, by, br] of B) for (let i = 0; i < per; i++) { const a = R() * 6.28, r = Math.pow(R(), 0.65) * br; const px = bx + Math.cos(a) * r, py = by + Math.sin(a) * r * 0.85;
      const c = cols[(R() * cols.length) | 0], sh = (0.78 + R() * 0.4) * (1.08 - (py - (by - br)) / (2 * br) * 0.3); g.fillStyle = rgb(c[0] * sh, c[1] * sh, c[2] * sh);
      g.save(); g.translate(px, py); g.rotate(R() * 6.28); g.beginPath(); g.ellipse(0, 0, lr * (0.75 + R() * 0.5), lr * 0.42, 0, 0, 6.28); g.fill(); g.restore(); } };
  cluster('leaf', 9, 330, [[112, 146, 56], [134, 162, 64], [92, 128, 48], [156, 172, 80], [120, 154, 60]], 8, 0.3);
  cluster('shrub', 8, 480, [[58, 90, 36], [72, 104, 42], [48, 76, 32], [88, 116, 50]], 7, 0.28);
  // copy to a DataTexture and bleed colour into transparent texels (no black fringes in the mips)
  const im = g.getImageData(0, 0, S, S).data, data = new Uint8Array(S * S * 4);
  for (let j = 0; j < S; j++) { const src = (S - 1 - j) * S * 4, dst = j * S * 4; data.set(im.subarray(src, src + S * 4), dst); }
  for (let i = 0; i < S * S; i++) if (data[i * 4 + 3] < 8) { data[i * 4] = 48; data[i * 4 + 1] = 70; data[i * 4 + 2] = 32; }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat); t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 4; t.needsUpdate = true;
  return t;
}
const reg = (k, u, v) => { const [u0, v0, u1, v1] = ATL[k]; return [u0 + (u1 - u0) * u, v0 + (v1 - v0) * v]; };

// card quad: root point, along (unit), side (unit), length, width → pushes 2 tris
function pushCard(A, root, along, side, L, W, k, center, rot = false) {
  const c = [[0, -0.5], [1, -0.5], [1, 0.5], [0, 0.5]].map(([u, s]) => new THREE.Vector3().copy(root).addScaledVector(along, u * L).addScaledVector(side, s * W));
  const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => rot ? reg(k, Math.min(0.999, Math.max(0.001, v)), Math.min(0.999, Math.max(0.001, u))) : reg(k, Math.min(0.999, Math.max(0.001, u)), Math.min(0.999, Math.max(0.001, v))));
  for (const i of [0, 1, 2, 0, 2, 3]) { const p = c[i]; A.pos.push(p.x, p.y, p.z); A.uv.push(...uvs[i]);
    const n = new THREE.Vector3(p.x - center.x, (p.y - center.y) * 0.6, p.z - center.z).normalize().multiplyScalar(0.75).add(new THREE.Vector3(0, 0.45, 0)).normalize(); A.nor.push(n.x, n.y, n.z); }
}
function trunkInto(A, h, r0, r1, k, segs = 6) {
  for (let i = 0; i < segs; i++) { const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1) / segs) * Math.PI * 2;
    const q = [[a0, 0, r0], [a1, 0, r0], [a1, h, r1], [a0, h, r1]].map(([a, y, r]) => [Math.cos(a) * r, y, Math.sin(a) * r]);
    const uvq = [[i / segs, 0], [(i + 1) / segs, 0], [(i + 1) / segs, 1], [i / segs, 1]].map(([u, v]) => reg(k, 0.02 + u * 0.96, 0.01 + v * 0.98));
    for (const j of [0, 2, 1, 0, 3, 2]) { A.pos.push(...q[j]); A.uv.push(...uvq[j]); const a = j === 0 || j === 3 ? a0 : a1; A.nor.push(Math.cos(a), 0, Math.sin(a)); } }
}
function geoFrom(A) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(A.pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(A.nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(A.uv, 2)); g.computeBoundingSphere(); return g; }
// conifer at nominal height H (instances scale it)
function coniferGeo(R, { H = 15, crownBase = 0.25, radius = 3.0, step = 0.9, perWhorl = 5, droop = 0.25, shape = 0.9, trunkR = 0.28 }) {
  const A = { pos: [], nor: [], uv: [] }; trunkInto(A, H * 0.96, trunkR, trunkR * 0.18, 'pbark');
  const yc = H * (crownBase + (1 - crownBase) * 0.45), center = new THREE.Vector3(0, yc, 0);
  for (let y = H * crownBase; y < H * 0.93; y += step * (0.8 + R() * 0.4)) {
    const t = (y - H * crownBase) / (H * (1 - crownBase)), L = radius * Math.pow(1 - t, shape) * (0.8 + R() * 0.35) + 0.5, off = R() * 6.28;
    const n = Math.max(3, Math.round(perWhorl * (1 - t * 0.4)));
    for (let i = 0; i < n; i++) { if (R() < 0.12) continue;
      const a = off + (i / n) * Math.PI * 2 + (R() - 0.5) * 0.5, d = droop + (R() - 0.5) * 0.3;
      const along = new THREE.Vector3(Math.cos(a) * Math.cos(d), -Math.sin(d), Math.sin(a) * Math.cos(d));
      const lat = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)), up = new THREE.Vector3().crossVectors(along, lat).normalize();
      const tw = 0.35 + R() * 0.6, side = lat.clone().multiplyScalar(Math.cos(tw)).addScaledVector(up, Math.sin(tw));
      pushCard(A, new THREE.Vector3(Math.cos(a) * 0.1, y, Math.sin(a) * 0.1), along, side, L, L * 0.75, 'spray', center);
    } }
  // leader: two crossed vertical cards
  const th = H * 0.2; for (const a of [0, Math.PI / 2]) pushCard(A, new THREE.Vector3(0, H - th * 1.05, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), th * 1.1, th * 0.75, 'top', center, true);
  return geoFrom(A);
}
function birchGeo(R, { H = 11, crown0 = 0.42, rad = 2.3, cards = 42, trunkR = 0.15 }) {
  const A = { pos: [], nor: [], uv: [] }; trunkInto(A, H * 0.93, trunkR, trunkR * 0.3, 'bbark');
  const yc = H * (crown0 + (1 - crown0) * 0.5), hy = H * (1 - crown0) * 0.5, center = new THREE.Vector3(0, yc, 0);
  for (let i = 0; i < cards; i++) {
    const a = R() * 6.28, r = Math.sqrt(R()) * rad, y = yc + (R() * 2 - 1) * hy * 0.85 * (1 - (r / rad) * 0.3);
    const p = new THREE.Vector3(Math.cos(a) * r * 0.85, y, Math.sin(a) * r * 0.85);
    const out = new THREE.Vector3(Math.cos(a), 0.2 + R() * 0.3, Math.sin(a)).normalize(), s = 0.95 + R() * 0.6;
    const lat = new THREE.Vector3(-Math.sin(a + R()), (R() - 0.5) * 0.8, Math.cos(a + R())).normalize();
    const up = new THREE.Vector3().crossVectors(out, lat).normalize();
    pushCard(A, p.clone().addScaledVector(up, -s * 0.5), up, lat, s, s, 'leaf', center);
  }
  return geoFrom(A);
}
// dome bush: many small leaf-cluster cards on an ellipsoid shell (reads as a leafy mass even up close) — ~2 tris per card
function bushGeo(R, { r = 0.9, h = 0.85, cards = 60, size = 0.45 }) {
  const A = { pos: [], nor: [], uv: [] }, center = new THREE.Vector3(0, h * 0.25, 0), rnd3 = new THREE.Vector3();
  for (let i = 0; i < cards; i++) {
    const th = R() * 6.283, ph = Math.acos(1 - R() * 1.2), k = i < cards * 0.25 ? 0.55 + R() * 0.2 : 0.82 + R() * 0.25;   // a quarter fills the inside
    const dir = new THREE.Vector3(Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th));
    const p = new THREE.Vector3(dir.x * r * k, Math.max(0.08, dir.y * h * k), dir.z * r * k);
    rnd3.set(R() - 0.5, R() - 0.5, R() - 0.5); const side = new THREE.Vector3().crossVectors(dir, rnd3).normalize(), up = new THREE.Vector3().crossVectors(side, dir).normalize();
    const sz = size * r * (0.75 + R() * 0.55);
    pushCard(A, p.clone().addScaledVector(up, -sz * 0.5), up, side, sz, sz, 'shrub', center);
  }
  return geoFrom(A);
}

// ================================================================== build
export async function buildNature(ctx) {
  const { groups, physics } = ctx;
  const G = groups.site, R = mulberry32(4242);
  const stats = { instances: {} };

  // ---------------- textures / materials
  // only the maps each surface samples (the terrain paints its own colour and uses no ARM): ~20 MB instead of ~26 MB
  const [TL, TF, TD, TG, TR, TS, TW] = await Promise.all([
    loadTexMaps('grass_lawn', ['diff', 'nor_gl']), loadTexMaps('forest_floor', ['diff', 'nor_gl']), loadTexMaps('dry_grass', ['diff']),
    loadTexMaps('gravel', ['diff', 'nor_gl']), loadTexMaps('rock', ['diff', 'nor_gl']), loadTexSet('stone_wall'), loadTexSet('deck')]);
  const stdTex = (T, o = {}) => { const m = new THREE.MeshStandardMaterial({ color: o.color ?? 0xffffff, map: T.map, normalMap: T.normalMap, roughnessMap: T.roughnessMap, aoMap: T.aoMap || null, roughness: o.roughness ?? 1, metalness: 0, vertexColors: !!o.vc, side: o.side ?? THREE.FrontSide });
    if (o.ns) m.normalScale.set(o.ns, o.ns); return m; };
  const M = {
    wall: stdTex(TS, { color: srgb(236, 232, 224), ns: 1.4 }),
    flag: (() => { const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0, vertexColors: true }); const t = texture(TR.map, uv());
      m.colorNode = mix(t.rgb, vec3(luminance(t.rgb)), 0.7).mul(1.75); m.normalNode = normalMap(texture(TR.normalMap, uv()).rgb, vec2(0.8)); return m; })(),
    deck: stdTex(TW, { color: srgb(200, 182, 160), roughness: 0.9 }),
    timber: new THREE.MeshStandardMaterial({ color: srgb(58, 44, 34), roughness: 0.85 }),
    steel: new THREE.MeshStandardMaterial({ color: srgb(22, 22, 23), roughness: 0.5, metalness: 0.6 }),
  };
  const B = { wall: new Batch(M.wall), flag: new Batch(M.flag, { color: true }), deck: new Batch(M.deck), timber: new Batch(M.timber), steel: new Batch(M.steel) };

  // ================================================================ LAYOUT (data first; terrain weights and masks read it)
  // --- stone step paths down the garden (r1): two winding paths
  const PATHS = [
    [[5.0, -3.25], [6.9, -6.8], [10.3, -10.2], [13.2, -13.6], [13.7, -17.6], [11.7, -21.4], [10.3, -25.0], [10.1, -27.2]],
    [[-6.6, -3.25], [-7.3, -7.0], [-4.8, -10.4], [-2.0, -13.8], [-2.5, -17.8], [-0.8, -21.8], [0.3, -25.6], [0.4, -27.9]],
  ];
  const steps = [];            // {poly, top, cx, cz}
  const pathPts = [];          // dense polyline points for masks/weights
  PATHS.forEach((P, pi) => {
    const curve = new THREE.CatmullRomCurve3(P.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
    const len = curve.getLength(), n = Math.floor(len / 0.6), pts = curve.getSpacedPoints(n);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
      let dx = q.x - o.x, dz = q.z - o.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      pathPts.push([p.x, p.z, pi]);
      if (i === 0 && pi === 0) continue;
      const w = 1.05 + R() * 0.3, d = 0.5 + R() * 0.12, rot = Math.atan2(dz, dx) + (R() - 0.5) * 0.18;
      const cx = p.x + (R() - 0.5) * 0.12, cz = p.z + (R() - 0.5) * 0.12;
      const poly = irregularPoly(cx, cz, d / 2, w / 2, rot, R, 10, 0.12, 0.5);
      let hi = -1e9; for (const [x, z] of poly) hi = Math.max(hi, terrainH(x, z));
      steps.push({ poly, top: hi + 0.035, cx, cz, dx, dz, w, d });
    }
  });

  // --- boardwalk: from the lawn west of the house down to the dock (r3). Axis-aligned runs (physics ramps/floors are axis-aligned)
  const BW = [[-17.5, -4.3], [-17.5, -12.0], [-12.5, -12.0], [-12.5, -20.6], [-5.5, -20.6], [-5.5, -29.3]];
  const BW_W = 1.3;
  const bwH = BW.map(([x, z], i) => i === 0 ? terrainH(x, z) + 0.14 : terrainH(x, z) + 0.32);
  for (let i = 0; i < BW.length - 1; i++) {                 // x-runs are flat: level with the previous landing, above the terrain
    const [ax, az] = BW[i], [bx, bz] = BW[i + 1];
    if (az === bz) { let mx = -1e9; for (let t = 0; t <= 1; t += 0.05) mx = Math.max(mx, terrainH(lerp(ax, bx, t), az - BW_W / 2), terrainH(lerp(ax, bx, t), az + BW_W / 2));
      bwH[i] = Math.max(bwH[i], mx + 0.25); bwH[i + 1] = bwH[i]; }
  }
  for (let i = 1; i < bwH.length; i++) bwH[i] = Math.min(bwH[i], bwH[i - 1]);
  const DOCK_Y = Math.max(-8.72, bwH[bwH.length - 1]);
  bwH[bwH.length - 1] = DOCK_Y;
  const DOCK = { x0: -6.6, x1: -4.4, z0: -38.8, z1: -29.3 };

  // --- low garden walls (r2): curved dry-stone walls on the west lawn and by the east path
  const LOWWALLS = [
    { pts: [[-30, -5.2], [-26, -6.4], [-22.5, -6.2], [-20, -5.0]], h: 0.75 },
    { pts: [[16.5, -5.0], [19.5, -6.6], [23.5, -7.0], [27.0, -6.0]], h: 0.7 },
    { pts: [[-23.8, 2.0], [-24.6, 6.5], [-24.4, 11.5], [-23.2, 16.4]], h: 0.6, plateau: true },
  ];

  // --- trees (planned first so the ground under them turns to forest floor)
  const trees = [];            // {x,z,type,s,yaw}
  const treeOK = (x, z) => {
    if (x > -27 && x < 27 && z > -6 && z < 18.4) return false;                 // house, terrace, parking
    if (x > -27 && x < -10 && z > -2 && z < 18.4) return false;
    if (z > -34 && z < -5 && x > -40 && x < 44) return false;                  // the lake view stays open (added back sparsely below)
    if (terrainV(x, z) < WATER_Y + 0.6) return false;
    for (const [px, pz] of pathPts) if ((px - x) ** 2 + (pz - z) ** 2 < 4) return false;
    for (let i = 0; i < BW.length - 1; i++) if (distSeg(x, z, ...BW[i], ...BW[i + 1]) < 2.2) return false;
    return true;
  };
  { let tries = 0;
    while (trees.length < 1250 && tries++ < 60000) {
      const x = -150 + R() * 300, z = -40 + R() * 200, d = Math.hypot(x - 5, z - 5);
      if (d > 20 && R() < (d - 20) / 170) continue;                              // denser near, thinner far (terrain tint takes over)
      if (!treeOK(x, z)) continue;
      if (trees.some(t => (t.x - x) ** 2 + (t.z - z) ** 2 < (d < 70 ? 7 : 10))) continue;
      const birch = (z < 25 && R() < 0.35) || R() < 0.15;
      trees.push({ x, z, type: birch ? 3 + (R() < 0.5 ? 0 : 1) : Math.floor(R() * 3), s: 0.75 + R() * 0.55, yaw: R() * 6.28 });
    }
    // a few trees framing the lake slope (r3) and young birches near the house (r1)
    const extra = [[-34, -12, 0], [-38, -22, 1], [-30, -28, 3], [40, -12, 1], [42, -22, 0], [37, -29, 3], [-22, -16, 4], [30, -18, 3],
      [26.5, 2.5, 3], [29.5, 8.5, 4], [-13.5, -6.5, 3], [24.5, -9.5, 4], [18, -26, 4], [-16, -26, 3]];
    for (const [x, z, t] of extra) trees.push({ x, z, type: t, s: 0.8 + R() * 0.3, yaw: R() * 6.28 });
  }

  // ---- ground-weight helpers (pure functions of the layout)
  const gravelD = (x, z) => Math.min(
    Math.max(-21.5 - x, x + 12.2, 0.8 - z, z - 17.6),                         // parking (extended to the back wall, like r1)
    Math.max(-62 - x, x + 21, 3.6 - z, z - 9.4),                              // driveway from the west
    Math.max(-13.5 - x, x - 9.2, 12.5 - z, z - 15.3),                         // entry path behind the house
    Math.max(-11.3 - x, x + 9.7, 1.8 - z, z - 2.3) + 0.3);                    // foot of the parking stair
  const treeGrid = new Map(); for (const t of trees) { const k = Math.floor(t.x / 8) + ',' + Math.floor(t.z / 8); if (!treeGrid.has(k)) treeGrid.set(k, []); treeGrid.get(k).push(t); }
  const nearTree = (x, z) => { let m = 0; const i0 = Math.floor(x / 8), j0 = Math.floor(z / 8);
    for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) for (const t of treeGrid.get(i + ',' + j) || []) { const d2 = (t.x - x) ** 2 + (t.z - z) ** 2; m = Math.max(m, Math.exp(-d2 / (t.type > 2 ? 6 : 10))); } return m; };
  const pathGrid = new Map(); for (const p of pathPts) { const k = Math.floor(p[0] / 4) + ',' + Math.floor(p[1] / 4); if (!pathGrid.has(k)) pathGrid.set(k, []); pathGrid.get(k).push(p); }
  const nearPath = (x, z) => { let d = 1e9; const i0 = Math.floor(x / 4), j0 = Math.floor(z / 4);
    for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) for (const p of pathGrid.get(i + ',' + j) || []) d = Math.min(d, Math.hypot(p[0] - x, p[1] - z)); return d; };
  const macro = (x, z) => [fbm(x * 0.035, z * 0.035), fbm(x * 0.11 + 7, z * 0.11 + 3)];
  const lawnW = (x, z, y) => {
    const n = fbm(x * 0.06, z * 0.06);
    let lawn = 1 - sstep(34, 52, Math.hypot((x - 6) / 1.25, (z + 4) / 1.15) + n * 9);   // the garden around the house + slope to the lake
    if (z > 12.25 && z < TER_Z && x > -26 && x < 30) lawn = Math.max(lawn, 0.95);       // the plateau strip behind the house
    if (z >= TER_Z) lawn *= 1 - sstep(TER_Z + 0.5, TER_Z + 3.5 + n * 2, z);            // terraces: grass at the edge, then forest
    return lawn;
  };

  // small stuff (grass, flowers, shrubs, ferns, rocks, flagstones) is skipped in the lake reflection pass
  const NRF = new NoReflect(); G.add(NRF);

  // ================================================================ MASK for vegetation
  const mask = new Mask(-70, 70, -40, 34, 0.25);
  mask.rect(-9.8, 22.5, -2.0, 12.6, 2);                               // house footprint (+ deck posts line)
  mask.rect(-10.4, -8.35, -4.6, 1.7, 2);                              // kept clear: landing of the house's black steel stair (quincho deck, x≈-8.7)
  mask.rect(-8.6, 22.6, -2.75, -0.1, 2);                              // flagstone terrace
  mask.rect(-23.5, -9.6, 0, 18.4, 2);                                 // parking + stair + walls
  mask.rect(-62, -21, 3.3, 9.7, 2);                                   // driveway
  mask.rect(-13.8, 9.5, 12.2, 15.6, 2);                               // entry path
  mask.rect(-47.6, -10.8, -0.25, 0.6, 2); mask.rect(19.2, 41.2, 11.5, 12.6, 2);
  mask.rect(-25.8, 24.8, 17.9, 19.3, 2);                              // big wall line
  for (const st of steps) mask.poly(st.poly.map(([x, z]) => [x, z]), 2), mask.disk(st.cx, st.cz, 0.62, 1);
  for (let i = 0; i < BW.length - 1; i++) { const [ax, az] = BW[i], [bx, bz] = BW[i + 1]; mask.rect(Math.min(ax, bx) - 0.8, Math.max(ax, bx) + 0.8, Math.min(az, bz) - 0.8, Math.max(az, bz) + 0.8, 2); }
  mask.rect(DOCK.x0 - 0.3, DOCK.x1 + 0.3, DOCK.z0, DOCK.z1 + 0.5, 2);
  for (const w of LOWWALLS) for (let q = 0; q < w.pts.length - 1; q++) { const [ax, az] = w.pts[q], [bx, bz] = w.pts[q + 1]; const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.2); for (let t = 0; t <= n; t++) mask.disk(lerp(ax, bx, t / n), lerp(az, bz, t / n), 0.45, 2); }
  for (const [x, z] of [[10.1, -27.9], [0.4, -28.6]]) mask.disk(x, z, 1.2, 2);
  const lawnAt = (x, z) => { const y = terrainV(x, z); if (y < WATER_Y + 0.35) return 0; let w = lawnW(x, z, y) * (1 - nearTree(x, z) * 0.8); const gd = gravelD(x, z); if (gd < 0.4) w = 0; return w; };

  // ================================================================ VEGETATION PLAN (spots first: the terrain bakes occlusion under them)
  // shrub clumps (Poly Haven shrub_02, the two lighter nodes): house base, garden, path edges, wall feet (r1)
  const shrubSpots = [], fernSpots = [], bushSpots = [], rockSpots = [], boulderSpots = [];
  const ok = (x, z, r = 0.6) => !mask.get(x, z) && !mask.get(x + r, z) && !mask.get(x - r, z) && !mask.get(x, z + r) && !mask.get(x, z - r) && terrainV(x, z) > WATER_Y + 0.4;
  const addShrub = (x, z, s) => { if (shrubSpots.length >= 60 || !ok(x, z, 0.45 * s)) return false; shrubSpots.push({ x, z, s, yaw: R() * 6.28, v: Math.floor(R() * 2), dy: -0.12 * s }); mask.disk(x, z, 0.55 * s, 1); return true; };
  const addBush = (x, z, s) => { if (!ok(x, z, 0.3 * s)) return false; bushSpots.push({ x, z, s, yaw: R() * 6.28, v: R() < 0.5 ? 0 : 1, dy: -0.1 * s }); mask.disk(x, z, 0.5 * s, 1); return true; };
  // a clump = 1-3 model shrubs + card bushes around them (r1: lush masses, not single plants)
  const clump = (x, z, big = 1) => { const n = 2 + Math.floor(R() * 3.5);
    if (R() < 0.35) addShrub(x + (R() - 0.5), z + (R() - 0.5), (0.6 + R() * 0.4) * big);
    for (let i = 0; i < n; i++) { const a = R() * 6.28, r = i ? 0.8 + R() * 1.1 : 0; addBush(x + Math.cos(a) * r, z + Math.sin(a) * r, (0.75 + R() * 0.7) * big); } };
  for (let x = -8; x < 22.5; x += 2.6 + R() * 2.6) clump(x, -3.4 - R() * 0.9, 0.85);                              // terrace edge
  for (let i = 0; i < 8; i++) clump(23.5 + R() * 13, -3 + R() * 14.5);                                            // east lawn beds
  for (let i = 0; i < 6; i++) clump(-44 + R() * 30, -2.4 - R() * 1.6);                                            // foot of the parking wall
  for (let i = 0; i < 7; i++) clump(-22 + R() * 46, 13.6 + R() * 4.2, 0.9);                                        // behind the house, wall foot
  for (const [px, pz] of pathPts) if (R() < 0.1) { const side = R() < 0.5 ? -1 : 1; clump(px + side * (1.6 + R() * 1.0), pz + (R() - 0.5), 0.8); }
  for (let i = 0, nc = 0; i < 900 && nc < 55; i++) { const x = -14 + R() * 44, z = -27 + R() * 22; if (fbm(x * 0.13, z * 0.13) > -0.02 && lawnAt(x, z) > 0.3) { clump(x, z, 0.85 + R() * 0.35); nc++; } }   // the garden between the paths (r1)
  for (let i = 0, nc = 0; i < 600 && nc < 30; i++) { const x = -34 + R() * 76, z = -30 + R() * 26; if (fbm(x * 0.1, z * 0.1) > 0.15 && lawnAt(x, z) > 0.3) { clump(x, z, 0.9 + R() * 0.3); nc++; } }
  // forest undergrowth + terrace tops (cheap card bushes)
  for (let i = 0, nf = 0; i < 3000 && nf < 360; i++) { const x = -70 + R() * 140, z = -32 + R() * 70, y = terrainV(x, z);
    if (mask.get(x, z) || y < WATER_Y + 0.5) continue; const dist = Math.hypot(x - 6, z - 4); if (dist < 26 && z < 12) continue;
    if (nearTree(x, z) < 0.2 && R() < 0.8) continue; if (addBush(x, z, 0.8 + R() * 0.9)) nf++; }
  // ferns: shade, path edges, under trees near the house, wall feet
  for (let i = 0; i < 1400 && fernSpots.length < 200; i++) { const x = -40 + R() * 90, z = -30 + R() * 58; if (!ok(x, z, 0.3)) continue;
    const t = nearTree(x, z), p = nearPath(x, z) < 1.8 ? 0.45 : 0, w = z > 12.4 && z < 18.4 ? 0.6 : 0; if (R() > Math.max(t, p, w, 0.02)) continue;
    fernSpots.push({ x, z, s: 0.9 + R() * 0.9, yaw: R() * 6.28, v: R() < 0.72 ? 2 + Math.floor(R() * 2) : Math.floor(R() * 2) }); }
  // big pale boulders on the lawn and slope (r1): the scanned rocks, desaturated + lightened
  const boulderAt = [[-3.2, -8.6, 1.5], [2.4, -12.0, 1.9], [-9.4, -13.2, 1.3], [15.6, -9.8, 1.4], [18.5, -17.4, 1.7], [-12.3, -24.5, 1.4], [6.8, -18.6, 1.2], [26.5, -3.8, 1.3], [-20.5, -9.8, 1.6], [4.6, -24.2, 1.1], [32, -14, 1.5]];
  for (const [x, z, s] of boulderAt) { if (mask.get(x, z) === 2) continue; boulderSpots.push({ x, z, s, yaw: R() * 6.28, v: Math.floor(R() * 3), dy: -0.25 * s, sx: 1, sy: 0.85 }); mask.disk(x, z, 1.1 * s, 1);
    physics.solid(x - 0.7 * s, x + 0.7 * s, z - 0.6 * s, z + 0.6 * s, terrainV(x, z) - 0.2, terrainV(x, z) + 0.7 * s); }
  // small rocks: shoreline, steep bits, under trees, wall foot — procedural low-poly, triplanar mossy rock
  for (let i = 0; i < 1400 && rockSpots.length < 150; i++) { const x = -60 + R() * 120, z = -36 + R() * 72, y = terrainV(x, z); if (mask.get(x, z) === 2) continue;
    const shore = y < WATER_Y + 0.9 && y > WATER_Y - 0.5, slope = Math.abs(terrainV(x + 0.5, z) - terrainV(x - 0.5, z)) + Math.abs(terrainV(x, z + 0.5) - terrainV(x, z - 0.5));
    if (!(shore || slope > 0.6 || (nearTree(x, z) > 0.3 && R() < 0.3))) continue; rockSpots.push({ x, z, s: (shore ? 0.35 : 0.25) + R() * 0.55, yaw: R() * 6.28, v: Math.floor(R() * 3), dy: -0.12 }); }
  for (let x = -47; x < -12; x += 2.4 + R() * 3) rockSpots.push({ x, z: -0.6 - R() * 0.4, s: 0.3 + R() * 0.3, yaw: R() * 6.28, v: Math.floor(R() * 3), dy: -0.1 });   // wall foot
  // ---- baked ground occlusion: darker ground under/around shrubs, rocks, trees and at wall feet (grounds everything)
  const AO = new Float32Array(mask.w * mask.h);
  const splat = (x, z, r, k) => { const c = mask.c, i0 = Math.max(0, Math.floor((x - 2 * r - mask.x0) / c)), i1 = Math.min(mask.w - 1, Math.floor((x + 2 * r - mask.x0) / c)),
      j0 = Math.max(0, Math.floor((z - 2 * r - mask.z0) / c)), j1 = Math.min(mask.h - 1, Math.floor((z + 2 * r - mask.z0) / c));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const px = mask.x0 + (i + 0.5) * c, pz = mask.z0 + (j + 0.5) * c, d2 = ((px - x) ** 2 + (pz - z) ** 2) / (r * r);
      if (d2 < 4) { const v = k * Math.exp(-d2 * 1.3), q = j * mask.w + i; if (v > AO[q]) AO[q] = v; } } };
  for (const s_ of shrubSpots) splat(s_.x, s_.z, 1.0 * s_.s, 0.6);
  for (const s_ of bushSpots) splat(s_.x, s_.z, 0.8 * s_.s, 0.45);
  for (const s_ of boulderSpots) splat(s_.x, s_.z, 1.2 * s_.s, 0.6);
  for (const s_ of rockSpots) splat(s_.x, s_.z, 0.6 * s_.s, 0.4);
  for (const s_ of fernSpots) splat(s_.x, s_.z, 0.45 * s_.s, 0.3);
  for (const t of trees) if (Math.abs(t.x) < 75 && t.z > -42 && t.z < 36) splat(t.x, t.z, (t.type > 2 ? 1.6 : 2.3) * t.s, 0.4);
  const wallFoot = (pts, off) => { for (let q = 0; q < pts.length - 1; q++) { const [ax, az] = pts[q], [bx, bz] = pts[q + 1], n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.35); for (let t = 0; t <= n; t++) splat(lerp(ax, bx, t / n) + off[0], lerp(az, bz, t / n) + off[1], 0.9, 0.45); } };
  wallFoot([[-11.0, 0], [-47.5, 0]], [0, -0.35]); wallFoot([[19.4, 12.0], [41, 12.0]], [0, -0.35]); wallFoot([[-25.3, 18.4], [24.3, 18.4]], [0, -0.35]);
  for (const w of LOWWALLS) wallFoot(w.pts, [0, 0]);
  const aoAt = (x, z) => { const i = Math.floor((x - mask.x0) / mask.c), j = Math.floor((z - mask.z0) / mask.c); return i < 0 || j < 0 || i >= mask.w || j >= mask.h ? 0 : AO[j * mask.w + i]; };

  // ================================================================ TERRAIN
  function axis(a0, a1, c0, c1, fine, grow, cap, extra) {
    const L = []; let v = c0; while (v > a0) { L.push(v); v -= Math.min(cap, fine + (c0 - v) * grow); } L.push(a0);
    const M_ = []; for (let x = c0 + fine; x < c1; x += fine) M_.push(x);
    const Rr = []; v = c1; while (v < a1) { Rr.push(v); v += Math.min(cap, fine + (v - c1) * grow); } Rr.push(a1);
    let arr = [...L.reverse(), ...M_, ...Rr];
    for (const e of extra) { arr = arr.filter(q => Math.abs(q - e) > 0.07); arr.push(e - 0.012, e + 0.012); }
    return arr.sort((a, b) => a - b);
  }
  const XS = axis(-300, 300, -34, 44, 0.4, 0.03, 9, [-25, -11.25, -11, -9.75, -2, 4, 24]);
  const ZS = axis(-125, 300, -38, 30, 0.4, 0.03, 9, [0.25, 6.75, 12.25, 13.5, TER_Z]);
  const NX = XS.length, NZ = ZS.length, NV = NX * NZ;
  const pos = new Float32Array(NV * 3), nor = new Float32Array(NV * 3), uvA = new Float32Array(NV * 2), wts = new Float32Array(NV * 4), aux = new Float32Array(NV * 4);
  // helpers for weights
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const k = j * NX + i, x = XS[i], z = ZS[j], y = terrainV(x, z);
    pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z; uvA[k * 2] = x; uvA[k * 2 + 1] = z;
    // one-sided slopes (choose the gentler side so the cliff tops under the walls stay flat-shaded)
    const h = 0.3, yxp = terrainV(x + h, z), yxm = terrainV(x - h, z), yzp = terrainV(x, z + h), yzm = terrainV(x, z - h);
    const gx = Math.abs(yxp - y) < Math.abs(y - yxm) ? (yxp - y) / h : (y - yxm) / h, gz = Math.abs(yzp - y) < Math.abs(y - yzm) ? (yzp - y) / h : (y - yzm) / h;
    const nl = Math.hypot(gx, 1, gz); nor[k * 3] = -gx / nl; nor[k * 3 + 1] = 1 / nl; nor[k * 3 + 2] = -gz / nl;
    const slope = Math.hypot(gx, gz);
    // weights
    let wL = lawnW(x, z, y), wF = 1 - wL, wD = 0, wG = 0;
    const tn = nearTree(x, z); wF = Math.max(wF, tn * 0.85); wL *= 1 - tn * 0.8;
    const n2 = fbm(x * 0.09 + 11, z * 0.09 - 4);
    if (z < -6 && y > WATER_Y + 0.3) wD += sstep(0.1, 0.45, n2) * 0.55 * sstep(-6, -12, z);    // sun-bleached patches on the lake slope
    wD += sstep(0.5, 0.9, slope) * 0.9;
    const pd = nearPath(x, z); wD += (1 - sstep(0.5, 1.2, pd)) * 0.6; wL *= sstep(0.35, 1.0, pd) * 0.6 + 0.4;   // trampled edges
    for (let q = 0; q < BW.length - 1; q++) { const d = distSeg(x, z, ...BW[q], ...BW[q + 1]); if (d < 1.4) { wD += (1 - d / 1.4) * 0.5; wF += (1 - d / 1.4) * 0.4; } }
    const gd = gravelD(x, z) + fbm(x * 0.5, z * 0.5) * 0.35; wG = 1 - sstep(-0.15, 0.3, gd);
    if (y < WATER_Y + 0.7) { const s = sstep(WATER_Y + 0.7, WATER_Y + 0.1, y); wG = Math.max(wG, s * 0.7); wD += s * 0.6; wL *= 1 - s; }   // pebbly shore
    const keep = 1 - wG; wL *= keep; wF *= keep; wD *= keep;
    const sum = wL + wF + wD + wG + 1e-6; wts.set([wL / sum, wF / sum, wD / sum, wG / sum], k * 4);
    // aux: far canopy tint (the forested hills), macro colour
    const dH = Math.hypot(x - 5, (z - 5) * 1.1), mc = macro(x, z);
    const canopy = y > WATER_Y + 1 ? sstep(95, 170, dH + fbm(x * 0.02, z * 0.02) * 30) : 0;
    aux.set([canopy, mc[0], mc[1], aoAt(x, z)], k * 4);
  }
  const idx = new Uint32Array((NX - 1) * (NZ - 1) * 6); let ii = 0;
  for (let j = 0; j < NZ - 1; j++) for (let i = 0; i < NX - 1; i++) { const a = j * NX + i, b = a + 1, c = a + NX, d = c + 1; idx[ii++] = a; idx[ii++] = c; idx[ii++] = b; idx[ii++] = b; idx[ii++] = c; idx[ii++] = d; }
  const tgeo = new THREE.BufferGeometry();
  tgeo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); tgeo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  tgeo.setAttribute('uv', new THREE.BufferAttribute(uvA, 2)); tgeo.setAttribute('wts', new THREE.BufferAttribute(wts, 4)); tgeo.setAttribute('aux', new THREE.BufferAttribute(aux, 4));
  tgeo.setIndex(new THREE.BufferAttribute(idx, 1)); tgeo.computeBoundingSphere();
  // TSL material: world-UV texture blend + macro variation (no visible tiling)
  const tmat = new THREE.MeshStandardNodeMaterial({ roughness: 0.96, metalness: 0 });
  {
    const U = uv(), w = attribute('wts', 'vec4'), ax = attribute('aux', 'vec4');
    const rot = (p, a, s) => vec2(p.x.mul(Math.cos(a)).sub(p.y.mul(Math.sin(a))), p.x.mul(Math.sin(a)).add(p.y.mul(Math.cos(a)))).div(s);
    const m1 = smoothstep(-0.25, 0.25, ax.z);
    const lawnT = mix(texture(TL.map, U.div(2.3)).rgb, texture(TL.map, rot(U, 0.9, 5.3)).rgb, m1);
    const forT = mix(texture(TF.map, U.div(2.6)).rgb, texture(TF.map, rot(U, 2.1, 6.1)).rgb, m1);
    const dryT = texture(TD.map, rot(U, 0.4, 2.4)).rgb;
    const grav = texture(TG.map, U.div(1.35)).rgb.pow(1.45).mul(vec3(0.82, 0.8, 0.77));   // more contrast: reads as loose stones, not concrete
    // The Poly Haven photos are brown (leaf litter, sand). Use them as luminance DETAIL and paint the colour ourselves.
    const det = (t, avg, k) => luminance(t).div(avg).clamp(0.3, 1.9).pow(k);
    const sunny = smoothstep(-0.45, 0.55, ax.y);
    const greenness = lawnT.g.sub(lawnT.r).mul(5).clamp(-0.6, 0.6);        // green blades vs brown leaves in the photo
    const lawn = mix(vec3(0.04, 0.11, 0.015), vec3(0.1, 0.17, 0.028), sunny).mul(det(lawnT, 0.24, 1.15))
      .mul(vec3(float(1).sub(greenness.mul(0.3)), float(1).add(greenness.mul(0.3)), float(1)));
    const forest = mix(vec3(0.045, 0.075, 0.02), vec3(0.078, 0.07, 0.032), smoothstep(-0.2, 0.45, ax.z)).mul(det(forT, 0.23, 1.0));
    const dry = mix(vec3(0.17, 0.155, 0.07), vec3(0.12, 0.13, 0.05), smoothstep(-0.3, 0.3, ax.z)).mul(det(dryT, 0.31, 1.0));
    const wsum = w.x.add(w.y).add(w.z).add(w.w).max(0.001);
    let alb = lawn.mul(w.x).add(forest.mul(w.y)).add(dry.mul(w.z)).add(grav.mul(w.w)).div(wsum);
    alb = alb.mul(float(1).add(ax.z.mul(0.22))).mul(float(1).sub(ax.w.mul(0.72)));
    const canopyC = mix(vec3(0.035, 0.06, 0.024), vec3(0.07, 0.1, 0.038), smoothstep(-0.4, 0.4, ax.z));
    alb = mix(alb, canopyC, ax.x);
    const wet = smoothstep(WATER_Y + 0.9, WATER_Y + 0.05, positionWorld.y); alb = alb.mul(float(1).sub(wet.mul(0.4)));
    tmat.colorNode = alb;
    const nmix = texture(TL.normalMap, U.div(2.3)).rgb.mul(w.x).add(texture(TF.normalMap, U.div(2.6)).rgb.mul(w.y)).add(vec3(0.5, 0.5, 1).mul(w.z)).add(texture(TG.normalMap, U.div(1.35)).rgb.mul(w.w)).div(wsum);
    tmat.normalNode = normalMap(nmix, vec2(0.9).mul(float(1).sub(ax.x)));
  }
  const terrain = new THREE.Mesh(tgeo, tmat); terrain.receiveShadow = true; terrain.castShadow = false; terrain.userData.noMerge = true; terrain.name = 'terrain'; G.add(terrain);
  stats.terrainVerts = NV;

  // ================================================================ RETAINING WALLS
  const retainBox = (x0, x1, z0, z1, y1 = 3) => { B.wall.add(boxGeo(x0, x1, -0.3, y1, z0, z1, 3.6)); physics.floorRect(x0, x1, z0, z1, y1); physics.solid(x0, x1, z0, z1, 0, y1); };
  // v1 walls against the house (positions unchanged; mostly hidden behind the house)
  retainBox(-10.0, -2.5, 12.0, 12.5);          // behind laundry / bath 4
  retainBox(-2.5, -1.96, 11.36, 14.0);         // patio inglés west
  retainBox(3.77, 4.5, 11.36, 14.0);           // patio inglés east
  retainBox(-2.5, 4.5, 13.58, 14.0);           // patio inglés back
  retainBox(4.5, 11.2, 11.36, 12.5);           // under the entry
  retainBox(11.2, 19.4, 12.0, 12.5);           // behind the storerooms
  retainBox(19.07, 19.4, 9.1, 12.0);           // outdoor storeroom (east)
  retainBox(-10.0, -9.5, 6.4, 12.5);           // hanging-yard (west)
  retainBox(-11.0, -10.0, 6.4, 7.0);           // parking stair head
  // visible v1 walls, rebuilt as battered dry-stone (same footprint, plus physics as v1)
  // east of the house: along z=12 from x=19.4, extended to x=41 where the far bank takes over
  dryWall(B.wall, [[19.4, 12.02], [41.0, 12.02]], { top: () => 3.02, bot: () => -0.3, side: 1, thick: 0.5, batter: 0.08, seed: 3 });
  physics.floorRect(19.4, 41, 12.0, 12.5, 3); physics.col(19.4, 12.0, 41, 12.0, -0.3, 3, 0.06);
  // parking: east edge (x=-11) and front (z=0), 3 m + a 0.45 m parapet (fall protection, like r1)
  dryWall(B.wall, [[-11.02, 6.4], [-11.02, 0.02]], { top: () => 3.0, bot: () => -0.3, side: -1, thick: 0.5, batter: 0.08, seed: 4 });
  dryWall(B.wall, [[-11.02, 0.02], [-47.5, 0.02]], { top: () => 3.0, bot: () => -0.3, side: -1, thick: 0.5, batter: 0.08, seed: 5 });
  physics.floorRect(-11.5, -11.0, 0, 7.0, 3); physics.solid(-11.5, -11.0, 0, 7.0, 0, 3);
  physics.floorRect(-47.5, -11.0, 0, 0.5, 3); physics.col(-47.5, 0.0, -11.0, 0.0, -0.3, 3, 0.06);
  dryWall(B.wall, [[-11.28, 6.3], [-11.28, 0.3], [-47.5, 0.3]], { top: () => 3.46, bot: () => 2.95, side: -1, both: true, thick: 0.34, batter: 0.02, amp: 0.03, step: 0.3, seed: 6 });
  physics.col(-11.3, 0.3, -11.3, 6.3, 3, 3.46, 0.2); physics.col(-47.5, 0.3, -11.3, 0.3, 3, 3.46, 0.2);
  // BIG angled walls around/behind the parking plateau (r1): 4.2 m behind the parking, 2 m behind the house, wing walls up the hill
  const WZ = 18.4;
  dryWall(B.wall, [[-25.3, WZ], [-11.0, WZ]], { top: () => 7.2, bot: () => 2.7, side: 1, thick: 0.6, batter: 0.13, amp: 0.07, step: 0.36, seed: 7 });
  dryWall(B.wall, [[-11.0, WZ], [24.3, WZ]], { top: () => 5.0, bot: () => 2.7, side: 1, thick: 0.6, batter: 0.11, amp: 0.06, seed: 8 });
  const fillA = z => z < TER_Z ? 7.2 : 7.2 - Math.max(0, z - 24) * 0.6, fillB = z => z < TER_Z ? 5.0 : 5.0 - Math.max(0, z - 22) * 0.6;
  const wingEnd = (topF, x) => { let z = WZ; while (z < 40 && topF(z) > terrainH(x, z) + 0.05) z += 0.25; return z; };
  const zA = wingEnd(fillA, -25.3), zB = wingEnd(fillB, 24.3), zS = (() => { let z = WZ; while (z < 40 && fillA(z) > Math.max(terrainH(-10.7, z), fillB(z)) + 0.05) z += 0.25; return z; })();
  dryWall(B.wall, [[-25.3, WZ - 0.2], [-25.3, zA]], { top: (x, z) => fillA(z), bot: (x, z) => Math.min(terrainH(-25.6, z), fillA(z)) - 0.3, side: -1, thick: 0.6, batter: 0.13, amp: 0.07, seed: 9 });
  dryWall(B.wall, [[-10.7, WZ], [-10.7, zS]], { top: (x, z) => fillA(z), bot: (x, z) => Math.max(terrainH(-10.4, z), fillB(z)) - 0.3, side: 1, thick: 0.3, batter: 0.1, amp: 0.06, seed: 10 });
  dryWall(B.wall, [[24.3, WZ - 0.2], [24.3, zB]], { top: (x, z) => fillB(z), bot: (x, z) => Math.min(terrainH(24.6, z), fillB(z)) - 0.3, side: 1, thick: 0.6, batter: 0.11, amp: 0.06, seed: 11 });
  // physics: faces + terrace tops
  physics.col(-25.3, WZ, -11.0, WZ, 2.7, 7.2, 0.08); physics.col(-11.0, WZ, 24.3, WZ, 2.7, 5.0, 0.08);
  physics.col(-25.3, WZ, -25.3, 24.5, 2.7, 7.2, 0.1); physics.col(-25.3, 24.5, -25.3, zA, 2.7, 6.8, 0.1);
  physics.col(-10.7, WZ, -10.7, zS, 4.7, 7.2, 0.1); physics.col(24.3, WZ, 24.3, zB, 2.7, 5.0, 0.1);
  physics.floorRect(-25.3, -11.0, WZ, 24, 7.2); physics.ramp(-25.0, -11.0, 24, 31, 'z', 24, 31, 7.2, 3.0);
  physics.floorRect(-11.0, 24.3, WZ, 22, 5.0); physics.ramp(-11.0, 24.0, 22, 25.34, 'z', 22, 25.34, 5.0, 3.0);
  // low garden walls (r2)
  LOWWALLS.forEach((w, i) => {
    const base = w.plateau ? 3 : null;
    dryWall(B.wall, w.pts, { top: (x, z) => (base ?? terrainH(x, z)) + w.h, bot: (x, z) => (base ?? terrainH(x, z)) - 0.25, both: true, thick: 0.5, batter: 0.06, amp: 0.035, step: 0.28, tile: 3.0, seed: 20 + i });
    for (let q = 0; q < w.pts.length - 1; q++) { const [ax, az] = w.pts[q], [bx, bz] = w.pts[q + 1]; physics.col(ax, az, bx, bz, (base ?? terrainH(ax, az)) - 0.2, (base ?? terrainH(ax, az)) + w.h, 0.25); }
  });

  // ================================================================ FLAGSTONE TERRACE along the lower floor (z -0.2 → -3)
  const POSTS = [[-1.9, -1.7], [1.86, -1.7], [5.56, -1.7], [9.3, -1.7]];
  { const seeds = [], sp = 0.62;
    for (let z = -0.45; z > -3.5; z -= sp) for (let x = -8.4; x < 22.6; x += sp) seeds.push([x + (R() - 0.5) * 0.36 + ((Math.round(z / sp) & 1) * sp * 0.5), z + (R() - 0.5) * 0.3]);
    const Nt = perlin(77);
    for (let s = 0; s < seeds.length; s++) {
      const [sx, sz] = seeds[s]; let poly = [[sx - 1, sz - 1], [sx + 1, sz - 1], [sx + 1, sz + 1], [sx - 1, sz + 1]];
      for (let t = 0; t < seeds.length; t++) { if (t === s) continue; const [tx, tz] = seeds[t]; if (Math.abs(tx - sx) > 1.6 || Math.abs(tz - sz) > 1.6) continue;
        const mx = (sx + tx) / 2, mz = (sz + tz) / 2, nx = tx - sx, nz = tz - sz; poly = clipHalf(poly, mx, mz, nx, nz); if (poly.length < 3) break; }
      poly = clipHalf(poly, 0, -0.2, 0, 1);                                    // straight edge along the house
      poly = clipHalf(poly, -8.4, 0, -1, 0); poly = clipHalf(poly, 22.4, 0, 1, 0);
      if (poly.length < 3) continue;
      let cx = 0, cz = 0; for (const [x, z] of poly) { cx += x; cz += z; } cx /= poly.length; cz /= poly.length;
      if (cz < -2.55 + Nt(cx * 0.7, 3) * 0.55 && R() < 0.85) continue;          // ragged lawn edge
      if (POSTS.some(([px, pz]) => Math.hypot(px - cx, pz - cz) < 0.42)) continue;
      const gap = 0.04; poly = poly.map(([x, z]) => { const dx = x - cx, dz = z - cz, l = Math.hypot(dx, dz) || 1; return [x - dx / l * gap, z - dz / l * gap]; });
      const k = 0.82 + R() * 0.2, c = [0.95 * k, 0.93 * k, 0.88 * k];
      B.flag.add(slabGeo(poly, 0.075 + R() * 0.012, 0.16, 1.7, 0.02), c);
    }
    physics.floorRect(-8.4, 22.4, -2.7, -0.2, 0.08);
  }
  function clipHalf(poly, mx, mz, nx, nz) {   // keep points with (p-m)·n <= 0
    const out = [], f = p => (p[0] - mx) * nx + (p[1] - mz) * nz;
    for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length], fa = f(a), fb = f(b);
      if (fa <= 0) out.push(a); if ((fa <= 0) !== (fb <= 0)) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); } }
    return out;
  }

  // ================================================================ STONE STEP PATHS (r1)
  for (const st of steps) {
    const k = 0.8 + R() * 0.2; B.flag.add(slabGeo(st.poly, st.top, 0.42, 1.6, 0.03), [0.97 * k, 0.95 * k, 0.9 * k]);
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (const [x, z] of st.poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const sx = (x1 - x0) * 0.18, sz = (z1 - z0) * 0.18; physics.floorRect(x0 + sx, x1 - sx, z0 + sz, z1 - sz, st.top);
  }
  // small flat stone landings where the paths reach the shore
  for (const [x, z] of [[10.1, -27.9], [0.4, -28.6]]) { const poly = irregularPoly(x, z, 1.1, 0.8, R(), R, 11, 0.1, 0.6); const top = Math.max(...poly.map(([a, b]) => terrainH(a, b))) + 0.05; B.flag.add(slabGeo(poly, top, 0.5, 1.6), [0.8, 0.79, 0.75]); physics.floorRect(x - 0.8, x + 0.8, z - 0.55, z + 0.55, top); }

  // ================================================================ PARKING STAIR (x -11..-10, z 7.0 → 2.0) — stone blocks + cheek wall (r2)
  { const n = 17, z0 = 6.4, z1 = 2.0;
    for (let i = 0; i < n; i++) { const za = z0 - (i + 1) * (z0 - z1) / n, zb = z0 - i * (z0 - z1) / n + 0.04, top = 3 - (i + 0.5) * 3 / n;
      const poly = [[-11.0, za], [-10.02, za + (R() - 0.5) * 0.03], [-10.02, zb], [-11.0, zb]];
      const k = 0.78 + R() * 0.16; B.flag.add(slabGeo(poly, top + 0.04, Math.max(0.3, top + 0.3), 1.3, 0.02), [k, k * 0.98, k * 0.94]); }
    physics.ramp(-11.0, -10.0, z1, z0, 'z', z1, z0, 0, 3);
    dryWall(B.wall, [[-9.97, 1.85], [-9.97, 6.4]], { top: (x, z) => sstep(1.85, 6.4, z) * 3 * 0 + (z - 2.0) / 4.4 * 3 + 0.55, bot: () => -0.3, side: -1, both: true, thick: 0.22, batter: 0.01, amp: 0.02, step: 0.25, tile: 2.4, seed: 30 });
    physics.col(-9.97, 1.85, -9.97, 6.4, 0, 3.6, 0.12);
    // landing stones at the foot
    B.flag.add(slabGeo(irregularPoly(-10.5, 1.45, 0.55, 0.7, 0.1, R, 10, 0.1, 0.5), 0.07, 0.25, 1.6), [0.85, 0.84, 0.8]);
  }

  // ================================================================ BOARDWALK + DOCK (r3)
  {
    const tread = (x0, x1, z0, z1, y, alongX) => {           // boards across the walking direction
      const g = boxGeo(x0, x1, y - 0.06, y, z0, z1, 0);
      const p = g.attributes.position, uvb = g.attributes.uv; for (let i = 0; i < p.count; i++) { const u = alongX ? p.getZ(i) : p.getX(i), v = alongX ? p.getX(i) : p.getZ(i); uvb.setXY(i, u / 2.0, v / 2.0 + (p.getY(i) < y - 0.03 ? 0.3 : 0)); }
      B.deck.add(g); physics.floorRect(x0, x1, z0, z1, y);
    };
    const post = (x, z, y1) => { const y0 = terrainH(x, z) - 0.3; if (y1 - y0 > 0.1) B.timber.add(boxGeo(x - 0.06, x + 0.06, y0, y1, z - 0.06, z + 0.06)); };
    const hw = BW_W / 2;
    for (let i = 0; i < BW.length - 1; i++) {
      const [ax, az] = BW[i], [bx, bz] = BW[i + 1], ya = bwH[i], yb = bwH[i + 1], alongX = az === bz;
      // landing at the corner
      if (i > 0) { tread(ax - hw, ax + hw, az - hw, az + hw, ya, alongX); for (const [px, pz] of [[ax - hw + 0.08, az - hw + 0.08], [ax + hw - 0.08, az - hw + 0.08], [ax - hw + 0.08, az + hw - 0.08], [ax + hw - 0.08, az + hw - 0.08]]) post(px, pz, ya - 0.06); }
      // run from the landing edge to the next landing edge
      const dir = alongX ? Math.sign(bx - ax) : Math.sign(bz - az), s0 = (alongX ? ax : az) + dir * (i > 0 ? hw : 0), s1 = (alongX ? bx : bz) - dir * (i < BW.length - 2 ? hw : 0);
      const drop = ya - yb, n = Math.max(1, Math.round(drop / 0.17)), L = Math.abs(s1 - s0), tl = L / n;
      for (let k = 0; k < n; k++) {
        const a = s0 + dir * k * tl, b = s0 + dir * (k + 1) * tl, y = alongX ? ya : ya - drop * (k + 1) / n + (k === n - 1 ? 0 : 0);
        const lo = Math.min(a, b), hi = Math.max(a, b);
        if (alongX) tread(lo, hi, az - hw, az + hw, y, true); else tread(ax - hw, ax + hw, lo - (k ? 0.02 : 0), hi, y, false);
      }
      // stringers + posts + handrail on the outer (east / lake) side
      const len = L, cx = alongX ? (s0 + s1) / 2 : ax, cz = alongX ? az : (s0 + s1) / 2, dx = alongX ? dir : 0, dz = alongX ? 0 : dir;
      const yTop = ya - (alongX ? 0 : drop / n) - 0.06, yEnd = yb - 0.06, rise = (yEnd - yTop);
      for (const off of [-hw + 0.05, hw - 0.05]) { const ox = alongX ? 0 : off, oz = alongX ? off : 0;
        B.timber.add(orientedBox(cx + ox, cz + oz, dx, dz, len, 0.07, (yTop + yEnd) / 2 - 0.26, (yTop + yEnd) / 2, 0, -rise * dir * (alongX ? 1 : 1)));
        for (let t = 0.05; t <= 1.0; t += 1.6 / Math.max(1.6, len)) { const s = lerp(s0, s1, Math.min(1, t)), yy = lerp(yTop, yEnd, Math.min(1, t)) - 0.25; post(alongX ? s : ax + off, alongX ? az + off : s, yy); }
      }
      // handrail: black steel posts + rail (outer side = +x for z-runs, -z for x-runs)
      const ro = alongX ? -hw + 0.04 : hw - 0.04;
      for (let t = 0; t <= 1.0001; t += 1.5 / Math.max(1.5, len)) { const s = lerp(s0, s1, t), yy = lerp(ya - (alongX ? 0 : drop / n), yb, t);
        const px = alongX ? s : ax + ro, pz = alongX ? az + ro : s; B.steel.add(boxGeo(px - 0.025, px + 0.025, yy, yy + 0.95, pz - 0.025, pz + 0.025)); }
      B.steel.add(orientedBox(alongX ? cx : ax + ro, alongX ? az + ro : cz, dx, dz, len, 0.05, (yTop + yEnd) / 2 + 0.98, (yTop + yEnd) / 2 + 1.03, 0, -rise * dir));
      if (alongX) physics.col(s0, az + ro, s1, az + ro, yb, ya + 1.0, 0.04); else physics.col(ax + ro, s0, ax + ro, s1, yb, ya + 1.0, 0.04);
    }
    // dock: boards across, fascia, posts into the water, a bench-cleat
    for (let z = DOCK.z1; z > DOCK.z0 + 0.01; z -= 0.155) { const g = boxGeo(DOCK.x0, DOCK.x1, DOCK_Y - 0.05, DOCK_Y, z - 0.14, z, 0); const p = g.attributes.position, u = g.attributes.uv; for (let i = 0; i < p.count; i++) u.setXY(i, p.getX(i) / 2.0 + z * 0.37, p.getZ(i) / 2.0); B.deck.add(g); }
    physics.floorRect(DOCK.x0, DOCK.x1, DOCK.z0, DOCK.z1, DOCK_Y);
    B.timber.add(boxGeo(DOCK.x0 - 0.06, DOCK.x0, DOCK_Y - 0.32, DOCK_Y, DOCK.z0, DOCK.z1)); B.timber.add(boxGeo(DOCK.x1, DOCK.x1 + 0.06, DOCK_Y - 0.32, DOCK_Y, DOCK.z0, DOCK.z1));
    B.timber.add(boxGeo(DOCK.x0 - 0.06, DOCK.x1 + 0.06, DOCK_Y - 0.32, DOCK_Y, DOCK.z0 - 0.06, DOCK.z0));
    for (let z = DOCK.z1 - 0.6; z > DOCK.z0 - 0.1; z -= 2.3) for (const x of [DOCK.x0 + 0.05, DOCK.x1 - 0.05]) { const r = 0.1; const cyl = new THREE.CylinderGeometry(r, r, 3.4, 7); cyl.translate(x, DOCK_Y + 0.25 - 1.7, z); B.timber.add(cyl); }
    for (const z of [DOCK.z0 + 0.4, DOCK.z0 + 4.4]) B.steel.add(boxGeo(DOCK.x1 - 0.2, DOCK.x1 - 0.1, DOCK_Y, DOCK_Y + 0.12, z - 0.15, z + 0.15));
  }

  // ================================================================ LAKE (WaterMesh) + far hills
  const waterNormals = await new THREE.TextureLoader().loadAsync('https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/textures/waternormals.jpg');
  waterNormals.wrapS = waterNormals.wrapT = THREE.RepeatWrapping;
  const sunDir = (ctx.sunDir || new THREE.Vector3(-0.78, 0.3, -0.55)).clone().normalize();
  const water = new WaterMesh(new THREE.PlaneGeometry(1400, 760), { waterNormals, sunDirection: sunDir.clone(), sunColor: new THREE.Color(1.0, 0.96, 0.88), waterColor: 0x1d4b5c, distortionScale: 1.4, size: 3.0, resolutionScale: 0.5 });
  water.rotation.x = -Math.PI / 2; water.position.set(5, WATER_Y, -400); water.userData.noMerge = true; water.receiveShadow = true; water.name = 'lake'; G.add(water);
  { // sun glitter (r3): WaterMesh's own specular is weak at grazing angles, so an additive glint layer on top of it,
    // driven by the same normal map and the same sunDirection uniform (so main.js time-of-day updates move it too)
    const gm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true });
    const wp = positionWorld.xz;
    const n1 = texture(waterNormals, wp.mul(0.045).add(vec2(time.mul(0.021), time.mul(0.012)))).xyz.mul(2).sub(1);
    const n2 = texture(waterNormals, wp.mul(0.11).sub(vec2(time.mul(0.016), time.mul(-0.013)))).xyz.mul(2).sub(1);
    const nrm = normalize(vec3(n1.x.add(n2.x), float(2.4), n1.y.add(n2.y)));
    const eye = normalize(cameraPosition.sub(positionWorld));
    const r = reflect(water.sunDirection.negate(), nrm);
    const g = pow(max(dot(eye, r), 0.0), 420.0).mul(70.0).mul(smoothstep(0.02, 0.2, water.sunDirection.y));
    gm.colorNode = vec3(1.0, 0.86, 0.62).mul(g);
    const glint = new THREE.Mesh(new THREE.PlaneGeometry(1400, 760), gm); glint.rotation.x = -Math.PI / 2; glint.position.set(5, WATER_Y + 0.015, -400);
    glint.renderOrder = 2; glint.userData.noMerge = true; glint.name = 'lake_glint'; G.add(glint);
  }
  { // far shore: a band of forested hills around the lake, one mesh
    const pos = [], col = [], idxH = [], NA = 160, NR = 14, c0 = new THREE.Color(), cFar = srgb(64, 86, 80), cNear = srgb(40, 62, 38);
    for (let i = 0; i <= NA; i++) { const a = Math.PI * (1.02 + i / NA * 0.96);
      for (let j = 0; j <= NR; j++) { const r = 560 + j * 26, x = 5 + Math.cos(a) * r * 1.25, z = -30 + Math.sin(a) * r;
        const hh = (18 + 60 * Math.pow(Math.sin(j / NR * Math.PI * 0.5), 1.2)) * (0.6 + 0.4 * (fbm(i * 0.08, j * 0.2) + 0.5)) + fbm(i * 0.4, j * 0.5) * 8;
        pos.push(x, WATER_Y - 3 + (j === 0 ? 0 : hh), z); c0.copy(cNear).lerp(cFar, j / NR * 0.7).multiplyScalar(0.8 + fbm(i * 0.3, j * 0.3) * 0.3); col.push(c0.r, c0.g, c0.b); } }
    for (let i = 0; i < NA; i++) for (let j = 0; j < NR; j++) { const a = i * (NR + 1) + j, b = a + NR + 1; idxH.push(a, b, a + 1, b, b + 1, a + 1); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idxH); g.computeVertexNormals();
    const hills = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 })); hills.userData.noMerge = true; hills.name = 'far_hills'; G.add(hills);
  }

  // ================================================================ PICKUP (dark, parked on the plateau) + BOAT (moored at the dock)
  const paint = new THREE.MeshPhysicalMaterial({ color: srgb(24, 26, 29), metalness: 0.55, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 });
  const dglass = new THREE.MeshPhysicalMaterial({ color: srgb(12, 14, 17), metalness: 0.1, roughness: 0.04, clearcoat: 1 });
  const rubber = new THREE.MeshStandardMaterial({ color: srgb(18, 18, 18), roughness: 0.92 });
  const alloy = new THREE.MeshStandardMaterial({ color: srgb(150, 152, 155), metalness: 0.85, roughness: 0.3 });
  const lamp = new THREE.MeshStandardMaterial({ color: 0xeeeeee, emissive: srgb(255, 245, 230), emissiveIntensity: 0.4, roughness: 0.2 });
  const tail = new THREE.MeshStandardMaterial({ color: srgb(120, 10, 10), emissive: srgb(90, 0, 0), emissiveIntensity: 0.3, roughness: 0.3 });
  const whiteHull = new THREE.MeshPhysicalMaterial({ color: srgb(244, 244, 240), roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.1, vertexColors: true, side: THREE.DoubleSide });
  const seatMat = new THREE.MeshStandardMaterial({ color: srgb(214, 204, 186), roughness: 0.7 });
  const CB = { paint: new Batch(paint), glass: new Batch(dglass), rubber: new Batch(rubber), alloy: new Batch(alloy), lamp: new Batch(lamp, { cast: false }), tail: new Batch(tail, { cast: false }) };
  {
    const T = new THREE.Matrix4().makeRotationY(0.1).setPosition(-17.2, 3.0, 8.4);          // front faces the lake (-z)
    const add = (b, g) => { g.applyMatrix4(T); b.add(g); };
    const rb = (w, h, d, x, y, z, r = 0.08) => { const g = new RoundedBoxGeometry(w, h, d, 2, r); g.translate(x, y, z); return g; };
    // local: x across (1.86 m), z along (front = -z), y up. Hilux-like double cab, 5.33 m.
    add(CB.paint, rb(1.86, 0.62, 2.1, 0, 0.82, -1.62, 0.12));         // front body + hood
    add(CB.paint, rb(1.86, 0.6, 1.62, 0, 0.8, 0.1, 0.1));           // cab lower body (doors)
    { const s = new THREE.Shape([[-0.62, 0], [1.1, 0], [0.84, 0.66], [-0.45, 0.66]].map(([a, b]) => new THREE.Vector2(a, b)));
      const g = new THREE.ExtrudeGeometry(s, { depth: 1.62, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 2 }); g.rotateY(Math.PI / 2); g.translate(-0.81, 1.1, 0.25); add(CB.glass, g); }
    add(CB.paint, rb(1.64, 0.07, 1.36, 0, 1.79, 0.05, 0.03));         // roof
    for (const xs of [-0.82, 0.82]) add(CB.paint, rb(0.07, 0.62, 0.12, xs, 1.43, 0.08, 0.02));   // B-pillars
    for (const xs of [-0.89, 0.89]) add(CB.paint, rb(0.08, 0.66, 1.74, xs, 0.83, 1.76, 0.03));  // bed sides
    add(CB.paint, rb(1.86, 0.3, 1.74, 0, 0.65, 1.76, 0.06));          // bed lower body
    add(CB.paint, rb(1.86, 0.66, 0.08, 0, 0.83, 0.93, 0.03));         // bed front wall
    add(CB.rubber, boxGeo(-0.85, 0.85, 0.8, 0.82, 0.97, 2.58));       // bed liner (black)
    add(CB.paint, rb(1.86, 0.64, 0.08, 0, 0.84, 2.64, 0.03));         // tailgate
    add(CB.rubber, rb(1.76, 0.36, 0.08, 0, 0.84, -2.66, 0.05));       // grille
    add(CB.alloy, rb(1.9, 0.16, 0.14, 0, 0.46, -2.66, 0.05)); add(CB.alloy, rb(1.9, 0.14, 0.12, 0, 0.44, 2.68, 0.05));  // bumpers
    for (const xs of [-0.7, 0.7]) { add(CB.lamp, rb(0.34, 0.12, 0.06, xs, 1.02, -2.64, 0.03)); add(CB.tail, rb(0.08, 0.36, 0.1, xs * 1.26, 0.92, 2.6, 0.02)); }
    for (const [xs, zs] of [[-0.8, -1.58], [0.8, -1.58], [-0.8, 1.52], [0.8, 1.52]]) {
      const tire = new THREE.CylinderGeometry(0.385, 0.385, 0.27, 22); tire.rotateZ(Math.PI / 2); tire.translate(xs, 0.385, zs); add(CB.rubber, tire);
      const rim = new THREE.CylinderGeometry(0.23, 0.23, 0.02, 16); rim.rotateZ(Math.PI / 2); rim.translate(xs + Math.sign(xs) * 0.137, 0.385, zs); add(CB.alloy, rim);
      add(CB.rubber, rb(0.14, 0.2, 1.0, xs * 1.14, 0.82, zs, 0.05));  // arch flares
    }
    add(CB.alloy, rb(0.08, 0.05, 1.6, -0.97, 0.5, -0.1, 0.02)); add(CB.alloy, rb(0.08, 0.05, 1.6, 0.97, 0.5, -0.1, 0.02));   // side steps
    // collider: axis-aligned approx of the rotated body
    physics.solid(-18.35, -16.05, 5.6, 11.2, 3, 4.9);
  }
  const boat = new THREE.Group(); boat.name = 'boat';
  {
    // ~6.6 m bowrider. Lofted hull: stations stern (t=0, z=0) → bow (t=1, z=L); section keel → chine → knuckle → gunwale, mirrored.
    const L = 6.6, NS = 30, W = 9, P = [], C = [], I = [];
    const beam = t => 1.2 * (t < 0.5 ? 1 - 0.04 * (0.5 - t) : Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.5) / 0.5, 2.2)))) + 0.004;
    const keel = t => -0.4 + Math.pow(Math.max(0, t - 0.45) / 0.55, 2.2) * 0.72;
    const sheer = t => 0.52 + Math.pow(t, 2.4) * 0.34;
    const sec = t => { const b = beam(t), yk = keel(t), ys = sheer(t);
      return [[0, yk], [b * 0.62, yk + 0.2 * (1 - t * 0.5)], [b * 0.97, Math.min(ys - 0.2, yk + 0.42)], [b, Math.min(ys - 0.08, yk + 0.62)], [b * 0.985, ys]]; };
    for (let i = 0; i <= NS; i++) { const t = i / NS, h = sec(t), row = [...h.slice().reverse().map(([x, y]) => [-x, y]), ...h.slice(1)];
      for (const [x, y] of row) { P.push(x, y, t * L); const band = y > -0.06 && y < 0.07 ? 1 : y > sheer(t) - 0.07 ? 2 : 0;   // boot stripe, rub rail
        const c = band === 1 ? [0.04, 0.07, 0.13] : band === 2 ? [0.12, 0.12, 0.13] : [1, 1, 1]; C.push(...c); } }
    for (let i = 0; i < NS; i++) for (let j = 0; j < W - 1; j++) { const a = i * W + j, b2 = (i + 1) * W + j; I.push(a, b2, a + 1, b2, b2 + 1, a + 1); }
    { const c0 = P.length / 3; P.push(0, 0.1, 0); C.push(0.95, 0.95, 0.95); for (let j = 0; j < W - 1; j++) I.push(c0, j + 1, j); }   // transom
    const hull = new THREE.BufferGeometry(); hull.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); hull.setAttribute('color', new THREE.Float32BufferAttribute(C, 3)); hull.setIndex(I); hull.computeVertexNormals();
    const add = (g, m) => { const o = new THREE.Mesh(g, m); o.castShadow = o.receiveShadow = true; boat.add(o); return o; };
    add(hull, whiteHull);
    const colored = (g, k = 0.96) => { g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(g.attributes.position.count * 3).fill(k), 3)); return g; };
    // decks at the gunwale: bow deck (t>0.66) and a short stern deck; the cockpit between is sunk (floor at 0.12)
    const deckPts = (t0, t1, inset) => { const pts = []; for (let i = 0; i <= 16; i++) { const t = t0 + (t1 - t0) * i / 16; pts.push([Math.max(0.01, beam(t) * 0.985 - inset), t * L, sheer(t)]); } return pts; };
    const deckGeo = (t0, t1, inset, yOff = 0) => { const a1 = deckPts(t0, t1, inset), pos = [];
      for (let i = 0; i < a1.length - 1; i++) { const [x0, z0, y0] = a1[i], [x1, z1, y1] = a1[i + 1];
        pos.push(-x0, y0 + yOff, z0, x0, y0 + yOff, z0, x1, y1 + yOff, z1, -x0, y0 + yOff, z0, x1, y1 + yOff, z1, -x1, y1 + yOff, z1); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); return colored(g); };
    add(deckGeo(0.66, 1.0, 0.0), whiteHull); add(deckGeo(0.0, 0.1, 0.0), whiteHull);
    add(colored(new THREE.BoxGeometry(2.2, 0.04, 3.6).translate(0, 0.12, 2.6), 0.9), whiteHull);                // cockpit floor
    // cockpit coaming: thin inner wall around the sunk part
    for (const sx of [-1, 1]) add(colored(new THREE.BoxGeometry(0.1, 0.44, 3.7).translate(sx * 1.08, 0.36, 2.65)), whiteHull);
    const seat = (w, h, d, x, y, z) => add(new RoundedBoxGeometry(w, h, d, 2, 0.06).translate(x, y, z), seatMat);
    seat(2.0, 0.2, 0.62, 0, 0.32, 1.1); seat(2.0, 0.42, 0.14, 0, 0.55, 0.84);          // stern bench + backrest
    seat(0.56, 0.18, 0.56, -0.5, 0.36, 3.1); seat(0.56, 0.44, 0.12, -0.5, 0.6, 2.86); // helm seats
    seat(0.56, 0.18, 0.56, 0.5, 0.36, 3.1); seat(0.56, 0.44, 0.12, 0.5, 0.6, 2.86);
    seat(1.4, 0.14, 0.9, 0, 0.62, 4.55);                                                // bow cushions (sunk bow seating)
    add(colored(new RoundedBoxGeometry(0.62, 0.5, 0.48, 2, 0.06).translate(0.5, 0.38, 3.62)), whiteHull);    // console
    add(colored(new RoundedBoxGeometry(0.62, 0.5, 0.48, 2, 0.06).translate(-0.5, 0.38, 3.62)), whiteHull);
    { const ws = new THREE.CylinderGeometry(1.15, 1.15, 0.34, 28, 1, true, -Math.PI * 0.44, Math.PI * 0.88); ws.scale(1, 1, 0.42); ws.rotateY(Math.PI); ws.rotateX(-0.35); ws.translate(0, 0.78, 3.4); add(ws, dglass); }
    add(new THREE.CylinderGeometry(0.02, 0.02, 1.9, 6).rotateZ(Math.PI / 2).translate(0, 0.98, 0.35), alloy);   // tow bar
    for (const sx of [-1, 1]) add(new THREE.CylinderGeometry(0.02, 0.02, 0.4, 6).translate(sx * 0.9, 0.78, 0.35), alloy);
    boat.traverse(o => { if (o.isMesh) o.userData.noMerge = true; });
    boat.position.set(-3.05, WATER_Y + 0.02, -31.2); boat.rotation.y = Math.PI + 0.06;     // bow toward the open lake (-z)
    G.add(boat);
  }

  // small stuff (grass, flowers, shrubs, ferns, rocks, flagstones) is skipped in the lake reflection pass

  // ================================================================ GRASS (instanced tufts, TSL wind)
  const windStrength = uniform(0.13), windSpeed = uniform(1.5);
  {
    const blades = 4, segs = 3, A = { pos: [], nor: [], uv: [] }, Rg = mulberry32(5);
    for (let b = 0; b < blades; b++) {
      const a = (b / blades) * 6.28 + Rg() * 1.2, ox = Math.cos(a) * 0.05, oz = Math.sin(a) * 0.05, h = 0.17 + Rg() * 0.15, w = 0.036 + Rg() * 0.014;
      const lean = 0.25 + Rg() * 0.3, la = a + (Rg() - 0.5) * 1.2, rx = -Math.sin(a + 1.3), rz = Math.cos(a + 1.3);
      const row = f => { const t = f, y = h * t, off = lean * h * t * t, cx = ox + Math.cos(la) * off, cz = oz + Math.sin(la) * off, ww = w * (1 - t) * 0.5;
        return [[cx - rx * ww, y, cz - rz * ww], [cx + rx * ww, y, cz + rz * ww]]; };
      for (let s = 0; s < segs; s++) { const f0 = s / segs, f1 = (s + 1) / segs, [a0, a1] = row(f0), [b0, b1] = row(f1);
        const quad = s === segs - 1 ? [[a0, f0, 0], [a1, f0, 1], [b0, f1, 0.5]] : [[a0, f0, 0], [a1, f0, 1], [b1, f1, 1], [a0, f0, 0], [b1, f1, 1], [b0, f1, 0]];
        for (const [p, v, u] of quad) { A.pos.push(...p); A.uv.push(u, v); A.nor.push(Math.cos(la) * 0.25, 1, Math.sin(la) * 0.25); } }
    }
    const tuft = geoFrom(A);
    const gmat = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide });
    const hgt = uv().y, bend = hgt.mul(hgt);
    const P = positionLocal, phase = hash(instanceIndex).mul(6.283);
    const gust = sin(time.mul(windSpeed).add(P.x.mul(0.19)).add(P.z.mul(0.11))).mul(0.5).add(0.5);
    const sway = sin(time.mul(windSpeed.mul(1.7)).add(phase)).mul(0.35).add(gust.mul(0.8));
    const moved = P.add(vec3(sway.mul(windStrength), 0, sway.mul(windStrength).mul(0.45)).mul(bend));
    gmat.positionNode = moved;
    gmat.colorNode = vec3(mix(float(0.55), float(1.2), hgt.pow(0.7)));   // × instanceColor (applied by NodeMaterial)
    gmat.normalNode = transformNormalToView(vec3(0.0, 1.0, 0.0));        // both faces lit like the lawn below (no dark back faces)
    const COUNT_MAX = 40000, grass = new THREE.InstancedMesh(tuft, gmat, COUNT_MAX), d = new THREE.Object3D(), c = new THREE.Color();
    let n = 0, tries = 0;
    while (n < COUNT_MAX && tries++ < 700000) {
      const x = 6 + (R() * 2 - 1) * 54, z = -9 + (R() * 2 - 1) * 42;
      const dist = Math.hypot(x - 6, z - 2); if (dist > 58) continue;
      if (mask.get(x, z)) continue;
      const wl = lawnAt(x, z); if (wl < 0.35) continue;
      const dens = (1 - sstep(20, 52, dist) * 0.92) * sstep(0.35, 0.8, wl); if (R() > dens) continue;
      const y = terrainV(x, z); d.position.set(x, y - 0.015, z); d.rotation.set(0, R() * 6.28, 0); const s = 0.75 + R() * 0.6 + (1 - dens) * 0.2; d.scale.set(s, s * (0.8 + R() * 0.5), s); d.updateMatrix(); grass.setMatrixAt(n, d.matrix);
      const [m0, m1] = macro(x, z), yl = sstep(-0.4, 0.5, m0);
      c.setRGB(lerp(0.06, 0.11, yl), lerp(0.18, 0.21, yl), lerp(0.025, 0.035, yl)).multiplyScalar(0.85 + m1 * 0.25 + R() * 0.2);
      if (z < -8) c.lerp(new THREE.Color(0.2, 0.19, 0.08), sstep(0.1, 0.45, fbm(x * 0.09 + 11, z * 0.09 - 4)) * 0.5);
      c.multiplyScalar(1 - aoAt(x, z) * 0.55); grass.setColorAt(n, c); n++;
    }
    grass.count = n; grass.castShadow = false; grass.receiveShadow = true; grass.frustumCulled = false; grass.name = 'grass';
    NRF.add(grass); stats.instances.grassTufts = n; stats.instances.grassBlades = n * blades;
    // tall wild-grass clumps (r1: around boulders, along the steps, at shrub and forest edges) — same material, 12 blades each
    const T = { pos: [], nor: [], uv: [] }, Rt = mulberry32(8);
    for (let b = 0; b < 12; b++) { const a = Rt() * 6.28, r0 = Rt() * 0.09, ox = Math.cos(a) * r0, oz = Math.sin(a) * r0, h = 0.42 + Rt() * 0.42, w = 0.03 + Rt() * 0.012, lean = 0.35 + Rt() * 0.4;
      const rx = -Math.sin(a + 1.4), rz = Math.cos(a + 1.4);
      const row = t => { const off = lean * h * t * t, cx = ox + Math.cos(a) * off, cz = oz + Math.sin(a) * off, ww = w * (1 - t) * 0.5; return [[cx - rx * ww, h * t, cz - rz * ww], [cx + rx * ww, h * t, cz + rz * ww]]; };
      for (let sgi = 0; sgi < 4; sgi++) { const f0 = sgi / 4, f1 = (sgi + 1) / 4, [a0, a1] = row(f0), [b0, b1] = row(f1);
        const q = sgi === 3 ? [[a0, f0, 0], [a1, f0, 1], [b0, f1, 0.5]] : [[a0, f0, 0], [a1, f0, 1], [b1, f1, 1], [a0, f0, 0], [b1, f1, 1], [b0, f1, 0]];
        for (const [pp, v, u] of q) { T.pos.push(...pp); T.uv.push(u, v); T.nor.push(0, 1, 0); } } }
    const tall = new THREE.InstancedMesh(geoFrom(T), gmat, 3300); let nt = 0;
    const tallAt = (x, z, s) => { if (nt >= 3300 || mask.get(x, z) === 2) return; const y = terrainV(x, z); if (y < WATER_Y + 0.3) return;
      d.position.set(x, y - 0.02, z); d.rotation.set(0, R() * 6.28, 0); d.scale.set(s, s * (0.8 + R() * 0.5), s); d.updateMatrix(); tall.setMatrixAt(nt, d.matrix);
      const k = sstep(0.0, 0.5, fbm(x * 0.2 + 3, z * 0.2)); c.setRGB(lerp(0.09, 0.2, k), lerp(0.17, 0.19, k), lerp(0.035, 0.06, k)).multiplyScalar(0.85 + R() * 0.3); tall.setColorAt(nt++, c); };
    for (const b of boulderSpots) for (let i = 0; i < 14; i++) { const a = R() * 6.28, r = (0.9 + R() * 0.9) * b.s; tallAt(b.x + Math.cos(a) * r, b.z + Math.sin(a) * r, 0.7 + R() * 0.6); }
    for (const st of steps) if (R() < 0.7) { const side = R() < 0.5 ? -1 : 1, off = st.w * 0.5 + 0.25 + R() * 0.5; tallAt(st.cx - st.dz * side * off, st.cz + st.dx * side * off, 0.6 + R() * 0.6); }
    for (const sp of [...shrubSpots, ...bushSpots.filter(b => Math.hypot(b.x - 6, b.z + 10) < 34)]) for (let i = 0; i < 4; i++) { const a = R() * 6.28, r = (0.7 + R() * 0.7) * sp.s; tallAt(sp.x + Math.cos(a) * r, sp.z + Math.sin(a) * r, 0.7 + R() * 0.6); }
    for (let i = 0; i < 20000 && nt < 3300; i++) { const x = -40 + R() * 90, z = -32 + R() * 50; if (mask.get(x, z)) continue; const w = lawnAt(x, z); if (w < 0.2) continue;
      if (fbm(x * 0.15 + 9, z * 0.15 - 2) > 0.18 || (w < 0.6 && R() < 0.25)) tallAt(x, z, 0.6 + R() * 0.7); }
    tall.count = nt; tall.castShadow = false; tall.receiveShadow = true; tall.frustumCulled = false; tall.name = 'grass_tall'; NRF.add(tall);
    stats.instances.tallGrassTufts = nt; stats.instances.grassBlades += nt * 12;
  }

  // ================================================================ WILDFLOWERS (tiny white flowers in the lawn)
  {
    const A = { pos: [], nor: [], col: [] }, push = (p, c, n = [0, 1, 0]) => { A.pos.push(...p); A.col.push(...c); A.nor.push(...n); };
    const stemH = 0.34, W = [1.3, 1.3, 1.24], Y = [1.1, 0.85, 0.25], S = [0.2, 0.32, 0.1];
    for (let k = 0; k < 3; k++) {             // three heads on one sprig, each tilted a different way so some face the sun
      const hx = (k - 1) * 0.08, hz = (k % 2) * 0.06, hy = stemH * (0.72 + k * 0.14), ax = new THREE.Vector3(Math.cos(k * 2.1), 0, Math.sin(k * 2.1)), tilt = 0.55;
      const n = new THREE.Vector3(0, 1, 0).applyAxisAngle(ax, tilt).toArray();
      const P = (x, y, z) => { const v = new THREE.Vector3(x, y, z).applyAxisAngle(ax, tilt); return [hx + v.x, hy + v.y, hz + v.z]; };
      push([hx - 0.005, 0, hz], S); push([hx + 0.005, 0, hz], S); push([hx, hy, hz], S);
      for (let p = 0; p < 6; p++) { const a0 = p / 6 * 6.28, a1 = a0 + 0.75, r = 0.05; push(P(0, 0.006, 0), Y, n); push(P(Math.cos(a0) * r, 0, Math.sin(a0) * r), W, n); push(P(Math.cos(a1) * r, 0, Math.sin(a1) * r), W, n); }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(A.pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(A.nor, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(A.col, 3));
    const fm = new THREE.MeshLambertNodeMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const P = positionLocal, bend = P.y.div(0.3).clamp(0, 1).pow(2);
    fm.positionNode = P.add(vec3(sin(time.mul(1.8).add(hash(instanceIndex).mul(6.28))).mul(0.03), 0, 0).mul(bend));
    const COUNT = 5200, fl = new THREE.InstancedMesh(g, fm, COUNT), d = new THREE.Object3D(); let n = 0, tries = 0;
    while (n < COUNT && tries++ < 200000) {
      const x = -30 + R() * 72, z = -30 + R() * 50; if (mask.get(x, z)) continue;
      const wl = lawnAt(x, z); if (wl < 0.5 || aoAt(x, z) > 0.3) continue;
      const clump = sstep(0.05, 0.4, fbm(x * 0.18 + 3, z * 0.18 + 9)); if (R() > clump) continue;
      d.position.set(x, terrainV(x, z) - 0.01, z); d.rotation.set(0, R() * 6.28, 0); d.scale.setScalar(0.8 + R() * 0.6); d.updateMatrix(); fl.setMatrixAt(n++, d.matrix);
    }
    fl.count = n; fl.castShadow = false; fl.receiveShadow = true; fl.name = 'flowers'; NRF.add(fl); stats.instances.flowers = n;
  }

  // ================================================================ MODELS: shrubs, ferns, rocks (Poly Haven, instanced by node)
  async function nodesOf(id) {
    const sc = await loadModel(id); sc.updateMatrixWorld(true); const out = [];
    // shared.js loads the alpha-fix maps with TextureLoader (flipY = true) but glTF textures are flipY = false,
    // so the cut-out lands on the wrong texels and the leaves vanish. Reload those maps un-flipped (same URL → browser cache).
    const ent = await modelEntry(id);
    for (const f of (ent && ent.alpha_fix) || []) {
      const t = await new THREE.TextureLoader().loadAsync(f.alphaMap); t.flipY = false; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true;
      sc.traverse(o => { if (o.isMesh) for (const m of [].concat(o.material)) if (m.name === f.material) { m.alphaMap = t; m.alphaTest = 0.5; m.needsUpdate = true; } });
    }
    for (const top of sc.children) { const geos = [], mats = []; top.updateMatrixWorld(true);
      top.traverse(o => { if (o.isMesh) { const g = o.geometry.clone(); g.applyMatrix4(o.matrixWorld); geos.push(g); mats.push(o.material); } });
      if (!geos.length) continue;
      const g = geos.length > 1 ? mergeGeometries(geos.map(q => { for (const k of Object.keys(q.attributes)) if (!['position', 'normal', 'uv'].includes(k)) q.deleteAttribute(k); return q; }), false) : geos[0];
      g.computeBoundingBox(); const bb = g.boundingBox; g.translate(-(bb.min.x + bb.max.x) / 2, 0, -(bb.min.z + bb.max.z) / 2); g.computeBoundingSphere();
      out.push({ name: top.name, geo: g, mat: mats[0], size: bb.getSize(new THREE.Vector3()), minY: bb.min.y }); }
    return out;
  }
  const [shrubN, fernN, rockN] = await Promise.all([nodesOf('shrub_02'), nodesOf('fern_02'), nodesOf('rock_moss_set_02')]);
  const place = (list, spots, { tint, cast = true, name, parent = NRF, pick = s => s.v % list.length }) => {   // spots: {x,z,y?,s,yaw,v}
    const by = list.map(() => []); for (const s of spots) by[pick(s)].push(s);
    const d = new THREE.Object3D(), c = new THREE.Color(); let tot = 0;
    list.forEach((nd, i) => { if (!by[i].length) return; const im = new THREE.InstancedMesh(nd.geo, nd.mat, by[i].length);
      by[i].forEach((s, k) => { d.position.set(s.x, (s.y ?? terrainV(s.x, s.z)) + (s.dy ?? 0), s.z); d.rotation.set(s.rx ?? 0, s.yaw, s.rz ?? 0); d.scale.set(s.s * (s.sx ?? 1), s.s * (s.sy ?? 1), s.s * (s.sx ?? 1)); d.updateMatrix(); im.setMatrixAt(k, d.matrix);
        c.copy(tint(s)); im.setColorAt(k, c); });
      im.castShadow = cast; im.receiveShadow = true; im.name = name + '_' + i; parent.add(im); tot += by[i].length; });
    stats.instances[name] = tot;
  };
  place([shrubN[1], shrubN[3]], shrubSpots, { tint: () => new THREE.Color().setRGB(0.8 + R() * 0.2, 0.92 + R() * 0.2, 0.62 + R() * 0.15), name: 'shrub' });
  place(fernN, fernSpots, { tint: () => new THREE.Color().setRGB(0.85 + R() * 0.2, 0.95 + R() * 0.1, 0.8), name: 'fern', cast: false });
  { const rmat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
    rmat.colorNode = triplanarTexture(texture(TR.map), null, null, float(0.6), positionWorld, normalWorld).rgb.mul(1.15);
    const rocks = [1, 2, 3].map(sd => ({ geo: rockGeo(sd), mat: rmat }));
    place(rocks, rockSpots, { tint: () => new THREE.Color().setScalar(0.85 + R() * 0.3), name: 'rock' }); }
  { const rockSel = [rockN[1], rockN[2], rockN[5]].filter(Boolean);
    const pale = rockSel.map(nd => { const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 }); const t = texture(nd.mat.map, uv());
      m.colorNode = mix(t.rgb, vec3(luminance(t.rgb)), 0.72).mul(1.85).mul(vec3(1.0, 0.99, 0.95)); if (nd.mat.normalMap) m.normalNode = normalMap(texture(nd.mat.normalMap, uv()).rgb, vec2(1.2));
      return { ...nd, mat: m }; });
    place(pale, boulderSpots, { tint: () => new THREE.Color().setScalar(0.92 + R() * 0.12), name: 'boulder', parent: G });
  }

  // ================================================================ TREES + card bushes (one atlas, one material)
  const atlas = makeAtlas();
  const fmat = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide, alphaTest: 0.42 });   // no specular: cards seen edge-on must not glint grey
  { const t = texture(atlas, uv());
    // gentle sway of the upper crown (shadow copies the positionNode)
    const P = positionLocal, k = P.y.div(14).clamp(0, 1).pow(2).mul(0.12);
    fmat.positionNode = P.add(vec3(sin(time.mul(0.9).add(hash(instanceIndex).mul(6.28))).mul(k), 0, cos(time.mul(0.7).add(hash(instanceIndex).mul(3.1))).mul(k.mul(0.6))));
    fmat.colorNode = vec4(t.rgb, t.a);    // × instanceColor (applied by NodeMaterial)
    fmat.normalNode = transformNormalToView(normalLocal); }   // same outward 'crown' normal on both faces (no dark back faces)
  const TV = [
    coniferGeo(mulberry32(1), { H: 17, crownBase: 0.4, radius: 3.0, step: 0.7, perWhorl: 7, droop: -0.05, shape: 0.6, trunkR: 0.28 }),   // pine: tall, high crown
    coniferGeo(mulberry32(2), { H: 14, crownBase: 0.1, radius: 3.1, step: 0.55, perWhorl: 7, droop: 0.3, shape: 1.0, trunkR: 0.26 }),   // fir: dense cone
    coniferGeo(mulberry32(3), { H: 15, crownBase: 0.25, radius: 2.7, step: 0.62, perWhorl: 7, droop: 0.15, shape: 0.8, trunkR: 0.24 }),    // mixed
    birchGeo(mulberry32(4), { H: 12, crown0: 0.36, rad: 1.9, cards: 90, trunkR: 0.14 }),
    birchGeo(mulberry32(5), { H: 9.5, crown0: 0.3, rad: 1.6, cards: 70, trunkR: 0.12 }),
  ];
  const BV = [bushGeo(mulberry32(6), { r: 1.05, h: 1.15, cards: 80 }), bushGeo(mulberry32(7), { r: 0.85, h: 1.0, cards: 60, size: 0.5 })];
  { const d = new THREE.Object3D(), c = new THREE.Color();
    TV.forEach((geo, v) => { const list = trees.filter(t => t.type === v); if (!list.length) return; const im = new THREE.InstancedMesh(geo, fmat, list.length);
      list.forEach((t, k) => { d.position.set(t.x, terrainV(t.x, t.z) - 0.15, t.z); d.rotation.set(0, t.yaw, 0); d.scale.setScalar(t.s); d.updateMatrix(); im.setMatrixAt(k, d.matrix);
        if (v < 3) c.setRGB(0.72 + R() * 0.2, 0.8 + R() * 0.2, 0.72 + R() * 0.16); else c.setRGB(0.9 + R() * 0.15, 0.95 + R() * 0.1, 0.8 + R() * 0.12); im.setColorAt(k, c);
        if (Math.hypot(t.x - 5, t.z - 5) < 70) physics.col(t.x, t.z, t.x, t.z, terrainV(t.x, t.z) - 0.5, terrainV(t.x, t.z) + 4, v < 3 ? 0.28 * t.s : 0.16 * t.s); });
      im.castShadow = true; im.receiveShadow = true; im.name = 'trees_' + v; G.add(im); stats.instances['trees_' + v] = list.length; });
    BV.forEach((geo, v) => { const list = bushSpots.filter(b => b.v === v); const im = new THREE.InstancedMesh(geo, fmat, list.length);
      list.forEach((b, k) => { d.position.set(b.x, terrainV(b.x, b.z) + b.dy, b.z); d.rotation.set(0, b.yaw, 0); d.scale.setScalar(b.s); d.updateMatrix(); im.setMatrixAt(k, d.matrix); if (R() < 0.22) c.setRGB(1.0 + R() * 0.2, 1.08 + R() * 0.15, 0.62 + R() * 0.15); else c.setRGB(0.55 + R() * 0.25, 0.72 + R() * 0.22, 0.5 + R() * 0.18); im.setColorAt(k, c); });
      im.castShadow = true; im.receiveShadow = true; im.name = 'bushes_' + v; NRF.add(im); stats.instances['bushes_' + v] = list.length; });
  }

  // ================================================================ finish: build batches, merge statics
  for (const [k, b] of Object.entries(B)) b.build(k === 'flag' ? NRF : G);
  for (const b of Object.values(CB)) b.build(G);
  G.traverse(o => { if (o.isMesh && o !== terrain && o !== water && o.castShadow === undefined) o.castShadow = true; });
  mergeGroup(G);
  ctx.natureStats = stats;
  stats.walkTests = { boardwalk: [[BW[0][0], BW[0][1] + 1.2], ...BW, [(DOCK.x0 + DOCK.x1) / 2, DOCK.z0 + 0.5]], path2: PATHS[1], parkingStair: [[-10.5, 1.2], [-10.5, 7.4], [-12.5, 8.5]], dockY: DOCK_Y };

  const baseY = boat.position.y;
  return {
    stats,
    wind: { strength: windStrength, speed: windSpeed },
    update(dt, t) {
      boat.position.y = baseY + Math.sin(t * 1.1) * 0.035; boat.rotation.z = Math.sin(t * 0.8) * 0.012; boat.rotation.x = Math.sin(t * 0.9 + 1) * 0.008;
      if (ctx.sunDir) water.sunDirection.value.copy(ctx.sunDir).normalize();
    },
  };
}
