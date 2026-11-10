import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createObject, validateProject, addObject, deleteObject, updateObject, connectObjects, disconnectObjects, autoConnect, connectedIds, cloneProject, nextId, applyTemplate } from '../src/project.js';

function pair() {
  let project = createProject('empty');
  project = addObject(project, 'block', [0, 0.10, 0]);
  return addObject(project, 'hinge', [0.20, 0.10, 0]);
}

test('all three robot templates are valid and contain usable articulated structures', () => {
  for (const name of ['rover', 'arm', 'platform']) {
    const project = createProject(name);
    assert.deepEqual(validateProject(project), { ok: true, errors: [] }, name);
    assert.ok(project.connections.some(connection => connection.type === 'revolute'), name);
    assert.ok(project.objects.some(object => object.type === 'payload'));
    if (name === 'arm') assert.ok(project.objects.some(object => object.fixed && object.type === 'block'));
    else assert.ok(project.objects.some(object => object.type === 'drive'));
    assert.deepEqual(applyTemplate(name), project);
  }
});

test('creation preserves caller position arrays and returns independent default vectors', () => {
  const position = [1, 0.10, 0];
  const first = createObject('drive', 'drive-1', position);
  const second = createObject('drive', 'drive-2');
  first.position[0] = 2; first.size[0] = 0.5;
  assert.deepEqual(position, [1, 0.10, 0]);
  assert.deepEqual(second.size, [0.18, 0.14, 0.18]);
  assert.throws(() => createObject('dragon', 'x'));
});

test('malformed imports report errors without throwing', () => {
  for (const invalid of [null, [], 1, {}, { version: 2 }, { ...createProject('empty'), objects: [null] }, { ...createProject('empty'), connections: [null], missions: [null] }]) {
    assert.doesNotThrow(() => validateProject(invalid));
    assert.equal(validateProject(invalid).ok, false);
  }
  const project = createProject('empty');
  project.objects = [{ ...createObject('block', 'bad'), position: [NaN, 0.10, 0] }];
  assert.equal(validateProject(project).ok, false);
});

test('rejects body overlap, rotated floor penetration, wheel penetration and bounds', () => {
  const project = pair();
  project.objects[1].position = [0.05, 0.10, 0];
  assert.ok(validateProject(project).errors.some(error => error.includes('Пересечение')));
  const floor = createProject('empty');
  floor.objects.push({ ...createObject('block', 'block'), position: [0, 0.07, 0], rotation: [0, 0, Math.PI / 4] });
  assert.ok(validateProject(floor).errors.some(error => error.includes('пол')));
  floor.objects = [createObject('drive', 'drive', [0, 0.07, 0])];
  assert.equal(validateProject(floor).ok, false);
  floor.objects = [createObject('block', 'block', [4.99, 0.10, 0])];
  assert.ok(validateProject(floor).errors.some(error => error.includes('границы')));
});

test('OBB avoids false collisions for rotated slender parallel links', () => {
  const project = createProject('empty');
  project.objects = [
    { ...createObject('block', 'one', [0, 0.10, 0]), size: [0.40, 0.10, 0.04], rotation: [0, Math.PI / 4, 0] },
    { ...createObject('block', 'two', [0.06, 0.10, 0.06]), size: [0.40, 0.10, 0.04], rotation: [0, Math.PI / 4, 0] },
  ];
  assert.equal(validateProject(project).ok, true);
});

test('face connections support horizontal and vertical adjacency, not diagonals or duplicates', () => {
  let project = pair();
  project = connectObjects(project, 'block-1', 'hinge-1', 'revolute');
  assert.equal(project.connections.length, 1);
  assert.throws(() => connectObjects(project, 'hinge-1', 'block-1'));
  assert.throws(() => connectObjects(project, 'block-1', 'block-1'));
  assert.throws(() => connectObjects(project, 'block-1', 'missing'));
  project = addObject(project, 'block', [0, 0.26, 0]);
  project = connectObjects(project, 'block-1', 'block-2');
  assert.equal(project.connections.length, 2);
  let diagonal = addObject(createProject('empty'), 'block', [0, 0.10, 0]);
  diagonal = addObject(diagonal, 'block', [0.20, 0.10, 0.20]);
  assert.throws(() => connectObjects(diagonal, 'block-1', 'block-2'));
});

