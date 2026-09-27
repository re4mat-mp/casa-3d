// main.js — v2 engine: renderer, sky + sun by the hour, post-processing, the four stages,
// aerial / walking cameras, UI. The house (house.js) and the site (nature.js) are built by other modules
// and loaded with dynamic import(): if one of them fails, a simple stand-in is used and a red notice shows.
//
// URL params (for testing): ?webgl (force the WebGL2 backend) · ?q=media · ?stage=plano|lineas|maqueta|terminada
// ?hour=17.5 · ?view=aerial|side|top|plan|general · ?walk=<group>.<item> (a PLACES entry) · ?house=standin · ?nature=standin
// ?tm=agx|neutral|aces · ?exp=1.0 · ?stats · ?selftest · ?capture=engine_name.png (POSTs the canvas to /__save)
import * as S from './shared.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

const { THREE, TSL, groups, physics, labels, label, rnd, LV_Z, LV_F, H, WATER_Y, terrainH, onPlateau, loadingManager, srgb } = S;
const { pass, mrt, normalView, velocity, sample, screenUV, packNormalToRGB, unpackRGBToNormal, builtinAOContext } = TSL;
const V3 = THREE.Vector3, D2R = Math.PI / 180;
const $ = id => document.getElementById(id);
const Q = new URLSearchParams(location.search);
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- status (read by the test captures)
const status = window.__status = { errors: [], warns: [], steps: [] };
addEventListener('error', e => status.errors.push(String(e.message)));
addEventListener('unhandledrejection', e => status.errors.push('rej: ' + (e.reason && (e.reason.stack || e.reason))));
{ const oe = console.error, ow = console.warn;
  console.error = (...a) => { status.errors.push(a.map(String).join(' ')); oe.apply(console, a); };
  console.warn = (...a) => { status.warns.push(a.map(String).join(' ')); ow.apply(console, a); }; }
const step = s => { status.steps.push(`${(performance.now() / 1000).toFixed(2)}s ${s}`); };

// ---------------------------------------------------------------- loading screen
const prog = { hdr: 0, items: 0, build: 0, compile: 0, shown: 0, phase: 'Preparando…', loaded: 0, total: 0 };
function showProgress() {
  const p = 0.03 + 0.17 * prog.hdr + 0.6 * prog.items + 0.1 * prog.build + 0.1 * prog.compile;
  prog.shown = Math.max(prog.shown, Math.min(0.99, p));
  const pc = Math.round(prog.shown * 100);
  $('loadTxt').textContent = `${prog.phase} ${pc}%`;
  $('bar').firstElementChild.style.width = pc + '%';
}
const phase = s => { prog.phase = s; showProgress(); step(s); };
loadingManager.onProgress = (url, loaded, total) => {
  prog.loaded = loaded; prog.total = total; prog.items = total ? loaded / total : 0;
  if (loaded < total) prog.phase = /\.(gltf|glb|bin)(\?|$)/i.test(url) ? 'Cargando muebles y plantas…' : 'Cargando texturas…';
  showProgress();
};
loadingManager.onError = url => status.warns.push('no se pudo cargar ' + url);
const managerIdle = () => prog.loaded >= prog.total;

function notice(msg) { const n = $('notice'); n.innerHTML += (n.innerHTML ? '<br>' : '') + msg; n.classList.add('on'); }

// ---------------------------------------------------------------- quality
const touch = matchMedia('(pointer:coarse)').matches;
const savedQ = (() => { try { return localStorage.getItem('casa3d.q'); } catch (e) { return null; } })();
let quality = Q.get('q') || savedQ || (touch ? 'media' : 'alta');
if (quality !== 'alta' && quality !== 'media') quality = 'alta';
const pixelRatio = () => quality === 'alta' ? Math.min(devicePixelRatio, 1.5) : 1;

// ---------------------------------------------------------------- renderer
phase('Preparando el motor…');
// Some browsers expose navigator.gpu but requestAdapter() never settles (seen in an embedded Chromium):
// probe it with a timeout and fall back to WebGL2 instead of hanging on the loading screen forever.
async function webgpuResponds(ms) {
  if (!navigator.gpu) return false;
  const timeout = new Promise(r => setTimeout(() => r('timeout'), ms));
  try {
    const a = await Promise.race([navigator.gpu.requestAdapter(), timeout]);
    if (!a || a === 'timeout') return false;
    const d = await Promise.race([a.requestDevice(), timeout]);
    if (!d || d === 'timeout') return false;
    d.destroy();
    return true;
  } catch (e) { return false; }
}
const forceGL = Q.has('webgl') || !(await webgpuResponds(4000));
if (forceGL && !Q.has('webgl')) step('WebGPU did not respond in 4 s: using WebGL2');
const renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL: forceGL });
renderer.setPixelRatio(pixelRatio());
renderer.setSize(innerWidth, innerHeight);
const TONE = { agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping, aces: THREE.ACESFilmicToneMapping };
const toneMapping = TONE[Q.get('tm')] ?? THREE.NeutralToneMapping;
renderer.toneMapping = toneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.info.autoReset = false;
document.body.prepend(renderer.domElement);
await renderer.init();
status.backend = renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
// without WebGPU (older Safari, Firefox) the WebGL2 fallback compiles shaders slowly: start in Media unless chosen
if (status.backend === 'WebGL2' && !Q.get('q') && !savedQ) { quality = 'media'; renderer.setPixelRatio(1); }
S.setMaxAnisotropy(Math.min(8, renderer.getMaxAnisotropy()));
step('renderer ' + status.backend);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.08, 3000);
camera.rotation.order = 'YXZ';
const FOV_ORBIT = 45, FOV_WALK = 70;
Object.values(groups).forEach(g => scene.add(g));

// ---------------------------------------------------------------- sun + sky (HDRI, rotated so its sun matches ours)
const CENTER = new V3(6.3, 0, 5.4);                       // middle of the house footprint
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 330 });
sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.035; sun.shadow.radius = 3;
// the scene is static except for wind: the shadow map is re-rendered only when something changes (hour, toggles,
// stage, quality) — about a third of the frame cost on a laptop. ?shadowauto re-renders it every frame (swaying tree shadows).
sun.shadow.autoUpdate = Q.has('shadowauto');
sun.target.position.copy(CENTER);
scene.add(sun, sun.target);
const sunDir = new V3(-0.78, 0.39, -0.49).normalize();     // toward the sun; nature.js copies it into the lake

// Time of day. Chile: the sun is to the north (-z) at noon, rises at +x, sets at -x.
function sunAt(h) {
  const f = (h - 6) / 14, s = Math.max(0, Math.sin(Math.PI * f));
  const el = Math.max(1.5, 58 * Math.pow(s, 1.5));          // degrees; 17:30 ≈ 23° (golden), 13:00 = 58°
  const az = Math.PI * f, e = el * D2R;
  return { el, az, dir: new V3(Math.cos(az) * Math.cos(e), Math.sin(e), -Math.sin(az) * Math.cos(e)) };
}

