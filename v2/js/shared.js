// shared.js — everything the house, nature and main modules share.
// Builders: you may ADD helpers at the bottom of this file; do not change existing exports.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export { THREE, TSL, mergeGeometries };

// ---------- constants (meters; see SPEC.md) ----------
export const LV_Z = 0.05;   // lower floor ("zócalo") floor top
export const LV_F = 3.0;    // first floor floor top
export const H = 2.7;       // wall height
export const WATER_Y = -9.0;

// ---------- deterministic random ----------
export function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;}}
export const rnd = mulberry32(20260626);
export const srgb = (r,g,b) => new THREE.Color().setRGB(r/255,g/255,b/255,THREE.SRGBColorSpace);

// ---------- terrain (identical to v1) ----------
export function noise(x,z){ return Math.sin(x*0.13+1.3)*Math.cos(z*0.11)*1.1 + Math.sin(x*0.37+z*0.21)*0.35 + Math.cos(x*0.05-z*0.07)*1.5; }
export function onPlateau(x,z){
  if(z>=12.25){ if(x>=-2.0-1e-6 && x<=4.0+1e-6 && z<=13.5+1e-6) return false; return true; } // patio inglés hole
  if(x<=-11.25 && z>=0.25) return true;
  if(x<=-9.75 && z>=6.75) return true;
  return false;
}
export function terrainH(x,z){
  let y;
  if(z>=18.5) y=3+(z-18.5)*0.38;
  else if(onPlateau(x,z)) y=3;
  else if(z>-4) y=0;
  else y=(z+4)*0.3;
  let w=0; if(z<-7) w=Math.min(1,(-7-z)/12); if(z>19) w=Math.min(1,(z-19)/10);
  const dx = x<-26 ? -26-x : x>34 ? x-34 : 0; w=Math.max(w,Math.min(1,dx/15));
  y += noise(x,z)*w;
  if(z<-34) y=Math.min(y,-9.5-(-34-z)*0.2);
  return y;
}

// ---------- groups ----------
export const groups = { site:new THREE.Group(), zc:new THREE.Group(), ff:new THREE.Group(), roof:new THREE.Group() };
Object.entries(groups).forEach(([k,g])=>g.name=k);

// ---------- walk physics registries (same semantics as v1) ----------
const cols=[], floors=[], ramps=[];
export const physics = {
  cols, floors, ramps,
  col(x1,z1,x2,z2,y0,y1,t){ cols.push({x1,z1,x2,z2,y0,y1,t}); },
  floorRect(x0,x1,z0,z1,y){ floors.push({x0,x1,z0,z1,y}); },
  ramp(x0,x1,z0,z1,axis,a0,a1,y0,y1){ ramps.push({x0,x1,z0,z1,axis,a0,a1,y0,y1}); },
  solid(x0,x1,z0,z1,y0,y1){ const c=physics.col; c(x0,z0,x1,z0,y0,y1,0.02); c(x0,z1,x1,z1,y0,y1,0.02); c(x0,z0,x0,z1,y0,y1,0.02); c(x1,z0,x1,z1,y0,y1,0.02); },
  getFloor(x,z,feet){
    let best=terrainH(x,z), terr=true;
    for(const f of floors) if(x>=f.x0&&x<=f.x1&&z>=f.z0&&z<=f.z1&&f.y<=feet+0.55&&f.y>best){best=f.y;terr=false;}
    for(const r of ramps) if(x>=r.x0&&x<=r.x1&&z>=r.z0&&z<=r.z1){ const a=r.axis==='x'?x:z; const t=Math.max(0,Math.min(1,(a-r.a0)/(r.a1-r.a0))); const y=r.y0+(r.y1-r.y0)*t;
      if(y<=feet+0.55&&y>best){best=y;terr=false;} }
    return {y:best, water:terr&&best<WATER_Y+0.1};
  },
  collide(px,pz,feet){
    const r=0.24, yb=feet+0.3, yt=feet+1.7;
    for(let it=0;it<3;it++) for(const c of cols){
      if(c.y1<yb||c.y0>yt) continue;
      const dx=c.x2-c.x1, dz=c.z2-c.z1, L2=dx*dx+dz*dz; let t=L2>0?((px-c.x1)*dx+(pz-c.z1)*dz)/L2:0; t=Math.max(0,Math.min(1,t));
      const qx=c.x1+dx*t, qz=c.z1+dz*t; let ex=px-qx, ez=pz-qz; const d=Math.hypot(ex,ez), mn=r+c.t;
      if(d<mn){ if(d<1e-6){ ex=-dz; ez=dx; const l=Math.hypot(ex,ez)||1; ex/=l; ez/=l; } else { ex/=d; ez/=d; } px=qx+ex*mn; pz=qz+ez*mn; }
    }
    return [px,pz];
  },
};

// ---------- interior / exterior lights registry (main.js dims them by time of day) ----------
export const lights = [];   // push lights with light.userData.baseIntensity set

