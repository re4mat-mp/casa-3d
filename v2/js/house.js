// house.js — v2 builder A: the house itself.
// Walls, glazing, slabs, decks, railings, both stairs, roofs, chimneys, lights, furniture, labels.
// Every coordinate below comes from v1 (casa_3d/index.html), which was measured from the architect's plans.
// Do not move walls. New in v2: materials, depth (frames, reveals, fascias, soffits), roof valleys instead of
// floating gable triangles, the black steel exterior stair off the quincho deck, lights, modelled furniture.
// Returns { update(dt,t) — fire flicker; setGlow(k) — 0..1 scales every emissive (downlights, sconces, lamps, washes);
//           decals — additive wash/flame meshes to hide under a clay override; materials }.
// Pushes 12 PointLights into ctx.lights (userData.baseIntensity set). Adds nothing to shared.js.
import { THREE, TSL, box, planarUV, mergeGroup, loadTexSet, loadModel, srgb } from './shared.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const V3 = THREE.Vector3, D2R = Math.PI / 180;
const UP = new V3(0, 1, 0), DOWN = new V3(0, -1, 0);

// ---------- tiny indexed-geometry builder (flat polygons, one normal per polygon) ----------
class GB {
  constructor() { this.pos = []; this.nor = []; this.uvs = []; this.idx = []; }
  // pts: planar convex polygon (V3[]); hint: the side the face should look at; uvf(p) -> [u,v]
  poly(pts, hint, uvf) {
    const n = new V3();
    for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length];
      n.x += (a.y - b.y) * (a.z + b.z); n.y += (a.z - b.z) * (a.x + b.x); n.z += (a.x - b.x) * (a.y + b.y); }
    if (n.lengthSq() < 1e-12) return; n.normalize();
    if (hint && n.dot(hint) < 0) { pts = pts.slice().reverse(); n.negate(); }
    const base = this.pos.length / 3;
    for (const p of pts) { this.pos.push(p.x, p.y, p.z); this.nor.push(n.x, n.y, n.z); const t = uvf ? uvf(p, n) : [0, 0]; this.uvs.push(t[0], t[1]); }
    for (let i = 1; i < pts.length - 1; i++) this.idx.push(base, base + i, base + i + 1);
  }
  empty() { return this.idx.length === 0; }
  geo() { const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setIndex(this.idx); return g; }
}

