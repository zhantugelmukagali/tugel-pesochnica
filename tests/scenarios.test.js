import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation } from '../src/physics.js';
import { withScenario } from '../src/scenarios.js';
import { validateProject } from '../src/project.js';
import { transformAssembly } from '../src/assembly-edit.js';

for (const template of ['rover', 'arm', 'platform']) {
  test(`${template}: complete default scenario reaches measured poses within 60 simulated seconds`, async () => {
    const project = withScenario(template);
    assert.deepEqual(validateProject(project).errors, []);
    const simulation = await createSimulation(project);
    try {
      simulation.execute(project.missions);
      let previousIndex = 0;
      let snapshot;
      const seenJointAngles = new Map();
      for (let i = 0; i < 60 * 60; i++) {
        snapshot = simulation.step(1 / 60);
        for (const [id, angle] of Object.entries(snapshot.jointAngles)) seenJointAngles.set(id, Math.max(seenJointAngles.get(id) ?? 0, Math.abs(angle)));
        if (snapshot.missionIndex > previousIndex) {
          const completed = project.missions[previousIndex];
          if (completed.type === 'joint') assert.ok(Math.abs(snapshot.jointAngles[completed.connectionId] - completed.angle) < 2.2, `${template} reported success at wrong joint angle`);
          previousIndex = snapshot.missionIndex;
        }
        assert.ok(snapshot.objects.every((object) => object.position.every(Number.isFinite)));
        if (snapshot.status !== 'running') break;
      }
      assert.equal(snapshot.status, 'completed', `${template}: ${snapshot.message}`);
      assert.ok(snapshot.time < 60);
      assert.ok(snapshot.metrics.maxSpeed < 2, `${template} produced an unstable ${snapshot.metrics.maxSpeed.toFixed(2)} m/s body speed`);
      assert.equal(snapshot.missionIndex, project.missions.length);
      assert.ok([...seenJointAngles.values()].some((angle) => angle > 20), 'Robot did not physically change shape');
      for (const angle of Object.values(snapshot.jointAngles)) assert.ok(Math.abs(angle) < 2.5, 'Final folded angle was not restored');
      if (template !== 'arm') {
        const base = snapshot.objects.find((object) => object.id === 'drive-1');
        // Turning occurs around the physical assembly; allow its anchor to move
        // slightly after the move command finishes.
        assert.ok(Math.hypot(base.position[0] - 0.45, base.position[2] + 0.25) < (template === 'rover' ? 0.2 : 0.045));
      }
    } finally { simulation.dispose(); }
  });
}

test('yaw-rotated arm keeps its local hinge axes and completes the full script in the rotated plane', async () => {
  const project = transformAssembly(withScenario('arm'), 'block-1', { rotation: [0, Math.PI / 2, 0] });
  assert.deepEqual(validateProject(project).errors, []);
  const simulation = await createSimulation(project);
  try {
    simulation.execute(project.missions);
    let snapshot;
    let maximumHeight = 0;
    let previousIndex = 0;
    for (let i = 0; i < 60 * 60; i++) {
      snapshot = simulation.step(1 / 60);
      for (const object of snapshot.objects.filter((part) => part.id.startsWith('hinge-'))) {
        maximumHeight = Math.max(maximumHeight, object.position[1]);
        assert.ok(Math.abs(object.position[0] + 0.4) < 0.008, 'Rotated arm left its new YZ articulation plane');
      }
      if (snapshot.missionIndex > previousIndex) {
        const completed = project.missions[previousIndex];
        if (completed.type === 'joint') assert.ok(Math.abs(snapshot.jointAngles[completed.connectionId] - completed.angle) < 2.2);
        previousIndex = snapshot.missionIndex;
      }
      if (snapshot.status !== 'running') break;
    }
    assert.equal(snapshot.status, 'completed', snapshot.message);
    assert.ok(snapshot.time < 60);
    assert.ok(maximumHeight > 0.4, 'The rotated arm did not lift');
    assert.ok(snapshot.metrics.maxSpeed < 2, `Unstable rotated-arm speed: ${snapshot.metrics.maxSpeed}`);
    for (const angle of Object.values(snapshot.jointAngles)) assert.ok(Math.abs(angle) < 2.5);
  } finally { simulation.dispose(); }
});