// ---------- labels ----------
export const labels = [];
export function label(group,text,x,y,z){
  const c=document.createElement('canvas'), g=c.getContext('2d'), font='600 40px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
  g.font=font; const w=Math.ceil(g.measureText(text).width)+40, h=64; c.width=w; c.height=h;
  g.font=font; g.fillStyle='rgba(28,28,30,0.78)'; g.beginPath(); g.roundRect(0,0,w,h,32); g.fill();
  g.fillStyle='#fff'; g.textBaseline='middle'; g.fillText(text,20,h/2+2);
  const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace;
  const s=new THREE.Sprite(new THREE.SpriteMaterial({map:t,sizeAttenuation:false,transparent:true,depthTest:true}));
  const sc=0.036; s.scale.set(sc*w/h,sc,1); s.position.set(x,y,z); s.renderOrder=10; s.userData.isLabel=true;
  labels.push(s); group.add(s); return s;
}

// ---------- geometry helpers ----------
// World-space planar UVs: 1 texture tile = s meters. rotate90 swaps u/v on vertical faces (e.g. horizontal boards).
export function planarUV(geo,s,rotate90=false){
  const p=geo.attributes.position,n=geo.attributes.normal,uv=geo.attributes.uv;
  for(let i=0;i<p.count;i++){ const ax=Math.abs(n.getX(i)),ay=Math.abs(n.getY(i)),az=Math.abs(n.getZ(i)); let u,v;
    if(ax>=ay&&ax>=az){u=p.getZ(i);v=p.getY(i);} else if(ay>=az){u=p.getX(i);v=p.getZ(i);} else {u=p.getX(i);v=p.getY(i);}
    if(rotate90 && ay<ax+az){ const t=u; u=v; v=t; }
    uv.setXY(i,u/s,v/s); }
  uv.needsUpdate=true;
}
// Axis-aligned box from min/max coords. Material's userData.s (meters per tile) drives the UVs; userData.rot90 rotates them.
export function box(group,x0,x1,y0,y1,z0,z1,mat,o={}){
  const w=x1-x0,h=y1-y0,d=z1-z0; if(w<=0.001||h<=0.001||d<=0.001) return null;
  const g=new THREE.BoxGeometry(w,h,d); g.translate((x0+x1)/2,(y0+y1)/2,(z0+z1)/2);
  const m0=Array.isArray(mat)?mat[2]:mat; if(m0.userData.s) planarUV(g,m0.userData.s,!!m0.userData.rot90);
  const m=new THREE.Mesh(g,mat); m.castShadow=o.cast!==false; m.receiveShadow=true; group.add(m); return m;
}
// Merge static meshes that share a material (keeps draw calls low). Skips arrays, instanced, labels, userData.noMerge.
export function mergeGroup(grp){
  const buckets=new Map(), rm=[];
  for(const o of grp.children){
    if(!o.isMesh||o.isInstancedMesh||Array.isArray(o.material)||o.userData.noMerge||!o.geometry.index||o.children.length) continue;
    if(!o.matrix.equals(new THREE.Matrix4())) { o.updateMatrix(); if(!o.matrix.equals(new THREE.Matrix4())) continue; }
    const k=o.material.uuid+'|'+o.castShadow+'|'+Object.keys(o.geometry.attributes).sort().join(); if(!buckets.has(k)) buckets.set(k,{mat:o.material,cast:o.castShadow,geos:[]});
    buckets.get(k).geos.push(o.geometry); rm.push(o);
  }
  rm.forEach(o=>grp.remove(o));
  for(const bk of buckets.values()){
    const m=new THREE.Mesh(mergeGeometries(bk.geos,false),bk.mat);   // bucket key includes the attribute set, so nothing is dropped
    m.castShadow=bk.cast; m.receiveShadow=true; grp.add(m);
  }
}