function canvasTex(w, h, fn) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = fn(x / (w - 1), y / (h - 1)); const i = (y * w + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(255, v * 255)); img.data[i + 3] = 255; }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ======================================================================================
// MATERIALS
// ======================================================================================
async function makeMaterials() {
  const { texture, uv, float, mix, smoothstep, luminance, hash, floor, color, normalView, positionViewDirection, pow } = TSL;
  const M = {};
  const std = (c, o = {}) => { const m = new THREE.MeshStandardNodeMaterial({ color: c, roughness: o.r ?? 0.85, metalness: o.m ?? 0, side: o.side ?? THREE.FrontSide });
    if (o.s) m.userData.s = o.s; if (o.em !== undefined) { m.emissive = new THREE.Color(o.em); m.emissiveIntensity = o.ei ?? 1; } return m; };
  const lin = (r, g, b) => new THREE.Color(r, g, b);   // linear colour, may exceed 1 (brightens dark albedo maps)

  const [CL, RF, OAK, CON, DK] = await Promise.all([loadTexSet('cladding'), loadTexSet('metal_roof_alt'), loadTexSet('oak_floor'), loadTexSet('concrete_floor'), loadTexSet('deck')]);

  // Exterior cladding: black_painted_planks rotated 90° (horizontal boards) and gradient-mapped to a charred,
  // weathered brown: the black paint's luminance drives dark→warm-brown, the AO darkens the board joints, and
  // each board gets its own tone so the wall doesn't read as one flat sheet.
  {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
    m.normalMap = CL.normalMap; m.roughnessMap = CL.roughnessMap; m.aoMap = CL.aoMap;
    const d = texture(CL.map, uv()).rgb, L = luminance(d);
    const t = smoothstep(0.002, 0.16, L);
    const board = floor(uv().x.mul(11.0).add(0.03)).add(1000.0);
    const vary = hash(board.add(floor(uv().y.mul(0.16)).mul(37.0)));
    const ao = texture(CL.aoMap, uv()).r;
    const base = mix(color(0x33291f), color(0x806c5a), t);
    m.colorNode = base.mul(float(0.84).add(vary.mul(0.3))).mul(ao.mul(ao));
    m.userData.s = 1.6; m.userData.rot90 = true;
    M.clad = m;
  }
  const pbrN = async (slot, o = {}) => { const t = await loadTexSet(slot); const m = new THREE.MeshStandardNodeMaterial({ color: o.color ?? 0xffffff, roughness: o.roughness ?? 1, metalness: 0,
    map: o.useMap === false ? null : t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap, aoMap: t.aoMap || null });
    if (o.normalScale) m.normalScale.set(o.normalScale, o.normalScale); m.userData.s = o.tileMeters ?? t.size_m[0]; m.userData.rot90 = !!o.rot90; return m; };
  M.cladBlack = await pbrN('cladding', { rot90: true, color: lin(0.85, 0.83, 0.8) });
  // Roof: box-profile normal + ARM only, near-black painted metal; UVs are laid by the roof builder so ribs run downslope.
  M.roof = new THREE.MeshStandardNodeMaterial({ color: srgb(38, 39, 41), roughness: 0.95, metalness: 0.3, normalMap: RF.normalMap, roughnessMap: RF.roughnessMap });
  M.roof.normalScale.set(0.9, 0.9);
  M.roofSeam = std(srgb(30, 31, 33), { r: 0.45, m: 0.4 });
  // Warm wood lining (soffits, vaulted ceilings of the living and quincho).
  M.lining = new THREE.MeshStandardNodeMaterial({ color: lin(1.18, 1.05, 0.9), roughness: 0.85, map: OAK.map, normalMap: OAK.normalMap, roughnessMap: OAK.roughnessMap });
  M.lining.userData.s = 1.7;
  // Interior plaster (warm white with the plaster's normal/roughness), ceilings.
  M.plaster = await pbrN('plaster_white', { useMap: false, color: srgb(242, 237, 228), normalScale: 0.6 });
  M.skirt = std(srgb(236, 232, 224), { r: 0.5 });
  M.ceiling = std(srgb(247, 245, 240), { r: 0.95 }); M.ceiling.emissive = new THREE.Color(0.045, 0.042, 0.038);
  // Floors
  M.oak = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.75, map: OAK.map, normalMap: OAK.normalMap, roughnessMap: OAK.roughnessMap }); M.oak.userData.s = 1.7;
  M.concFloor = new THREE.MeshStandardNodeMaterial({ color: lin(1.75, 1.7, 1.62), roughness: 0.55, map: CON.map, normalMap: CON.normalMap, roughnessMap: CON.roughnessMap }); M.concFloor.userData.s = 3;
  M.plinth = new THREE.MeshStandardNodeMaterial({ color: lin(2.05, 2.0, 1.9), roughness: 1, map: CON.map, normalMap: CON.normalMap, roughnessMap: CON.roughnessMap }); M.plinth.userData.s = 3;
  M.deck = new THREE.MeshStandardNodeMaterial({ color: lin(0.8, 0.76, 0.72), roughness: 0.9, map: DK.map, normalMap: DK.normalMap, roughnessMap: DK.roughnessMap }); M.deck.userData.s = 2;
  M.stone = await pbrN('stone_wall_alt', { color: lin(0.95, 0.93, 0.9) });
  // Metals, frames
  M.steel = std(srgb(22, 23, 24), { r: 0.42, m: 0.55 });
  M.frame = std(srgb(24, 25, 27), { r: 0.38, m: 0.45 });
  M.groove = std(srgb(40, 38, 35), { r: 0.9 });
  M.steelApp = std(srgb(170, 174, 178), { r: 0.28, m: 0.9 });
  M.chrome = std(srgb(220, 220, 220), { r: 0.12, m: 1 });
  M.blackGlass = std(srgb(10, 10, 11), { r: 0.06, m: 0.2 });
  M.tv = std(srgb(8, 8, 9), { r: 0.1, m: 0.3 });
  M.mirror = std(srgb(225, 230, 233), { r: 0.02, m: 1 });
  // Glass (variant B of the r186 notes: alpha + env reflections, a fresnel ramp on the opacity)
  const fres = pow(float(1).sub(normalView.dot(positionViewDirection).abs().clamp(0, 1)), float(4));
  M.glass = new THREE.MeshPhysicalNodeMaterial({ color: srgb(14, 20, 23), roughness: 0.03, metalness: 0, transparent: true, depthWrite: false });
  M.glass.opacityNode = mix(float(0.2), float(0.9), fres);
  M.railGlass = new THREE.MeshPhysicalNodeMaterial({ color: srgb(22, 36, 36), roughness: 0.04, metalness: 0, transparent: true, depthWrite: false });
  M.railGlass.opacityNode = mix(float(0.13), float(0.85), fres);
  M.ghost = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide });
  // Stone tops, cabinets, wood furniture
  M.stoneTop = std(srgb(232, 230, 225), { r: 0.25 });
  M.sinkDark = std(srgb(50, 52, 54), { r: 0.3, m: 0.6 });
  M.cabinet = std(srgb(214, 207, 196), { r: 0.6 });
  M.walnut = new THREE.MeshStandardNodeMaterial({ color: lin(0.55, 0.42, 0.34), roughness: 0.6, map: OAK.map, normalMap: OAK.normalMap }); M.walnut.userData.s = 1.7;
  M.oakFurn = new THREE.MeshStandardNodeMaterial({ color: lin(1.0, 0.95, 0.88), roughness: 0.6, map: OAK.map, normalMap: OAK.normalMap }); M.oakFurn.userData.s = 1.7;
  M.teak = new THREE.MeshStandardNodeMaterial({ color: lin(0.85, 0.66, 0.5), roughness: 0.7, map: DK.map, normalMap: DK.normalMap }); M.teak.userData.s = 1.2;
  M.ceramic = std(srgb(246, 246, 243), { r: 0.14 });
  M.tubInside = std(srgb(214, 222, 226), { r: 0.1 });
  M.potWhite = std(srgb(236, 233, 227), { r: 0.5 });
  M.dirt = std(srgb(52, 40, 30), { r: 1 });
  // Fabrics (sheen = the soft rim light of cloth)
  const fab = (c, sh) => new THREE.MeshPhysicalNodeMaterial({ color: c, roughness: 0.92, metalness: 0, sheen: 1, sheenRoughness: 0.65, sheenColor: sh ?? c });
  M.linen = fab(srgb(212, 202, 186), srgb(240, 232, 218));
  M.boucle = fab(srgb(228, 222, 210), srgb(250, 246, 238));
  M.outdoor = fab(srgb(126, 122, 115), srgb(170, 166, 158));
  M.charcoal = fab(srgb(78, 74, 69), srgb(120, 116, 110));
  M.sheet = fab(srgb(243, 241, 236), srgb(255, 255, 255));
  M.duvet = fab(srgb(224, 214, 198), srgb(245, 238, 226));
  M.throwOlive = fab(srgb(104, 110, 80), srgb(150, 156, 124));
  M.throwRust = fab(srgb(158, 90, 54), srgb(200, 140, 100));
  M.pillowBlue = fab(srgb(84, 104, 120), srgb(130, 150, 166));
  M.pillowCream = fab(srgb(234, 226, 210));
  M.rug = std(srgb(200, 188, 168), { r: 1 }); M.rugBorder = std(srgb(146, 130, 110), { r: 1 }); M.rug2 = std(srgb(170, 166, 158), { r: 1 });
  // Light emitters (tone-mapped + bloomed by main.js; setGlow() scales them by time of day)
  M.lightDisc = std(srgb(40, 38, 35), { r: 0.5, em: srgb(255, 212, 158), ei: 7 });
  M.sconceGlow = std(srgb(40, 38, 35), { r: 0.5, em: srgb(255, 206, 150), ei: 9 });
  M.lampShade = new THREE.MeshStandardNodeMaterial({ color: srgb(238, 226, 204), roughness: 0.9, emissive: srgb(255, 196, 132), emissiveIntensity: 1.8 });
  M.globe = new THREE.MeshStandardNodeMaterial({ color: srgb(250, 244, 234), roughness: 0.5, emissive: srgb(255, 210, 160), emissiveIntensity: 3.2 });
  // wall-wash scallop under/over a light: additive gradient decal
  const scallop = canvasTex(64, 128, (u, v) => { const w = 0.1 + 0.32 * v; const x = (u - 0.5) / w; return Math.exp(-x * x * 2.2) * Math.pow(1 - v, 1.6) * smooth(0, 0.06, v); });
  M.wash = new THREE.MeshBasicMaterial({ map: scallop, color: srgb(255, 206, 160), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: true });
  M.wash.color.multiplyScalar(0.22);
  const flame = canvasTex(64, 64, (u, v) => { const x = (u - 0.5) * 2, y = 1 - v; const w = 0.85 * Math.pow(1 - y, 0.6) + 0.05; return smooth(w, w * 0.4, Math.abs(x)) * smooth(1.0, 0.1, y) * (0.75 + 0.25 * Math.sin(u * 23 + v * 7)); });
  M.fire = new THREE.MeshBasicMaterial({ map: flame, color: srgb(255, 150, 70), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  M.fire.color.multiplyScalar(4);
  const art = (seed, pal) => { const c = document.createElement('canvas'); c.width = 256; c.height = 180; const g = c.getContext('2d');
    let a = seed; const r = () => ((a = (a * 16807) % 2147483647) / 2147483647);
    g.fillStyle = pal[0]; g.fillRect(0, 0, 256, 180);
    for (let i = 0; i < 7; i++) { g.globalAlpha = 0.55 + r() * 0.4; g.fillStyle = pal[1 + (i % (pal.length - 1))]; g.beginPath();
      g.ellipse(r() * 256, r() * 180, 30 + r() * 90, 20 + r() * 60, r() * 3, 0, 7); g.fill(); }
    g.globalAlpha = 1; const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; };
  M.art1 = new THREE.MeshStandardNodeMaterial({ map: art(7, ['#e9e1d3', '#b86a3c', '#6f7a5e', '#2f3438', '#d8b98a']), roughness: 0.9 });
  M.art2 = new THREE.MeshStandardNodeMaterial({ map: art(31, ['#dfe0dc', '#4f6272', '#a7b0a6', '#c98f5a', '#1f2326']), roughness: 0.9 });
  M.embers = std(srgb(20, 8, 4), { r: 0.9, em: srgb(255, 90, 30), ei: 3 });
  M.logs = std(srgb(40, 28, 20), { r: 1 });
  M.soot = std(srgb(18, 17, 16), { r: 1 });
  // Interiors: the environment (sky) light is not occluded by walls in a rasterizer, so every indoor surface would
  // get the full sky fill and read cool/grey. aoNode scales only indirect light — the lamps and the sun stay.
  const indoor = (k, ...ms) => { for (const m of ms) m.aoNode = m.aoMap ? texture(m.aoMap, uv()).r.mul(k) : float(k); };
  indoor(0.42, M.plaster, M.ceiling, M.skirt, M.art1, M.art2, M.oak, M.cabinet, M.stoneTop, M.walnut, M.oakFurn, M.ceramic, M.tubInside, M.rug, M.rugBorder, M.rug2,
    M.linen, M.boucle, M.charcoal, M.sheet, M.duvet, M.throwOlive, M.throwRust, M.pillowBlue, M.pillowCream, M.groove, M.lampShade);
  indoor(0.55, M.concFloor, M.lining, M.outdoor);
  return M;
}

// ======================================================================================
// BUILD
// ======================================================================================
export async function buildHouse(ctx) {
  const { groups, physics, lights, label } = ctx;
  const LV_Z = ctx.LV_Z ?? 0.05, LV_F = ctx.LV_F ?? 3.0, H = ctx.H ?? 2.7;
  const { col, floorRect, ramp, solid } = physics;
  const M = await makeMaterials();
  const ZC = groups.zc, FF = groups.ff, RF = groups.roof;

  // ---------------- primitive helpers ----------------
  const B = (g, x0, x1, y0, y1, z0, z1, mat, cast = true) => box(g, x0, x1, y0, y1, z0, z1, mat, { cast });
  const addGeo = (g, geo, mat, cast = true) => { const m = new THREE.Mesh(geo, mat); m.castShadow = cast; m.receiveShadow = true; g.add(m); return m; };
  // rounded box, centre + size, optional rotations baked into the geometry
  function rb(g, cx, cy, cz, w, h, d, r, mat, o = {}) {
    const rr = Math.max(0.002, Math.min(r, w / 2 - 0.002, h / 2 - 0.002, d / 2 - 0.002));
    const geo = new RoundedBoxGeometry(w, h, d, o.seg ?? 2, rr);
    if (!geo.index) geo.setIndex([...Array(geo.attributes.position.count).keys()]);   // r186 builds it non-indexed; mergeGroup needs an index
    if (o.rx) geo.rotateX(o.rx); if (o.rz) geo.rotateZ(o.rz); if (o.ry) geo.rotateY(o.ry);
    geo.translate(cx, cy, cz); return addGeo(g, geo, mat, o.cast !== false);
  }
  const rbx = (g, x0, x1, y0, y1, z0, z1, r, mat, o) => rb(g, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, x1 - x0, y1 - y0, z1 - z0, r, mat, o);
  function cyl(g, x, y0, y1, z, r, mat, seg = 16, o = {}) { const geo = new THREE.CylinderGeometry(o.rTop ?? r, r, y1 - y0, seg); geo.translate(x, (y0 + y1) / 2, z); return addGeo(g, geo, mat, o.cast !== false); }
  // box along a segment p0→p1 (w = horizontal width across, h = height in the vertical plane of the segment)
  function beam(g, p0, p1, w, h, mat, cast = true) {
    const dir = new V3().subVectors(p1, p0), L = dir.length(); dir.normalize();
    let side = new V3().crossVectors(dir, UP); if (side.lengthSq() < 1e-6) side.set(1, 0, 0); side.normalize();
    const up = new V3().crossVectors(side, dir).normalize();
    const geo = new THREE.BoxGeometry(L, h, w); geo.applyMatrix4(new THREE.Matrix4().makeBasis(dir, up, side));
    geo.translate((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, (p0.z + p1.z) / 2); return addGeo(g, geo, mat, cast);
  }
  // disc (recessed downlight) at p facing n
  function disc(g, p, n, r = 0.045, mat = M.lightDisc) {
    const geo = new THREE.CylinderGeometry(r, r, 0.012, 14); geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, n));
    geo.translate(p.x + n.x * 0.004, p.y + n.y * 0.004, p.z + n.z * 0.004); return addGeo(g, geo, mat, false);
  }
  // an extruded polygon: poly = [[a,y],...] in the wall plane; axis 'z' → plane at z∈[c0,c1] (a = x); 'x' → x∈[c0,c1] (a = z)
  function prism(g, poly, axis, c0, c1, mat, cast = true) {
    const gb = new GB(), P = (a, y, c) => axis === 'z' ? new V3(a, y, c) : new V3(c, y, a);
    const nA = axis === 'z' ? new V3(0, 0, 1) : new V3(1, 0, 0);
    gb.poly(poly.map(([a, y]) => P(a, y, c1)), nA); gb.poly(poly.map(([a, y]) => P(a, y, c0)), nA.clone().negate());
    const ca = poly.reduce((s, p) => s + p[0], 0) / poly.length, cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length];
      const mid = [(a[0] + b[0]) / 2 - ca, (a[1] + b[1]) / 2 - cy]; const hint = P(mid[0], mid[1], 0).sub(P(0, 0, 0));
      gb.poly([P(a[0], a[1], c0), P(b[0], b[1], c0), P(b[0], b[1], c1), P(a[0], a[1], c1)], hint); }
    const geo = gb.geo(); if (mat.userData.s) planarUV(geo, mat.userData.s, !!mat.userData.rot90); return addGeo(g, geo, mat, cast);
  }
  // wall-wash decal (additive gradient) on a wall face: top centre at (x,y,z), extends down by h
  function wash(g, x, y, z, face, w = 0.9, h = 1.6, up = false) {
    const geo = new THREE.PlaneGeometry(w, h); if (up) geo.rotateZ(Math.PI);
    const n = { n: new V3(0, 0, -1), s: new V3(0, 0, 1), e: new V3(1, 0, 0), w: new V3(-1, 0, 0) }[face];
    geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V3(0, 0, 1), n));
    geo.translate(x + n.x * 0.012, up ? y + h / 2 : y - h / 2, z + n.z * 0.012); return addGeo(g, geo, M.wash, false);
  }

  // ---------------- glazing, walls, rails, slabs ----------------
  function pane(g, horiz, c, a0, a1, y0, y1, o = {}) {
    const gt = 0.006;
    horiz ? B(g, a0, a1, y0, y1, c - gt, c + gt, M.glass, false) : B(g, c - gt, c + gt, y0, y1, a0, a1, M.glass, false);
    const fd = 0.03, fw = 0.05;   // frame 6 cm deep, 5 cm face
    const fr = (p0, p1, q0, q1) => horiz ? B(g, p0, p1, q0, q1, c - fd, c + fd, M.frame) : B(g, c - fd, c + fd, q0, q1, p0, p1, M.frame);
    fr(a0, a1, y0, y0 + fw); fr(a0, a1, y1 - fw, y1);
    const n = Math.max(1, Math.round((a1 - a0) / (o.bay || 1.4)));
    for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n;
      if (i === 0) fr(a0, a0 + fw, y0 + fw, y1 - fw); else if (i === n) fr(a1 - fw, a1, y0 + fw, y1 - fw); else fr(a - 0.024, a + 0.024, y0 + fw, y1 - fw); }
    if (o.transom) fr(a0, a1, o.transom - 0.025, o.transom + 0.025);
  }
  // black sheet-metal lining of a window opening, from the frame out to the cladding face, with a projecting sill
  function reveal(g, horiz, c, sg, t, wa, wb, y0, y1) {
    const q0 = c + sg * 0.03, q1 = c + sg * (t / 2 + 0.055), lo = Math.min(q0, q1), hi = Math.max(q0, q1);
    const BX = (p0, p1, ya, yb, qa, qb) => horiz ? B(g, p0, p1, ya, yb, qa, qb, M.frame) : B(g, qa, qb, ya, yb, p0, p1, M.frame);
    BX(wa, wb, y1 - 0.02, y1, lo, hi); BX(wa, wa + 0.02, y0, y1, lo, hi); BX(wb - 0.02, wb, y0, y1, lo, hi);
    BX(wa - 0.03, wb + 0.03, y0 - 0.02, y0 + 0.008, sg > 0 ? lo : lo - 0.045, sg > 0 ? hi + 0.045 : hi);
  }
  function wall(g, x1, z1, x2, z2, o = {}) {
    const base = o.base ?? LV_F, h = o.h ?? H, t = o.t ?? 0.2, horiz = Math.abs(z1 - z2) < 1e-6;
    const a0 = horiz ? Math.min(x1, x2) : Math.min(z1, z2), a1 = horiz ? Math.max(x1, x2) : Math.max(z1, z2), c = horiz ? z1 : x1;
    const mat = o.ghost ? M.ghost : o.both ? M.clad : M.plaster, sg = (o.out === 'n' || o.out === 'w') ? -1 : 1;
    const BX = (p0, p1, ya, yb, qa, qb, m, cast = true) => horiz ? B(g, p0, p1, ya, yb, qa, qb, m, cast) : B(g, qa, qb, ya, yb, p0, p1, m, cast);
    const pieces = []; let cur = a0;
    for (const [wa, wb, s, hd] of (o.win || []).slice().sort((a, b) => a[0] - b[0])) {
      if (wa > cur) pieces.push([cur, wa, 0, h]); pieces.push([wa, wb, 0, s]); pieces.push([wa, wb, hd, h]);
      pane(g, horiz, c, wa, wb, base + s, base + hd, { bay: 1.3 });
      if (o.out) reveal(g, horiz, c, sg, t, wa, wb, base + s, base + hd);
      cur = wb;
    }
    if (cur < a1) pieces.push([cur, a1, 0, h]);
    for (const [p0, p1, y0, y1] of pieces) {
      if (y1 - y0 < 0.01) continue;
      BX(p0, p1, base + y0, base + y1, c - t / 2, c + t / 2, mat, !o.ghost);
      if (y0 === 0 && !o.ghost && !o.both && !o.noSkirt) {   // painted skirting on the interior face(s)
        if (!o.out || sg > 0) BX(p0, p1, base, base + 0.07, c - t / 2 - 0.012, c - t / 2, M.skirt, false);
        if (!o.out || sg < 0) BX(p0, p1, base, base + 0.07, c + t / 2, c + t / 2 + 0.012, M.skirt, false);
      }
      if (o.out) {   // dark horizontal cladding on the outside face (wraps the corners by 12 cm)
        const wr = o.wrap || [true, true], e0 = p0 === a0 && wr[0] ? 0.12 : 0, e1 = p1 === a1 && wr[1] ? 0.12 : 0, qa = c + sg * t / 2, qb = c + sg * (t / 2 + 0.05);
        let yb = base + y0;
        if (o.plinth && y0 === 0) { const qc = c + sg * (t / 2 + 0.062); BX(p0 - e0, p1 + e1, base - 0.3, base + 0.26, Math.min(qa, qc), Math.max(qa, qc), M.plinth); yb = base + 0.26; }
        BX(p0 - e0, p1 + e1, yb, base + y1, Math.min(qa, qb), Math.max(qa, qb), M.clad);
      }
    }
    if (o.out) {   // clad the free ends so the plaster core never shows outside
      // thin plates over the end faces, kept 3 mm off the interior face so they never show indoors
      const inner = c - sg * (t / 2 - 0.003), outer = c + sg * (t / 2 + 0.05);
      const wr = o.wrap || [true, true], q0 = Math.min(inner, outer), q1 = Math.max(inner, outer);
      const yb = o.plinth ? base + 0.26 : base;
      if (wr[0]) BX(a0 - 0.008, a0 + 0.001, yb, base + h, q0, q1, M.clad);
      if (wr[1]) BX(a1 - 0.001, a1 + 0.008, yb, base + h, q0, q1, M.clad);
      if (o.plinth) { const qp = c + sg * (t / 2 + 0.062), p0 = Math.min(c - t / 2, qp), p1 = Math.max(c + t / 2, qp);
        if (wr[0]) BX(a0 - 0.008, a0 + 0.04, base - 0.3, base + 0.26, p0, p1, M.plinth); if (wr[1]) BX(a1 - 0.04, a1 + 0.008, base - 0.3, base + 0.26, p0, p1, M.plinth); }
    }
    if (!o.ghost && !o.noCol) { const sh = t / 2; horiz ? col(a0 + sh, c, a1 - sh, c, base, base + h, t / 2) : col(c, a0 + sh, c, a1 - sh, base, base + h, t / 2); }
  }
  function glass(g, x1, z1, x2, z2, o = {}) {
    const base = o.base ?? LV_F, horiz = Math.abs(z1 - z2) < 1e-6, c = horiz ? z1 : x1;
    const a0 = horiz ? Math.min(x1, x2) : Math.min(z1, z2), a1 = horiz ? Math.max(x1, x2) : Math.max(z1, z2);
    pane(g, horiz, c, a0, a1, base + (o.y0 ?? 0), base + (o.h ?? H), o);
    if (!o.pass && !o.ghost) col(x1, z1, x2, z2, base + (o.y0 ?? 0), base + (o.h ?? H), 0.05);
  }
  // railings: frameless-looking glass between thin black posts, black top rail (r2)
  function railGlass(g, x1, z1, x2, z2, base, o = {}) {
    const horiz = Math.abs(z1 - z2) < 1e-6, c = horiz ? z1 : x1;
    const a0 = horiz ? Math.min(x1, x2) : Math.min(z1, z2), a1 = horiz ? Math.max(x1, x2) : Math.max(z1, z2), L = a1 - a0;
    const BX = (p0, p1, ya, yb, qa, qb, m, cast = true) => horiz ? B(g, p0, p1, ya, yb, qa, qb, m, cast) : B(g, qa, qb, ya, yb, p0, p1, m, cast);
    const n = Math.max(1, Math.ceil(L / 1.6));
    for (let i = 0; i <= n; i++) { const a = a0 + L * i / n; BX(a - 0.022, a + 0.022, base, base + 1.0, c - 0.022, c + 0.022, M.steel); }
    for (let i = 0; i < n; i++) { const p0 = a0 + L * i / n + 0.03, p1 = a0 + L * (i + 1) / n - 0.03; BX(p0, p1, base + 0.06, base + 0.99, c - 0.006, c + 0.006, M.railGlass, false); }
    BX(a0 - 0.02, a1 + 0.02, base + 1.0, base + 1.045, c - 0.03, c + 0.03, M.steel);
    BX(a0, a1, base, base + 0.06, c - 0.022, c + 0.022, M.steel);
    if (!o.noCol) col(x1, z1, x2, z2, base, base + 1.05, 0.04);
  }
  // railings: black vertical balusters (r1, the long bedroom-wing deck)
  function railBal(g, x1, z1, x2, z2, base, o = {}) {
    const horiz = Math.abs(z1 - z2) < 1e-6, c = horiz ? z1 : x1;
    const a0 = horiz ? Math.min(x1, x2) : Math.min(z1, z2), a1 = horiz ? Math.max(x1, x2) : Math.max(z1, z2), L = a1 - a0;
    const BX = (p0, p1, ya, yb, qa, qb, m, cast = true) => horiz ? B(g, p0, p1, ya, yb, qa, qb, m, cast) : B(g, qa, qb, ya, yb, p0, p1, m, cast);
    const np = Math.max(1, Math.ceil(L / 2.0));
    for (let i = 0; i <= np; i++) { const a = a0 + L * i / np; BX(a - 0.028, a + 0.028, base, base + 1.0, c - 0.028, c + 0.028, M.steel); }
    const nb = Math.round(L / 0.11);
    for (let i = 1; i < nb; i++) { const a = a0 + L * i / nb; BX(a - 0.008, a + 0.008, base + 0.07, base + 1.0, c - 0.008, c + 0.008, M.steel); }
    BX(a0 - 0.02, a1 + 0.02, base + 1.0, base + 1.045, c - 0.032, c + 0.032, M.steel);
    BX(a0, a1, base + 0.06, base + 0.09, c - 0.016, c + 0.016, M.steel);
    if (!o.noCol) col(x1, z1, x2, z2, base, base + 1.05, 0.04);
  }
  // first-floor slab: black steel edge (reads as the fascia band between floors), floor skin, ceiling skin below
  function slab(g, x0, x1, z0, z1, top, under = M.ceiling, th = 0.25) {   // exterior decks pass th=0.34: deeper black fascia (r2)
    B(g, x0, x1, LV_F - th, LV_F - 0.022, z0, z1, M.steel);
    B(g, x0, x1, LV_F - 0.022, LV_F, z0, z1, top);
    B(g, x0 + 0.002, x1 - 0.002, LV_F - th - 0.012, LV_F - th, z0 + 0.002, z1 - 0.002, under, false);
    floorRect(x0, x1, z0, z1, LV_F);
  }
  const post = (g, x, z, y0, y1) => B(g, x - 0.06, x + 0.06, y0, y1, z - 0.06, z + 0.06, M.steel);

  // ---------------- lights ----------------
  const glowMats = [M.lightDisc, M.sconceGlow, M.lampShade, M.globe, M.wash];
  const glowBase = new Map(glowMats.map(m => [m, m.isMeshBasicMaterial ? m.color.clone() : m.emissiveIntensity]));
  function point(g, x, y, z, I, dist = 6) {
    const l = new THREE.PointLight(srgb(255, 212, 168), I, dist, 2); l.position.set(x, y, z); l.castShadow = false;
    l.userData.baseIntensity = I; g.add(l); lights.push(l); return l;
  }
  const downGrid = (g, x0, x1, z0, z1, y, nx, nz) => { for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) disc(g, new V3(x0 + (i + 0.5) * (x1 - x0) / nx, y, z0 + (j + 0.5) * (z1 - z0) / nz), DOWN); };
  function sconce(g, x, y, z, face, withWash = true) {
    const n = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }[face], d = 0.1, w = 0.1, h = 0.28;
    const cx = x + n[0] * d / 2, cz = z + n[1] * d / 2, hx = n[0] ? d / 2 : w / 2, hz = n[0] ? w / 2 : d / 2;
    B(g, cx - hx, cx + hx, y - h / 2, y + h / 2, cz - hz, cz + hz, M.steel);
    B(g, cx - hx * 0.7, cx + hx * 0.7, y + h / 2, y + h / 2 + 0.004, cz - hz * 0.7, cz + hz * 0.7, M.sconceGlow, false);
    B(g, cx - hx * 0.7, cx + hx * 0.7, y - h / 2 - 0.004, y - h / 2, cz - hz * 0.7, cz + hz * 0.7, M.sconceGlow, false);
    const fx = x + n[0] * (d + 0.002), fz = z + n[1] * (d + 0.002), sx = n[0] ? 0.002 : 0.012, sz = n[0] ? 0.012 : 0.002;
    B(g, fx - sx, fx + sx, y - h * 0.32, y + h * 0.32, fz - sz, fz + sz, M.sconceGlow, false);
    if (withWash) { wash(g, x, y + h / 2, z, face, 0.8, 1.5, true); wash(g, x, y - h / 2, z, face, 0.8, 1.9); }
  }

  // ---------------- furniture ----------------
  const mapLocal = (x0, x1, z0, z1, back) => (a, d) => {   // a: along the piece, d: depth from its back
    if (back === 'n') return [x0 + a, z0 + d]; if (back === 's') return [x1 - a, z1 - d];
    if (back === 'w') return [x0 + d, z1 - a]; return [x1 - d, z0 + a];
  };
  function lbox(g, W, back, a0, a1, d0, d1, y0, y1, r, mat, o = {}) {   // rounded box in a piece's local frame
    const [xa, za] = W(a0, d0), [xb, zb] = W(a1, d1);
    const tilt = o.tilt || 0, alongX = back === 'n' || back === 's';
    const sgn = { n: -1, s: 1, w: 1, e: -1 }[back];
    const opt = { seg: o.seg ?? 2, cast: o.cast };
    if (tilt) { if (alongX) opt.rx = sgn * tilt; else opt.rz = sgn * tilt; }
    if (o.yaw) opt.ry = o.yaw;
    return rb(g, (xa + xb) / 2, (y0 + y1) / 2, (za + zb) / 2, Math.abs(xb - xa), y1 - y0, Math.abs(zb - za), r, mat, opt);
  }
  // modern low sofa with rounded cushions, arms, throw pillows. back = side of the backrest.
  function sofa(g, x0, x1, z0, z1, b, back, mat = M.linen, o = {}) {
    const alongX = back === 'n' || back === 's', L = alongX ? x1 - x0 : z1 - z0, Dp = alongX ? z1 - z0 : x1 - x0;
    const W = mapLocal(x0, x1, z0, z1, back), arms = o.arms ?? [true, true], aw = 0.2;
    const ext0 = o.ext0 || 0, ext1 = o.ext1 || 0;   // back extension into an L corner
    lbox(g, W, back, 0.06, L - 0.06, 0.08, Dp - 0.1, b, b + 0.1, 0.01, M.steel);   // recessed plinth
    lbox(g, W, back, 0, L, 0, Dp, b + 0.08, b + 0.3, 0.04, mat);                  // upholstered base
    lbox(g, W, back, -ext0, L + ext1, 0, 0.2, b + 0.28, b + 0.68, 0.06, mat);        // back frame
    if (arms[0]) lbox(g, W, back, 0, aw, 0, Dp, b + 0.28, b + 0.6, 0.07, mat);
    if (arms[1]) lbox(g, W, back, L - aw, L, 0, Dp, b + 0.28, b + 0.6, 0.07, mat);
    const s0 = arms[0] ? aw : 0, s1 = arms[1] ? L - aw : L, n = Math.max(1, Math.round((s1 - s0) / 0.95));
    for (let i = 0; i < n; i++) { const a0 = s0 + (s1 - s0) * i / n + 0.006, a1 = s0 + (s1 - s0) * (i + 1) / n - 0.006;
      lbox(g, W, back, a0, a1, 0.2, Dp - 0.02, b + 0.29, b + 0.46, 0.07, mat, { seg: 3 });
      lbox(g, W, back, a0, a1, 0.21, 0.43, b + 0.44, b + 0.88, 0.09, mat, { seg: 3, tilt: 0.14 }); }
    if (ext0 || ext1) { const a0 = ext0 ? -ext0 + 0.2 : L, a1 = ext0 ? 0 : L + ext1 - 0.2; if (a1 > a0) lbox(g, W, back, a0, a1, 0.21, 0.43, b + 0.44, b + 0.88, 0.09, mat, { seg: 3, tilt: 0.14 }); }
    const pm = o.pillows || [M.pillowCream, M.throwRust];
    lbox(g, W, back, s0 + 0.08, s0 + 0.54, 0.4, 0.56, b + 0.46, b + 0.9, 0.07, pm[0], { tilt: 0.3, yaw: 0.12 });
    lbox(g, W, back, s1 - 0.54, s1 - 0.08, 0.4, 0.56, b + 0.46, b + 0.9, 0.07, pm[1], { tilt: 0.3, yaw: -0.1 });
    solid(x0, x1, z0, z1, b, b + 0.8);
  }
  // bed: upholstered headboard, platform, mattress, duvet with a folded edge, pillows, a throw across the foot
  function bed(g, x0, x1, z0, z1, b, head, o = {}) {
    const back = head, alongX = head === 'n' || head === 's';
    const Wd = alongX ? x1 - x0 : z1 - z0, Ln = alongX ? z1 - z0 : x1 - x0, W = mapLocal(x0, x1, z0, z1, back);
    lbox(g, W, back, 0.08, Wd - 0.08, 0.2, Ln - 0.12, b, b + 0.1, 0.01, M.steel);
    lbox(g, W, back, 0, Wd, 0.06, Ln, b + 0.09, b + 0.32, 0.03, o.base || M.walnut);
    lbox(g, W, back, -0.06, Wd + 0.06, 0, 0.1, b + 0.08, b + 1.08, 0.04, o.head || M.charcoal, { seg: 3 });
    lbox(g, W, back, 0.03, Wd - 0.03, 0.12, Ln - 0.02, b + 0.31, b + 0.53, 0.07, M.sheet, { seg: 3 });
    lbox(g, W, back, -0.03, Wd + 0.03, 0.66, Ln + 0.03, b + 0.36, b + 0.575, 0.08, M.duvet, { seg: 3 });
    lbox(g, W, back, -0.035, Wd + 0.035, 0.62, 0.82, b + 0.37, b + 0.6, 0.08, M.duvet, { seg: 3 });
    const np = Wd > 1.3 ? 2 : 1, pw = (Wd - 0.16) / np;
    for (let i = 0; i < np; i++) { const a = 0.08 + i * pw; lbox(g, W, back, a + 0.02, a + pw - 0.02, 0.13, 0.52, b + 0.52, b + 0.7, 0.08, M.sheet, { seg: 3, tilt: 0.35 }); }
    lbox(g, W, back, Wd * 0.3, Wd * 0.7, 0.42, 0.58, b + 0.55, b + 0.88, 0.06, o.pillow || M.pillowBlue, { tilt: 0.3 });
    lbox(g, W, back, -0.05, Wd + 0.05, Ln - 0.62, Ln - 0.12, b + 0.565, b + 0.6, 0.015, o.throw || M.throwOlive);
    solid(x0, x1, z0, z1, b, b + 0.6);
  }
  // long dining table: solid wood slab top, black steel legs and apron
  function diningTable(g, x0, x1, z0, z1, b, h = 0.75, top = M.walnut) {
    rbx(g, x0, x1, b + h - 0.05, b + h, z0, z1, 0.012, top);
    const alongX = x1 - x0 >= z1 - z0, ins = 0.14, lw = 0.06;
    for (const [x, z] of [[x0 + ins, z0 + ins], [x1 - ins, z0 + ins], [x0 + ins, z1 - ins], [x1 - ins, z1 - ins]]) B(g, x - lw / 2, x + lw / 2, b, b + h - 0.05, z - lw / 2, z + lw / 2, M.steel);
    if (alongX) { B(g, x0 + ins, x1 - ins, b + h - 0.12, b + h - 0.05, z0 + ins - 0.02, z0 + ins + 0.02, M.steel); B(g, x0 + ins, x1 - ins, b + h - 0.12, b + h - 0.05, z1 - ins - 0.02, z1 - ins + 0.02, M.steel); }
    else { B(g, x0 + ins - 0.02, x0 + ins + 0.02, b + h - 0.12, b + h - 0.05, z0 + ins, z1 - ins, M.steel); B(g, x1 - ins - 0.02, x1 - ins + 0.02, b + h - 0.12, b + h - 0.05, z0 + ins, z1 - ins, M.steel); }
    solid(x0, x1, z0, z1, b, b + h);
  }
  function lowTable(g, x0, x1, z0, z1, b, h, top = M.walnut) {
    rbx(g, x0, x1, b + h - 0.045, b + h, z0, z1, 0.015, top);
    B(g, x0 + 0.1, x1 - 0.1, b, b + h - 0.045, z0 + 0.1, z1 - 0.1, M.steel);
    solid(x0, x1, z0, z1, b, b + h);
  }
  // quincho outdoor chair: black steel frame, teak slats. ry: 0 → faces +z
  function outChair(g, cx, cz, b, ry) {
    const c = Math.cos(ry), s = Math.sin(ry), P = (lx, lz) => [cx + lx * c + lz * s, cz - lx * s + lz * c];
    for (const [lx, lz] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) { const [x, z] = P(lx, lz); B(g, x - 0.012, x + 0.012, b, b + 0.44, z - 0.012, z + 0.012, M.steel); }
    const [sx, sz] = P(0, 0.01); rb(g, sx, b + 0.455, sz, 0.46, 0.035, 0.44, 0.01, M.teak, { ry });
    const [bx, bz] = P(0, -0.215); rb(g, bx, b + 0.72, bz, 0.46, 0.34, 0.03, 0.01, M.teak, { ry, rx: 0 });
    for (const lx of [-0.21, 0.21]) { const [x, z] = P(lx, -0.215); B(g, x - 0.012, x + 0.012, b + 0.44, b + 0.9, z - 0.012, z + 0.012, M.steel); }
  }
  // cabinet run with door/drawer seams, handles and optional stone top. front = side the doors face.
  function units(g, x0, x1, z0, z1, yb, yt, front, o = {}) {
    const mat = o.mat || M.cabinet, alongX = front === 'n' || front === 's';
    const a0 = alongX ? x0 : z0, a1 = alongX ? x1 : z1;
    const out = (front === 'n' || front === 'w') ? -1 : 1;
    const qlo = alongX ? z0 : x0, qhi = alongX ? z1 : x1;
    const BA = (p0, p1, y0, y1, q0, q1, m, cast = true) => alongX ? B(g, p0, p1, y0, y1, q0, q1, m, cast) : B(g, q0, q1, y0, y1, p0, p1, m, cast);
    let yc = yb;
    if (o.toe) { BA(a0, a1, yb, yb + 0.1, out > 0 ? qlo : qlo + 0.07, out > 0 ? qhi - 0.07 : qhi, M.steel); yc = yb + 0.1; }
    BA(a0, a1, yc, yt, qlo, qhi, mat);
    const n = Math.max(1, Math.round((a1 - a0) / (o.door || 0.6)));
    const g0 = out > 0 ? qhi : qlo - 0.003, g1 = out > 0 ? qhi + 0.003 : qlo;
    for (let i = 1; i < n; i++) { const a = a0 + (a1 - a0) * i / n; BA(a - 0.003, a + 0.003, yc, yt, g0, g1, M.groove, false); }
    if (o.drawer) BA(a0, a1, yt - o.drawer - 0.003, yt - o.drawer + 0.003, g0, g1, M.groove, false);
    if (o.handles !== false) { const h0 = out > 0 ? qhi : qlo - 0.022, h1 = out > 0 ? qhi + 0.022 : qlo, hy = o.handleY ?? (yt - 0.07);
      for (let i = 0; i < n; i++) { const am = a0 + (a1 - a0) * (i + 0.5) / n; BA(am - 0.11, am + 0.11, hy - 0.008, hy + 0.008, h0, h1, M.steel, false); } }
    if (o.top) BA(a0, a1, yt, yt + 0.04, out > 0 ? qlo : qlo - 0.02, out > 0 ? qhi + 0.02 : qhi, o.top);
  }
  function cabinet(g, x0, x1, z0, z1, b, h, front, mat = M.cabinet) {
    units(g, x0, x1, z0, z1, b, b + h, front, { mat, toe: h > 1.2, handleY: h > 1.2 ? b + 1.05 : b + h - 0.07 });
    solid(x0, x1, z0, z1, b, b + h);
  }
  // bathroom / laundry fixtures (v1 "fixture" footprints). back = wall side.
  function fixture(g, x0, x1, z0, z1, b, h, kind, back) {
    const W = mapLocal(x0, x1, z0, z1, back), alongX = back === 'n' || back === 's';
    const L = alongX ? x1 - x0 : z1 - z0, Dp = alongX ? z1 - z0 : x1 - x0;
    if (kind === 'wc') {
      lbox(g, W, back, L / 2 - 0.2, L / 2 + 0.2, 0, 0.06, b + 0.2, b + 1.0, 0.02, M.ceramic);
      lbox(g, W, back, L / 2 - 0.18, L / 2 + 0.18, 0.02, Math.min(Dp, 0.56), b + 0.22, b + 0.42, 0.09, M.ceramic, { seg: 3 });
      lbox(g, W, back, L / 2 - 0.06, L / 2 + 0.06, 0.06, 0.066, b + 0.8, b + 0.9, 0.005, M.chrome);
    } else if (kind === 'vanity') {
      lbox(g, W, back, 0, L, 0, Dp, b + 0.3, b + 0.8, 0.01, M.walnut);
      lbox(g, W, back, -0.01, L + 0.01, -0.0, Dp + 0.01, b + 0.8, b + 0.84, 0.005, M.stoneTop);
      lbox(g, W, back, L / 2 - 0.2, L / 2 + 0.2, Dp * 0.35, Dp * 0.35 + 0.3, b + 0.84, b + 0.97, 0.06, M.ceramic, { seg: 3 });
      lbox(g, W, back, L / 2 - 0.012, L / 2 + 0.012, 0.03, 0.18, b + 0.84, b + 1.06, 0.006, M.chrome);
      lbox(g, W, back, 0.02, L - 0.02, -0.004, 0.012, b + 1.08, b + 1.95, 0.004, M.mirror, { cast: false });
    } else if (kind === 'tub') {
      lbox(g, W, back, 0, L, 0, Dp, b, b + 0.55, 0.06, M.ceramic, { seg: 3 });
      lbox(g, W, back, 0.09, L - 0.09, 0.09, Dp - 0.09, b + 0.5, b + 0.552, 0.05, M.tubInside);
    } else if (kind === 'washer') {
      lbox(g, W, back, 0.01, L - 0.01, 0, Dp - 0.01, b, b + h, 0.02, M.ceramic);
      const [cx, cz] = W(L / 2, Dp); const n = { n: [0, 1], s: [0, -1], w: [1, 0], e: [-1, 0] }[back];
      const geo = new THREE.CylinderGeometry(0.17, 0.17, 0.02, 24); geo.rotateX(Math.PI / 2);
      if (n[0]) geo.rotateY(Math.PI / 2); geo.translate(cx + n[0] * 0.005, b + h * 0.45, cz + n[1] * 0.005); addGeo(g, geo, M.blackGlass);
    } else if (kind === 'sink') {
      lbox(g, W, back, 0, L, 0, Dp, b, b + h - 0.04, 0.01, M.cabinet);
      lbox(g, W, back, -0.01, L + 0.01, 0, Dp + 0.01, b + h - 0.04, b + h, 0.004, M.stoneTop);
    }
    solid(x0, x1, z0, z1, b, b + h);
  }
  function rug(g, x0, x1, z0, z1, b, mat = M.rug, border = M.rugBorder) {
    rbx(g, x0, x1, b, b + 0.01, z0, z1, 0.004, border, { cast: false });
    rbx(g, x0 + 0.12, x1 - 0.12, b + 0.001, b + 0.016, z0 + 0.12, z1 - 0.12, 0.006, mat, { cast: false });
  }
  // framed picture on a wall face: centre (x,y,z), face = direction it looks at, w x h metres
  function picture(g, x, y, z, face, w, h, mat) {
    const n = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }[face], d = 0.035;
    const X = (u, dn) => n[0] ? [x + n[0] * dn, z + u] : [x + u, z + n[1] * dn];
    const [xa, za] = X(-w / 2 - 0.03, 0), [xb, zb] = X(w / 2 + 0.03, d);
    B(g, Math.min(xa, xb), Math.max(xa, xb), y - h / 2 - 0.03, y + h / 2 + 0.03, Math.min(za, zb), Math.max(za, zb), M.steel);
    const geo = new THREE.PlaneGeometry(w, h); geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V3(0, 0, 1), new V3(n[0], 0, n[1])));
    geo.translate(x + n[0] * (d + 0.002), y, z + n[1] * (d + 0.002)); addGeo(g, geo, mat, false);
  }
  function tableLamp(g, x, y, z) {
    cyl(g, x, y, y + 0.02, z, 0.07, M.steel, 16); cyl(g, x, y + 0.02, y + 0.34, z, 0.008, M.steel, 8);
    cyl(g, x, y + 0.26, y + 0.46, z, 0.14, M.lampShade, 20, { rTop: 0.12, cast: false });
  }
  // Poly Haven models → one InstancedMesh per (model part, group)
  const modelReqs = [];
  const model = (id, g, x, y, z, ry = 0, o = {}) => {
    modelReqs.push({ id, g, x, y, z, ry, s: o.s || 1, cast: o.cast !== false });
    // the plants' "dirt"/"pebbles" sub-meshes are 54-57k triangles each: replaced by a soil disc
    if (id === 'potted_plant_02') cyl(g, x, y + 0.29, y + 0.322, z, 0.212, M.dirt, 18, { cast: false });
    if (id === 'potted_plant_01') cyl(g, x, y + 0.48, y + 0.512, z, 0.215, M.dirt, 18, { cast: false });
  };
  function pendant(g, x, z, yBottom, yCeil) {   // modern_ceiling_lamp_01: globe bottom at y=0.221 in model space, top 1.173
    model('modern_ceiling_lamp_01', g, x, yBottom - 0.221, z, 0, { cast: false });
    if (yCeil > yBottom + 0.96) cyl(g, x, yBottom + 0.95, yCeil, z, 0.005, M.steel, 6, { cast: false });
  }

  // ======================================================================================
  // ZÓCALO (lower floor) — "PLANTA PISO ZOCALO", 1/50
  // ======================================================================================
  {
    const g = ZC, b = LV_Z, zb = { base: LV_Z };
    // slab: concrete plinth (exposed edge) + polished concrete floor
    B(g, -9.57, 22.3, -0.45, b - 0.02, -0.14, 12.13, M.plinth); B(g, -9.57, 22.3, b - 0.02, b, -0.14, 12.13, M.concFloor);
    floorRect(-9.57, 22.3, -0.14, 12.13, LV_Z);
    const zo = { ...zb, plinth: true };
    // lake facade (z=3.6): sliding glass
    glass(g, -7.42, 3.6, -3.7, 3.6, { ...zb, pass: true }); glass(g, -3.7, 3.6, 0.02, 3.6, { ...zb, pass: true });
    glass(g, 0.02, 3.6, 7.37, 3.6, { ...zb, pass: true }); glass(g, 7.37, 3.6, 12.92, 3.6, { ...zb, pass: true });
    wall(g, 12.92, 3.6, 14.84, 3.6, { ...zo, out: 'n', win: [[13.2, 14.5, 1.6, 2.3]] });
    glass(g, 14.84, 3.6, 20.36, 3.6, { ...zb, ghost: true });      // future bedroom 6: glazed, no collider (as v1)
    wall(g, 20.36, 3.6, 22.3, 3.6, { ...zo, out: 'n' });
    // bedroom-row partitions
    wall(g, -7.42, 3.6, -7.42, 7.98, { ...zo, out: 'w', win: [[4.4, 6.6, 0.9, 2.2]] });
    wall(g, -3.7, 3.6, -3.7, 7.98, zb); wall(g, 0.02, 3.6, 0.02, 7.98, zb); wall(g, 7.37, 3.6, 7.37, 7.98, zb);
    wall(g, -0.02, -0.14, -0.02, 1.5, { ...zo, out: 'w', both: true }); wall(g, 7.4, -0.14, 7.4, 1.5, { ...zo, out: 'e', both: true });   // covered terrace
    wall(g, -7.42, 7.92, -4.6, 7.92, zb); wall(g, -3.7, 7.92, -1.0, 7.92, zb);
    wall(g, 0.02, 7.92, 5.7, 7.92, { ...zb, win: [[1.16, 2.36, 0.9, 2.2], [3.42, 4.62, 0.9, 2.2]] });
    wall(g, 7.37, 7.92, 11.99, 7.92, zb);
    // bathroom 3 + walk-in
    wall(g, 12.92, 3.6, 12.92, 6.18, zb); wall(g, 12.92, 7.08, 12.92, 7.98, zb); wall(g, 13.6, 6.18, 14.84, 6.18, zb);
    wall(g, 14.84, 3.6, 14.84, 7.98, zb); wall(g, 12.92, 7.92, 14.84, 7.92, zb);
    // future bathroom 5 / bedroom 6 (ghost, as v1)
    wall(g, 16.66, 3.6, 16.66, 6.3, { ...zb, ghost: true }); wall(g, 14.84, 6.3, 16.66, 6.3, { ...zb, ghost: true }); wall(g, 14.84, 7.98, 20.36, 7.98, { ...zb, ghost: true });
    wall(g, 20.36, 3.6, 20.36, 7.98, zb); wall(g, 22.3, 3.6, 22.3, 7.98, { ...zo, out: 'e' }); wall(g, 20.36, 7.98, 22.3, 7.98, { ...zo, out: 's' });
    // clothes-drying pergola
    for (const x of [-9.4, -8.9, -8.4, -7.9]) B(g, x - 0.05, x + 0.05, LV_Z, 2.75, 7.86, 7.98, M.steel);
    B(g, -9.45, -7.85, 2.62, 2.72, 7.86, 7.98, M.steel);
    // service row
    wall(g, -6.58, 9.22, -6.58, 10.2, zb); wall(g, -6.58, 11.0, -6.58, 12.04, zb);
    wall(g, -5.64, 9.22, -4.01, 9.22, zb); wall(g, -4.01, 9.22, -4.01, 12.04, zb);
    wall(g, -4.01, 9.22, -2.82, 9.22, zb); wall(g, -2.0, 9.22, -2.0, 11.36, zb);
    wall(g, -2.0, 9.22, 0.09, 9.22, zb); wall(g, 0.8, 9.22, 5.65, 9.22, zb);
    wall(g, 0.09, 9.22, 0.09, 11.36, { ...zb, ghost: true });
    wall(g, -1.96, 11.36, 3.77, 11.36, { ...zb, out: 's', win: [[-1.5, 3.4, 0.9, 2.3]] });
    wall(g, 5.65, 9.22, 5.65, 11.36, zb);
    // stair box
    wall(g, 7.4, 9.05, 7.4, 11.34, zb); wall(g, 8.6, 9.05, 11.16, 9.05, zb); wall(g, 11.16, 9.05, 11.16, 12.13, zb);
    // stores
    wall(g, 12.23, 9.1, 14.88, 9.1, zb); wall(g, 14.88, 10.0, 14.88, 12.13, zb); wall(g, 14.88, 9.1, 17.44, 9.1, { ...zo, out: 'n', wrap: [false, true] });

    // --- furniture ---
    // bedroom 5
    bed(g, -7.27, -5.28, 4.44, 6.44, b, 'w', { throw: M.throwRust, pillow: M.pillowCream });
    cabinet(g, -7.3, -4.8, 7.25, 7.82, b, 2.3, 'n');
    model('side_table_01', g, -6.9, b, 4.12, 0);
    // bedroom 4 (two singles)
    bed(g, -3.58, -1.6, 4.3, 5.28, b, 'w', { base: M.oakFurn, head: M.linen }); bed(g, -3.58, -1.6, 5.68, 6.68, b, 'w', { base: M.oakFurn, head: M.linen, throw: M.throwRust });
    cabinet(g, -3.6, -1.1, 7.25, 7.82, b, 2.3, 'n');
    // living room (sala de estar)
    rug(g, 0.6, 4.6, 4.4, 7.3, b, M.rug2, M.rugBorder);
    sofa(g, 0.32, 1.22, 4.1, 7.5, b, 'w', M.boucle, { arms: [true, false], pillows: [M.pillowBlue, M.pillowCream] });
    sofa(g, 1.22, 2.93, 4.1, 5.0, b, 'n', M.boucle, { arms: [false, true], ext0: 0.9, pillows: [M.throwRust, M.pillowCream] });
    model('modern_coffee_table_01', g, 2.19, b, 6.33, 0); solid(1.8, 2.58, 5.74, 6.92, b, b + 0.4);
    model('mid_century_lounge_chair', g, 4.0, b, 6.7, -2.5);
    units(g, 6.8, 7.25, 5.0, 6.8, b + 0.15, b + 0.55, 'w', { mat: M.walnut, handles: false, door: 0.9 }); solid(6.8, 7.25, 5.0, 6.8, b, b + 0.5);
    B(g, 7.2, 7.25, b + 0.95, b + 1.62, 5.3, 6.5, M.tv);
    picture(g, 0.12, b + 1.55, 5.9, 'e', 1.3, 0.9, M.art1);                  // above the sala sofa
    model('potted_plant_02', g, 6.7, b, 4.1, 0.6);
    // covered terrace (under the living)
    sofa(g, 2.04, 2.84, 0.32, 2.9, b, 'w', M.outdoor, { pillows: [M.pillowCream, M.throwOlive] });
    sofa(g, 4.64, 5.46, 0.32, 2.9, b, 'e', M.outdoor, { pillows: [M.throwOlive, M.pillowCream] });
    model('coffee_table_round_01', g, 3.75, b, 1.55, 0); solid(3.2, 4.3, 1.2, 1.9, b, b + 0.4);
    // bedroom 3
    bed(g, 8.7, 10.5, 5.22, 7.22, b, 's', { throw: M.throwOlive });
    cabinet(g, 7.46, 11.9, 7.25, 7.82, b, 2.3, 'n');
    model('side_table_01', g, 8.35, b, 6.95, Math.PI); model('side_table_01', g, 10.85, b, 6.95, Math.PI);
    // bathroom 3, walk-in
    fixture(g, 14.3, 14.72, 4.0, 4.9, b, 0.85, 'vanity', 'e'); fixture(g, 14.3, 14.72, 5.3, 5.75, b, 0.42, 'wc', 'e');
    cabinet(g, 14.3, 14.75, 6.4, 7.8, b, 2.1, 'w');
    // laundry, bathroom 4
    fixture(g, -6.4, -5.2, 11.4, 11.98, b, 0.9, 'washer', 's'); fixture(g, -5.0, -4.4, 11.4, 11.98, b, 0.9, 'sink', 's');
    fixture(g, -3.9, -3.45, 11.3, 11.75, b, 0.42, 'wc', 's'); fixture(g, -2.55, -2.12, 9.6, 10.4, b, 0.85, 'vanity', 'e');
    B(g, -9.3, -6.9, b + 1.8, b + 1.815, 10.2, 10.215, M.steel); B(g, -9.3, -6.9, b + 1.8, b + 1.815, 10.8, 10.815, M.steel);
    cabinet(g, 11.4, 14.6, 11.6, 11.98, b, 2.0, 'n', M.walnut);
    B(g, 18.3, 20.3, b, b + 0.55, 4.84, 6.64, M.ghost, false);

    // --- interior U-stair (two flights and a landing) ---
    for (let i = 0; i < 8; i++) { const x0 = 8.4 + i * 0.25, top = b + (i + 1) * 1.5 / 8;
      B(g, x0, x0 + 0.25, b, top - 0.04, 9.1, 10.12, M.plaster); B(g, x0 - 0.015, x0 + 0.25, top - 0.04, top, 9.1, 10.12, M.oak); }
    B(g, 10.4, 11.1, 1.35, 1.51, 9.1, 11.3, M.plaster); B(g, 10.4, 11.1, 1.51, 1.55, 9.1, 11.3, M.oak);
    for (let i = 0; i < 8; i++) { const x1 = 10.4 - i * 0.25, top = 1.55 + (i + 1) * 1.45 / 8; B(g, x1 - 0.265, x1, top - 0.055, top, 10.2, 11.3, M.oak); }
    beam(g, new V3(10.45, 1.3, 10.75), new V3(8.35, 2.78, 10.75), 0.16, 0.22, M.steel);   // central steel stringer
    B(g, 8.4, 10.4, b, 1.45, 10.14, 10.2, M.plaster); col(8.4, 10.17, 10.4, 10.17, 0, 1.5, 0.04);
    ramp(8.4, 10.4, 9.1, 10.12, 'x', 8.4, 10.4, b, 1.55); floorRect(10.4, 11.1, 9.1, 11.3, 1.55); ramp(8.4, 10.4, 10.2, 11.3, 'x', 10.4, 8.4, 1.55, LV_F);
    // handrail on the open side of the upper flight
    for (const [x, y] of [[10.35, 1.55], [8.45, 3.0]]) B(g, x - 0.015, x + 0.015, y, y + 0.92, 11.25, 11.28, M.steel);
    beam(g, new V3(10.35, 2.47, 11.265), new V3(8.45, 3.92, 11.265), 0.04, 0.04, M.steel);

    // --- lights (lower floor) ---
    point(g, 3.7, 1.7, 5.9, 6, 7);    // sala
    point(g, 3.7, 1.8, 1.7, 4);       // covered terrace
    point(g, 10.1, 1.7, 5.6, 4);      // bedroom 3
    point(g, -1.8, 1.7, 5.9, 3.5);    // bedroom 4
    point(g, -5.6, 1.7, 5.9, 3.5);    // bedroom 5
    tableLamp(g, 8.35, b + 0.55, 6.95); tableLamp(g, 10.85, b + 0.55, 6.95); tableLamp(g, -6.9, b + 0.55, 4.12);
    // exterior sconces on the lower facade + wall washes
    sconce(g, 12.95, 2.05, 3.45, 'n'); sconce(g, 14.8, 2.05, 3.45, 'n'); sconce(g, 22.15, 2.05, 3.45, 'n');
    sconce(g, -0.17, 2.05, 0.9, 'w'); sconce(g, 7.55, 2.05, 0.9, 'e');
    sconce(g, -7.57, 2.05, 4.0, 'w'); sconce(g, 22.45, 2.05, 5.8, 'e');

    const ly = 1.35;
    label(g, 'Sala de estar', 3.7, ly, 6.1); label(g, 'Terraza cubierta', 3.7, ly, 1.4); label(g, 'Dormitorio 3', 10.0, ly, 4.6);
    label(g, 'Baño 3', 13.9, ly, 4.6); label(g, 'Dormitorio 4', -1.9, ly, 5.9); label(g, 'Dormitorio 5', -5.6, ly, 5.9);
    label(g, 'Lavado', -5.3, ly, 10.6); label(g, 'Baño 4', -3.0, ly, 10.2); label(g, 'Dorm. servicio (posible)', 2.7, ly, 10.3);
    label(g, 'Bodega', 13.0, ly, 10.6); label(g, 'Bodega exterior', 17.0, ly, 10.6); label(g, 'Patio inglés', 0.9, ly, 12.6);
    label(g, 'Futuro dormitorio 6', 18.5, ly, 5.6); label(g, 'Patio de colgar', -8.1, ly, 10.6);
  }

  // ======================================================================================
  // PRIMER PISO (first floor) — "PLANTA PRIMER PISO", 1/50
  // ======================================================================================
  {
    const g = FF, b = LV_F, fb = { base: LV_F };
    // slabs and decks (deck undersides: dark cladding boards)
    slab(g, 0, 7.4, 0, 12.06, M.oak);
    slab(g, -7.38, 0, 3.56, 7.8, M.deck); slab(g, -6.66, 0, 7.8, 12.06, M.deck); slab(g, -9.6, -6.66, 7.8, 12.0, M.deck, M.clad);   // quincho floor: lower-floor rooms below
    slab(g, -1.9, 9.3, -1.7, 0, M.deck, M.clad, 0.34); slab(g, -1.9, 0, 0, 1.5, M.deck, M.clad, 0.34); slab(g, -8.7, 0, 1.5, 3.56, M.deck, M.clad, 0.34);
    slab(g, 7.4, 9.3, 0, 1.52, M.deck, M.clad, 0.34); slab(g, 7.4, 22.28, 1.52, 3.56, M.deck, M.clad, 0.34);
    slab(g, 7.4, 22.2, 3.56, 7.86, M.oak); slab(g, 7.4, 8.4, 7.86, 11.34, M.oak); slab(g, 8.4, 11.16, 7.86, 9.0, M.oak); slab(g, 11.16, 19.5, 7.86, 12.06, M.oak);

    // central volume: living + dining + kitchen
    wall(g, 0, -0.2, 0, 1.5, { ...fb, out: 'w' });
    glass(g, 0, 1.5, 0, 7.8, { ...fb, pass: true });
    wall(g, 0, 7.8, 0, 10.32, { ...fb, out: 'w' }); wall(g, 0, 11.28, 0, 12.06, { ...fb, out: 'w' });
    glass(g, 0, 0, 7.4, 0, { ...fb, pass: true, bay: 1.5 });
    wall(g, 7.4, -0.2, 7.4, 3.56, { ...fb, out: 'e', wrap: [true, false] }); wall(g, 7.4, 3.56, 7.4, 7.92, fb);
    wall(g, 0, 12.06, 5.64, 12.06, { ...fb, out: 's', win: [[1.8, 4.26, 0.95, 2.2]] });
    wall(g, 5.64, 7.8, 5.64, 12.06, fb);
    glass(g, 5.64, 11.34, 7.4, 11.34, { ...fb, pass: true, bay: 0.9 });   // front door
    // stair well
    wall(g, 8.4, 9.0, 11.16, 9.0, fb); wall(g, 11.16, 9.0, 11.16, 12.06, fb);
    glass(g, 7.4, 11.34, 11.16, 11.34, fb); railGlass(g, 8.4, 9.0, 8.4, 10.17, LV_F);
    // bedroom wing
    glass(g, 7.4, 3.56, 12.9, 3.56, { ...fb, pass: true });
    wall(g, 12.9, 3.56, 14.82, 3.56, { ...fb, out: 'n', win: [[13.2, 14.5, 1.6, 2.3]] });
    glass(g, 14.82, 3.56, 22.2, 3.56, { ...fb, pass: true });
    wall(g, 22.2, 3.56, 22.2, 7.8, { ...fb, out: 'e', win: [[4.2, 7.2, 0.5, 2.4]] });
    wall(g, 7.4, 7.2, 11.9, 7.2, fb);
    units(g, 7.5, 11.9, 7.25, 7.6, b, b + 2.2, 's', { mat: M.oakFurn, door: 0.73, handleY: b + 1.05 }); solid(7.5, 11.9, 7.25, 7.6, b, b + 2.2);   // hall shelving
    wall(g, 12.9, 3.56, 12.9, 6.18, fb); wall(g, 12.9, 7.02, 12.9, 7.86, fb); wall(g, 13.9, 6.18, 14.82, 6.18, fb);
    wall(g, 14.82, 3.56, 14.82, 7.86, fb); wall(g, 12.9, 7.86, 14.82, 7.86, fb);
    wall(g, 16.92, 7.8, 19.5, 7.8, fb); wall(g, 19.5, 7.8, 22.2, 7.8, { ...fb, out: 's', wrap: [false, true] }); wall(g, 15.8, 7.8, 15.8, 9.2, fb);
    wall(g, 12.9, 9.2, 14.5, 9.2, fb); wall(g, 15.4, 9.2, 15.8, 9.2, fb); wall(g, 17.8, 9.2, 19.5, 9.2, fb);
    wall(g, 16.92, 9.2, 16.92, 10.14, fb); wall(g, 15.48, 10.14, 16.92, 10.14, fb); wall(g, 15.48, 9.2, 15.48, 12.06, fb);
    wall(g, 12.06, 9.2, 12.06, 10.38, fb); wall(g, 12.06, 10.38, 12.9, 10.38, fb); wall(g, 12.9, 9.2, 12.9, 12.06, fb);
    wall(g, 11.16, 12.06, 19.5, 12.06, { ...fb, out: 's', win: [[11.5, 12.6, 1.5, 2.2], [13.3, 15.0, 1.5, 2.2], [15.7, 16.7, 1.5, 2.2], [17.3, 19.1, 1.5, 2.2]] });
    wall(g, 19.5, 7.8, 19.5, 12.06, { ...fb, out: 'e', wrap: [false, true], win: [[8.0, 9.0, 0.9, 2.2], [10.3, 11.7, 1.5, 2.2]] });
    // quincho + service patio
    wall(g, -7.38, 3.48, -7.38, 6.36, { ...fb, out: 'w', both: true }); railGlass(g, -7.38, 6.36, -7.38, 7.8, LV_F);
    wall(g, -9.6, 7.8, -9.6, 12.0, { ...fb, h: 1.8, out: 'w', both: true }); wall(g, -9.6, 7.8, -6.66, 7.8, { ...fb, h: 1.8, out: 'n', both: true }); wall(g, -9.6, 12.0, -6.66, 12.0, { ...fb, h: 1.8, out: 's', both: true });
    wall(g, -6.66, 7.8, -6.66, 10.26, { ...fb, both: true }); wall(g, -6.66, 12.0, -1.08, 12.0, { ...fb, out: 's', both: true });
    railGlass(g, -1.08, 12.06, 0, 12.06, LV_F);
    // deck railings: glass on the living/quincho decks (r2), balusters on the long bedroom deck (r1)
    railGlass(g, -1.9, -1.7, 9.3, -1.7, LV_F); railGlass(g, -1.9, -1.7, -1.9, 1.5, LV_F); railGlass(g, -8.7, 1.5, -1.9, 1.5, LV_F);
    railGlass(g, -8.7, 1.5, -8.7, 2.3, LV_F);                          // opening 2.3..3.56 → the new steel stair
    railGlass(g, -8.7, 3.56, -7.38, 3.56, LV_F);
    railBal(g, 9.3, -1.7, 9.3, 1.52, LV_F); railBal(g, 9.3, 1.52, 22.28, 1.52, LV_F); railBal(g, 22.28, 1.52, 22.28, 3.56, LV_F);
    railGlass(g, -2.23, 12.06, -2.23, 13.8, LV_F); railGlass(g, 4.13, 12.06, 4.13, 13.8, LV_F); railGlass(g, -2.23, 13.8, 4.13, 13.8, LV_F);
    // columns (black steel)
    for (const x of [-1.9, 1.86, 5.56, 9.3]) post(g, x, -1.7, 0, LV_F - 0.25);
    post(g, -0.3, -1.75, LV_F, 5.5); post(g, 7.7, -1.75, LV_F, 5.5);
    for (const x of [-8.7, -5.8, -2.9]) post(g, x, 1.5, 0, 5.84);
    for (const x of [9.3, 12.6, 15.9, 19.2, 22.28]) post(g, x, 1.52, 0, 5.84);
    for (const x of [0, 1.88, 5.58, 7.4]) post(g, x, -0.1, LV_Z, 2.75);

    // --- fireplaces ---
    // living: plaster chimney breast, black steel surround, firebox with a live flame
    { // breast split around a 0.85 x 0.7 opening recessed 0.34 m, black steel frame, hearth bench, logs and a live flame
      const fy0 = b + 0.45, fy1 = b + 1.15, fz0 = 3.5, fz1 = 4.35, fx = 7.0;
      B(g, 6.66, 7.3, b, fy0, 3.1, 4.75, M.plaster); B(g, 6.66, 7.3, fy1, 6.15, 3.1, 4.75, M.plaster);
      B(g, 6.66, 7.3, fy0, fy1, 3.1, fz0, M.plaster); B(g, 6.66, 7.3, fy0, fy1, fz1, 4.75, M.plaster);
      B(g, fx, 7.3, fy0, fy1, fz0, fz1, M.soot, false);
      B(g, 6.66, fx, fy0 - 0.01, fy0, fz0, fz1, M.soot, false); B(g, 6.66, fx, fy1, fy1 + 0.01, fz0, fz1, M.soot, false);
      B(g, 6.66, fx, fy0, fy1, fz0, fz0 + 0.01, M.soot, false); B(g, 6.66, fx, fy0, fy1, fz1 - 0.01, fz1, M.soot, false);
      B(g, 6.6, 6.66, fy0 - 0.08, fy0, fz0 - 0.08, fz1 + 0.08, M.steel); B(g, 6.6, 6.66, fy1, fy1 + 0.08, fz0 - 0.08, fz1 + 0.08, M.steel);
      B(g, 6.6, 6.66, fy0, fy1, fz0 - 0.08, fz0, M.steel); B(g, 6.6, 6.66, fy0, fy1, fz1, fz1 + 0.08, M.steel);
      B(g, 6.2, 6.66, b, b + 0.3, 3.1, 4.75, M.stoneTop);                         // raised hearth bench
      B(g, 6.75, 6.98, fy0, fy0 + 0.03, fz0 + 0.1, fz1 - 0.1, M.embers, false);
      for (const z of [3.8, 4.05]) { const lg = new THREE.CylinderGeometry(0.045, 0.05, 0.55, 8); lg.rotateX(Math.PI / 2); lg.rotateY(0.25 * (z < 3.9 ? 1 : -1)); lg.translate(6.87, fy0 + 0.07, z); addGeo(g, lg, M.logs); }
      const fl = new THREE.PlaneGeometry(0.6, 0.5); fl.rotateY(-Math.PI / 2); fl.translate(6.86, fy0 + 0.26, 3.925); const m = addGeo(g, fl, M.fire, false); m.userData.noMerge = true;
      solid(6.66, 7.3, 3.1, 4.75, b, 5.7);
    }
    // quincho: stone fireplace, firebox facing east
    { const fy0 = b + 0.35, fy1 = b + 1.1, fz0 = 4.8, fz1 = 5.7, fx = -6.9;
      B(g, -7.38, -6.52, b, fy0, 4.32, 6.18, M.stone); B(g, -7.38, -6.52, fy1, 5.9, 4.32, 6.18, M.stone);
      B(g, -7.38, -6.52, fy0, fy1, 4.32, fz0, M.stone); B(g, -7.38, -6.52, fy0, fy1, fz1, 6.18, M.stone);
      B(g, -7.38, fx, fy0, fy1, fz0, fz1, M.soot, false);
      B(g, fx, -6.52, fy0 - 0.01, fy0, fz0, fz1, M.soot, false); B(g, fx, -6.52, fy1, fy1 + 0.01, fz0, fz1, M.soot, false);
      B(g, fx, -6.52, fy0, fy1, fz0, fz0 + 0.01, M.soot, false); B(g, fx, -6.52, fy0, fy1, fz1 - 0.01, fz1, M.soot, false);
      B(g, -6.52, -6.22, b, b + 0.3, 4.32, 6.18, M.stone);
      B(g, -6.88, -6.62, fy0, fy0 + 0.03, fz0 + 0.1, fz1 - 0.1, M.embers, false);
      for (const z of [5.1, 5.4]) { const lg = new THREE.CylinderGeometry(0.05, 0.055, 0.6, 8); lg.rotateX(Math.PI / 2); lg.rotateY(0.3 * (z < 5.25 ? 1 : -1)); lg.translate(-6.74, fy0 + 0.08, z); addGeo(g, lg, M.logs); }
      const fl = new THREE.PlaneGeometry(0.7, 0.55); fl.rotateY(Math.PI / 2); fl.translate(-6.74, fy0 + 0.29, 5.25); const m = addGeo(g, fl, M.fire, false); m.userData.noMerge = true;
      solid(-7.38, -6.52, 4.32, 6.18, b, 5.7);
    }
    // quincho BBQ counter: stone, stone top, grill, black hood + flue through the roof
    B(g, -6.6, -1.1, b, b + 0.9, 11.35, 11.95, M.stone); B(g, -6.62, -1.08, b + 0.9, b + 0.95, 11.3, 11.97, M.stoneTop); solid(-6.6, -1.1, 11.35, 11.95, b, b + 0.95);
    B(g, -4.58, -2.82, b + 0.95, b + 1.0, 11.4, 11.9, M.steel);
    B(g, -4.55, -2.85, b + 0.951, b + 0.955, 11.42, 11.88, M.embers, false);
    B(g, -4.7, -2.7, b + 1.9, b + 2.6, 11.25, 11.95, M.steel); B(g, -3.95, -3.45, b + 2.6, 6.9, 11.5, 11.9, M.steel);
    B(g, -4.02, -3.38, 6.9, 6.95, 11.43, 11.97, M.steel);

    // --- quincho furniture ---
    sofa(g, -1.86, -0.98, 3.66, 6.24, b, 'e', M.outdoor, { pillows: [M.throwOlive, M.pillowCream] });
    sofa(g, -5.06, -2.46, 6.42, 7.3, b, 's', M.outdoor, { pillows: [M.pillowCream, M.throwRust] });
    model('coffee_table_round_01', g, -3.84, b, 5.26, 0); solid(-4.68, -3.0, 4.78, 5.74, b, b + 0.4);
    diningTable(g, -5.28, -2.1, 8.7, 9.9, b, 0.75, M.teak);
    for (const x of [-4.9, -4.28, -3.66, -3.04, -2.42]) { outChair(g, x, 8.35, b, 0); outChair(g, x, 10.25, b, Math.PI); }
    outChair(g, -5.65, 9.3, b, Math.PI / 2); outChair(g, -1.75, 9.3, b, -Math.PI / 2);
    // --- living / dining ---
    rug(g, 1.0, 4.8, 0.7, 3.7, b);
    sofa(g, 1.2, 2.1, 0.82, 3.42, b, 'w', M.linen, { arms: [false, true], pillows: [M.pillowBlue, M.pillowCream] });
    sofa(g, 2.1, 4.56, 2.52, 3.42, b, 's', M.linen, { arms: [true, false], ext1: 0.9, pillows: [M.throwRust, M.pillowCream] });
    model('modern_coffee_table_01', g, 3.39, b, 1.535, Math.PI / 2); solid(2.8, 3.98, 1.15, 1.92, b, b + 0.38);
    model('mid_century_lounge_chair', g, 5.5, b, 1.6, -2.2);
    model('side_table_01', g, 1.62, b, 0.45, 0);
    model('potted_plant_01', g, 0.45, b, 0.45, 0.4);
    diningTable(g, 1.56, 4.14, 4.44, 5.62, b, 0.75, M.walnut);
    for (const x of [1.9, 2.5, 3.1, 3.7]) { model('dining_chair_02', g, x, b, 4.05, 0); model('dining_chair_02', g, x, b, 6.0, Math.PI); }
    model('dining_chair_02', g, 1.15, b, 5.03, Math.PI / 2); model('dining_chair_02', g, 4.55, b, 5.03, -Math.PI / 2);
    // --- kitchen ---
    units(g, 0.12, 0.8, 7.9, 10.3, b, b + 2.3, 'e', { toe: true, door: 0.6, handleY: b + 1.05 }); solid(0.12, 0.8, 7.9, 10.3, b, b + 2.3);
    B(g, 0.8, 0.806, b + 0.1, b + 2.28, 9.12, 9.68, M.steelApp);                                   // integrated fridge door
    units(g, 4.98, 5.54, 7.9, 11.25, b, b + 0.9, 'w', { toe: true, drawer: 0.2, top: M.stoneTop, handleY: b + 0.83 }); solid(4.95, 5.54, 7.9, 11.25, b, b + 0.94);
    B(g, 5.02, 5.46, b + 0.94, b + 0.946, 9.3, 9.9, M.blackGlass);                                  // cooktop
    B(g, 5.515, 5.54, b + 0.94, b + 1.5, 7.9, 11.25, M.stoneTop);                                   // splashback
    units(g, 5.2, 5.54, 7.9, 9.2, b + 1.5, b + 2.3, 'w', { handleY: b + 1.53 }); units(g, 5.2, 5.54, 10.0, 11.25, b + 1.5, b + 2.3, 'w', { handleY: b + 1.53 });
    B(g, 5.08, 5.54, b + 1.62, b + 2.3, 9.2, 10.0, M.steelApp);                                     // range hood
    units(g, 1.6, 4.5, 11.4, 11.96, b, b + 0.9, 'n', { toe: true, drawer: 0.2, top: M.stoneTop, handleY: b + 0.83 }); solid(1.6, 4.5, 11.35, 11.96, b, b + 0.94);
    B(g, 2.75, 3.45, b + 0.94, b + 0.945, 11.45, 11.85, M.sinkDark);                                 // sink
    cyl(g, 3.1, b + 0.94, b + 1.24, 11.88, 0.014, M.chrome, 10); beam(g, new V3(3.1, b + 1.23, 11.89), new V3(3.1, b + 1.23, 11.66), 0.022, 0.022, M.chrome);
    units(g, 1.92, 3.64, 8.54, 9.54, b, b + 0.9, 'n', { toe: true, mat: M.oakFurn, handles: false, door: 0.86 });   // island
    B(g, 1.87, 3.69, b + 0.9, b + 0.95, 8.49, 9.59, M.stoneTop); B(g, 1.87, 1.92, b, b + 0.9, 8.49, 9.59, M.stoneTop); B(g, 3.64, 3.69, b, b + 0.9, 8.49, 9.59, M.stoneTop);
    solid(1.87, 3.69, 8.49, 9.59, b, b + 0.95);
    for (const [x, z] of [[2.35, 8.2], [3.2, 8.2], [2.35, 9.9], [3.2, 9.9]]) model('metal_stool_01', g, x, b, z, 0);
    // --- bedrooms ---
    bed(g, 9.0, 10.74, 5.18, 7.14, b, 's', { throw: M.throwRust });
    model('side_table_01', g, 8.65, b, 6.9, Math.PI); model('side_table_01', g, 11.09, b, 6.9, Math.PI);
    solid(8.4, 8.9, 6.65, 7.12, b, b + 0.55); solid(10.84, 11.34, 6.65, 7.12, b, b + 0.55);
    tableLamp(g, 8.65, b + 0.55, 6.9); tableLamp(g, 11.09, b + 0.55, 6.9);
    picture(g, 9.87, b + 1.62, 7.1, 'n', 1.0, 0.7, M.art1);                    // above the bed, bedroom 2
    rug(g, 17.6, 21.2, 5.0, 7.7, b);
    bed(g, 18.5, 20.35, 5.8, 7.72, b, 's', { head: M.linen, base: M.oakFurn, throw: M.throwOlive, pillow: M.throwRust });
    model('side_table_01', g, 18.15, b, 7.45, Math.PI); model('side_table_01', g, 20.7, b, 7.45, Math.PI);
    solid(17.9, 18.4, 7.2, 7.7, b, b + 0.55); solid(20.45, 20.95, 7.2, 7.7, b, b + 0.55);
    tableLamp(g, 18.15, b + 0.55, 7.45); tableLamp(g, 20.7, b + 0.55, 7.45);
    picture(g, 19.43, b + 1.62, 7.7, 'n', 1.2, 0.8, M.art2);                   // above the bed, bedroom 1
    sofa(g, 15.0, 15.8, 4.3, 6.1, b, 'w', M.boucle, { pillows: [M.pillowBlue, M.pillowCream] });
    lowTable(g, 16.2, 16.8, 4.9, 5.5, b, 0.4, M.oakFurn);
    cabinet(g, 14.3, 14.72, 6.35, 7.76, b, 2.2, 'w');
    model('potted_plant_02', g, 21.75, b, 4.1, 1.1);
    // --- bathrooms, walk-in ---
    fixture(g, 14.25, 14.72, 3.8, 4.9, b, 0.85, 'vanity', 'e'); fixture(g, 14.3, 14.72, 5.3, 5.75, b, 0.42, 'wc', 'e');
    fixture(g, 17.2, 19.4, 11.2, 11.96, b, 0.55, 'tub', 's'); fixture(g, 18.95, 19.42, 9.4, 10.8, b, 0.85, 'vanity', 'e'); fixture(g, 15.6, 16.0, 11.45, 11.9, b, 0.42, 'wc', 's');
    fixture(g, 11.3, 11.7, 11.45, 11.9, b, 0.42, 'wc', 's'); fixture(g, 12.4, 12.82, 10.55, 11.1, b, 0.85, 'vanity', 'e');
    cabinet(g, 13.0, 13.45, 9.4, 11.9, b, 2.2, 'e'); cabinet(g, 15.0, 15.38, 10.3, 11.9, b, 2.2, 'w'); cabinet(g, 12.15, 12.8, 9.3, 10.3, b, 2.2, 'e');
    // --- deck plants (white pots, r1/r2) ---
    for (const [x, z, r] of [[-1.45, -1.25, 0.3], [8.85, -1.25, 1.9], [-8.25, 1.95, 2.4], [-2.35, 1.95, 0.8], [12.2, 2.05, 1.3], [21.8, 2.05, 2.8]]) model('potted_plant_02', g, x, b, z, r);
    model('potted_plant_02', g, 6.05, b, 11.75, 0.8);

    // --- NEW: black steel exterior stair, quincho deck west edge → lawn (r2) ---
    {
      const X0 = -9.9, X1 = -8.75, R = 0.1875, T = 0.28;
      // top landing (y=3.0), mid landing (y=1.5): steel frame + deck boards, posts to the ground
      B(g, X0, -8.7, b - 0.16, b - 0.03, 2.3, 3.5, M.steel); B(g, X0 + 0.02, -8.72, b - 0.03, b, 2.32, 3.48, M.deck);
      B(g, X0, X1, 1.5 - 0.16, 1.5 - 0.03, -0.8, 0.34, M.steel); B(g, X0 + 0.02, X1 - 0.02, 1.47, 1.5, -0.78, 0.32, M.deck);
      for (const z of [2.36, 3.44]) post(g, X0 + 0.06, z, 0, b - 0.16);
      for (const [x, z] of [[X0 + 0.06, -0.74], [X0 + 0.06, 0.28], [X1 - 0.06, -0.74], [X1 - 0.06, 0.28]]) post(g, x, z, 0, 1.34);
      B(g, X0 - 0.1, X1 + 0.1, -0.02, 0.05, -3.1, -2.62, M.plinth);                                   // footing pad
      // flights: 8 risers each, open treads on two flat-bar stringers
      const flight = (zTop, yTop) => {
        for (let i = 1; i <= 7; i++) { const y = yTop - i * R, z1 = zTop - (i - 1) * T + 0.02, z0 = zTop - i * T;
          B(g, X0 + 0.04, X1 - 0.04, y - 0.045, y, z0, z1, M.deck); B(g, X0 + 0.02, X1 - 0.02, y - 0.07, y - 0.045, z0 + 0.02, z0 + 0.06, M.steel); }
        const zBot = zTop - 8 * T;
        for (const x of [X0 + 0.01, X1 - 0.01]) beam(g, new V3(x, yTop - 0.13, zTop + 0.02), new V3(x, yTop - 8 * R - 0.13, zBot + 0.02), 0.016, 0.26, M.steel);
        return zBot;
      };
      flight(2.3, 3.0); flight(-0.8, 1.5);
      // guards: posts, handrails and balusters on both sides
      const guard = (x, pts) => {   // pts: [z, yFloor] polyline along the side
        for (const [z, y] of pts) B(g, x - 0.022, x + 0.022, y, y + 1.0, z - 0.022, z + 0.022, M.steel);
        for (let k = 0; k < pts.length - 1; k++) { const [za, ya] = pts[k], [zb2, yb] = pts[k + 1];
          beam(g, new V3(x, ya + 1.0, za), new V3(x, yb + 1.0, zb2), 0.045, 0.04, M.steel);
          const n = Math.max(1, Math.round(Math.abs(zb2 - za) / 0.12));
          for (let j = 1; j < n; j++) { const f = j / n, z = za + (zb2 - za) * f, y = ya + (yb - ya) * f; B(g, x - 0.008, x + 0.008, y + 0.05, y + 1.0, z - 0.008, z + 0.008, M.steel); } }
      };
      guard(X0 + 0.01, [[3.48, 3.0], [2.3, 3.0], [0.34 + 0.0, 1.5 + 0.0], [-0.8, 1.5], [-2.76, 0.0]]);
      guard(X1 - 0.01, [[1.5, 1.5 + (1.5 - 0.34) / (2.3 - 0.34) * 1.5], [0.34, 1.5], [-0.8, 1.5], [-2.76, 0.0]]);
      B(g, X0, -8.72, b, b + 1.0, 3.478, 3.5, M.steel); beam(g, new V3(X0, b + 1.02, 3.49), new V3(-8.72, b + 1.02, 3.49), 0.045, 0.04, M.steel);
      for (let x = X0 + 0.12; x < -8.75; x += 0.12) B(g, x - 0.008, x + 0.008, b + 0.05, b + 1.0, 3.481, 3.497, M.steel);
      // walk physics
      floorRect(X0, -8.7, 2.3, 3.5, LV_F); floorRect(X0, X1, -0.8, 0.34, 1.5);
      ramp(X0, X1, 0.34, 2.3, 'z', 0.34, 2.3, 1.5, LV_F); ramp(X0, X1, -2.76, -0.8, 'z', -2.76, -0.8, 0.0, 1.5);
      col(X0 - 0.02, -2.76, X0 - 0.02, 3.5, 0, 4.2, 0.03); col(X1 + 0.02, -2.76, X1 + 0.02, 1.5, 0, 4.2, 0.03);
      col(X0, 3.52, -8.7, 3.52, 2.9, 4.1, 0.03);
    }

    // --- lights (first floor) ---
    point(g, 3.2, 5.4, 1.9, 11, 8);  // living
    point(g, 2.85, 4.9, 5.0, 7);     // dining (under the pendants)
    point(g, 2.8, 5.2, 10.0, 8);     // kitchen
    point(g, -3.7, 5.2, 7.6, 8, 7);  // quincho
    point(g, 10.0, 4.55, 5.3, 4);    // bedroom 2
    point(g, 18.4, 4.55, 5.5, 5);    // bedroom 1
    point(g, 7.9, 4.6, 10.4, 3.5);   // entrance / stair
    for (const [x, z] of [[2.1, 5.03], [2.85, 5.03], [3.6, 5.03]]) pendant(g, x, z, b + 1.55, 5.385 + (x + 0.45) * Math.tan(35 * D2R));
    for (const [x, z] of [[2.35, 9.04], [3.2, 9.04]]) pendant(g, x, z, b + 1.72, 5.385 + (x + 0.45) * Math.tan(35 * D2R));
    for (const x of [-4.5, -2.9]) pendant(g, x, 9.3, b + 1.6, 5.72 + (12.5 - 9.3) * Math.tan(22 * D2R));
    // sconces beside the doors and on the deck walls
    sconce(g, 5.76, b + 2.0, 11.72, 'e'); sconce(g, 11.04, b + 2.0, 11.72, 'w');
    sconce(g, 5.3, b + 2.05, 12.21, 's'); sconce(g, 11.33, b + 2.05, 12.21, 's');
    sconce(g, -7.53, b + 2.05, 3.85, 'w'); sconce(g, -7.53, b + 2.05, 6.0, 'w');
    sconce(g, -0.15, b + 2.05, 0.75, 'w'); sconce(g, 7.55, b + 2.05, 0.75, 'e');
    sconce(g, 13.1, b + 2.05, 3.41, 'n'); sconce(g, 14.62, b + 2.05, 3.41, 'n'); sconce(g, 22.35, b + 2.05, 3.85, 'e');

    const ly = LV_F + 1.35;
    label(g, 'Living', 3.4, ly, 1.6); label(g, 'Comedor', 2.85, ly, 5.0); label(g, 'Cocina', 2.8, ly, 10.4); label(g, 'Quincho', -3.7, ly, 7.7);
    label(g, 'Terraza', 3.7, ly, -0.85); label(g, 'Dormitorio 1', 18.3, ly, 5.2); label(g, 'Dormitorio 2', 10.1, ly, 4.5);
    label(g, 'Baño 2', 13.9, ly, 4.6); label(g, 'Baño 1', 18.2, ly, 10.6); label(g, 'Baño visitas', 12.0, ly, 11.2);
    label(g, 'Entrada', 6.5, ly, 10.2); label(g, 'Patio de servicio', -8.1, ly, 9.9);

    // recessed downlights, lower floor (they sit in this slab's ceiling, so they hide with the first floor)
    const yc = LV_F - 0.262;
    downGrid(g, 0.02, 7.37, 3.6, 7.92, yc, 3, 2);       // sala
    downGrid(g, 0.0, 7.4, -0.1, 3.6, yc, 3, 2);         // covered terrace
    downGrid(g, 7.37, 12.92, 3.6, 7.2, yc, 2, 2);       // bedroom 3
    downGrid(g, -3.7, 0.02, 3.6, 7.2, yc, 2, 2);        // bedroom 4
    downGrid(g, -7.42, -3.7, 3.6, 7.2, yc, 2, 2);       // bedroom 5
    downGrid(g, -7.42, 7.37, 7.92, 9.22, yc, 6, 1);     // corridor
    downGrid(g, 12.92, 14.84, 3.6, 6.18, yc, 1, 2);     // bathroom 3
    downGrid(g, -6.58, -2.0, 9.22, 11.36, yc, 2, 1);    // laundry / bathroom 4
  }

  // ======================================================================================
  // ROOFS — three gables (central higher, 35°; wings 22°), with real valleys where the wings meet the centre
  // ======================================================================================
  {
    const g = RF, TH = 0.22;
    const tM = Math.tan(35 * D2R), dM = TH / Math.cos(35 * D2R), tW = Math.tan(22 * D2R), dW = TH / Math.cos(22 * D2R);
    const xr = 3.7, eM = 5.385, eW = 5.72, zr = 6.85;
    const yMU = x => eM + (4.15 - Math.abs(x - xr)) * tM, yMT = x => yMU(x) + dM;       // main roof underside / top
    const yWU = z => eW + (5.65 - Math.abs(z - zr)) * tW, yWT = z => yWU(z) + dW;       // wing roofs
    const xvE = z => 7.85 - (yWT(z) - eM - dM) / tM, xvW = z => -0.45 + (yWT(z) - eM - dM) / tM;   // valley lines
    const P = (x, y, z) => new V3(x, y, z);
    // slab with vertical fascia edges: top polygon, bottom = top shifted down by d
    function roofSlab(top, d, uAx, vAx, tile = 4.4) {
      const gt = new GB(), gbm = new GB(), ge = new GB(), bot = top.map(p => p.clone().add(P(0, -d, 0)));
      gt.poly(top, UP, p => [p.dot(uAx) / tile, p.dot(vAx) / tile]);
      gbm.poly(bot, DOWN, p => [p.dot(uAx) / 1.7, p.dot(vAx) / 1.7]);
      const c = top.reduce((s, p) => s.add(p), new V3()).multiplyScalar(1 / top.length);
      for (let i = 0; i < top.length; i++) { const a = top[i], bq = top[(i + 1) % top.length];
        const hint = new V3((a.x + bq.x) / 2 - c.x, 0, (a.z + bq.z) / 2 - c.z);
        ge.poly([a, bq, bot[(i + 1) % top.length], bot[i]], hint, p => [(p.x + p.z) / 1.6, p.y / 1.6]); }
      addGeo(g, gt.geo(), M.roof); addGeo(g, gbm.geo(), M.lining); addGeo(g, ge.geo(), M.steel);
    }
    const alongZ = new V3(0, 0, 1), alongX = new V3(1, 0, 0);
    const slopeX = s => new V3(s * Math.cos(35 * D2R), -Math.sin(35 * D2R), 0);         // downslope, main roof
    const slopeZ = s => new V3(0, -Math.sin(22 * D2R), s * Math.cos(22 * D2R));        // downslope, wings
    const yR = yMT(xr), yE = eM + dM, yRW = yWT(zr), yEW = eW + dW;
    // main roof, east + west slopes: front part (over the living deck) to the eaves; behind z=1.2 clipped at the walls (the wings cover it)
    roofSlab([P(xr, yR, -1.9), P(7.85, yE, -1.9), P(7.85, yE, 1.2), P(xr, yR, 1.2)], dM, alongZ, slopeX(1));
    roofSlab([P(xr, yR, 1.2), P(7.4, yMT(7.4), 1.2), P(7.4, yMT(7.4), 12.5), P(xr, yR, 12.5)], dM, alongZ, slopeX(1));
    roofSlab([P(-0.45, yE, -1.9), P(xr, yR, -1.9), P(xr, yR, 1.2), P(-0.45, yE, 1.2)], dM, alongZ, slopeX(-1));
    roofSlab([P(0, yMT(0), 1.2), P(xr, yR, 1.2), P(xr, yR, 12.5), P(0, yMT(0), 12.5)], dM, alongZ, slopeX(-1));
    // bedroom wing (east): valley on the west end
    roofSlab([P(xvE(1.2), yEW, 1.2), P(22.7, yEW, 1.2), P(22.7, yRW, zr), P(xvE(zr), yRW, zr)], dW, alongX, slopeZ(-1));
    roofSlab([P(xvE(zr), yRW, zr), P(22.7, yRW, zr), P(22.7, yEW, 12.5), P(xvE(12.5), yEW, 12.5)], dW, alongX, slopeZ(1));
    // quincho wing (west): valley on the east end
    roofSlab([P(-7.8, yEW, 1.2), P(xvW(1.2), yEW, 1.2), P(xvW(zr), yRW, zr), P(-7.8, yRW, zr)], dW, alongX, slopeZ(-1));
    roofSlab([P(-7.8, yRW, zr), P(xvW(zr), yRW, zr), P(xvW(12.5), yEW, 12.5), P(-7.8, yEW, 12.5)], dW, alongX, slopeZ(1));
    // ridge caps + valley flashings
    beam(g, P(xr, yR + 0.02, -1.95), P(xr, yR + 0.02, 12.55), 0.2, 0.05, M.roofSeam);
    beam(g, P(xvE(zr) - 0.1, yRW + 0.02, zr), P(22.75, yRW + 0.02, zr), 0.2, 0.05, M.roofSeam);
    beam(g, P(-7.85, yRW + 0.02, zr), P(xvW(zr) + 0.1, yRW + 0.02, zr), 0.2, 0.05, M.roofSeam);
    for (const [xv, s] of [[xvE, 1], [xvW, -1]]) { beam(g, P(xv(1.2), yEW + 0.01, 1.2), P(xv(zr), yRW + 0.01, zr), 0.16, 0.02, M.roofSeam); beam(g, P(xv(zr), yRW + 0.01, zr), P(xv(12.5), yEW + 0.01, 12.5), 0.16, 0.02, M.roofSeam); }
    // standing seams (raised ribs every 0.49 m, downslope) — clipped to each slope polygon in plan
    {
      const seam = (x0, z0, x1, z1, yf) => beam(g, P(x0, yf(x0, z0) + 0.022, z0), P(x1, yf(x1, z1) + 0.022, z1), 0.022, 0.035, M.roofSeam);
      const sp = 4.4 / 9;
      for (let z = -1.9 + sp / 2; z < 12.5; z += sp) {   // main roof: seams along x, stopping at the valleys behind z=1.2
        const xe = z < 1.2 ? 7.85 - 0.02 : xvE(z) - 0.04, xw = z < 1.2 ? -0.45 + 0.02 : xvW(z) + 0.04;
        if (xe > xr + 0.05) seam(xr, z, xe, z, (x) => yMT(x)); if (xw < xr - 0.05) seam(xw, z, xr, z, (x) => yMT(x));
      }
      for (let x = -7.8 + sp / 2; x < 22.7; x += sp) {   // wings: seams along z, stop at the valley
        if (x > 0 && x < 7.4) { const zLim = (xx, s) => { // valley: xvE(z) = x → solve for z on each slope
            const yT = eM + dM + (xx < xr ? (xx + 0.45) : (7.85 - xx)) * tM; const dz = (yT - dW - eW) / tW; return s < 0 ? 1.2 + dz : 12.5 - dz; };
          // in the valley zone a wing slope only exists between the valley line (za / zb) and its ridge
          if ((x > xvE(zr) + 0.05) || (x < xvW(zr) - 0.05)) { const za = zLim(x, -1), zb = zLim(x, 1);
            if (za < zr - 0.1) seam(x, Math.max(1.22, za + 0.06), x, zr, (xx, zz) => yWT(zz));
            if (zb > zr + 0.1) seam(x, zr, x, Math.min(12.48, zb - 0.06), (xx, zz) => yWT(zz)); }
          continue; }
        seam(x, 1.22, x, zr, (xx, zz) => yWT(zz)); seam(x, zr, x, 12.48, (xx, zz) => yWT(zz));
      }
    }
    // gable walls: cladding with horizontal boards (the living's front gable is wood, not glass — r1)
    const triMain = [[0, 5.7], [7.4, 5.7], [xr, yMU(xr) - 0.01]];
    prism(g, triMain, 'z', -0.1, 0.1, M.plaster); prism(g, triMain.map(([a, y]) => [a < xr ? a - 0.1 : a > xr ? a + 0.1 : a, y]), 'z', -0.15, -0.1, M.clad);
    prism(g, triMain, 'z', 11.96, 12.16, M.plaster); prism(g, triMain.map(([a, y]) => [a < xr ? a - 0.1 : a > xr ? a + 0.1 : a, y]), 'z', 12.16, 12.21, M.clad);
    const triWing = [[1.2, 5.7], [12.5, 5.7], [12.5, eW], [zr, yWU(zr) - 0.01], [1.2, eW]];
    prism(g, triWing, 'x', 22.1, 22.35, M.clad); prism(g, triWing, 'x', -7.53, -7.28, M.clad); prism(g, triWing, 'x', -0.15, 0.1, M.clad);
    // cladding strips between wall heads and the sloping wing soffits
    B(g, 7.4, 22.2, 5.7, yWU(3.56), 3.46, 3.66, M.clad); B(g, 7.4, 19.5, 5.7, yWU(12.06), 11.96, 12.16, M.clad);
    B(g, -6.66, -1.08, 5.7, yWU(12.0), 11.9, 12.1, M.clad);
    // flat ceilings of the bedroom wing, back porch soffit
    B(g, 7.4, 22.2, 5.7, 5.75, 3.56, 7.86, M.ceiling, false); B(g, 7.4, 19.5, 5.7, 5.75, 7.86, 12.06, M.ceiling, false);
    B(g, 19.5, 22.2, 5.7, 5.75, 7.8, 12.5, M.lining, false);
    // chimney stacks: black-clad, capped
    const stack = (x0, x1, z0, z1, y0, y1) => { B(g, x0, x1, y0, y1, z0, z1, M.cladBlack); B(g, x0 - 0.05, x1 + 0.05, y1 + 0.1, y1 + 0.16, z0 - 0.05, z1 + 0.05, M.steel);
      for (const [x, z] of [[x0 + 0.04, z0 + 0.04], [x1 - 0.04, z0 + 0.04], [x0 + 0.04, z1 - 0.04], [x1 - 0.04, z1 - 0.04]]) B(g, x - 0.02, x + 0.02, y1, y1 + 0.1, z - 0.02, z + 0.02, M.steel);
      cyl(g, (x0 + x1) / 2, y1, y1 + 0.09, (z0 + z1) / 2, 0.08, M.soot, 12); };
    stack(6.8, 7.3, 3.6, 4.3, 6.1, 9.5); stack(-7.3, -6.6, 4.9, 5.6, yWU(4.9), 8.8);
    B(g, -7.29, -6.61, 5.9, yWU(5.6) + 0.05, 4.91, 5.59, M.stone);

    // vaulted-ceiling downlights (living/kitchen: on the lining, oriented to the slope) + quincho
    const nMain = s => new V3(-s * tM, -1, 0).normalize();   // s=-1 west slope faces +x-down
    for (const z of [1.2, 3.2, 6.8, 8.8, 10.6]) for (const x of [0.75, 6.65]) disc(g, P(x, yMU(x), z), nMain(x < xr ? -1 : 1));
    for (const x of [-6.4, -4.4, -2.4, -0.6]) for (const z of [4.6, 9.2]) disc(g, P(x, yWU(z), z), new V3(0, -1, (z < zr ? 1 : -1) * tW).normalize());
    // bedroom-wing flat ceilings
    const yc = 5.7 - 0.002;
    downGrid(g, 7.4, 12.9, 3.56, 7.2, yc, 2, 2); downGrid(g, 14.82, 22.2, 3.56, 7.8, yc, 3, 2);
    downGrid(g, 12.9, 14.82, 3.56, 6.18, yc, 1, 2); downGrid(g, 15.48, 19.5, 9.2, 12.06, yc, 2, 2); downGrid(g, 7.4, 8.4, 7.9, 11.3, yc, 1, 3);
    downGrid(g, 12.9, 15.48, 9.2, 12.06, yc, 2, 1);
    // soffit downlights under the eaves (warm, r2) + a few wall washes where they graze cladding
    for (const x of [8.4, 10.8, 13.2, 15.6, 18.0, 20.4, 22.1]) disc(g, P(x, yWU(1.5), 1.5), new V3(0, -1, tW).normalize());
    for (const x of [-7.3, -5.3, -3.3, -1.3]) disc(g, P(x, yWU(1.5), 1.5), new V3(0, -1, tW).normalize());
    for (const x of [9.4, 12.95, 15.35, 17.0, 19.3]) disc(g, P(x, yWU(12.3), 12.3), new V3(0, -1, -tW).normalize());
    for (const x of [-6.2, -4.2, -2.2]) disc(g, P(x, yWU(12.3), 12.3), new V3(0, -1, -tW).normalize());
    for (const z of [2.6, 5.0, 8.7, 11.0]) { disc(g, P(22.45, yWU(z), z), new V3(0, -1, (z < zr ? 1 : -1) * tW).normalize()); disc(g, P(-7.6, yWU(z), z), new V3(0, -1, (z < zr ? 1 : -1) * tW).normalize()); }
    for (const x of [0.6, 6.8]) for (const z of [-1.4, -0.45]) disc(g, P(x, yMU(x), z), nMain(x < xr ? -1 : 1));
    for (const x of [1.2, 6.2]) disc(g, P(x, yMU(x), 12.3), nMain(x < xr ? -1 : 1));
    for (const z of [8.9, 11.4]) disc(g, P(20.85, 5.7 - 0.002, z), DOWN);
    for (const x of [12.95, 15.35, 17.0]) wash(g, x, 5.66, 12.212, 's', 0.9, 1.1);
    for (const x of [-6.2, -4.2, -2.2]) wash(g, x, 5.66, 12.152, 's', 0.9, 1.9);
  }

  // ---------------- models, merge, done ----------------
  await flushModels(modelReqs, M);
  for (const g of [ZC, FF, RF]) mergeGroup(g);

  let glow = 1;
  function setGlow(k) {   // 0 = lights off (midday), 1 = full evening glow
    glow = k;
    for (const m of glowMats) { const b0 = glowBase.get(m); if (m.isMeshBasicMaterial) m.color.copy(b0).multiplyScalar(k); else m.emissiveIntensity = b0 * k; }
  }
  const fireBase = M.fire.color.clone();
  function update(dt, t) {
    const f = 0.82 + 0.12 * Math.sin(t * 7.3) + 0.08 * Math.sin(t * 13.1 + 1.3) + 0.05 * Math.sin(t * 23.7);
    M.fire.color.copy(fireBase).multiplyScalar(f); M.embers.emissiveIntensity = 2.6 + 0.8 * f;
  }
  // additive decals (wall washes, flames): hide them for the clay "maqueta" stage or an override material
  const decals = []; for (const g of [ZC, FF, RF]) g.traverse(o => { if (o.isMesh && (o.material === M.wash || o.material === M.fire)) decals.push(o); });
  return { update, setGlow, decals, materials: M };
}