// HDRIs from assets/polyhaven_assets.json. Each is normalised (average sky = 1) and its sun is clamped out of the
// data, because the DirectionalLight already is the sun (otherwise the sky light counts it twice).
const hdrLoader = new HDRLoader();
const skies = new Map();          // id -> Promise<{tex, sunAz, sunEl, avg, horizon: Color}>
let SKY_LIST = null, currentSky = null, wantedSky = null;
function analyzeAndClamp(tex) {   // ~30 ms: statistics on a 1/16 sample, the clamp only in a window around the sun
  const { data, width: W, height: Hh } = tex.image, half = data instanceof Uint16Array;
  const rd = half ? v => THREE.DataUtils.fromHalfFloat(v) : v => v, wr = half ? v => THREE.DataUtils.toHalfFloat(v) : v => v;
  const lum = i => rd(data[i]) * 0.2126 + rd(data[i + 1]) * 0.7152 + rd(data[i + 2]) * 0.0722;
  let max = 0, mx = 0, my = 0, sum = 0, n = 0;
  const hr = [0, 0, 0]; let hn = 0;
  for (let y = 0; y < Hh / 2; y += 4) {
    const cosLat = Math.cos((0.5 - (y + 0.5) / Hh) * Math.PI);
    for (let x = 0; x < W; x += 4) {
      const i = (y * W + x) * 4, l = lum(i);
      if (l > max) { max = l; mx = x; my = y; }
      sum += Math.min(l, 20) * cosLat; n += cosLat;
      if (y > Hh * 0.42) { hr[0] += rd(data[i]); hr[1] += rd(data[i + 1]); hr[2] += rd(data[i + 2]); hn++; }
    }
  }
  const avg = sum / n, cap = avg * 12, R = Math.round(W / 24);
  let clamped = 0, sx = 0, sy = 0, sw = 0;
  for (let y = Math.max(0, my - R); y < Math.min(Hh, my + R); y++) for (let dx = -R; dx < R; dx++) {
    const x = (mx + dx + W) % W, i = (y * W + x) * 4, l = lum(i);
    if (l > cap) { const k = cap / l; data[i] = wr(rd(data[i]) * k); data[i + 1] = wr(rd(data[i + 1]) * k); data[i + 2] = wr(rd(data[i + 2]) * k); clamped++; sx += dx * l; sy += y * l; sw += l; }
  }
  const cx = sw ? mx + sx / sw : mx, cy = sw ? sy / sw : my;          // centroid of the sun disc
  const u = (cx + 0.5) / W, v = 1 - (cy + 0.5) / Hh;
  const sunAz = (u - 0.5) * 2 * Math.PI, sunEl = (v - 0.5) * 180;     // same convention as TSL equirectUV
  tex.needsUpdate = true;
  const horizon = new THREE.Color(hr[0] / hn / avg, hr[1] / hn / avg, hr[2] / hn / avg);
  return { sunAz, sunEl, avg, horizon, max, clamped };
}
function loadSky(id, onProg) {
  if (skies.has(id)) return skies.get(id);
  const e = SKY_LIST.find(h => h.id === id);
  const p = hdrLoader.loadAsync(e.url, ev => { if (onProg && ev.lengthComputable) onProg(ev.loaded / ev.total); }).then(tex => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    const t0 = performance.now(), a = analyzeAndClamp(tex); a.ms = Math.round(performance.now() - t0); step(`sky ${id}: sun az ${(a.sunAz / D2R).toFixed(1)}° el ${a.sunEl.toFixed(1)}°, avg ${a.avg.toFixed(2)}, clamped ${a.clamped}px, ${a.ms} ms`);
    status.skies = status.skies || {}; status.skies[id] = { sunAz: +(a.sunAz / D2R).toFixed(1), sunEl: +a.sunEl.toFixed(1), avg: +a.avg.toFixed(3) };
    return { id, tex, ...a };
  });
  skies.set(id, p); return p;
}
// which HDRI for which sun height: the midday one when the sun is high, the late-afternoon one around golden hour,
// the soft sunset one at the very ends of the day
function skyFor(el) { return el > 40 ? 'kloofendal_48d_partly_cloudy_puresky' : el > 5 ? 'table_mountain_2_puresky' : 'kloppenheim_06_puresky'; }

// ---------------------------------------------------------------- hour → sun, sky, fog, exposure, interior lights
let hour = +(Q.get('hour') || $('hour').value);
$('hour').value = hour;
let glow = 1;                         // interior lights 0..1
let houseAPI = null, natureAPI = null;
const fogColor = new THREE.Color();
scene.fog = new THREE.Fog(0xcfd6d8, 300, 3200);
const EXPOSURE = +(Q.get('exp') || 1.25), SUN_K = +(Q.get('sunk') || 1.35), ENV_K = +(Q.get('envk') || 0.6);
const look = { bg: 0.75, env: 0.4, sunI: 3.2 };

// One texture object is the sky for the whole session: swapping HDRIs copies the new pixels into it and bumps its
// PMREM version. Assigning a different texture to scene.environment would recompile every material (seconds).
let skyTex = null;
function skyTexture(s) {
  if (!skyTex) {   // a private copy, so every loaded sky keeps its own pixels for switching back
    skyTex = s.tex.clone(); const im = s.tex.image;
    skyTex.image = { data: new im.data.constructor(im.data), width: im.width, height: im.height };
    skyTex.needsUpdate = true; skyTex.userData.src = s.id; return skyTex;
  }
  if (skyTex.userData.src !== s.id) {
    const a = skyTex.image, b = s.tex.image;
    if (a.width === b.width && a.height === b.height && a.data.constructor === b.data.constructor) {
      a.data.set(b.data); skyTex.needsUpdate = true; skyTex.needsPMREMUpdate = true; skyTex.userData.src = s.id;
    } else { skyTex = s.tex; skyTex.userData.src = s.id; }
  }
  return skyTex;
}
function applySky() {
  const s = currentSky; if (!s) return;
  if (stage === 'plano' || stage === 'lineas') return;
  const tex = skyTexture(s);
  scene.background = tex; scene.environment = tex;
  // rotate the sky so its sun sits at our sun's azimuth. Equirect azimuth = atan2(z, x); the renderer samples the
  // texture with R(rotation)^T · dir, so a texture azimuth φ shows up in the world at φ − θ.
  const phiW = Math.atan2(sunDir.z, sunDir.x);
  const theta = s.sunAz - phiW;
  scene.backgroundRotation.set(0, theta, 0); scene.environmentRotation.set(0, theta, 0);
  scene.backgroundIntensity = look.bg / s.avg;
  scene.environmentIntensity = look.env / s.avg;
  fogColor.copy(s.horizon).multiplyScalar(look.bg * 0.92);
  scene.fog.color.copy(fogColor);
}

function setHour(h) {
  hour = h;
  const { el, dir } = sunAt(h);
  sunDir.copy(dir);
  sun.position.copy(CENTER).addScaledVector(dir, 160); sun.target.updateMatrixWorld();
  // colour: white-yellow at noon → gold → orange near the horizon
  const warm = 1 - smooth(6, 42, el), low = 1 - smooth(1, 9, el);
  const c = new THREE.Color(1.0, lerp(0.95, 0.74, warm), lerp(0.88, 0.5, warm));
  c.lerp(new THREE.Color(1.0, 0.52, 0.26), low);
  sun.color.copy(c);
  look.sunI = SUN_K * 3.3 * (0.3 + 0.7 * smooth(0, 22, el));
  look.env = ENV_K * (0.3 + 0.18 * smooth(2, 40, el) + 0.16 * (1 - smooth(1, 10, el)));   // dusk: more sky fill
  look.bg = 0.55 + 0.35 * smooth(0, 40, el);
  sun.intensity = look.sunI;
  renderer.toneMappingExposure = EXPOSURE * (1 + 0.45 * (1 - smooth(2, 22, el)) + 0.35 * (1 - smooth(1, 8, el)));
  glow = 1 - smooth(24, 42, el);
  applyLights();
  // HDRI for this sun height (loaded lazily; swapped when ready)
  const want = skyFor(el);
  if (SKY_LIST && want !== (currentSky && currentSky.id) && want !== wantedSky) {
    wantedSky = want;
    loadSky(want).then(s => { if (wantedSky === s.id) { currentSky = s; applySky(); } }).catch(e => status.warns.push('sky ' + e));
  }
  applySky();
  sun.shadow.needsUpdate = true;
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  $('hourTxt').textContent = `${hh}:${String(mm).padStart(2, '0')}`;
}
function applyLights() {
  const k = stage === 'terminada' ? glow : 0;
  for (const l of S.lights) { const b = l.userData.baseIntensity ?? l.intensity; l.userData.baseIntensity = b; l.intensity = b * k; l.visible = k > 0.001; }
  if (houseAPI && houseAPI.setGlow) houseAPI.setGlow(k);
}

