import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import * as projectModel from '../src/project.js';
import * as workspaceStore from '../src/workspace-store.js';
import * as assemblyEdit from '../src/assembly-edit.js';
import { withScenario } from '../src/scenarios.js';

// DOM integration, not a WebGL/browser rendering test. Run the actual UI entry,
// replacing only its renderer and asynchronous physics boundary with test doubles.
const source = (await readFile(new URL('../src/builder.js', import.meta.url), 'utf8'))
  .replace(/^import[^\n]*;\s*$/gm, '')
  .replace(/import\('\.\/physics\.js'\)/g, '__loadPhysics()');

function fakeSimulation(project) {
  const sim = { time: 0, status: 'idle', disposed: false, executed: [], steps: [] };
  sim.snapshot = () => ({ time: sim.time, status: sim.status, message: 'test state', missionIndex: 0,
    objects: structuredClone(project.objects), metrics: { distance: 0, maxSpeed: 0, contacts: 0 } });
  sim.execute = missions => { sim.executed = structuredClone(missions); sim.status = 'running'; };
  sim.step = dt => { sim.steps.push(dt); sim.time += dt; return sim.snapshot(); };
  sim.dispose = () => { sim.disposed = true; };
  return sim;
}

function mount(t, options = {}) {
  const window = new Window({ url: 'https://tugel.test/' });
  window.document.body.innerHTML = '<div id="app"></div>';
  const scene = { project: null, selected: null, tool: null, simulation: false, waypoint: null,
    setProject(p) { this.project = structuredClone(p); }, setSelection(id) { this.selected = id; },
    setTool(value) { this.tool = value; }, setSimulation(value) { this.simulation = value; },
    setWaypoint(value) { this.waypoint = value; }, setView() {}, setGrid() {}, fit() {}, updatePoses() {},
    capture() { return 'data:image/png;base64,'; } };
  const simulations = [];
  let callbacks;
  const dependencies = {
    ...projectModel, ...workspaceStore, ...assemblyEdit, withScenario,
    createBuilderScene(container, cbs) { assert.ok(container); callbacks = cbs; return scene; },
    saveWorkspace: p => workspaceStore.saveWorkspace(p, window.localStorage),
    loadWorkspace: () => workspaceStore.loadWorkspace(window.localStorage),
    window, document: window.document, requestAnimationFrame: () => 1,
    setTimeout: () => 1, clearTimeout: () => {},
    __loadPhysics: async () => ({ createSimulation: async p => {
      const sim = options.createSimulation ? await options.createSimulation(p) : fakeSimulation(p);
      simulations.push(sim);
      return sim;
    } }),
  };
  const run = new Function(...Object.keys(dependencies), source + '\nreturn { snapshot: () => ({ project: structuredClone(project), selected, mode, playing, loading, pickingTarget, hasSimulation: !!simulation }), tickPhysics };');
  const api = run(...Object.values(dependencies));
  const query = selector => {
    const element = window.document.querySelector(selector);
    assert.ok(element, `Expected UI element ${selector}`);
    return element;
  };
  const click = selector => {
    const element = query(selector);
    assert.equal(element.disabled, false, `${selector} must be enabled`);
    assert.equal(typeof element.onclick, 'function');
    return element.onclick({ target: element, currentTarget: element, preventDefault() {}, stopPropagation() {} });
  };
  const change = (selector, value) => {
    const element = query(selector);
    element.value = String(value);
    if (typeof element.onchange === 'function') return element.onchange({ target: element, currentTarget: element });
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const empty = () => { click('[data-library="robots"]'); click('#emptyProject'); };
  const place = (type, position) => {
    if (!window.document.querySelector(`[data-part="${type}"]`)) click('[data-library="parts"]');
    click(`[data-part="${type}"]`); callbacks.onGroundClick(position);
  };
  t.after(() => window.happyDOM.abort());
  return { ...api, window, query, click, change, empty, place, scene, callbacks, simulations };
}

test('constructor adds selected parts, connects neighbours, supports undo/redo and cascading deletion', t => {
  const app = mount(t);
  assert.ok(app.snapshot().project.objects.length > 0);
  assert.ok(app.snapshot().project.missions.length > 0);
  app.empty();
  assert.equal(app.snapshot().project.objects.length, 0);
  app.place('block', [0, 0, 0]);
  const first = app.snapshot().selected;
  app.place('block', [.2, 0, 0]);
  const second = app.snapshot().selected;
  assert.notEqual(first, second);
  assert.equal(app.scene.selected, second);
  app.click('#connectSelected');
  app.callbacks.onSelect(first);
  assert.equal(app.snapshot().project.connections.length, 1);
  app.click('#undo');
  assert.equal(app.snapshot().project.connections.length, 0);
  app.click('#redo');
  assert.equal(app.snapshot().project.connections.length, 1);
  app.click('#delete');
  assert.equal(app.snapshot().project.objects.length, 1);
  assert.equal(app.snapshot().project.connections.length, 0);
  assert.equal(projectModel.validateProject(app.snapshot().project).ok, true);
});

test('invalid property edit rolls back project and renderer without destroying undo', t => {
  const app = mount(t);
  app.empty();
  app.place('block', [0, 0, 0]);
  const before = app.snapshot().project;
  app.change('#objectMass', -10);
  assert.deepEqual(app.snapshot().project, before);
  assert.deepEqual(app.scene.project, before);
  assert.equal(Number(app.query('#objectMass').value), before.objects[0].mass);
  assert.ok(app.query('#toast').textContent.length > 0);
  app.click('#undo');
  assert.equal(app.snapshot().project.objects.length, 0);
});

test('group transform keeps connected neighbours together; individual edit detaches cleanly', t => {
  const app = mount(t);
  app.empty();
  app.place('block', [0, 0, 0]);
  const first = app.snapshot().selected;
  app.place('block', [.2, 0, 0]);
  const second = app.snapshot().selected;
  app.click('#connectSelected');
  app.callbacks.onSelect(first);
  assert.equal(app.query('#moveAssembly').checked, true);
  const before = app.snapshot().project;
  app.callbacks.onTransform(first, { position: [.4, .1, 0] });
  let moved = app.snapshot().project;
  assert.equal(moved.connections.length, 1);
  assert.ok(Math.abs(moved.objects.find(o => o.id === second).position[0] - .6) < 1e-9);
  assert.deepEqual(moved.objects.find(o => o.id === first).position, [.4, .1, 0]);
  app.click('#undo');
  assert.deepEqual(app.snapshot().project, before);
  app.click('#redo');
  const checkbox = app.query('#moveAssembly');
  checkbox.checked = false;
  checkbox.onchange({ target: checkbox });
  app.callbacks.onTransform(first, { position: [-.4, .1, 0] });
  moved = app.snapshot().project;
  assert.equal(moved.connections.length, 0);
  assert.ok(Math.abs(moved.objects.find(o => o.id === second).position[0] - .6) < 1e-9);
  assert.equal(projectModel.validateProject(moved).ok, true);
});

test('joint inspector changes axis and rolls back a limit that invalidates its mission', t => {
  const app = mount(t);
  const original = app.snapshot().project.connections.find(c => c.type === 'revolute');
  assert.ok(original);
  app.change(`[data-link-axis="${original.id}"]`, 'z');
  assert.equal(app.snapshot().project.connections.find(c => c.id === original.id).axis, 'z');
  app.change(`[data-link-limit="${original.id}"]`, 1);
  assert.equal(app.snapshot().project.connections.find(c => c.id === original.id).limit, original.limit);
  assert.equal(Number(app.query(`[data-link-limit="${original.id}"]`).value), original.limit);
});

test('custom mission uses snapped floor waypoint, can be reordered and deleted', t => {
  const app = mount(t);
  app.click('[data-mode="test"]');
  const originalLength = app.snapshot().project.missions.length;
  app.click('#addTaskToggle');
  app.click('#pickTarget');
  assert.equal(app.scene.tool, 'place');
  app.callbacks.onGroundClick([.53, 0, -.29]);
  assert.equal(app.query('#missionX').value, '0.60');
  assert.equal(app.query('#missionZ').value, '-0.20');
  app.click('#appendTask');
  const mission = app.snapshot().project.missions.at(-1);
  assert.equal(mission.type, 'move');
  assert.equal(mission.x, .6);
  assert.equal(mission.z, -.2);
  assert.equal(app.snapshot().project.missions.length, originalLength + 1);
  app.click(`[data-up-task="${originalLength}"]`);
  assert.equal(app.snapshot().project.missions[originalLength - 1].id, mission.id);
  app.click(`[data-delete-task="${mission.id}"]`);
  assert.equal(app.snapshot().project.missions.length, originalLength);
});

test('changing task type cancels stale waypoint picking before removed inputs can be accessed', t => {
  const app = mount(t);
  app.click('[data-mode="test"]');
  app.click('#addTaskToggle');
  app.click('#pickTarget');
  app.change('#missionType', 'wait');
  assert.doesNotThrow(() => app.callbacks.onGroundClick([.4, 0, .4]));
  assert.equal(app.snapshot().pickingTarget, false);
  app.change('#missionSeconds', 2);
  app.click('#appendTask');
  assert.equal(app.snapshot().project.missions.at(-1).seconds, 2);
});

test('single step pauses, reset disposes simulation, build restores editable initial project', async t => {
  const app = mount(t);
  const initial = app.snapshot().project;
  app.click('[data-mode="test"]');
  await app.click('#stepTest');
  assert.equal(app.snapshot().playing, false);
  assert.equal(app.simulations[0].steps.length, 1);
  assert.equal(app.simulations[0].steps[0], .1);
  await app.click('#runTest');
  assert.equal(app.snapshot().playing, true);
  await app.click('#runTest');
  assert.equal(app.snapshot().playing, false);
  app.click('#resetTest');
  assert.equal(app.simulations[0].disposed, true);
  assert.equal(app.snapshot().hasSimulation, false);
  app.click('[data-mode="build"]');
  assert.equal(app.scene.simulation, false);
  assert.deepEqual(app.snapshot().project, initial);
  assert.deepEqual(app.scene.project, initial);
});

test('switching to build while physics initializes discards the stale simulation', async t => {
  let resolveSimulation;
  const app = mount(t, { createSimulation: p => new Promise(resolve => { resolveSimulation = () => resolve(fakeSimulation(p)); }) });
  app.click('[data-mode="test"]');
  const pending = app.click('#runTest');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(app.snapshot().loading, true);
  app.click('[data-mode="build"]');
  assert.equal(typeof resolveSimulation, 'function');
  resolveSimulation();
  await pending;
  assert.equal(app.simulations[0].disposed, true);
  assert.equal(app.snapshot().mode, 'build');
  assert.equal(app.snapshot().playing, false);
  assert.equal(app.snapshot().hasSimulation, false);
  assert.equal(app.snapshot().loading, false);
});

test('local save/load restores the assembly and leaves an undo path to current edits', t => {
  const app = mount(t);
  app.empty();
  app.place('block', [0, 0, 0]);
  app.click('#save');
  const saved = app.snapshot().project;
  app.place('block', [.4, 0, 0]);
  app.click('#load');
  assert.deepEqual(app.snapshot().project, saved);
  app.click('#undo');
  assert.equal(app.snapshot().project.objects.length, 2);
});