// ---------- Poly Haven assets (CC0), list verified 2026-09-27 in assets/polyhaven_assets.json ----------
let ASSETS=null;
export async function loadAssetList(){ if(!ASSETS) ASSETS=await (await fetch(new URL('../assets/polyhaven_assets.json',import.meta.url))).json(); return ASSETS; }
export const loadingManager = new THREE.LoadingManager();
// glTF textures live under Models/jpg/1k/<id>/ on the CDN, not Models/gltf/1k/<id>/textures/
loadingManager.setURLModifier(u => u.replace(/\/Models\/gltf\/1k\/([^/]+)\/textures\//, '/Models/jpg/1k/$1/'));
const texLoader = new THREE.TextureLoader(loadingManager);
let maxAniso = 8;
export function setMaxAnisotropy(n){ maxAniso=n; }
const texCache = new Map();
// glTF textures are flipY=false; the alpha-fix JPGs must match or the leaves vanish (found by the nature builder).
function alphaTex(url){ const key=url+'|alpha'; if(texCache.has(key)) return texCache.get(key);
  const t=texLoader.load(url); t.flipY=false; t.wrapS=t.wrapT=THREE.RepeatWrapping; texCache.set(key,t); return t; }
function tex(url,srgbColor){
  const key=url+'|'+srgbColor; if(texCache.has(key)) return texCache.get(key);
  const t=texLoader.load(url); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.anisotropy=maxAniso; if(srgbColor) t.colorSpace=THREE.SRGBColorSpace;
  texCache.set(key,t); return t;
}
// A PBR texture set for a slot of assets.textures (e.g. 'cladding', 'oak_floor', 'deck', 'metal_roof', 'metal_roof_alt',
// 'stone_wall', 'concrete_floor', 'plaster_white', 'grass_lawn', 'forest_floor', 'dry_grass', 'gravel', 'rock').
// Returns {map, normalMap, roughnessMap, aoMap, metalnessMap, size_m}. Uses the packed 'arm' map when present.
export async function loadTexSet(slot){
  const A=await loadAssetList(); const e=A.textures[slot]; if(!e) throw new Error('no texture slot '+slot);
  const m=e.maps, out={ size_m:e.size_m };
  if(m.diff) out.map=tex(m.diff,true);
  if(m.nor_gl) out.normalMap=tex(m.nor_gl,false);
  if(m.arm){ const a=tex(m.arm,false); out.aoMap=a; out.roughnessMap=a; out.metalnessMap=a; }
  else if(m.rough) out.roughnessMap=tex(m.rough,false);
  return out;
}
// Convenience: a MeshStandardMaterial from a slot, tiled every size_m meters in world space (via box()/planarUV()).
// opts: {color, useMap:true, roughness, metalness, normalScale, rot90, tileMeters, side}
export async function pbr(slot,opts={}){
  const s=await loadTexSet(slot);
  const mat=new THREE.MeshStandardMaterial({
    color: opts.color ?? 0xffffff, roughness: opts.roughness ?? 1, metalness: opts.metalness ?? 0,
    map: opts.useMap===false ? null : s.map, normalMap: s.normalMap, roughnessMap: s.roughnessMap,
    aoMap: s.aoMap||null, metalnessMap: opts.metalness ? s.metalnessMap : null, side: opts.side ?? THREE.FrontSide,
  });
  if(opts.normalScale) mat.normalScale.set(opts.normalScale,opts.normalScale);
  mat.userData.s = opts.tileMeters ?? s.size_m[0];
  mat.userData.rot90 = !!opts.rot90;
  return mat;
}
// A Poly Haven glTF model (by id, e.g. 'dining_chair_02'). Cached; every call returns a fresh clone.
// Foliage: applies the verified alpha maps (alphaTest 0.5, DoubleSide) so leaves are not solid rectangles.
const gltfLoader = new GLTFLoader(loadingManager);
const modelCache = new Map();
export async function loadModel(id){
  const A=await loadAssetList();
  let entry=null; for(const list of Object.values(A.models)) for(const e of list) if(e.id===id) entry=e;
  if(!entry) throw new Error('no model '+id);
  if(!modelCache.has(id)) modelCache.set(id,(async()=>{
    const g=await gltfLoader.loadAsync(entry.gltf);
    const fixes=new Map((entry.alpha_fix||[]).map(f=>[f.material,f]));
    g.scene.traverse(o=>{ if(!o.isMesh) return; o.castShadow=o.receiveShadow=true;
      const mats=Array.isArray(o.material)?o.material:[o.material];
      for(const m of mats){ const f=fixes.get(m.name); if(f){ m.alphaMap=alphaTex(f.alphaMap); m.alphaTest=0.5; m.transparent=false; m.side=THREE.DoubleSide; m.needsUpdate=true; } } });
    return g.scene;
  })());
  const scene=await modelCache.get(id);
  return scene.clone(true);
}
export async function modelEntry(id){ const A=await loadAssetList(); for(const list of Object.values(A.models)) for(const e of list) if(e.id===id) return e; return null; }

// ---------- added by nature.js (builder B) ----------
// Only some maps of a texture slot, e.g. loadTexMaps('dry_grass', ['diff']) — same cache as loadTexSet, fewer bytes.
// keys: 'diff' → map, 'nor_gl' → normalMap, 'arm' → aoMap/roughnessMap/metalnessMap, 'rough' → roughnessMap.
export async function loadTexMaps(slot, keys){
  const A=await loadAssetList(); const e=A.textures[slot]; if(!e) throw new Error('no texture slot '+slot);
  const out={ size_m:e.size_m };
  for(const k of keys){ const u=e.maps[k]; if(!u) continue; const t=tex(u,k==='diff');
    if(k==='diff') out.map=t; else if(k==='nor_gl') out.normalMap=t; else if(k==='arm'){ out.aoMap=t; out.roughnessMap=t; out.metalnessMap=t; } else if(k==='rough') out.roughnessMap=t; }
  return out;
}