// ---------------------------------------------------------------- post-processing
// Alta: normals pre-pass → GTAO → lit pass (AO feeds the indirect light) → TRAA → a touch of bloom.
// Media: one pass with 4× MSAA, no AO, no TRAA.
let pipes = {}, pipe = null;
function makePipe(q) {
  const rp = new THREE.RenderPipeline(renderer);
  if (q === 'alta') {
    const pre = pass(scene, camera); pre.name = 'prepass'; pre.transparent = false;
    pre.setMRT(mrt({ output: packNormalToRGB(normalView), velocity }));
    const preNormal = sample(u => unpackRGBToNormal(pre.getTextureNode().sample(u)));
    const preDepth = pre.getTextureNode('depth'), preVel = pre.getTextureNode('velocity');
    pre.getTexture('output').type = THREE.UnsignedByteType;
    const aoPass = ao(preDepth, preNormal, camera);
    aoPass.resolutionScale = 0.5; aoPass.samples.value = 16; aoPass.radius.value = +(Q.get('aor') || 0.7); aoPass.scale.value = +(Q.get('aos') || 1.1); aoPass.thickness.value = 1;
    aoPass.useTemporalFiltering = true;
    const scenePass = pass(scene, camera, { samples: 0 }); scenePass.name = 'beauty';
    scenePass.contextNode = builtinAOContext(aoPass.getTextureNode().sample(screenUV).r);
    const t = traa(scenePass, preDepth, preVel, camera); t.useSubpixelCorrection = false;
    const b = bloom(t, +(Q.get('bloom') ?? 0.1), 0.35, 1.4);
    rp.outputNode = Q.get('bloom') === '0' ? t : t.add(b);
    return { rp, aoPass, bloom: b };
  }
  const scenePass = pass(scene, camera, { samples: 4 }); scenePass.name = 'beauty-msaa';
  rp.outputNode = scenePass;
  return { rp };
}
function usePipe() { pipe = pipes[quality] || (pipes[quality] = makePipe(quality)); }

function setQuality(q, persist = false) {
  quality = q; if (persist) try { localStorage.setItem('casa3d.q', q); } catch (e) { /* private mode */ }
  $('qAlta').classList.toggle('on', q === 'alta'); $('qMedia').classList.toggle('on', q === 'media');
  renderer.setPixelRatio(pixelRatio()); renderer.setSize(innerWidth, innerHeight);
  // the shadow map keeps its size in both qualities: a new shadow texture recompiles every material (a 4 s freeze)
  sun.shadow.needsUpdate = true;
  applyGrassDensity();
  usePipe();
}
// Media keeps half of the grass tufts and flowers (they are placed at random, so dropping the tail thins them evenly)
function applyGrassDensity() {
  groups.site.traverse(o => { if (!o.isInstancedMesh || !/^(grass|grass_tall|flowers)$/.test(o.name)) return;
    if (o.userData.count0 === undefined) o.userData.count0 = o.count;
    o.count = quality === 'alta' ? o.userData.count0 : Math.floor(o.userData.count0 * 0.5); });
}

// ---------------------------------------------------------------- stand-ins (used only if a builder module fails)
function standInHouse(ctx) {
  const wood = new THREE.MeshStandardMaterial({ color: srgb(62, 50, 42), roughness: 0.9 });
  const roofM = new THREE.MeshStandardMaterial({ color: srgb(34, 35, 37), roughness: 0.55, metalness: 0.4, side: THREE.DoubleSide });
  const glassM = new THREE.MeshStandardMaterial({ color: srgb(255, 214, 160), emissive: srgb(255, 190, 120), emissiveIntensity: 0.6, roughness: 0.2 });
  S.box(groups.zc, -9.6, 22.3, 0, 2.95, 0.3, 12.5, wood);
  S.box(groups.zc, 0, 7.4, 0.3, 2.6, -0.02, 0.3, glassM);
  S.box(groups.ff, -9.6, 22.3, 2.95, 5.7, -1.7, 12.5, wood);
  S.box(groups.ff, -6, 20, 3.3, 5.4, -1.72, -1.6, glassM);
  const g = new THREE.BufferGeometry(), x0 = -10.2, x1 = 22.9, z0 = -2.3, z1 = 13.1, zm = (z0 + z1) / 2, y0 = 5.7, y1 = 8.6;
  g.setAttribute('position', new THREE.Float32BufferAttribute([x0, y0, z0, x1, y0, z0, x1, y1, zm, x0, y0, z0, x1, y1, zm, x0, y1, zm, x1, y0, z1, x0, y0, z1, x0, y1, zm, x1, y0, z1, x0, y1, zm, x1, y1, zm,
    x0, y0, z0, x0, y1, zm, x0, y0, z1, x1, y0, z0, x1, y0, z1, x1, y1, zm], 3));
  g.computeVertexNormals(); g.setIndex([...Array(18).keys()]);
  const roof = new THREE.Mesh(g, roofM); roof.castShadow = roof.receiveShadow = true; groups.roof.add(roof);
  ctx.physics.solid(-9.6, 22.3, -1.7, 12.5, 0, 5.7);
  for (const [x, y, z] of [[4, 4.8, 5], [14, 4.8, 5], [4, 1.8, 6]]) { const l = new THREE.PointLight(srgb(255, 200, 150), 6, 12, 2); l.position.set(x, y, z); l.userData.baseIntensity = 6; groups.ff.add(l); ctx.lights.push(l); }
  label(groups.ff, 'Casa (versión simple)', 6.3, 6.4, 5.4);
  return {};
}
function standInNature(ctx) {
  const W = 300, D = 260, NX = 150, NZ = 130;
  const geo = new THREE.PlaneGeometry(W, D, NX, NZ); geo.rotateX(-Math.PI / 2); geo.translate(5, 0, -20);
  const p = geo.attributes.position; for (let i = 0; i < p.count; i++) p.setY(i, terrainH(p.getX(i), p.getZ(i)));
  geo.computeVertexNormals();
  const t = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: srgb(86, 108, 58), roughness: 1 }));
  t.receiveShadow = true; t.name = 'terrain'; groups.site.add(t);
  const w = new THREE.Mesh(new THREE.PlaneGeometry(2400, 1200).rotateX(-Math.PI / 2).translate(5, WATER_Y, -620), new THREE.MeshStandardMaterial({ color: srgb(34, 64, 78), roughness: 0.06 }));
  w.name = 'lake'; groups.site.add(w);
  return {};
}