test('autoConnect ignores payload and obstacles and graph traversal handles loops', () => {
  let project = pair();
  project = addObject(project, 'block', [0, 0.10, 0.20]);
  project = addObject(project, 'block', [0.20, 0.10, 0.20]);
  project = addObject(project, 'payload', [-0.20, 0.10, 0]);
  for (const object of project.objects) project = autoConnect(project, object.id);
  assert.equal(project.connections.length, 4);
  assert.deepEqual(new Set(connectedIds(project, 'block-1')), new Set(['block-1', 'hinge-1', 'block-2', 'block-3']));
  assert.deepEqual(connectedIds(project, 'payload-1'), ['payload-1']);
  assert.deepEqual(connectedIds(project, 'missing'), []);
  assert.throws(() => connectObjects(project, 'block-1', 'payload-1'));
});

test('failed additions and updates leave the entire source project unchanged', () => {
  const project = pair();
  const saved = cloneProject(project);
  assert.throws(() => addObject(project, 'drive', [0, 0.10, 0]));
  assert.deepEqual(project, saved);
  assert.throws(() => updateObject(project, 'hinge-1', { position: [0, 0.10, 0] }));
  assert.deepEqual(project, saved);
  assert.throws(() => updateObject(project, 'hinge-1', { id: 'other' }));
  const updated = updateObject(project, 'hinge-1', { name: 'Локоть', mass: 0.15 });
  assert.deepEqual(project, saved);
  assert.equal(updated.objects[1].name, 'Локоть');
});

test('moving a part removes detached links and only their dependent joint missions', () => {
  let project = connectObjects(pair(), 'block-1', 'hinge-1', 'revolute');
  project.missions = [
    { id: 'mission-1', type: 'joint', connectionId: project.connections[0].id, angle: 20 },
    { id: 'mission-2', type: 'wait', seconds: 1 },
  ];
  const changed = updateObject(project, 'hinge-1', { position: [0.60, 0.10, 0] });
  assert.equal(changed.connections.length, 0);
  assert.deepEqual(changed.missions, [{ id: 'mission-2', type: 'wait', seconds: 1 }]);
  assert.equal(project.connections.length, 1);
  assert.equal(project.missions.length, 2);
});

test('delete/disconnect clean dangling missions and preserve unrelated commands', () => {
  let project = connectObjects(pair(), 'block-1', 'hinge-1', 'revolute');
  const connectionId = project.connections[0].id;
  project.missions = [
    { id: 'mission-1', type: 'joint', connectionId, angle: 20 },
    { id: 'mission-2', type: 'move', objectId: 'hinge-1', x: 1, z: 0 },
    { id: 'mission-3', type: 'wait', seconds: 1 },
  ];
  const disconnected = disconnectObjects(project, connectionId);
  assert.deepEqual(disconnected.missions.map(mission => mission.id), ['mission-2', 'mission-3']);
  const deleted = deleteObject(project, 'hinge-1');
  assert.equal(deleted.connections.length, 0);
  assert.deepEqual(deleted.missions.map(mission => mission.id), ['mission-3']);
  assert.equal(project.missions.length, 3);
});

test('import rejects dangling connections, duplicate ids and invalid joint missions', () => {
  const project = connectObjects(pair(), 'block-1', 'hinge-1', 'revolute');
  const broken = cloneProject(project);
  broken.connections[0].b = 'missing';
  assert.equal(validateProject(broken).ok, false);
  const duplicates = cloneProject(project);
  duplicates.objects[1].id = duplicates.objects[0].id;
  assert.equal(validateProject(duplicates).ok, false);
  project.missions = [{ id: 'mission-1', type: 'joint', connectionId: project.connections[0].id, angle: 100 }];
  assert.equal(validateProject(project).ok, false);
  project.missions[0].angle = 20;
  assert.equal(validateProject(project).ok, true);
  project.missions[0].connectionId = 'missing';
  assert.equal(validateProject(project).ok, false);
});

test('automatic placement finds non-overlapping locations and ids remain unique', () => {
  let project = createProject('empty');
  for (let i = 0; i < 8; i++) project = addObject(project, 'drive');
  assert.equal(project.objects.length, 8);
  assert.equal(validateProject(project).ok, true);
  assert.equal(nextId(project, 'drive'), 'drive-9');
  assert.equal(createProject('empty').objects.length, 0);
});
