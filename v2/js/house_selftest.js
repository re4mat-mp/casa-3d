// house_selftest.js — replays v1's walking behaviour against the physics that house.js registered.
// Used by test_house.html?selftest. Same walker as v1's updateWalk (radius 0.24, step-up 0.55, snap-down 0.4).
export function runSelfTest(physics) {
  const { getFloor, collide } = physics;
  const LV_F = 3.0, LV_Z = 0.05;
  // walk toward each waypoint in turn; `push` = keep pushing for that many seconds even when blocked
  function walk(start, path, push = 0) {
    const p = { x: start[0], z: start[2], feet: getFloor(start[0], start[2], start[1] + 0.3).y, vy: 0, grounded: true };
    let wi = 0, t = 0, stuck = 0, minFeet = p.feet, maxFeet = p.feet;
    const dt = 1 / 60, sp = 2.1;
    while (wi < path.length && t < 60) {
      const [tx, tz] = path[wi], dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
      if (d < 0.15) { wi++; stuck = 0; continue; }
      let nx = p.x + dx / d * sp * dt, nz = p.z + dz / d * sp * dt; [nx, nz] = collide(nx, nz, p.feet);
      const f = getFloor(nx, nz, p.feet);
      if (!f.water) { const moved = Math.hypot(nx - p.x, nz - p.z); p.x = nx; p.z = nz; stuck = moved < sp * dt * 0.2 ? stuck + dt : 0; }
      const fl = getFloor(p.x, p.z, p.feet).y;
      if (fl >= p.feet) { p.feet = fl; p.vy = 0; p.grounded = true; }
      else if (p.grounded && p.feet - fl < 0.4) p.feet = fl;
      else { p.grounded = false; p.vy -= 9.8 * dt; p.feet += p.vy * dt; if (p.feet <= fl) { p.feet = fl; p.vy = 0; p.grounded = true; } }
      minFeet = Math.min(minFeet, p.feet); maxFeet = Math.max(maxFeet, p.feet);
      t += dt;
      if (push ? t > push : stuck > 0.6) break;
    }
    return { x: +p.x.toFixed(3), z: +p.z.toFixed(3), feet: +p.feet.toFixed(3), reached: wi >= path.length, t: +t.toFixed(2), minFeet: +minFeet.toFixed(3) };
  }
  const tests = [
    ['Living deck: railing stops you at the front edge (z=-1.70)', () => { const r = walk([3.7, LV_F, -0.9], [[3.7, -6]], 4); return [r.z > -1.5 && r.feet === LV_F, r, `stopped at z=${r.z}, feet ${r.feet}`]; }],
    ['Bedroom deck: baluster railing stops you (z=1.52)', () => { const r = walk([15, LV_F, 2.6], [[15, -4]], 4); return [r.z > 1.7 && r.feet === LV_F, r, `stopped at z=${r.z}, feet ${r.feet}`]; }],
    ['Quincho deck: west glass rail stops you (x=-8.70, z 1.5–2.3)', () => { const r = walk([-7.6, LV_F, 1.9], [[-13, 1.9]], 4); return [r.x > -8.5 && r.feet === LV_F, r, `stopped at x=${r.x}, feet ${r.feet}`]; }],
    ['U-stair: first floor → lower floor', () => { const r = walk([7.9, LV_F, 10.75], [[10.0, 10.75], [10.75, 10.75], [10.75, 9.6], [8.6, 9.6], [8.0, 9.6], [8.0, 8.5]]); return [r.reached && Math.abs(r.feet - LV_Z) < 0.01, r, `reached=${r.reached}, feet ${r.feet} at (${r.x}, ${r.z}) in ${r.t}s`]; }],
    ['U-stair: lower floor → first floor', () => { const r = walk([8.0, LV_Z, 8.5], [[8.0, 9.6], [8.6, 9.6], [10.75, 9.6], [10.75, 10.75], [10.0, 10.75], [7.9, 10.75]]); return [r.reached && Math.abs(r.feet - LV_F) < 0.01, r, `reached=${r.reached}, feet ${r.feet} at (${r.x}, ${r.z})`]; }],
    ['Front door (glass, z=11.34) is passable from outside', () => { const r = walk([6.5, LV_F, 12.8], [[6.5, 10.0]]); return [r.reached && r.feet === LV_F, r, `reached=${r.reached} at z=${r.z}`]; }],
    ['Living sliding glass (z=0) is passable', () => { const r = walk([3.7, LV_F, -0.9], [[3.7, 0.8]]); return [r.reached, r, `reached=${r.reached} at z=${r.z}`]; }],
    ['Lower-floor sliding glass (z=3.60) is passable', () => { const r = walk([5.8, LV_Z, 2.0], [[5.8, 5.0]]); return [r.reached && Math.abs(r.feet - LV_Z) < 0.01, r, `reached=${r.reached} at z=${r.z}`]; }],
    ['Bed blocks you (bedroom 1, bed x 18.50–20.35)', () => { const r = walk([17.2, LV_F, 6.7], [[21, 6.7]], 3); return [r.x < 18.3, r, `stopped at x=${r.x}`]; }],
    ['Sofa blocks you (living, sofa z 2.52–3.42)', () => { const r = walk([3.3, LV_F, 3.95], [[3.3, 1.0]], 3); return [r.z > 3.6, r, `stopped at z=${r.z}`]; }],
    ['Dining table blocks you (table z 4.44–5.62)', () => { const r = walk([2.85, LV_F, 7.2], [[2.85, 3.0]], 3); return [r.z > 5.8, r, `stopped at z=${r.z}`]; }],
    ['Kitchen island blocks you', () => { const r = walk([2.8, LV_F, 10.6], [[2.8, 7.0]], 3); return [r.z > 9.7, r, `stopped at z=${r.z}`]; }],
    ['Exterior steel stair: quincho deck → lawn', () => { const r = walk([-5.0, LV_F, 2.8], [[-8.3, 2.9], [-9.3, 2.9], [-9.3, 0.0], [-9.3, -3.5]]); return [r.reached && Math.abs(r.feet) < 0.02, r, `reached=${r.reached}, feet ${r.feet} at (${r.x}, ${r.z}) in ${r.t}s`]; }],
    ['Exterior steel stair: lawn → quincho deck', () => { const r = walk([-9.3, 0, -3.8], [[-9.3, 0.0], [-9.3, 2.9], [-8.3, 2.9], [-5.0, 2.8]]); return [r.reached && r.feet === LV_F, r, `reached=${r.reached}, feet ${r.feet}`]; }],
    ['Exterior steel stair: side guard stops you on the landing', () => { const r = walk([-9.3, 1.5, -0.2], [[-6, -0.2]], 3); return [r.x < -8.9 && Math.abs(r.feet - 1.5) < 0.01, r, `stopped at x=${r.x}, feet ${r.feet}`]; }],
    ['Kitchen/entry wall blocks you (x=5.64)', () => { const r = walk([4.6, LV_F, 10.4], [[7.0, 10.4]], 3); return [r.x < 5.45, r, `stopped at x=${r.x}`]; }],
  ];
  const out = [];
  let pass = 0;
  for (const [name, fn] of tests) { let ok = false, info = '', r = null; try { [ok, r, info] = fn(); } catch (e) { info = 'ERROR ' + e; } if (ok) pass++; out.push({ name, ok, info, r }); }
  const text = `walk self-test: ${pass}/${tests.length} pass\n` + out.map(o => `${o.ok ? 'PASS' : 'FAIL'}  ${o.name} — ${o.info}`).join('\n');
  return { pass, total: tests.length, results: out, text };
}