// ---------------------------------------------------------------- build the house and the site
// Each builder gets its own physics/lights wrappers so a failed builder can be rolled back cleanly.
function trackedPhysics() {
  const own = { cols: [], floors: [], ramps: [] };
  const P = Object.create(physics);
  P.col = (x1, z1, x2, z2, y0, y1, t) => { physics.col(x1, z1, x2, z2, y0, y1, t); own.cols.push(physics.cols[physics.cols.length - 1]); };
  P.floorRect = (x0, x1, z0, z1, y) => { physics.floorRect(x0, x1, z0, z1, y); own.floors.push(physics.floors[physics.floors.length - 1]); };
  P.ramp = (x0, x1, z0, z1, axis, a0, a1, y0, y1) => { physics.ramp(x0, x1, z0, z1, axis, a0, a1, y0, y1); own.ramps.push(physics.ramps[physics.ramps.length - 1]); };
  P.solid = (x0, x1, z0, z1, y0, y1) => { P.col(x0, z0, x1, z0, y0, y1, 0.02); P.col(x0, z1, x1, z1, y0, y1, 0.02); P.col(x0, z0, x0, z1, y0, y1, 0.02); P.col(x1, z0, x1, z1, y0, y1, 0.02); };
  P.rollback = () => { for (const k of ['cols', 'floors', 'ramps']) { const set = new Set(own[k]); const arr = physics[k]; for (let i = arr.length - 1; i >= 0; i--) if (set.has(arr[i])) arr.splice(i, 1); } };
  return P;
}
function makeCtx() {
  return { THREE, TSL, groups, physics: trackedPhysics(), lights: [], label, rnd, LV_Z, LV_F, H, mats: {},
    loadModel: S.loadModel, loadTexSet: S.loadTexSet, terrainH, onPlateau, sunDir };
}
async function runBuilder(name, fn, groupKeys, standIn) {
  const ctx = makeCtx(), t0 = performance.now();
  let api = null, ok = false;
  if (Q.get(name) !== 'standin') {
    try {
      const mod = await import(`./${Q.get('break') === name ? 'missing_' : ''}${name}.js`);   // ?break=house tests the fallback
      if (typeof mod[fn] !== 'function') throw new Error(`${name}.js no exporta ${fn}()`);
      api = (await mod[fn](ctx)) || {}; ok = true;
    } catch (e) {
      console.error(`[${name}.js]`, e);
      notice(`<b>${name}.js</b> falló — se muestra una versión simple. <small>(${String(e && e.message || e).slice(0, 140)})</small>`);
    }
  }
  if (!ok) {
    ctx.physics.rollback();
    for (const k of groupKeys) { const g = groups[k]; for (const c of [...g.children]) g.remove(c); }
    for (let i = labels.length - 1; i >= 0; i--) { let o = labels[i]; while (o.parent) o = o.parent; if (o !== scene) labels.splice(i, 1); }
    const c2 = makeCtx(); c2.physics = physics; c2.physics.rollback = () => {};
    api = standIn(c2) || {}; ctx.lights = c2.lights;
  }
  S.lights.push(...ctx.lights);
  status[name] = { ok, ms: Math.round(performance.now() - t0), stats: api && api.stats ? api.stats.instances || api.stats : undefined };
  step(`${name}: ${ok ? 'ok' : 'stand-in'} in ${status[name].ms} ms`);
  return api;
}

// ---------------------------------------------------------------- the plan (stage 1) and the paper it lies on
const PAPER = srgb(246, 244, 239);
const planGroup = new THREE.Group(); planGroup.name = 'plan'; planGroup.visible = false; scene.add(planGroup);
const paper = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600).rotateX(-Math.PI / 2).translate(4, -0.03, 8), new THREE.MeshBasicMaterial({ color: PAPER }));
planGroup.add(paper);
const PLANS = {
  ff: { url: '../assets/plano_primer_piso.png', x0: -22.86, x1: 29.34, z0: -6.0, z1: 23.4 },
  zc: { url: '../assets/plano_zocalo.png', x0: -23.2, x1: 29.0, z0: -6.12, z1: 19.08 },
};
let planKey = 'ff';
const planTexLoader = new THREE.TextureLoader();
for (const [k, p] of Object.entries(PLANS)) {
  const m = new THREE.MeshBasicMaterial({ color: PAPER });
  p.mesh = new THREE.Mesh(new THREE.PlaneGeometry(p.x1 - p.x0, p.z1 - p.z0).rotateX(-Math.PI / 2).translate((p.x0 + p.x1) / 2, 0, (p.z0 + p.z1) / 2), m);
  p.mesh.visible = k === planKey; planGroup.add(p.mesh);
  p.load = () => p.tex || (p.tex = planTexLoader.loadAsync(new URL(p.url, import.meta.url).href).then(t => {
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.getMaxAnisotropy(); m.map = t; m.needsUpdate = true; return t; }));
}
function setPlan(k) { planKey = k; for (const [kk, p] of Object.entries(PLANS)) p.mesh.visible = kk === k; PLANS[k].load(); $('pFF').classList.toggle('on', k === 'ff'); $('pZC').classList.toggle('on', k === 'zc'); }

// ---------------------------------------------------------------- lines (stage 2), built once, lazily
const linesGroup = new THREE.Group(); linesGroup.name = 'lines'; linesGroup.visible = false; scene.add(linesGroup);
const lineParts = {};
let linesBuilt = false, rise = null;
const lineMat = new THREE.LineBasicMaterial({ color: srgb(38, 38, 40) });
async function buildLines() {
  if (linesBuilt) return; linesBuilt = true;
  const t0 = performance.now(); let segs = 0;
  for (const key of ['zc', 'ff', 'roof']) {
    const out = []; const g = groups[key]; g.updateMatrixWorld(true);
    const decals = new Set((houseAPI && houseAPI.decals) || []);
    const meshes = []; g.traverse(o => { if (o.isMesh && !o.isInstancedMesh && !o.isSprite && !decals.has(o)) meshes.push(o); });
    for (const o of meshes) {
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (m && (m.isMeshBasicMaterial || (m.emissive && m.emissiveIntensity > 0.5 && m.emissive.getHex() !== 0))) continue;   // lamp discs, glow
      const eg = new THREE.EdgesGeometry(o.geometry, 30), p = eg.attributes.position, v = new V3();
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); out.push(v.x, v.y, v.z); }
      eg.dispose();
      await sleep(0);
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(out.length).map((_, i) => i % 3 === 1 ? 1 : 0), 3));
    const ls = new THREE.LineSegments(geo, lineMat); ls.frustumCulled = false; ls.name = 'lines_' + key; lineParts[key] = ls; linesGroup.add(ls);
    segs += out.length / 6;
  }
  status.lines = { segments: segs, ms: Math.round(performance.now() - t0) }; step(`lines: ${segs} segments in ${status.lines.ms} ms`);
}

// ---------------------------------------------------------------- maquette (stage 3): white clay override
const clay = new THREE.MeshStandardMaterial({ color: srgb(238, 236, 231), roughness: 0.9, metalness: 0 });
const clayGlass = new THREE.MeshStandardMaterial({ color: srgb(214, 224, 228), roughness: 0.12, metalness: 0, transparent: true, opacity: 0.32, depthWrite: false });
const clayGround = new THREE.MeshStandardMaterial({ color: srgb(170, 170, 165), roughness: 1, metalness: 0 });
const clayWater = new THREE.Mesh(new THREE.PlaneGeometry(2400, 1200).rotateX(-Math.PI / 2).translate(5, WATER_Y + 0.01, -620), new THREE.MeshStandardMaterial({ color: srgb(196, 204, 208), roughness: 0.35 }));
clayWater.visible = false; clayWater.receiveShadow = true; clayWater.name = 'clay_water'; scene.add(clayWater);
const HIDE = 7;                                                  // a camera layer nobody renders
const VEG = /^(grass|grass_tall|flowers|trees_\d+|bushes_\d+|shrub_\d+|fern_\d+|rock_\d+)$/;   // small rocks would read as snow in clay
const isGlass = m => m && (m.transmission > 0 || (m.transparent && m.opacity < 0.9));
let clayOn = false;
function setClay(on) {
  if (on === clayOn) return; clayOn = on;
  const swap = (o, mat) => { if (o.userData.mat0 === undefined) o.userData.mat0 = o.material; o.material = mat; };
  const each = (g, f) => g.traverse(o => { if (o.isMesh && !o.isSprite) f(o); });
  const decals = new Set((houseAPI && houseAPI.decals) || []);
  if (on) {
    for (const k of ['zc', 'ff', 'roof']) each(groups[k], o => {
      if (decals.has(o)) { o.layers.set(HIDE); o.userData.hidden = true; return; }     // additive washes / flames would show as white quads
      swap(o, isGlass(Array.isArray(o.material) ? o.material[0] : o.material) ? clayGlass : clay); });
    each(groups.site, o => {
      if (VEG.test(o.name) || o.name === 'lake') { o.layers.set(HIDE); o.userData.hidden = true; return; }
      swap(o, (o.name === 'terrain' || o.name === 'far_hills') ? clayGround : isGlass(o.material) ? clayGlass : clay);
    });
  } else {
    for (const k of ['zc', 'ff', 'roof', 'site']) each(groups[k], o => {
      if (o.userData.mat0 !== undefined) { o.material = o.userData.mat0; delete o.userData.mat0; }
      if (o.userData.hidden) { o.layers.set(0); delete o.userData.hidden; }
    });
  }
  clayWater.visible = on;
}

