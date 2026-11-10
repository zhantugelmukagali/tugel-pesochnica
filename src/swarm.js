import * as THREE from 'three';

// Kinematic tabletop model: axis-aligned modules translate holonomically.
// It does not simulate wheels, force, attachment, or hardware docking.
const KEY = ([x, z]) => `${x},${z}`;
const equal = (a, b) => a[0] === b[0] && a[1] === b[1];
const distance = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
const DIRECTIONS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

function findPath(start, goal, occupied) {
  if (occupied.has(KEY(goal))) return null;
  const open = [{ cell: start, g: 0, f: distance(start, goal) }];
  const costs = new Map([[KEY(start), 0]]);
  const previous = new Map();
  while (open.length) {
    // Stable sorting makes equal-cost routes reproducible.
    open.sort((a, b) => a.f - b.f || a.g - b.g);
    const current = open.shift();
    const key = KEY(current.cell);
    if (current.g !== costs.get(key)) continue;
    if (equal(current.cell, goal)) {
      const path = [current.cell];
      let cursor = key;
      while (previous.has(cursor)) {
        const parent = previous.get(cursor);
        path.push(parent);
        cursor = KEY(parent);
      }
      return path.reverse();
    }
    for (const [dx, dz] of DIRECTIONS) {
      const next = [current.cell[0] + dx, current.cell[1] + dz];
      const nextKey = KEY(next);
      if (Math.abs(next[0]) > 14 || Math.abs(next[1]) > 11 || occupied.has(nextKey)) continue;
      const g = current.g + 1;
      if (g >= (costs.get(nextKey) ?? Infinity)) continue;
      costs.set(nextKey, g);
      previous.set(nextKey, current.cell);
      open.push({ cell: next, g, f: g + distance(next, goal) });
    }
  }
  return null;
}

function patternCells(pattern, count) {
  if (pattern === 'line') return Array.from({ length: count }, (_, i) => [i - Math.floor(count / 2), 0]);
  if (pattern === 'grid') {
    const columns = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / columns);
    return Array.from({ length: count }, (_, i) => [i % columns - Math.floor(columns / 2), Math.floor(i / columns) - Math.floor(rows / 2)]);
  }
  if (!['ring', 's'].includes(pattern)) return null;
  const cells = [];
  const used = new Set();
  for (let i = 0; i < count; i++) {
    const t = i / (pattern === 'ring' ? count : Math.max(1, count - 1));
    const radius = Math.max(2, Math.ceil(count / (2 * Math.PI)) + 1);
    const x = pattern === 'ring' ? radius * Math.cos(2 * Math.PI * t) : 3 * Math.sin(2 * Math.PI * t);
    const z = pattern === 'ring' ? radius * Math.sin(2 * Math.PI * t) : 5 - 10 * t;
    const candidates = [];
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const cell = [Math.round(x) + dx, Math.round(z) + dz];
      if (!used.has(KEY(cell))) candidates.push(cell);
    }
    candidates.sort((a, b) => (a[0] - x) ** 2 + (a[1] - z) ** 2 - (b[0] - x) ** 2 - (b[1] - z) ** 2);
    cells.push(candidates[0]);
    used.add(KEY(candidates[0]));
  }
  return cells;
}

