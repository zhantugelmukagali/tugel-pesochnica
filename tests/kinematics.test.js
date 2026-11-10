import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { DEFAULT_CONFIG, computeChain, presetAngles, validateTransition } from '../src/kinematics.js';

const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} ≈ ${expected}`);

test('straight chain has expected dimensions, mass and no penetrations', () => {
  const c = DEFAULT_CONFIG;
  const r = computeChain(Array(c.count - 1).fill(0));
  close(r.reach, (c.count - 1) * (c.size + c.gap));
  close(r.height, c.size + 0.005);
  close(r.totalMass, c.count * c.mass);
  assert.equal(r.modules.length, c.count);
  assert.equal(r.joints.length, c.count - 1);
  assert.deepEqual(r.collisions, []);
  assert.deepEqual(r.floorCollisions, []);
});

test('both half-pitch arms and quaternion normalization are invariant', () => {
  const c = { ...DEFAULT_CONFIG, count: 8 };
  const r = computeChain([25, 40, -30, -20, 45, 10, -15], c);
  r.joints.forEach((j, i) => {
    close(j.position.distanceTo(r.modules[i].position), (c.size + c.gap) / 2);
    close(j.position.distanceTo(r.modules[i + 1].position), (c.size + c.gap) / 2);
    close(j.axis.length(), 1);
  });
  r.modules.forEach(m => close(m.quaternion.length(), 1));
});

test('positive pitch raises a child, and local axes follow parent rotations', () => {
  const r = computeChain([90, 45], { count: 3, maxAngle: 100 });
  assert.ok(r.modules[2].position.y > r.modules[1].position.y);
  close(r.joints[1].axis.distanceTo(new Vector3(1, 0, 0)), 0);
});

test('known gravity moment uses downstream centers and axis projection', () => {
  const c = { count: 3, size: 0.08, gap: 0.04, mass: 0.1 };
  const r = computeChain([0, 0], c);
  close(r.joints[0].torque, 0);
  close(r.joints[1].torque, 0.1 * 9.81 * 0.06);
  close(r.maxTorque, 0.05886);
  const vertical = computeChain([0, 90], { ...c, maxAngle: 90 });
  close(vertical.joints[1].torque, 0);
  const planar = computeChain([25, 35], { ...c, axes: 'planar' });
  close(planar.maxTorque, 0);
});

test('floor checks rotated corners rather than only module centers', () => {
  const r = computeChain([0, -30], { count: 3 });
  assert.ok(r.modules[2].position.y > 0);
  assert.ok(r.floorCollisions.includes(2));
});

test('OBB checks adjacent overlaps and detects a folded-back chain', () => {
  const r = computeChain([180], { count: 2, maxAngle: 180 });
  assert.deepEqual(r.collisions, [{ a: 0, b: 1 }]);
  const smallGap = computeChain([90], { count: 2, gap: 0, maxAngle: 90, axes: 'planar' });
  assert.equal(smallGap.collisions.length, 1);
});

test('touching straight faces are not treated as penetration', () => {
  const r = computeChain([0], { count: 2, gap: 0 });
  assert.deepEqual(r.collisions, []);
});

test('presets obey angle limits and spatial arch stays above ground', () => {
  for (const axes of ['planar', 'spatial']) for (const count of [2, 3, 6, 12, 20]) {
    const c = { count, axes, maxAngle: 35 };
    for (const name of ['line', 'arc', 's', 'spring', 'arch', 'wave']) {
      const angles = presetAngles(name, c);
      assert.equal(angles.length, count - 1);
      assert.ok(angles.every(a => Math.abs(a) <= c.maxAngle));
    }
    assert.deepEqual(computeChain(presetAngles('arch', c), c).floorCollisions, []);
  }
});

test('validation rejects angle, floor and collision violations; torque remains a warning', () => {
  assert.equal(validateTransition([0], [86], { count: 2 }).reason, 'angle-limit');
  assert.equal(validateTransition([0, 0], [0, -30], { count: 3, torqueLimit: 100 }).reason, 'floor');
  assert.equal(validateTransition([0], [180], { count: 2, maxAngle: 180, torqueLimit: 100 }).reason, 'collision');
  const heavy = validateTransition([0, 0], [0, 20], { count: 3, torqueLimit: 0.001 });
  assert.equal(heavy.ok, true);
  assert.deepEqual(heavy.report.warnings, ['torque-limit']);
  assert.equal(validateTransition([0], [NaN], { count: 2 }).reason, 'invalid-input');
});

test('validation finds the first intermediate collision, before the final configuration', () => {
  const c = { count: 2, axes: 'planar', maxAngle: 180 };
  const result = validateTransition([0], [180], c);
  assert.equal(result.reason, 'collision');
  assert.ok(result.at > 0 && result.at < 1);
  assert.ok(result.report.collisions.length > 0);
  const previousAngle = 180 * result.at - 2;
  assert.deepEqual(computeChain([previousAngle], c).collisions, []);
});

test('default line, arch and arc presets have collision-free transitions', () => {
  for (const from of ['line', 'arch', 'arc']) for (const to of ['line', 'arch', 'arc']) {
    assert.equal(validateTransition(presetAngles(from), presetAngles(to)).ok, true, `${from} → ${to}`);
  }
});

test('safe planar interpolation succeeds and does not mutate caller arrays', () => {
  const from = [0, 0, 0];
  const to = [15, -15, 15];
  const result = validateTransition(from, to, { count: 4, axes: 'planar' });
  assert.equal(result.ok, true);
  assert.deepEqual(from, [0, 0, 0]);
  assert.deepEqual(to, [15, -15, 15]);
});