// ---------------------------------------------------------------- cameras: aerial (orbit) and walking
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.08; controls.minDistance = 2; controls.maxDistance = 260; controls.maxPolarAngle = 1.52;
const VIEWS = {
  general: { p: [-3, 21, -31], t: [7.5, 2.8, 5.5] },                  // r1: from the lake, golden hour
  side:    { p: [-24, 4.2, -9], t: [-2, 3.6, 5.2] },                   // r2: the quincho end with the steel stair
  top:     { p: [-34, 40, 34], t: [-4, 0, -8] },                       // r3: high over the parking, looking at the lake
  lake:    { p: [-8, 14, -52], t: [2, 0, -8] },                        // from over the lake: dock, boardwalk, garden
  entry:   { p: [12.5, 5.6, 19.5], t: [6.8, 3.4, 11.6] },              // the entry porch from the plateau
  stair:   { p: [-16, 3.6, -8], t: [-8.9, 1.6, 0.4] },                 // the black steel stair off the quincho deck
  back:    { p: [-20, 15, 26], t: [6, 3.5, 6] },
  lineas:  { p: [-17, 22, -27], t: [6, 1.5, 7] },
};
function planView() {   // top-down, framing the plan
  const P = PLANS[planKey], w = (P.x1 - P.x0) * 1.06, d = (P.z1 - P.z0) * 1.06, tf = Math.tan(FOV_ORBIT * D2R / 2);
  const h = Math.max(d / 2 / tf, w / 2 / (tf * camera.aspect));
  const cx = (P.x0 + P.x1) / 2, cz = (P.z0 + P.z1) / 2;
  return { p: [cx, h, cz + 0.05], t: [cx, 0, cz] };
}
camera.fov = FOV_ORBIT; camera.updateProjectionMatrix();
camera.position.set(...VIEWS.general.p); controls.target.set(...VIEWS.general.t); controls.update();

let mode = 'orbit', anim = null;
function flyTo(pos, target, dur = 1.3) { anim = { t: 0, dur, p0: camera.position.clone(), p1: new V3(...pos), t0: controls.target.clone(), t1: new V3(...target) }; }

const player = { x: 0, z: 0, feet: 0, vy: 0, yaw: 0, pitch: 0, eye: 0, grounded: true };
let walkTarget = null, stuck = 0;
const keys = {}, dp = {};
const tRoof = $('tRoof'), tFF = $('tFF'), tLabels = $('tLabels');

function setVis() {
  const house = stage === 'maqueta' || stage === 'terminada';
  groups.site.visible = house; groups.zc.visible = house;
  groups.ff.visible = house && tFF.checked; groups.roof.visible = house && tFF.checked && tRoof.checked;
  if (lineParts.ff) { lineParts.ff.visible = tFF.checked; lineParts.roof.visible = tFF.checked && tRoof.checked; }
  const show = house && tLabels.checked && (mode === 'walk' || !groups.roof.visible);   // from the air, names appear when the roof is off
  labels.forEach(s => s.visible = show);
  $('toggles').classList.toggle('off', stage === 'plano');
  sun.shadow.needsUpdate = true;
}
async function enterWalk(x, z, feetHint, yaw) {
  if (stage !== 'terminada' && stage !== 'maqueta') await setStage('terminada', { keepCamera: true });
  mode = 'walk'; document.body.classList.add('walk'); controls.enabled = false; anim = null;
  tFF.checked = true; tRoof.checked = true;
  player.x = x; player.z = z; player.feet = physics.getFloor(x, z, feetHint + 0.3).y; player.vy = 0; player.yaw = yaw; player.pitch = -0.05; player.eye = player.feet + 1.62;
  walkTarget = null; camera.fov = FOV_WALK; camera.updateProjectionMatrix(); setMode(); setVis();
}
function exitWalk() {
  mode = 'orbit'; document.body.classList.remove('walk'); controls.enabled = true; camera.fov = FOV_ORBIT; camera.updateProjectionMatrix();
  const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  controls.target.set(player.x + fx * 4, player.feet + 1, player.z + fz * 4);
  camera.position.set(player.x - fx * 14, player.feet + 12, player.z - fz * 14); setMode(); setVis();
}
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
function updateWalk(dt) {
  let fwd = 0, str = 0, turn = 0;
  if (keys.KeyW || keys.ArrowUp || dp.up) fwd += 1; if (keys.KeyS || keys.ArrowDown || dp.down) fwd -= 1;
  if (keys.KeyA) str -= 1; if (keys.KeyD) str += 1; if (keys.ArrowLeft || dp.left) turn += 1; if (keys.ArrowRight || dp.right) turn -= 1;
  player.yaw += turn * 1.9 * dt;
  if (fwd || str) walkTarget = null;
  const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw);
  let mx = -sy * fwd + cy * str, mz = -cy * fwd - sy * str;
  if (walkTarget) { const dx = walkTarget.x - player.x, dz = walkTarget.z - player.z, d = Math.hypot(dx, dz);
    if (d < 0.2) walkTarget = null; else { mx = dx / d; mz = dz / d; player.yaw += angDiff(Math.atan2(-dx, -dz), player.yaw) * Math.min(1, dt * 2.5); } }
  const len = Math.hypot(mx, mz);
  if (len > 0) {
    const sp = (keys.ShiftLeft || keys.ShiftRight) ? 4.6 : (walkTarget ? 2.6 : 2.1);
    let nx = player.x + mx / len * sp * dt, nz = player.z + mz / len * sp * dt; [nx, nz] = physics.collide(nx, nz, player.feet);
    const f = physics.getFloor(nx, nz, player.feet);
    if (!f.water) { const moved = Math.hypot(nx - player.x, nz - player.z); player.x = nx; player.z = nz;
      if (walkTarget) { stuck = moved < sp * dt * 0.2 ? stuck + dt : 0; if (stuck > 0.6) { walkTarget = null; stuck = 0; } } }
    else walkTarget = null;
  }
  const fl = physics.getFloor(player.x, player.z, player.feet).y;
  if (fl >= player.feet) { player.feet = fl; player.vy = 0; player.grounded = true; }
  else if (player.grounded && player.feet - fl < 0.4) { player.feet = fl; }
  else { player.grounded = false; player.vy -= 9.8 * dt; player.feet += player.vy * dt; if (player.feet <= fl) { player.feet = fl; player.vy = 0; player.grounded = true; } }
  player.eye += (player.feet + 1.62 - player.eye) * Math.min(1, dt * 12);
  camera.position.set(player.x, player.eye, player.z); camera.rotation.set(player.pitch, player.yaw, 0);
}

