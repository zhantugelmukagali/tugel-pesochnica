import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler, Quaternion, Vector3 } from 'three';
import { createProject, addObject, connectObjects, cloneProject, validateProject } from '../src/project.js';
import { transformAssembly } from '../src/assembly-edit.js';

const near = (a, b, epsilon = 1e-9) => assert.ok(Math.abs(a - b) < epsilon, `${a} ≈ ${b}`);
const vectorNear = (a, b) => a.forEach((value, i) => near(value, b[i]));

function pair() {
  let project = addObject(createProject('empty'), 'block', [0, 0.10, 0]);
  project = addObject(project, 'hinge', [0.20, 0.10, 0]);
  return connectObjects(project, 'block-1', 'hinge-1', 'revolute');
}

test('group translation preserves connections, relative offsets, fixed state and source', () => {
  const project = pair();
  project.objects[0].fixed = true;
  const saved = cloneProject(project);
  const result = transformAssembly(project, 'block-1', { position: [1, 0.40, 0.20] });
  vectorNear(result.objects[0].position, [1, 0.40, 0.20]);
  vectorNear(result.objects[1].position, [1.20, 0.40, 0.20]);
  assert.deepEqual(result.connections, project.connections);
  assert.equal(result.objects[0].fixed, true);
  assert.deepEqual(project, saved);
});

test('yaw rotation around selected part moves all members and preserves orientations', () => {
  const project = pair();
  const result = transformAssembly(project, 'block-1', { rotation: [0, Math.PI / 2, 0] });
  vectorNear(result.objects[0].position, [0, 0.10, 0]);
  vectorNear(result.objects[1].position, [0, 0.10, -0.20]);
  for (const object of result.objects) {
    const direction = new Vector3(1, 0, 0).applyEuler(new Euler(...object.rotation, 'XYZ'));
    vectorNear(direction.toArray(), [0, 0, -1]);
  }
  assert.deepEqual(result.connections, project.connections);
  assert.equal(validateProject(result).ok, true);
});

test('combined transform composes delta rotations instead of adding Euler components', () => {
  const project = pair();
  // Lift before tilting, to keep the complete assembly clear of the floor.
  const first = transformAssembly(project, 'block-1', { position: [0, 1, 0], rotation: [0.2, 0.3, 0.4] });
  const result = transformAssembly(first, 'block-1', { position: [1, 1, 1], rotation: [0.5, -0.2, 0.7] });
  const target = new Quaternion().setFromEuler(new Euler(0.5, -0.2, 0.7, 'XYZ'));
  const expected = new Vector3(0.20, 0, 0).applyQuaternion(target).add(new Vector3(1, 1, 1));
  vectorNear(result.objects[1].position, expected.toArray());
  const actual = new Quaternion().setFromEuler(new Euler(...result.objects[1].rotation, 'XYZ'));
  near(Math.abs(actual.dot(target)), 1);
  assert.equal(validateProject(result).ok, true);
});

test('blocked environment collision, floor and boundary transformations preserve source', () => {
  const project = addObject(pair(), 'obstacle', [1, 0.15, 0]);
  const saved = cloneProject(project);
  assert.throws(() => transformAssembly(project, 'block-1', { position: [1, 0.10, 0] }), /Пересечение/);
  assert.throws(() => transformAssembly(project, 'block-1', { position: [0, 0, 0] }), /пол/);
  assert.throws(() => transformAssembly(project, 'block-1', { position: [4.90, 0.10, 0] }), /границы/);
  assert.deepEqual(project, saved);
});

test('unconnected environment objects do not move with robot assembly', () => {
  const project = addObject(pair(), 'payload', [1, 0.065, 1]);
  const result = transformAssembly(project, 'block-1', { position: [-1, 0.10, 0] });
  assert.deepEqual(result.objects.find(object => object.type === 'payload'), project.objects.find(object => object.type === 'payload'));
});

test('individual mode detaches the moved part and clears dependent joint missions', () => {
  const project = pair();
  project.missions.push({ id: 'mission-1', type: 'joint', connectionId: project.connections[0].id, angle: 20 });
  const result = transformAssembly(project, 'hinge-1', { position: [0.60, 0.10, 0] }, { wholeAssembly: false });
  vectorNear(result.objects[0].position, project.objects[0].position);
  vectorNear(result.objects[1].position, [0.60, 0.10, 0]);
  assert.equal(result.connections.length, 0);
  assert.equal(result.missions.length, 0);
  assert.equal(project.connections.length, 1);
});

test('malformed edits reject and returned vectors do not alias patch arrays', () => {
  const project = pair();
  for (const patch of [null, [], { position: null }, { rotation: [0, NaN, 0] }, { position: [0, 0] }, { mass: 3 }]) assert.throws(() => transformAssembly(project, 'block-1', patch));
  assert.throws(() => transformAssembly(project, 'missing', {}));
  const patch = { position: [1, 0.10, 1] };
  const result = transformAssembly(project, 'block-1', patch);
  result.objects[0].position[0] = 2;
  assert.deepEqual(patch.position, [1, 0.10, 1]);
});
