import test from 'node:test';
import assert from 'node:assert/strict';
import { createSwarm } from '../src/swarm.js';

const SIZE = 0.08;
function verifyClearance(swarm) {
  const modules = swarm.modules;
  for (let i = 0; i < modules.length; i++) {
    assert.ok(Math.abs(modules[i].position.y - (SIZE / 2 + 0.005)) < 1e-9);
    for (let j = i + 1; j < modules.length; j++) {
      const a = modules[i].position;
      const b = modules[j].position;
      assert.ok(Math.abs(a.x - b.x) >= SIZE - 1e-8 || Math.abs(a.z - b.z) >= SIZE - 1e-8, `Collision between ${i} and ${j}`);
    }
  }
}

for (const count of [6, 20]) {
  test(`${count} modules safely transform through all supported forms`, () => {
    const swarm = createSwarm(count, SIZE);
    for (const pattern of ['ring', 'line', 's', 'grid']) {
      const planned = swarm.plan(pattern);
      assert.equal(planned.ok, true, `${pattern}: ${planned.reason}`);
      assert.ok(planned.steps > 0);
      let finished = false;
      for (let frame = 0; frame < 100000 && !finished; frame++) {
        finished = swarm.step(0.025, 5).completed;
        verifyClearance(swarm);
      }
      assert.equal(finished, true, `${pattern} did not finish`);
      assert.equal(swarm.progress, 1);
      assert.equal(swarm.activeIndex, null);
      swarm.modules.forEach((module, i) => assert.ok(module.position.distanceTo(swarm.targetModules[i].position) < 1e-8));
      assert.equal(new Set(swarm.modules.map((m) => `${m.position.x},${m.position.z}`)).size, count);
    }
  });
}

test('mid-movement replanning is rejected without corrupting the route', () => {
  const swarm = createSwarm(6);
  assert.equal(swarm.plan('ring').ok, true);
  swarm.step(0.1);
  const before = swarm.modules.map((m) => m.position.clone());
  assert.equal(swarm.plan('grid').ok, false);
  swarm.modules.forEach((m, i) => assert.ok(m.position.equals(before[i])));
  assert.equal(swarm.step(0, 0).moving, true);
  swarm.reset();
  assert.equal(swarm.activeIndex, null);
  assert.equal(swarm.progress, 0);
});

test('invalid initial overlapping or off-grid poses and unknown patterns fail safely', () => {
  const swarm = createSwarm(6);
  assert.equal(swarm.plan('unknown').ok, false);
  swarm.modules[1].position.copy(swarm.modules[0].position);
  assert.equal(swarm.plan('line').ok, false);
  swarm.reset();
  swarm.modules[0].position.x += 0.01;
  assert.equal(swarm.plan('grid').ok, false);
});

test('reset applies count and size and invalid time never moves modules', () => {
  const swarm = createSwarm();
  swarm.reset(3, 0.1);
  assert.equal(swarm.modules.length, 3);
  assert.equal(swarm.modules[0].position.y, 0.055);
  assert.equal(swarm.plan('s').ok, true);
  const before = swarm.modules.map((m) => m.position.clone());
  swarm.step(NaN);
  swarm.step(-1);
  swarm.step(1, -1);
  swarm.modules.forEach((m, i) => assert.ok(m.position.equals(before[i])));
});