// ---------------------------------------------------------------- stages
const STAGE_NAMES = ['plano', 'lineas', 'maqueta', 'terminada'];
let stage = 'terminada';
const paperWorld = s => s === 'plano' || s === 'lineas';
async function setStage(s, o = {}) {
  if (!STAGE_NAMES.includes(s)) return;
  const prev = stage;
  if (s === prev && !o.force) return;
  if (mode === 'walk' && paperWorld(s)) exitWalk();
  const fade = !o.instant && !(prev === 'plano' && s === 'lineas') && s !== prev;
  if (fade) { $('fade').classList.add('on'); await sleep(360); }
  stage = s;
  document.body.className = document.body.className.replace(/\bstage-\S+/g, '').trim() + ' stage-' + s + (mode === 'walk' ? ' walk' : '');
  document.querySelectorAll('#stages button').forEach(b => b.classList.toggle('on', b.dataset.stage === s));
  planGroup.visible = paperWorld(s);
  linesGroup.visible = s === 'lineas';
  if (paperWorld(s)) {
    PLANS[planKey].load();
    scene.background = PAPER; scene.environment = skyTex; scene.fog = null;
    renderer.toneMapping = THREE.NoToneMapping; renderer.toneMappingExposure = 1;
  } else {
    scene.fog = scene.fog || new THREE.Fog(fogColor, 300, 3200);
    renderer.toneMapping = toneMapping;
    setClay(s === 'maqueta');
  }
  if (s === 'lineas') {
    if (!linesBuilt) { $('help').textContent = 'Dibujando las líneas de la casa…'; await buildLines(); }
    rise = { t: 0, dur: 2.2 };
    linesGroup.scale.y = 0.001;
  }
  setVis(); setHour(hour); applyLights(); setMode();
  if (!o.keepCamera && mode === 'orbit') {
    const v = s === 'plano' ? planView() : s === 'lineas' ? VIEWS.lineas : VIEWS.general;
    if (o.instant) { camera.position.set(...v.p); controls.target.set(...v.t); controls.update(); } else flyTo(v.p, v.t, s === 'lineas' ? 2.4 : 1.4);
  }
  if (fade) { await sleep(60); $('fade').classList.remove('on'); }
}

// ---------------------------------------------------------------- input
const help = $('help');
function setMode() {
  $('mOrbit').classList.toggle('on', mode === 'orbit'); $('mWalk').classList.toggle('on', mode === 'walk');
  if (stage === 'plano') { help.textContent = touch ? 'El plano del arquitecto · un dedo gira · dos dedos acercan' : 'El plano del arquitecto · arrastra para girar · rueda para acercar · doble clic en el plano para entrar caminando'; return; }
  help.textContent = mode === 'orbit'
    ? (touch ? 'Un dedo gira · dos dedos acercan y mueven · elige un lugar en “Ir a…” para caminar'
             : 'Arrastra para girar · rueda para acercar · clic derecho para mover · doble clic en un piso para entrar caminando')
    : (touch ? 'Arrastra para mirar · flechas para caminar · toca el piso para ir ahí'
             : 'Arrastra para mirar · W/↑ avanzar · S/↓ retroceder · ←/→ girar · A/D de lado · Shift corre · clic en el piso para ir ahí · Esc sale');
}
[tRoof, tFF, tLabels].forEach(el => el.addEventListener('change', setVis));
addEventListener('keydown', e => { if (['INPUT', 'SELECT'].includes(e.target.tagName)) return; keys[e.code] = true;
  if (e.code === 'Escape' && mode === 'walk') exitWalk(); if (mode === 'walk' && e.code.startsWith('Arrow')) e.preventDefault(); });
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
document.querySelectorAll('#dpad button').forEach(bt => { const k = bt.dataset.k;
  bt.addEventListener('pointerdown', e => { e.preventDefault(); dp[k] = true; walkTarget = null; });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => bt.addEventListener(ev, () => { dp[k] = false; })); });

const ray = new THREE.Raycaster(); ray.camera = camera;
const visibleChain = o => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
let pickList = [];
function rebuildPickList() {
  pickList = [];
  for (const k of ['site', 'zc', 'ff', 'roof']) groups[k].traverse(o => {
    if (!o.isMesh || o.isInstancedMesh || o.isSprite) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (isGlass(m) || o.name === 'lake' || o.name === 'far_hills') return;
    pickList.push(o);
  });
}
function pick(cx, cy) {
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
  const list = paperWorld(stage) ? [PLANS[planKey].mesh, paper] : pickList;
  for (const h of ray.intersectObjects(list, false)) {
    if (!visibleChain(h.object)) continue;
    const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new V3(0, 1, 0);
    return { point: h.point, up: n.y > 0.6 };
  }
  return null;
}
let drag = null;
renderer.domElement.addEventListener('pointerdown', e => { if (mode !== 'walk') return; drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() }; renderer.domElement.setPointerCapture(e.pointerId); });
renderer.domElement.addEventListener('pointermove', e => { if (mode !== 'walk' || !drag) return;
  const k = touch ? 0.006 : 0.0042; player.yaw += (e.clientX - drag.x) * k; player.pitch = Math.max(-1.3, Math.min(1.3, player.pitch + (e.clientY - drag.y) * k));
  drag.x = e.clientX; drag.y = e.clientY; });
renderer.domElement.addEventListener('pointerup', e => { if (mode !== 'walk' || !drag) return;
  const moved = Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy), quick = performance.now() - drag.t < 450; drag = null;
  if (moved < 6 && quick) { const h = pick(e.clientX, e.clientY); if (h && h.up && Math.hypot(h.point.x - player.x, h.point.z - player.z) < 40) { walkTarget = { x: h.point.x, z: h.point.z }; stuck = 0; } } });
renderer.domElement.addEventListener('dblclick', e => { if (mode !== 'orbit') return; const h = pick(e.clientX, e.clientY); if (!h || !h.up) return;
  const d = new V3(); camera.getWorldDirection(d);
  const feet = paperWorld(stage) ? (planKey === 'ff' ? LV_F : LV_Z) : h.point.y;
  enterWalk(h.point.x, h.point.z, feet, Math.atan2(-d.x, -d.z)); });

// ---------------------------------------------------------------- places (same coordinates as v1; the dock moved onto the v2 dock)
const PLACES = [
  ['Primer piso', [
    ['Living · vista al lago', 6.4, LV_F, 7.2, 0.45], ['Cocina', 2.8, LV_F, 10.7, 0.2], ['Quincho', -3.3, LV_F, 10.9, 0.25], ['Terraza', 3.7, LV_F, -0.9, 0.35],
    ['Dormitorio 1 (principal)', 15.6, LV_F, 7.0, -0.8], ['Dormitorio 2', 8.1, LV_F, 6.6, -0.7], ['Entrada', 6.5, LV_F, 12.9, 0]]],
  ['Zócalo (piso de abajo)', [
    ['Sala de estar', 6.8, LV_Z, 7.4, 0.7], ['Terraza cubierta', 3.7, LV_Z, 3.0, 0], ['Dormitorio 3', 12.3, LV_Z, 7.3, 0.75],
    ['Dormitorio 4', -0.5, LV_Z, 7.3, 0.75], ['Dormitorio 5', -4.2, LV_Z, 7.3, 0.75], ['Patio inglés', 3.2, LV_Z, 13.2, 0.9]]],
  ['Exterior', [
    ['Jardín frente a la casa', 9, 0, -11, Math.PI - 0.25], ['Estacionamiento', -15, LV_F, 9.5, -1.2], ['Muelle', -5.5, -8.75, -37.6, Math.PI + 0.3]]],
];
const sel = $('goto');
sel.innerHTML = '<option value="">Elige un lugar…</option>' + PLACES.map(([g, items], gi) => `<optgroup label="${g}">${items.map((it, ii) => `<option value="${gi}.${ii}">${it[0]}</option>`).join('')}</optgroup>`).join('');
sel.addEventListener('change', () => { if (!sel.value) return; const [gi, ii] = sel.value.split('.').map(Number); const [, x, y, z, yaw] = PLACES[gi][1][ii];
  enterWalk(x, z, y, yaw); sel.value = ''; sel.blur(); });