export function createSwarm(count = 12, size = 0.08) {
  let modules = [];
  let targets = [];
  let actions = [];
  let actionIndex = 0;
  let totalDistance = 0;
  let travelled = 0;
  let moving = false;
  let finished = false;
  let status = 'Готов';
  let moduleSize;
  let spacing;
  const vector = ([x, z]) => new THREE.Vector3(x * spacing, moduleSize / 2 + 0.005, z * spacing);
  const cellOf = (module) => [Math.round(module.position.x / spacing), Math.round(module.position.z / spacing)];

  function reset(nextCount = modules.length || count, nextSize = moduleSize ?? size) {
    const n = Math.min(20, Math.max(3, Math.round(Number(nextCount) || 12)));
    moduleSize = Number.isFinite(nextSize) && nextSize > 0 ? nextSize : 0.08;
    spacing = moduleSize * 1.5;
    modules = patternCells('grid', n).map((cell, id) => ({ id, position: vector(cell), quaternion: new THREE.Quaternion() }));
    targets = modules.map((m) => ({ id: m.id, position: m.position.clone(), quaternion: m.quaternion.clone() }));
    actions = [];
    actionIndex = 0;
    totalDistance = travelled = 0;
    moving = finished = false;
    status = 'Готов';
  }

  function plan(pattern) {
    if (moving) return { ok: false, reason: 'Сначала завершите перестроение или нажмите сброс.', steps: 0 };
    const goals = patternCells(pattern, modules.length);
    if (!goals) return { ok: false, reason: 'Неизвестная форма.', steps: 0 };
    const cells = modules.map(cellOf);
    if (new Set(cells.map(KEY)).size !== modules.length || modules.some((m, i) => m.position.distanceTo(vector(cells[i])) > 1e-6)) {
      return { ok: false, reason: 'Начальные положения не соответствуют свободным узлам сетки. Нажмите сброс.', steps: 0 };
    }
    const proposedActions = [];
    const proposedTargets = new Array(modules.length);
    // Single-row perimeter parking leaves an approach from the inside or outside.
    const parking = Array.from({ length: modules.length }, (_, i) => [i % 10 - 5, i < 10 ? -8 : 8]);

    function assign(destinations, finalPhase) {
      const remaining = new Set(modules.map((_, i) => i));
      for (const goal of destinations) {
        const candidates = [...remaining].sort((a, b) => distance(cells[a], goal) - distance(cells[b], goal) || a - b);
        let selected = null;
        for (const index of candidates) {
          const occupied = new Set(cells.filter((_, i) => i !== index).map(KEY));
          const path = findPath(cells[index], goal, occupied);
          if (path) { selected = { index, path }; break; }
        }
        if (!selected) return false;
        remaining.delete(selected.index);
        cells[selected.index] = goal;
        if (selected.path.length > 1) proposedActions.push({ index: selected.index, path: selected.path.map(vector), cursor: 1 });
        if (finalPhase) proposedTargets[selected.index] = { id: selected.index, position: vector(goal), quaternion: new THREE.Quaternion() };
      }
      return true;
    }

    // Fill the interior first, so final grid cells cannot trap unfilled cells.
    const orderedGoals = [...goals].sort((a, b) => a[0] ** 2 + a[1] ** 2 - b[0] ** 2 - b[1] ** 2);
    if (!assign(parking, false) || !assign(orderedGoals, true)) {
      return { ok: false, reason: 'Не найден свободный маршрут в пределах площадки.', steps: 0 };
    }
    actions = proposedActions;
    targets = proposedTargets;
    actionIndex = 0;
    travelled = 0;
    const steps = actions.reduce((sum, action) => sum + action.path.length - 1, 0);
    totalDistance = steps * spacing;
    moving = actions.length > 0;
    finished = !moving;
    status = moving ? 'Перестроение: по одному модулю' : 'Форма готова';
    return { ok: true, steps };
  }

  function step(dt, speed = 1) {
    let budget = Number.isFinite(dt) && Number.isFinite(speed) ? Math.max(0, dt) * Math.max(0, speed) * 0.24 : 0;
    while (moving && budget > 1e-10) {
      const action = actions[actionIndex];
      const module = modules[action.index];
      const waypoint = action.path[action.cursor];
      const remaining = module.position.distanceTo(waypoint);
      const amount = Math.min(remaining, budget);
      if (remaining > 1e-10) module.position.lerp(waypoint, amount / remaining);
      budget -= amount;
      travelled += amount;
      if (remaining <= amount + 1e-10) {
        module.position.copy(waypoint);
        action.cursor++;
        if (action.cursor >= action.path.length) actionIndex++;
        if (actionIndex >= actions.length) {
          moving = false;
          finished = true;
          travelled = totalDistance;
          status = 'Форма готова';
        }
      }
    }
    return { moving, completed: finished };
  }

  reset(count, size);
  return {
    get modules() { return modules; },
    get targetModules() { return targets; },
    get progress() { return totalDistance > 0 ? Math.min(1, travelled / totalDistance) : finished ? 1 : 0; },
    get activeIndex() { return moving ? actions[actionIndex].index : null; },
    get status() { return status; },
    plan, step, reset,
  };
}
