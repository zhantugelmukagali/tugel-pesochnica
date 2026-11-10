import { Euler, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { OBB } from 'three/addons/math/OBB.js';

const TYPES = ['drive', 'block', 'hinge', 'payload', 'obstacle'];
const ROBOT_TYPES = new Set(['drive', 'block', 'hinge']);
const TOLERANCE = 0.020001;
const EPS = 1e-6;
const BOUNDS = 5;
const MAX_OBJECTS = 40;
const vector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const idValid = id => typeof id === 'string' && id.trim().length > 0 && id.length <= 100;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function cloneProject(project) { return structuredClone(project); }

export function nextId(project, prefix = 'object') {
  const ids = new Set([...(project.objects || []), ...(project.connections || []), ...(project.missions || [])].map(item => item.id));
  let number = 1;
  while (ids.has(`${prefix}-${number}`)) number++;
  return `${prefix}-${number}`;
}

export function createObject(type, id, position) {
  if (!TYPES.includes(type)) throw new Error(`Неизвестный тип детали: ${type}`);
  if (!idValid(id)) throw new Error('Нужен непустой идентификатор детали');
  const sizes = { payload: [0.13, 0.13, 0.13], obstacle: [0.30, 0.30, 0.30] };
  const size = sizes[type] || [0.18, 0.14, 0.18];
  const initial = position ?? [0, ROBOT_TYPES.has(type) ? 0.10 : size[1] / 2, 0];
  if (!vector(initial)) throw new Error('Положение детали должно содержать три конечных числа');
  return { id, type, position: [...initial], rotation: [0, 0, 0], size: [...size], mass: { drive: 0.20, block: 0.10, hinge: 0.10, payload: 0.12, obstacle: 2 }[type], ...(type === 'obstacle' ? { fixed: true } : {}) };
}

function geometry(object) {
  const quaternion = new Quaternion().setFromEuler(new Euler(...object.rotation, 'XYZ'));
  const center = new Vector3(...object.position);
  const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)].map(axis => axis.applyQuaternion(quaternion));
  const half = object.size.map(value => value / 2);
  const rotation = new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(quaternion));
  const box = new OBB(center, new Vector3(...half.map(value => Math.max(EPS, value - EPS))), rotation);
  const corners = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    corners.push(new Vector3(x * half[0], y * half[1], z * half[2]).applyQuaternion(quaternion).add(center));
  }
  return { center, axes, half, box, corners };
}

// A connector is one of the six cardinal faces of a part. Matching face normals
// must be parallel and face centers aligned. Rotated corner proximity is not docking.
function adjacent(a, b) {
  const ga = geometry(a), gb = geometry(b);
  const delta = gb.center.clone().sub(ga.center);
  for (let axisA = 0; axisA < 3; axisA++) for (let axisB = 0; axisB < 3; axisB++) {
    const normal = ga.axes[axisA];
    if (Math.abs(normal.dot(gb.axes[axisB])) < 1 - 1e-5) continue;
    const normalDistance = Math.abs(delta.dot(normal));
    const lateralDistance = delta.clone().addScaledVector(normal, -delta.dot(normal)).length();
    const expected = ga.half[axisA] + gb.half[axisB] + 0.02;
    if (Math.abs(normalDistance - expected) <= TOLERANCE && lateralDistance <= TOLERANCE) return true;
  }
  return false;
}

