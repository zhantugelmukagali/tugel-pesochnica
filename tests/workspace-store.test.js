import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../src/project.js';
import { createHistory, exportProject, importProject, saveWorkspace, loadWorkspace, WORKSPACE_STORAGE_KEY } from '../src/workspace-store.js';

const named = name => ({ ...createProject('empty'), name });
function memoryStorage() {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test('history snapshots isolate caller, getter, commit and undo mutations', () => {
  const initial = named('Initial');
  const history = createHistory(initial);
  initial.name = 'External mutation';
  const copy = history.current;
  copy.name = 'Getter mutation';
  copy.settings.gravity = 0;
  assert.equal(history.current.name, 'Initial');
  assert.equal(history.current.settings.gravity, 9.81);
  const next = named('Second');
  const result = history.commit(next, 'Переименовать');
  next.name = result.name = 'Changed';
  assert.equal(history.current.name, 'Second');
  assert.equal(history.lastLabel, 'Переименовать');
  const undone = history.undo();
  undone.settings.gravity = 0;
  assert.equal(history.current.settings.gravity, 9.81);
  assert.equal(history.current.name, 'Initial');
});

test('undo, redo, branching and bounded capacity', () => {
  const history = createHistory(named('A'), 2);
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  assert.equal(history.undo().name, 'A');
  history.commit(named('B'), 'B');
  history.commit(named('C'), 'C');
  history.commit(named('D'), 'D');
  assert.equal(history.undo().name, 'C');
  assert.equal(history.undo().name, 'B');
  assert.equal(history.canUndo, false);
  assert.equal(history.redo().name, 'C');
  history.commit(named('E'), 'E');
  assert.equal(history.canRedo, false);
  assert.equal(history.redo().name, 'E');
  assert.equal(history.lastLabel, 'E');
});

test('failed commits preserve current value, undo and redo branch', () => {
  const history = createHistory(named('A'));
  history.commit(named('B'), 'B');
  history.undo();
  assert.throws(() => history.commit({ version: 2 }), /Некорректный проект/);
  assert.equal(history.current.name, 'A');
  assert.equal(history.canRedo, true);
  assert.equal(history.redo().name, 'B');
  assert.throws(() => createHistory(named('A'), 0), RangeError);
});

test('export and import round trip a valid v2 project without shared objects', () => {
  const project = named('Эксперимент');
  const restored = importProject(exportProject(project));
  assert.deepEqual(restored, project);
  restored.settings.gravity = 0;
  assert.equal(project.settings.gravity, 9.81);
});

test('reject malformed, obsolete, oversized and prototype-shaped imports', () => {
  assert.throws(() => importProject('{bad json'), /JSON/);
  assert.throws(() => importProject('null'), /версии 2/);
  assert.throws(() => importProject('{"version":1}'), /версии 1/);
  assert.throws(() => importProject('{"version":2,"__proto__":{"polluted":true}}'), /имя свойства/);
  assert.throws(() => importProject('{"version":2,"nested":{"constructor":{}}}'), /имя свойства/);
  assert.equal({}.polluted, undefined);
  assert.throws(() => importProject(' '.repeat(1024 * 1024 + 1)), /1 МБ/);
  assert.throws(() => importProject('я'.repeat(600000)), /1 МБ/);
  assert.throws(() => importProject('['.repeat(70) + 'null' + ']'.repeat(70)), /слишком сложная/);
  assert.throws(() => importProject('{"version":2}'), /Некорректный проект/);
});

test('reject circular, non-finite and accessor values without executing getters', () => {
  const circular = named('A');
  circular.self = circular;
  assert.throws(() => exportProject(circular), /циклическую/);
  const invalid = named('A');
  invalid.settings.gravity = Infinity;
  assert.throws(() => exportProject(invalid), /JSON-данные/);
  let accessed = false;
  const accessor = named('A');
  Object.defineProperty(accessor, 'unexpected', { enumerable: true, get() { accessed = true; return 1; } });
  assert.throws(() => exportProject(accessor), /свойство/);
  assert.equal(accessed, false);
});

test('save/load preserve v1 slot and validate before replacing a stored workspace', () => {
  const storage = memoryStorage();
  storage.setItem('tugel-lab-scene', 'v1 data');
  assert.equal(loadWorkspace(storage), null);
  const project = named('Saved');
  assert.equal(saveWorkspace(project, storage), true);
  assert.deepEqual(loadWorkspace(storage), project);
  assert.equal(storage.getItem('tugel-lab-scene'), 'v1 data');
  assert.throws(() => saveWorkspace({ version: 2 }, storage), /Некорректный проект/);
  assert.equal(loadWorkspace(storage).name, 'Saved');
  storage.setItem(WORKSPACE_STORAGE_KEY, '{"version":1}');
  assert.throws(() => loadWorkspace(storage), /версии 1/);
});

test('storage failures explain export/import fallback', () => {
  assert.throws(() => saveWorkspace(named('A'), null), /экспорт JSON/);
  assert.throws(() => saveWorkspace(named('A'), { setItem() { throw Error('quota'); } }), /экспорт JSON/);
  assert.throws(() => loadWorkspace({ getItem() { throw Error('blocked'); } }), /импорт JSON/);
});