// ======================================================================================
// Poly Haven models → InstancedMesh per (model part, group). White pots for the plants, glowing pendant globes.
// ======================================================================================
async function flushModels(reqs, M) {
  const ids = [...new Set(reqs.map(r => r.id))];
  await Promise.all(ids.map(async id => {
    let root;
    try { root = await loadModel(id); } catch (e) { console.warn('house: model ' + id + ' failed', e); return; }
    root.updateMatrixWorld(true);
    const parts = []; root.traverse(o => { if (o.isMesh) parts.push(o); });
    const byGroup = new Map();
    for (const r of reqs) if (r.id === id) { if (!byGroup.has(r.g)) byGroup.set(r.g, []); byGroup.get(r.g).push(r); }
    for (const [g, list] of byGroup) for (const p of parts) {
      if (/_dirt$|pebbles/.test(p.name)) continue;
      let mat = p.material;
      if (/_pot$/.test(p.name)) mat = M.potWhite;
      else if (mat && /modern_ceiling_(globe|lamp_01_glass)/.test(mat.name)) mat = M.globe;
      const im = new THREE.InstancedMesh(p.geometry, mat, list.length);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
      list.forEach((r, i) => { q.setFromAxisAngle(UP, r.ry); m4.compose(new V3(r.x, r.y, r.z), q, new V3(r.s, r.s, r.s)); m4.multiply(p.matrixWorld); im.setMatrixAt(i, m4); });
      im.instanceMatrix.needsUpdate = true; im.castShadow = list[0].cast; im.receiveShadow = true; im.computeBoundingSphere();
      im.name = 'model:' + id; g.add(im);
    }
  }));
}