$('mWalk').onclick = () => { if (mode !== 'walk') enterWalk(6.4, 7.2, LV_F, 0.45); };
$('mOrbit').onclick = () => { if (mode === 'walk') exitWalk(); };
$('vGeneral').onclick = () => { if (mode === 'walk') exitWalk(); tRoof.checked = true; tFF.checked = true; setVis();
  const v = stage === 'plano' ? planView() : stage === 'lineas' ? VIEWS.lineas : VIEWS.general; flyTo(v.p, v.t); };
$('vPlanta').onclick = () => { if (mode === 'walk') exitWalk();
  if (paperWorld(stage)) { const v = planView(); flyTo(v.p, v.t); return; }
  tRoof.checked = false; setVis(); flyTo([6.3, 48, 5.95], [6.3, 0, 5.9]); };
$('collapse').onclick = e => { const p = $('panel'); p.classList.toggle('min'); e.target.textContent = p.classList.contains('min') ? '+' : '–'; };
$('hour').addEventListener('input', () => setHour(+$('hour').value));
// the first switch to a quality compiles its shaders (a few seconds, once): say so before the page freezes
async function pickQuality(q) { if (q === quality) return; const h = help.textContent; help.textContent = 'Cambiando la calidad… (la primera vez tarda unos segundos)';
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); setQuality(q, true); await sleep(50); help.textContent = h; }
$('qAlta').onclick = () => pickQuality('alta'); $('qMedia').onclick = () => pickQuality('media');
$('pFF').onclick = () => setPlan('ff'); $('pZC').onclick = () => setPlan('zc');
document.querySelectorAll('#stages button').forEach(b => b.onclick = () => setStage(b.dataset.stage));
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// ---------------------------------------------------------------- boot: sky + modules in parallel
phase('Cargando el cielo…');
const A = await S.loadAssetList();
SKY_LIST = A.hdris;
const firstSky = skyFor(sunAt(hour).el);
wantedSky = firstSky;
const skyP = loadSky(firstSky, f => { prog.hdr = f; showProgress(); }).then(s => { prog.hdr = 1; currentSky = s; showProgress(); return s; });
phase('Construyendo la casa y el jardín…');
[natureAPI, houseAPI] = await Promise.all([
  runBuilder('nature', 'buildNature', ['site'], standInNature),
  runBuilder('house', 'buildHouse', ['zc', 'ff', 'roof'], standInHouse),
]);
prog.build = 1; showProgress();
try { await skyP; } catch (e) { console.error('sky', e); notice('No se pudo cargar el cielo (HDRI).'); }
rebuildPickList();
setQuality(quality);
setHour(hour);
setVis(); setMode();
const qStage = Q.get('stage');
if (qStage && STAGE_NAMES.includes(qStage)) await setStage(qStage, { instant: true });
PLANS.ff.load();

// wait for textures/models still in flight (the builders don't await every texture), max 90 s
phase('Cargando texturas…');
{ const t0 = performance.now(); while (!managerIdle() && performance.now() - t0 < 90000) await sleep(100); }
phase(status.backend === 'WebGL2' ? 'Preparando la luz (puede tardar un poco)…' : 'Preparando la luz…');
// No renderer.compileAsync(): it compiles the canvas variants of the shaders, not the ones the post-processing passes
// use, and measured slower than letting the first frame compile them (WebGPU 4 s vs 31 s, WebGL2 33 s vs 45 s).
await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));   // let the text paint before the freeze
prog.compile = 1; showProgress();
step('ready');

// ---------------------------------------------------------------- self-test (walking) — ?selftest
function simWalk(start, path, push = 0) {
  const p = { x: start[0], z: start[2], feet: physics.getFloor(start[0], start[2], start[1] + 0.3).y, vy: 0, grounded: true };
  let wi = 0, t = 0, stuckT = 0; const dt = 1 / 60, sp = 2.1;
  while (wi < path.length && t < 90) {
    const [tx, tz] = path[wi], dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
    if (d < 0.15) { wi++; stuckT = 0; continue; }
    let nx = p.x + dx / d * sp * dt, nz = p.z + dz / d * sp * dt; [nx, nz] = physics.collide(nx, nz, p.feet);
    const f = physics.getFloor(nx, nz, p.feet);
    if (!f.water) { const moved = Math.hypot(nx - p.x, nz - p.z); p.x = nx; p.z = nz; stuckT = moved < sp * dt * 0.2 ? stuckT + dt : 0; }
    const fl = physics.getFloor(p.x, p.z, p.feet).y;
    if (fl >= p.feet) { p.feet = fl; p.vy = 0; p.grounded = true; }
    else if (p.grounded && p.feet - fl < 0.4) p.feet = fl;
    else { p.grounded = false; p.vy -= 9.8 * dt; p.feet += p.vy * dt; if (p.feet <= fl) { p.feet = fl; p.vy = 0; p.grounded = true; } }
    t += dt; if (push ? t > push : stuckT > 0.6) break;
  }
  return { x: +p.x.toFixed(2), z: +p.z.toFixed(2), feet: +p.feet.toFixed(3), reached: wi >= path.length, t: +t.toFixed(1) };
}
async function selfTest() {
  const T = [
    ['La baranda de la terraza te frena', () => { const r = simWalk([3.7, LV_F, -0.9], [[3.7, -6]], 4); return [r.z > -1.95 && Math.abs(r.feet - LV_F) < 0.01, r]; }],
    ['Escalera en U: primer piso → zócalo', () => { const r = simWalk([7.9, LV_F, 10.75], [[10.0, 10.75], [10.75, 10.75], [10.75, 9.6], [8.6, 9.6], [8.0, 9.6], [8.0, 8.5]]); return [r.reached && Math.abs(r.feet - LV_Z) < 0.02, r]; }],
    ['Se entra por la puerta principal', () => { const r = simWalk([6.5, LV_F, 12.8], [[6.5, 10.0]]); return [r.reached && Math.abs(r.feet - LV_F) < 0.01, r]; }],
    ['Se llega al muelle', () => { const r = simWalk([-17.5, 0, -3.3], [[-17.5, -4.3], [-17.5, -12.0], [-12.5, -12.0], [-12.5, -20.6], [-5.5, -20.6], [-5.5, -29.3], [-5.5, -37.6]]); return [r.reached && r.feet < -8 && r.feet > -9.2, r]; }],
    ['Del estacionamiento a la puerta y al hall', () => { const r = simWalk([9.5, 3, 16.5], [[8.2, 12.9], [6.5, 12.6], [6.5, 10.0]]); return [r.reached && Math.abs(r.feet - LV_F) < 0.01, r]; }],
    ['Porche de entrada sin hoyo (x 7.4–11.2, z 11.4–12.0)', () => { let bad = 0; for (let x = 7.5; x <= 11.1; x += 0.2) for (let z = 11.45; z <= 12.0; z += 0.1) if (Math.abs(physics.getFloor(x, z, 3).y - 3) > 0.02) bad++; return [bad === 0, { puntosBajos: bad }]; }],
  ];
  const W = natureAPI && natureAPI.stats && natureAPI.stats.walkTests;
  if (W) {
    const along = pts => simWalk([pts[0][0], 50, pts[0][1]].map((v, i) => i === 1 ? physics.getFloor(pts[0][0], pts[0][1], 50).y : v), pts.slice(1));
    T.push(['Pasarela de madera hasta el muelle (nature)', () => { const r = along(W.boardwalk); return [r.reached && Math.abs(r.feet - W.dockY) < 0.05, r]; }]);
    T.push(['Camino de piedras 2 (nature)', () => { const r = along(W.path2); return [r.reached, r]; }]);
    T.push(['Escalera del estacionamiento (nature)', () => { const r = along(W.parkingStair); return [r.reached && Math.abs(r.feet - 3) < 0.05, r]; }]);
  }
  const out = [];
  for (const [name, fn] of T) { let ok = false, r = null; try { [ok, r] = fn(); } catch (e) { r = String(e); } out.push({ name, ok, r }); }
  let house = null;
  try { const m = await import('./house_selftest.js'); house = m.runSelfTest(physics); } catch (e) { house = { text: 'house_selftest.js no disponible: ' + e.message }; }
  status.selftest = { engine: out, house: house && { pass: house.pass, total: house.total, text: house.text } };
  const txt = 'Prueba de caminata (motor): ' + out.filter(o => o.ok).length + '/' + out.length + '\n' + out.map(o => `${o.ok ? 'OK ' : 'FALLA'} ${o.name} ${JSON.stringify(o.r)}`).join('\n') + '\n\n' + (house ? house.text : '');
  console.log(txt); document.body.classList.add('showstats'); $('stats').textContent = txt;
}
if (Q.has('selftest')) await selfTest();