/** Validate an editable initial assembly, not a running physical state. */
export function validateProject(project) {
  const errors = [];
  const fail = message => errors.push(message);
  if (!record(project)) return { ok: false, errors: ['Проект должен быть объектом'] };
  if (project.version !== 2) fail('Поддерживается только версия проекта 2');
  if (typeof project.name !== 'string' || !project.name.trim() || project.name.length > 200) fail('У проекта должно быть название длиной до 200 символов');
  if (!Array.isArray(project.objects) || !Array.isArray(project.connections) || !Array.isArray(project.missions)) return { ok: false, errors: [...errors, 'objects, connections и missions должны быть массивами'] };
  // Reject oversized imports before the quadratic collision pass.
  if (project.objects.length > MAX_OBJECTS) return { ok: false, errors: [...errors, 'В проекте допускается не больше 40 деталей'] };
  if (project.connections.length > 160 || project.missions.length > 200) return { ok: false, errors: [...errors, 'Слишком много связей или команд'] };
  const settings = project.settings;
  if (!record(settings) || !Number.isFinite(settings.gravity) || settings.gravity < 0 || settings.gravity > 30 || !Number.isFinite(settings.speed) || settings.speed <= 0 || settings.speed > 5 || !Number.isFinite(settings.snap) || settings.snap <= 0 || settings.snap > 1) fail('Некорректные настройки: gravity 0–30, speed 0–5, snap 0–1');
  const byId = new Map(), geometries = new Map(), usedIds = new Set();
  function checkId(item, label) {
    if (!idValid(item.id)) fail(`${label}: некорректный идентификатор`);
    else if (usedIds.has(item.id)) fail(`Повтор идентификатора ${item.id}`);
    else usedIds.add(item.id);
  }
  for (const object of project.objects) {
    if (!record(object)) { fail('Некорректная запись детали'); continue; }
    checkId(object, 'Деталь');
    if (!TYPES.includes(object.type)) fail(`${object.id}: неизвестный тип детали`);
    if (!vector(object.position) || !vector(object.rotation) || !vector(object.size) || object.size.some(value => value < 0.01 || value > 2)) { fail(`${object.id}: некорректные положение, поворот или размер`); continue; }
    if (!Number.isFinite(object.mass) || object.mass <= 0 || object.mass > 100) fail(`${object.id}: масса должна быть больше 0 и не больше 100 кг`);
    if (object.fixed !== undefined && typeof object.fixed !== 'boolean') fail(`${object.id}: fixed должен быть логическим значением`);
    byId.set(object.id, object);
    const shape = geometry(object);
    geometries.set(object.id, shape);
    const floorClearance = object.type === 'drive' ? 0.02 : 0;
    if (shape.corners.some(corner => corner.y < floorClearance - EPS)) fail(`${object.id}: корпус или колёса пересекают пол`);
    if (shape.corners.some(corner => Math.abs(corner.x) > BOUNDS + EPS || Math.abs(corner.z) > BOUNDS + EPS || corner.y > BOUNDS + EPS)) fail(`${object.id}: деталь выходит за границы площадки ±5 м`);
  }
  const entries = [...geometries.entries()];
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    if (entries[i][1].box.intersectsOBB(entries[j][1].box, 1e-10)) fail(`Пересечение деталей ${entries[i][0]} и ${entries[j][0]}`);
  }
  const connectionById = new Map(), pairs = new Set();
  for (const connection of project.connections) {
    if (!record(connection)) { fail('Некорректная запись соединения'); continue; }
    checkId(connection, 'Соединение');
    connectionById.set(connection.id, connection);
    if (!['fixed', 'revolute'].includes(connection.type) || !['y', 'z'].includes(connection.axis)) fail(`${connection.id}: некорректный тип или ось соединения`);
    if (!Number.isFinite(connection.limit) || connection.limit <= 0 || connection.limit > 180 || !Number.isFinite(connection.angle) || Math.abs(connection.angle) > connection.limit) fail(`${connection.id}: некорректный угол или предел шарнира`);
    const a = byId.get(connection.a), b = byId.get(connection.b);
    if (!a || !b || a.id === b.id) { fail(`${connection.id}: соединение ссылается на отсутствующие или одинаковые детали`); continue; }
    if (!ROBOT_TYPES.has(a.type) || !ROBOT_TYPES.has(b.type)) fail(`${connection.id}: груз и препятствие нельзя соединять с роботом`);
    const pair = [a.id, b.id].sort().join('\u0000');
    if (pairs.has(pair)) fail(`${connection.id}: повтор соединения между ${a.id} и ${b.id}`);
    pairs.add(pair);
    if (!adjacent(a, b)) fail(`${connection.id}: соединять можно только соседние грани деталей`);
  }
  for (const mission of project.missions) {
    if (!record(mission)) { fail('Некорректная запись команды'); continue; }
    checkId(mission, 'Команда');
    if (!['move', 'turn', 'joint', 'wait'].includes(mission.type)) { fail(`${mission.id}: неизвестная команда`); continue; }
    if (mission.objectId !== undefined && !byId.has(mission.objectId)) fail(`${mission.id}: не найдена деталь команды`);
    if (mission.connectionId !== undefined && !connectionById.has(mission.connectionId)) fail(`${mission.id}: не найден шарнир команды`);
    for (const key of ['x', 'z', 'angle', 'seconds']) if (mission[key] !== undefined && !Number.isFinite(mission[key])) fail(`${mission.id}: ${key} должно быть конечным числом`);
    if (['move', 'turn'].includes(mission.type) && !ROBOT_TYPES.has(byId.get(mission.objectId)?.type)) fail(`${mission.id}: для движения нужен модуль робота`);
    if (mission.type === 'move' && (!Number.isFinite(mission.x) || !Number.isFinite(mission.z) || Math.abs(mission.x) > BOUNDS || Math.abs(mission.z) > BOUNDS)) fail(`${mission.id}: цель движения должна быть внутри площадки`);
    if (mission.type === 'turn' && (!Number.isFinite(mission.angle) || Math.abs(mission.angle) > 3600)) fail(`${mission.id}: некорректный угол поворота`);
    if (mission.type === 'wait' && (!Number.isFinite(mission.seconds) || mission.seconds < 0 || mission.seconds > 3600)) fail(`${mission.id}: ожидание должно быть от 0 до 3600 секунд`);
    if (mission.type === 'joint') {
      const connection = connectionById.get(mission.connectionId);
      if (connection?.type !== 'revolute' || !Number.isFinite(mission.angle) || Math.abs(mission.angle) > connection.limit) fail(`${mission.id}: нужен существующий шарнир и угол в его пределах`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function checked(project) {
  const result = validateProject(project);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return project;
}

function cleanup(project) {
  const objects = new Set(project.objects.map(object => object.id));
  project.connections = project.connections.filter(connection => objects.has(connection.a) && objects.has(connection.b));
  const connections = new Set(project.connections.map(connection => connection.id));
  project.missions = project.missions.filter(mission => (!mission.objectId || objects.has(mission.objectId)) && (!mission.connectionId || connections.has(mission.connectionId)));
  return project;
}

export function addObject(project, type, position) {
  if (project.objects.length >= MAX_OBJECTS) throw new Error('Достигнут предел: 40 деталей');
  const next = cloneProject(project);
  const object = createObject(type, nextId(project, type), position);
  if (position === undefined) {
    let found = false;
    for (let radius = 0; radius <= 24 && !found; radius++) for (let x = -radius; x <= radius && !found; x++) for (let z = -radius; z <= radius && !found; z++) {
      if (Math.max(Math.abs(x), Math.abs(z)) !== radius) continue;
      object.position[0] = x * 0.20; object.position[2] = z * 0.20;
      if (validateProject({ ...next, objects: [...next.objects, object] }).ok) found = true;
    }
    if (!found) throw new Error('Не удалось найти свободное место для детали');
  }
  next.objects.push(object);
  return checked(next);
}

export function deleteObject(project, id) {
  const next = cloneProject(project);
  next.objects = next.objects.filter(object => object.id !== id);
  return checked(cleanup(next));
}

export function updateObject(project, id, patch) {
  if (!record(patch)) throw new Error('Изменение детали должно быть объектом');
  if (patch.id !== undefined && patch.id !== id) throw new Error('Идентификатор детали нельзя менять');
  const next = cloneProject(project);
  const index = next.objects.findIndex(object => object.id === id);
  if (index < 0) throw new Error(`Деталь ${id} не найдена`);
  next.objects[index] = { ...next.objects[index], ...cloneProject(patch), id };
  const updated = next.objects[index];
  // Moving one part is an edit, not a deformation of its complete rigid group.
  // Detached connections and their joint missions are removed together.
  if (vector(updated.position) && vector(updated.rotation) && vector(updated.size) && updated.size.every(value => value > 0)) {
    next.connections = next.connections.filter(connection => {
      if (connection.a !== id && connection.b !== id) return true;
      const other = next.objects.find(object => object.id === (connection.a === id ? connection.b : connection.a));
      return other && ROBOT_TYPES.has(updated.type) && adjacent(updated, other);
    });
  }
  return checked(cleanup(next));
}

export function connectObjects(project, a, b, type = 'fixed') {
  if (!['fixed', 'revolute'].includes(type)) throw new Error('Неизвестный тип соединения');
  const first = project.objects.find(object => object.id === a), second = project.objects.find(object => object.id === b);
  if (!first || !second || a === b) throw new Error('Выберите две разные существующие детали');
  if (!ROBOT_TYPES.has(first.type) || !ROBOT_TYPES.has(second.type)) throw new Error('Соединять можно только модули робота');
  if (project.connections.some(connection => (connection.a === a && connection.b === b) || (connection.a === b && connection.b === a))) throw new Error('Эти детали уже соединены');
  if (!adjacent(first, second)) throw new Error('Для соединения совместите соседние грани деталей');
  const next = cloneProject(project);
  next.connections.push({ id: nextId(project, 'connection'), a, b, type, axis: 'y', angle: 0, limit: 85 });
  return checked(next);
}

export function disconnectObjects(project, connectionId) {
  const next = cloneProject(project);
  next.connections = next.connections.filter(connection => connection.id !== connectionId);
  return checked(cleanup(next));
}

export function autoConnect(project, id) {
  let next = cloneProject(project);
  const object = next.objects.find(item => item.id === id);
  if (!object) throw new Error(`Деталь ${id} не найдена`);
  if (!ROBOT_TYPES.has(object.type)) return checked(next);
  for (const other of next.objects) {
    if (other.id === id || !ROBOT_TYPES.has(other.type) || !adjacent(object, other)) continue;
    if (next.connections.some(connection => [connection.a, connection.b].includes(id) && [connection.a, connection.b].includes(other.id))) continue;
    next = connectObjects(next, id, other.id);
  }
  return checked(next);
}

export function connectedIds(project, id) {
  if (!project.objects.some(object => object.id === id)) return [];
  const found = new Set([id]), queue = [id];
  while (queue.length) {
    const current = queue.shift();
    for (const connection of project.connections) {
      const other = connection.a === current ? connection.b : connection.b === current ? connection.a : null;
      if (other && !found.has(other) && project.objects.some(object => object.id === other)) { found.add(other); queue.push(other); }
    }
  }
  return [...found];
}

export function createProject(template = 'rover') {
  if (!['empty', 'rover', 'arm', 'platform'].includes(template)) throw new Error(`Неизвестный шаблон: ${template}`);
  const project = { version: 2, name: { empty: 'Новый робот', rover: 'Перестраиваемый вездеход', arm: 'Модульный манипулятор', platform: 'Складная платформа' }[template], objects: [], connections: [], missions: [], settings: { gravity: 9.81, speed: 0.35, snap: 0.20 } };
  const part = (type, id, position, extra = {}) => { const object = { ...createObject(type, id, position), ...extra }; project.objects.push(object); return object; };
  const link = (a, b, type = 'fixed', extra = {}) => { const connection = { id: nextId(project, 'connection'), a, b, type, axis: 'y', angle: 0, limit: 85, ...extra }; project.connections.push(connection); return connection; };
  if (template === 'rover') {
    // Narrow bodies leave actual clearance for the yaw articulation.
    part('drive', 'drive-1', [-0.30, 0.10, 0], { size: [0.18, 0.14, 0.08], name: 'Передний привод' });
    part('drive', 'drive-2', [-0.08, 0.10, 0], { size: [0.18, 0.14, 0.08], name: 'Задний привод' });
    link('drive-1', 'drive-2', 'revolute', { name: 'Поворот корпуса', axis: 'y', limit: 45 });
    part('block', 'block-1', [-0.30, 0.26, 0], { size: [0.14, 0.14, 0.08], name: 'Полезная площадка' });
    link('drive-1', 'block-1');
  }
  if (template === 'arm') {
    // Ground support is explicit. Thin links provide pitching clearance.
    part('block', 'block-1', [-0.40, 0.23, 0], { size: [0.18, 0.04, 0.08], mass: 0.30, fixed: true, name: 'Закреплённая база' });
    part('obstacle', 'obstacle-base', [-0.40, 0.10, 0], { size: [0.22, 0.20, 0.16], name: 'Тумба основания' });
    for (let i = 1; i <= 3; i++) {
      part('hinge', `hinge-${i}`, [-0.40 + i * 0.22, 0.23, 0], { size: [0.18, 0.04, 0.08], mass: 0.08, name: ['Плечо', 'Предплечье', 'Наконечник'][i - 1] });
      link(i === 1 ? 'block-1' : `hinge-${i - 1}`, `hinge-${i}`, 'revolute', { axis: 'z', limit: 85, name: ['Плечевой шарнир', 'Локоть', 'Запястье'][i - 1] });
    }
  }
  if (template === 'platform') {
    part('drive', 'drive-1', [-0.20, 0.10, -0.10], { name: 'Левая база' });
    part('drive', 'drive-2', [-0.20, 0.10, 0.10], { name: 'Правая база' });
    link('drive-1', 'drive-2');
    // Thin wings rise about Z; midpoint anchors have equal X half-extents.
    part('block', 'block-1', [0, 0.10, -0.10], { size: [0.18, 0.06, 0.14], mass: 0.06, name: 'Левое крыло' });
    part('block', 'block-2', [0, 0.10, 0.10], { size: [0.18, 0.06, 0.14], mass: 0.06, name: 'Правое крыло' });
    link('drive-1', 'block-1', 'revolute', { axis: 'z', limit: 35, name: 'Левое крыло' });
    link('drive-2', 'block-2', 'revolute', { axis: 'z', limit: 35, name: 'Правое крыло' });
  }
  if (template !== 'empty') {
    part('payload', 'payload-1', [0.90, 0.065, 0.65], { name: 'Тестовый груз' });
    part('obstacle', 'obstacle-1', [1.20, 0.15, -0.80], { name: 'Препятствие' });
  }
  return checked(project);
}

export const applyTemplate = createProject;
