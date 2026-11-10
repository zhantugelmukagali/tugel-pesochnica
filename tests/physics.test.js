import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation } from '../src/physics.js';

const block = (id, type, position, extra = {}) => ({ id, type, position, rotation: [0, 0, 0], size: [0.18, 0.14, 0.18], mass: 0.3, ...extra });
const project = (objects, connections = []) => ({ objects, connections, settings: { gravity: 9.81, speed: 0.35 } });
function run(simulation, seconds, stopOnFinish = false) {
  let snapshot;
  for (let i = 0; i < seconds * 60; i++) {
    snapshot = simulation.step(1 / 60);
    if (stopOnFinish && ['completed', 'failed'].includes(snapshot.status)) break;
  }
  return snapshot;
}
const position = (snapshot, id) => snapshot.objects.find((o) => o.id === id).position;

test('dynamic payload falls and rests on a colliding floor', async () => {
  const sim = await createSimulation(project([block('payload', 'payload', [0, 1, 0])]));
  try {
    const middle = run(sim, 0.2);
    assert.ok(position(middle, 'payload')[1] < 0.95);
    const end = run(sim, 3);
    assert.ok(Math.abs(position(end, 'payload')[1] - 0.07) < 0.008);
    assert.ok(end.metrics.contacts > 0);
  } finally { sim.dispose(); }
});

test('bounded drive forces move a fixed connected assembly and preserve spacing', async () => {
  const sim = await createSimulation(project([
    block('drive', 'drive', [0, 0.075, 0]), block('body', 'block', [0.2, 0.075, 0]),
  ], [{ id: 'link', a: 'drive', b: 'body', type: 'fixed', axis: 'y' }]));
  try {
    run(sim, 0.5);
    sim.execute({ type: 'move', objectId: 'drive', x: 0.9, z: 0.3 });
    const end = run(sim, 20, true);
    assert.equal(end.status, 'completed', end.message);
    const a = position(end, 'drive');
    const b = position(end, 'body');
    assert.ok(Math.hypot(a[0] - 0.9, a[2] - 0.3) < 0.045);
    assert.ok(Math.abs(Math.hypot(...a.map((v, i) => v - b[i])) - 0.2) < 0.008);
    assert.ok(a[1] > 0.055);
  } finally { sim.dispose(); }
});

test('drive plans around obstacle instead of moving through it', async () => {
  const sim = await createSimulation(project([
    block('drive', 'drive', [-0.7, 0.075, 0]),
    block('wall', 'obstacle', [0, 0.15, 0], { size: [0.3, 0.3, 0.5] }),
  ]));
  try {
    run(sim, 0.4);
    sim.execute({ type: 'move', objectId: 'drive', x: 0.8, z: 0 });
    let maximumDetour = 0;
    let end;
    for (let i = 0; i < 1800; i++) {
      end = sim.step(1 / 60);
      const p = position(end, 'drive');
      maximumDetour = Math.max(maximumDetour, Math.abs(p[2]));
      assert.ok(Math.abs(p[0]) >= 0.238 || Math.abs(p[2]) >= 0.338, 'Drive penetrated obstacle');
      if (end.status !== 'running') break;
    }
    assert.equal(end.status, 'completed', end.message);
    assert.ok(maximumDetour > 0.4);
  } finally { sim.dispose(); }
});

test('blocked goal fails explicitly and stop cancels propulsion target', async () => {
  const sim = await createSimulation(project([
    block('drive', 'drive', [-0.7, 0.075, 0]), block('wall', 'obstacle', [0, 0.15, 0], { size: [0.3, 0.3, 0.5] }),
  ]));
  try {
    assert.equal(sim.execute({ type: 'move', objectId: 'drive', x: 0, z: 0 }).status, 'failed');
    sim.execute({ type: 'move', objectId: 'drive', x: -0.7, z: 1 });
    run(sim, 1);
    const before = position(sim.snapshot(), 'drive');
    sim.stop();
    const end = run(sim, 2);
    assert.equal(end.status, 'idle');
    assert.equal(end.activeMission, null);
    assert.ok(Math.hypot(position(end, 'drive')[0] - before[0], position(end, 'drive')[2] - before[2]) < 0.08);
  } finally { sim.dispose(); }
});

test('revolute motor achieves a measured angle under gravity without teleportation', async () => {
  const sim = await createSimulation(project([
    block('base', 'block', [0, 0.35, 0], { fixed: true, size: [0.16, 0.06, 0.1] }),
    block('arm', 'hinge', [0.2, 0.35, 0], { size: [0.16, 0.06, 0.1], mass: 0.15 }),
  ], [{ id: 'joint', a: 'base', b: 'arm', type: 'revolute', axis: 'z', limit: 70, angle: 0 }]));
  try {
    sim.execute({ type: 'joint', connectionId: 'joint', angle: 35 });
    const first = sim.step(1 / 60);
    assert.ok(Math.abs(first.jointAngles.joint - 35) > 1);
    const end = run(sim, 15, true);
    assert.equal(end.status, 'completed', end.message);
    assert.ok(Math.abs(end.jointAngles.joint - 35) < 2.1);
    assert.ok(position(end, 'arm')[1] > 0.38);
  } finally { sim.dispose(); }
});

test('turn command uses physical yaw torque', async () => {
  const sim = await createSimulation(project([block('drive', 'drive', [0, 0.075, 0])]));
  try {
    run(sim, 0.4);
    sim.execute({ type: 'turn', objectId: 'drive', angle: 90 });
    const end = run(sim, 15, true);
    assert.equal(end.status, 'completed', end.message);
    const q = end.objects[0].quaternion;
    const yaw = 2 * Math.atan2(q[1], q[3]) * 180 / Math.PI;
    assert.ok(Math.abs(yaw - 90) < 4);
  } finally { sim.dispose(); }
});

test('adjacent solid bodies block an impossible hinge angle and report failure', async () => {
  const sim = await createSimulation(project([
    block('base', 'block', [0, 0.2, 0], { fixed: true, size: [0.18, 0.18, 0.18] }),
    block('link', 'block', [0.2, 0.2, 0], { size: [0.18, 0.18, 0.18] }),
  ], [{ id: 'joint', a: 'base', b: 'link', type: 'revolute', axis: 'y', limit: 85 }]));
  try {
    sim.execute({ type: 'joint', connectionId: 'joint', angle: 75 });
    const end = run(sim, 30, true);
    assert.equal(end.status, 'failed');
    assert.ok(end.time < 30);
    assert.ok(Math.abs(end.jointAngles.joint) < 40, 'Bodies folded through each other');
  } finally { sim.dispose(); }
});

test('a full relative turn executes instead of being reduced to zero', async () => {
  const sim = await createSimulation(project([block('drive', 'drive', [0, 0.1, 0])]));
  try {
    sim.execute({ type: 'turn', objectId: 'drive', angle: 360 });
    const end = run(sim, 20, true);
    assert.equal(end.status, 'completed', end.message);
    assert.ok(end.time > 4, 'A full turn should take measurable simulated time');
    assert.ok(end.metrics.maxSpeed < 2);
  } finally { sim.dispose(); }
});