// ---------------------------------------------------------------- initial view from the URL (tests) and start
{ const v = Q.get('view'); if (v && VIEWS[v]) { camera.position.set(...VIEWS[v].p); controls.target.set(...VIEWS[v].t); controls.update(); }
  else if (v === 'plan') { const pv = planView(); camera.position.set(...pv.p); controls.target.set(...pv.t); controls.update(); }
  else if (v === 'planta') { tRoof.checked = false; setVis(); camera.position.set(6.3, 48, 5.95); controls.target.set(6.3, 0, 5.9); controls.update(); }
  const w = Q.get('walk'); if (w) { const [gi, ii] = w.split('.').map(Number); const pl = PLACES[gi] && PLACES[gi][1][ii]; if (pl) await enterWalk(pl[1], pl[3], pl[2], Q.has('yaw') ? +Q.get('yaw') : pl[4]); }
  if (Q.get('look') === 'hdrsun' && currentSky) {   // debug: look along our sun's azimuth at the HDRI sun's elevation (the disc should sit at the centre)
    const az = Math.atan2(sunDir.z, sunDir.x), el = currentSky.sunEl * D2R, d = new V3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
    camera.position.set(6, 80, 5); controls.target.copy(camera.position).addScaledVector(d, 10); controls.maxPolarAngle = Math.PI; controls.update(); }
  if (Q.get('look') === 'sun') { const c = CENTER.clone().add(new V3(0, 4, 0)); camera.position.copy(c); controls.target.copy(c).addScaledVector(sunDir, 10); controls.maxPolarAngle = Math.PI; controls.update(); }
  if (Q.has('stats')) document.body.classList.add('showstats'); }

const timer = new THREE.Timer(); timer.connect(document);
let frames = 0, first = true, capDone = false, settle = 0;
const ft = { acc: 0, n: 0, last: performance.now(), avg: 0 };
const capName = Q.get('capture');
renderer.setAnimationLoop(() => {
  timer.update(); const dt = Math.min(0.05, timer.getDelta()), t = timer.getElapsed();
  const now = performance.now(); ft.acc += now - ft.last; ft.n++; ft.last = now;
  if (mode === 'walk') {
    updateWalk(dt);
    if (tLabels.checked) for (const l of labels) { const d = l.position.distanceTo(camera.position); l.visible = d < 9 && Math.abs(l.position.y - camera.position.y) < 2.2; }
  } else {
    if (anim) { anim.t += dt; const k = Math.min(1, anim.t / anim.dur), e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      camera.position.lerpVectors(anim.p0, anim.p1, e); controls.target.lerpVectors(anim.t0, anim.t1, e); if (k >= 1) anim = null; }
    controls.update();
  }
  if (rise) { rise.t += dt; const k = Math.min(1, rise.t / rise.dur), e = 1 - Math.pow(1 - k, 3); linesGroup.scale.y = Math.max(0.001, e); if (k >= 1) rise = null; }
  if (houseAPI && houseAPI.update) houseAPI.update(dt, t);
  if (natureAPI && natureAPI.update) natureAPI.update(dt, t);
  renderer.info.reset();
  pipe.rp.render();
  frames++;
  if (first) { first = false; $('loading').classList.add('done'); setTimeout(() => $('loading').remove(), 800); step('first frame'); }
  if (ft.acc > 1000) { ft.avg = ft.acc / ft.n; ft.acc = 0; ft.n = 0;
    const i = renderer.info.render; status.frame = { ms: +ft.avg.toFixed(1), calls: i.drawCalls, tris: i.triangles, backend: status.backend, quality };
    if (document.body.classList.contains('showstats') && !Q.has('selftest')) $('stats').textContent = `${status.backend} · ${quality} · ${ft.avg.toFixed(1)} ms/cuadro\n${i.drawCalls} draw calls · ${(i.triangles / 1e6).toFixed(2)} M triángulos`; }
  if (capName && !capDone && managerIdle() && !busy) {
    settle++;
    if (settle === +(Q.get('settle') || 120)) { capDone = true;
      const i = renderer.info.render; status.captureFrame = { calls: i.drawCalls, tris: i.triangles, ms: +ft.avg.toFixed(1) };
      renderer.domElement.toBlob(async b => {
        await fetch('/__save?name=' + encodeURIComponent(capName.replace(/\.png$/, '.json')), { method: 'POST', body: JSON.stringify(status, null, 1) });
        await fetch('/__save?name=' + encodeURIComponent(capName), { method: 'POST', body: b }); status.captured = capName; }, 'image/png'); }
  }
});
// ?cycle: click through every stage, plan, hour, quality and walk once (runtime transitions on this backend)
let busy = false;
async function cycleTest() {
  busy = true; const log = [];
  const seq = [['stage', 'plano'], ['plan', 'zc'], ['stage', 'lineas'], ['plan', 'ff'], ['stage', 'maqueta'], ['hour', 13], ['stage', 'terminada'],
    ['quality', 'media'], ['hour', 19.75], ['walk', 0], ['exit', 0], ['quality', 'alta'], ['stage', 'lineas'], ['stage', 'maqueta'], ['walk', 1], ['exit', 0], ['stage', 'terminada'], ['hour', 17.5]];
  for (const [k, v] of seq) {
    const e0 = status.errors.length;
    try {
      if (k === 'stage') await setStage(v); else if (k === 'plan') setPlan(v); else if (k === 'hour') { $('hour').value = v; setHour(v); }
      else if (k === 'quality') setQuality(v); else if (k === 'exit') exitWalk();
      else if (k === 'walk') {   // enter, then hold W for a second in the real frame loop and check that we moved on the floor
        await enterWalk(...[[6.4, 7.2, LV_F, 0.45], [-9.3, -3.4, 0, 0]][v]);
        const x0 = player.x, z0 = player.z; keys.KeyW = true; await sleep(1000); keys.KeyW = false;
        log.push(`  caminar con W: ${Math.hypot(player.x - x0, player.z - z0).toFixed(2)} m, pies a ${player.feet.toFixed(2)} m`);
      }
    } catch (e) { status.errors.push(`cycle ${k}=${v}: ${e.stack || e}`); }
    await sleep(1600);
    log.push(`${k}=${v} → ${status.errors.length - e0} errores, ${ft.avg.toFixed(1)} ms`);
  }
  if (Q.get('view') && VIEWS[Q.get('view')]) { const w = VIEWS[Q.get('view')]; camera.position.set(...w.p); controls.target.set(...w.t); controls.update(); }
  status.cycle = log; step('cycle done'); busy = false;
}
if (Q.has('cycle')) cycleTest();

window.__casa = { THREE, scene, camera, controls, renderer, groups, physics, player, sun, setStage, setHour, setQuality, enterWalk, exitWalk, status, get pipe() { return pipe; }, skies, keys };
