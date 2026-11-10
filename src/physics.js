import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

// SI units. Rapier provides gravity, rigid contacts, friction and constraints.
// Propulsion is a bounded planar traction force, not a tire/suspension model.
// Chassis orientation remains physical: wheel contacts support the bodies;
// no translation or rotation is teleported or artificially locked.
const FIXED_DT = 1 / 60;
const DEG = Math.PI / 180;
let initialization;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const vec = (v) => new THREE.Vector3(v.x, v.y, v.z);
const quat = (q) => new THREE.Quaternion(q.x, q.y, q.z, q.w);
const wrapped = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const planarDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const finite = (v, fallback) => Number.isFinite(v) ? v : fallback;

function contains(rect, point) {
  return point.x > rect.minX && point.x < rect.maxX && point.z > rect.minZ && point.z < rect.maxZ;
}

function segmentClear(a, b, rectangles) {
  for (const rectangle of rectangles) {
    let lo = 0;
    let hi = 1;
    for (const [axis, minimum, maximum] of [['x', rectangle.minX, rectangle.maxX], ['z', rectangle.minZ, rectangle.maxZ]]) {
      const delta = b[axis] - a[axis];
      if (Math.abs(delta) < 1e-10) {
        if (a[axis] < minimum || a[axis] > maximum) { lo = 2; break; }
      } else {
        let t1 = (minimum - a[axis]) / delta;
        let t2 = (maximum - a[axis]) / delta;
        if (t1 > t2) [t1, t2] = [t2, t1];
        lo = Math.max(lo, t1);
        hi = Math.min(hi, t2);
      }
    }
    if (lo <= hi) return false;
  }
  return true;
}

function route(start, goal, rectangles) {
  if (rectangles.some((r) => contains(r, start) || contains(r, goal))) return null;
  if (segmentClear(start, goal, rectangles)) return [goal];
  const spacing = 0.12;
  const key = (x, z) => `${x},${z}`;
  // Grid is centered at the real start; connecting the first node is exact.
  const point = (x, z) => ({ x: start.x + x * spacing, z: start.z + z * spacing });
  const goalCell = [Math.round((goal.x - start.x) / spacing), Math.round((goal.z - start.z) / spacing)];
  const minX = Math.floor((Math.min(start.x, goal.x, ...rectangles.map((r) => r.minX)) - start.x - 1) / spacing);
  const maxX = Math.ceil((Math.max(start.x, goal.x, ...rectangles.map((r) => r.maxX)) - start.x + 1) / spacing);
  const minZ = Math.floor((Math.min(start.z, goal.z, ...rectangles.map((r) => r.minZ)) - start.z - 1) / spacing);
  const maxZ = Math.ceil((Math.max(start.z, goal.z, ...rectangles.map((r) => r.maxZ)) - start.z + 1) / spacing);
  if ((maxX - minX + 1) * (maxZ - minZ + 1) > 30000) return null;
  const heuristic = (x, z) => Math.abs(x - goalCell[0]) + Math.abs(z - goalCell[1]);
  const open = [{ x: 0, z: 0, g: 0, f: heuristic(0, 0) }];
  const best = new Map([[key(0, 0), 0]]);
  const parents = new Map();
  let found;
  let visited = 0;
  while (open.length && visited++ < 30000) {
    open.sort((a, b) => a.f - b.f || b.g - a.g);
    const current = open.shift();
    if (current.g !== best.get(key(current.x, current.z))) continue;
    const currentPoint = point(current.x, current.z);
    if (planarDistance(currentPoint, goal) <= spacing * 1.5 && segmentClear(currentPoint, goal, rectangles)) { found = current; break; }
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const x = current.x + dx;
      const z = current.z + dz;
      if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
      const nextPoint = point(x, z);
      if (!segmentClear(currentPoint, nextPoint, rectangles)) continue;
      const g = current.g + 1;
      if (g >= (best.get(key(x, z)) ?? Infinity)) continue;
      best.set(key(x, z), g);
      parents.set(key(x, z), [current.x, current.z]);
      open.push({ x, z, g, f: g + heuristic(x, z) });
    }
  }
  if (!found) return null;
  const points = [goal];
  let cursor = [found.x, found.z];
  while (cursor) {
    points.push(point(...cursor));
    cursor = parents.get(key(...cursor));
  }
  points.reverse();
  const smooth = [];
  let index = 0;
  while (index < points.length - 1) {
    let next = points.length - 1;
    while (next > index + 1 && !segmentClear(points[index], points[next], rectangles)) next--;
    smooth.push(points[next]);
    index = next;
  }
  return smooth;
}

export async function createSimulation(project) {
  initialization ??= RAPIER.init();
  await initialization;
  const world = new RAPIER.World({ x: 0, y: -Math.max(0, finite(project.settings?.gravity, 9.81)), z: 0 });
  world.timestep = FIXED_DT / 4;
  world.numSolverIterations = 12;
  world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.1, 50).setTranslation(0, -0.1, 0).setFriction(0.8));
  const entries = new Map();
  const joints = new Map();
  const adjacency = new Map();
  let disposed = false;
  let time = 0;
  let accumulator = 0;
  let status = 'idle';
  let message = 'Физическая модель готова';
  let active = null;
  let queue = [];
  let missionIndex = 0;
  let missionCount = 0;
  let maxSpeed = 0;
  let totalDistance = 0;
  let mechanicalWork = 0;
  let contacts = 0;
  let lastPositions = new Map();
  const speedLimit = clamp(finite(project.settings?.speed, 0.35), 0.03, 1.5);

  try {
    for (const object of project.objects ?? []) {
      if (!object.id || entries.has(object.id)) throw new Error('У объектов должны быть уникальные id.');
      const size = (object.size ?? [0.18, 0.14, 0.18]).map((v) => Math.max(0.01, finite(v, 0.1)));
      const position = object.position ?? [0, size[1] / 2 + 0.01, 0];
      const orientation = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(object.rotation ?? [0, 0, 0])));
      const fixed = Boolean(object.fixed) || object.type === 'obstacle';
      const description = (fixed ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic())
        .setTranslation(...position).setRotation(orientation).setLinearDamping(0.15).setAngularDamping(0.4).setCcdEnabled(true).setAdditionalSolverIterations(4);
      const body = world.createRigidBody(description);
      // Drive orientation is governed by gravity and wheel contacts.
      const mass = Math.max(0.01, finite(object.mass, 0.3));
      const collider = world.createCollider(RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2)
        .setDensity(mass / (size[0] * size[1] * size[2]))
        .setFriction(object.type === 'payload' ? 0.55 : object.type === 'obstacle' ? 0.6 : 0.04)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min).setRestitution(0), body);
      const colliders = [collider];
      if (object.type === 'drive') {
        // Spherical wheel contact approximation avoids cylinder-edge chatter.
        // Visual wheels are cylinders; tire deformation/rotation is not modeled.
        const wheelRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
        const radius = Math.min(0.025, size[0] / 5);
        for (const xSign of [-1, 1]) for (const zSign of [-1, 1]) {
          colliders.push(world.createCollider(RAPIER.ColliderDesc.ball(radius)
            .setTranslation(xSign * Math.max(0, size[0] / 2 - radius), -size[1] / 2 + radius - 0.02, zSign * size[2] / 2)
            .setRotation(wheelRotation).setDensity(0).setFriction(0.04)
            .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min), body));
        }
      }
      entries.set(object.id, { object, body, collider, colliders, size, mass, fixed });
      adjacency.set(object.id, new Set());
      lastPositions.set(object.id, vec(body.translation()));
    }
    for (const connection of project.connections ?? []) {
      const a = entries.get(connection.a);
      const b = entries.get(connection.b);
      if (!a || !b || a === b || joints.has(connection.id)) throw new Error('Некорректное соединение модулей.');
      adjacency.get(connection.a).add(connection.b);
      adjacency.get(connection.b).add(connection.a);
      const pA = vec(a.body.translation());
      const pB = vec(b.body.translation());
      const qA = quat(a.body.rotation());
      const qB = quat(b.body.rotation());
      const center = pA.clone().add(pB).multiplyScalar(0.5);
      const anchorA = center.clone().sub(pA).applyQuaternion(qA.clone().invert());
      const anchorB = center.clone().sub(pB).applyQuaternion(qB.clone().invert());
      // The saved axis belongs to body A's local frame. Whole-assembly editing
      // rotates that axis with the parent, preserving the articulation plane.
      const axis = (connection.axis === 'z' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0)).applyQuaternion(qA);
      const worldFrame = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), axis);
      const frameA = qA.clone().invert().multiply(worldFrame);
      const frameB = qB.clone().invert().multiply(worldFrame);
      const revolute = connection.type === 'revolute';
      const description = revolute
        ? RAPIER.JointData.revoluteWithAxes(anchorA, anchorB, axis.clone().applyQuaternion(qA.clone().invert()), axis.clone().applyQuaternion(qB.clone().invert()))
        : RAPIER.JointData.fixed(anchorA, frameA, anchorB, frameB);
      const joint = world.createImpulseJoint(description, a.body, b.body, true);
      joint.setLocalFrame1(anchorA, frameA);
      joint.setLocalFrame2(anchorB, frameB);
      // Adjacent articulated bodies must collide rather than fold through each other.
      joint.setContactsEnabled(revolute);
      const limit = clamp(finite(connection.limit, 85), 1, 175) * DEG;
      const entry = { connection, a, b, joint, frameA, frameB, revolute, limit, target: clamp(finite(connection.angle, 0) * DEG, -limit, limit), motorSetpoint: 0, integral: 0, stiffness: connection.axis === 'z' ? 1000 : 2, damping: connection.axis === 'z' ? 40 : 0.12 };
      if (revolute) {
        joint.setLimits(-limit, limit);
        joint.configureMotorModel(RAPIER.MotorModel.ForceBased);
        joint.setMotorMaxForce(connection.axis === 'z' ? 2 : 0.25);
        joint.configureMotorPosition(entry.motorSetpoint, entry.stiffness, entry.damping);
      }
      joints.set(connection.id, entry);
    }

  } catch (error) {
    world.free();
    throw error;
  }

  function jointAngle(entry) {
    const a = quat(entry.a.body.rotation()).multiply(entry.frameA);
    const b = quat(entry.b.body.rotation()).multiply(entry.frameB);
    const relative = a.invert().multiply(b).normalize();
    return wrapped(2 * Math.atan2(relative.x, relative.w));
  }

  function component(id) {
    if (!entries.has(id)) return [];
    const ids = new Set([id]);
    const pending = [id];
    while (pending.length) for (const next of adjacency.get(pending.pop())) if (!ids.has(next)) { ids.add(next); pending.push(next); }
    return [...ids].map((i) => entries.get(i));
  }

  function yaw(body) {
    const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(quat(body.rotation()));
    return Math.atan2(-forward.z, forward.x);
  }

  function fail(reason) {
    status = 'failed';
    message = reason;
    active = null;
    queue = [];
    holdJoints();
  }

  function holdJoints() {
    for (const entry of joints.values()) if (entry.revolute) {
      entry.target = clamp(jointAngle(entry), -entry.limit, entry.limit);
      entry.motorSetpoint = entry.target;
      entry.integral = 0;
      entry.joint.configureMotorPosition(entry.motorSetpoint, entry.stiffness, entry.damping);
    }
  }

  function obstacleBounds(group, anchor) {
    const ids = new Set(group.map((e) => e.object.id));
    const position = anchor.body.translation();
    const radius = Math.max(...group.map((e) => planarDistance(e.body.translation(), position) + Math.hypot(e.size[0], e.size[2]) / 2)) + 0.045;
    return [...entries.values()].filter((e) => !ids.has(e.object.id)).map((e) => {
      const p = e.body.translation();
      const matrix = new THREE.Matrix4().makeRotationFromQuaternion(quat(e.body.rotation())).elements;
      const extentX = (Math.abs(matrix[0]) * e.size[0] + Math.abs(matrix[4]) * e.size[1] + Math.abs(matrix[8]) * e.size[2]) / 2;
      const extentZ = (Math.abs(matrix[2]) * e.size[0] + Math.abs(matrix[6]) * e.size[1] + Math.abs(matrix[10]) * e.size[2]) / 2;
      return { minX: p.x - extentX - radius, maxX: p.x + extentX + radius, minZ: p.z - extentZ - radius, maxZ: p.z + extentZ + radius };
    });
  }

  function beginNext() {
    if (!queue.length) { status = 'completed'; active = null; missionIndex = missionCount; message = 'Задание выполнено'; return; }
    const mission = queue.shift();
    missionIndex = missionCount - queue.length - 1;
    const type = mission.type ?? mission.action;
    active = { mission: { ...mission, type }, elapsed: 0, stable: 0, stall: 0, lastMetric: Infinity, lastProgressTime: 0 };
    status = 'running';
    if (type === 'wait') {
      active.seconds = clamp(finite(mission.seconds, 1), 0, 3600);
      message = 'Ожидание';
      return;
    }
    if (type === 'joint') {
      const entry = joints.get(mission.connectionId);
      if (!entry?.revolute || !Number.isFinite(mission.angle)) { fail('Не найден управляемый шарнир или не задан угол.'); return; }
      const target = mission.angle * DEG;
      if (Math.abs(target) > entry.limit + 1e-7) { fail('Запрошенный угол превышает предел шарнира.'); return; }
      entry.target = target;
      entry.a.body.wakeUp();
      entry.b.body.wakeUp();
      active.entry = entry;
      message = 'Изменение формы';
      return;
    }
    if (!['move', 'turn'].includes(type)) { fail('Неизвестный тип задания.'); return; }
    const anchor = entries.get(mission.objectId);
    const group = component(mission.objectId);
    const drives = group.filter((entry) => entry.object.type === 'drive' && !entry.fixed);
    if (!anchor || !drives.length) { fail('Для движения нужен соединённый приводной модуль.'); return; }
    if (group.some((entry) => entry.fixed)) { fail('Конструкция закреплена и не может перемещаться.'); return; }
    Object.assign(active, { anchor, group, drives, mass: group.reduce((sum, entry) => sum + entry.mass, 0) });
    if (type === 'turn') {
      if (!Number.isFinite(mission.angle)) { fail('Не задан угол поворота.'); return; }
      active.targetTurn = mission.angle * DEG;
      active.lastYaw = yaw(anchor.body);
      active.turned = 0;
      message = 'Поворот конструкции';
    } else {
      if (!Number.isFinite(mission.x) || !Number.isFinite(mission.z)) { fail('Не задана конечная позиция.'); return; }
      const goal = { x: mission.x, z: mission.z };
      const obstacles = obstacleBounds(group, anchor);
      active.waypoints = route(anchor.body.translation(), goal, obstacles);
      if (!active.waypoints) { fail('Нет безопасного маршрута с учётом габаритов конструкции.'); return; }
      active.waypointIndex = 0;
      active.goal = goal;
      active.holdYaw = yaw(anchor.body);
      message = active.waypoints.length > 1 ? 'Обход препятствия' : 'Движение к цели';
    }
  }

  function applyDrive(group, drives, desired, targetYaw, totalMass, referenceBody = drives[0].body) {
    const average = new THREE.Vector3();
    for (const entry of group) average.addScaledVector(vec(entry.body.linvel()), entry.mass / totalMass);
    const acceleration = new THREE.Vector3(desired.x - average.x, 0, desired.z - average.z).multiplyScalar(10);
    if (acceleration.length() > 3.5) acceleration.setLength(3.5);
    const force = acceleration.multiplyScalar(totalMass / drives.length);
    for (const entry of drives) {
      // Force is only generated by drive bodies. Constraints carry the other bodies.
      entry.body.addForce(force, true);
      mechanicalWork += Math.max(0, force.dot(vec(entry.body.linvel()))) * FIXED_DT;
      if (targetYaw !== null) {
        const error = wrapped(targetYaw - yaw(referenceBody));
        const angularVelocity = entry.body.angvel().y;
        const desiredAngularSpeed = clamp(error * 4, -1.2, 1.2);
        const torque = clamp((desiredAngularSpeed - angularVelocity) * totalMass * 0.4, -totalMass * 0.15, totalMass * 0.15) / drives.length;
        entry.body.addTorque({ x: 0, y: torque, z: 0 }, true);
        mechanicalWork += Math.max(0, torque * angularVelocity) * FIXED_DT;
      }
    }
  }

  function brakes() {
    for (const entry of entries.values()) if (entry.object.type === 'drive' && !entry.fixed) {
      const velocity = entry.body.linvel();
      const force = new THREE.Vector3(-velocity.x, 0, -velocity.z).multiplyScalar(entry.mass * 12);
      if (force.length() > entry.mass * 4) force.setLength(entry.mass * 4);
      entry.body.addForce(force, true);
      entry.body.addTorque({ x: 0, y: -entry.body.angvel().y * entry.mass * 0.3, z: 0 }, true);
    }
  }

  function control() {
    for (const entry of entries.values()) if (!entry.fixed) { entry.body.resetForces(false); entry.body.resetTorques(false); }
    if (status !== 'running' || !active) { brakes(); return; }
    active.elapsed += FIXED_DT;
    const type = active.mission.type;
    if (type !== 'wait' && active.elapsed > 30) { fail('Задание остановлено: превышено время выполнения.'); brakes(); return; }
    if (type === 'wait') {
      brakes();
      if (active.elapsed >= active.seconds) beginNext();
      return;
    }
    if (type === 'joint') {
      brakes();
      const error = Math.abs(wrapped(active.entry.target - jointAngle(active.entry)));
      active.stable = error < 2 * DEG ? active.stable + FIXED_DT : 0;
      if (active.stable > 0.35) { beginNext(); return; }
      if (error < active.lastMetric - 0.008) { active.lastMetric = error; active.lastProgressTime = active.elapsed; }
      if (active.elapsed - active.lastProgressTime > 3.5) fail('Шарнир не достиг угла: движение заблокировано или не хватает момента.');
      return;
    }
    const velocity = active.anchor.body.linvel();
    const planarSpeed = Math.hypot(velocity.x, velocity.z);
    if (type === 'turn') {
      const currentYaw = yaw(active.anchor.body);
      active.turned += wrapped(currentYaw - active.lastYaw);
      active.lastYaw = currentYaw;
      const remaining = active.targetTurn - active.turned;
      const error = Math.abs(remaining);
      const targetYaw = currentYaw + clamp(remaining, -Math.PI / 2, Math.PI / 2);
      applyDrive(active.group, active.drives, { x: 0, z: 0 }, targetYaw, active.mass, active.anchor.body);
      active.stable = error < 3 * DEG && Math.abs(active.anchor.body.angvel().y) < 0.12 ? active.stable + FIXED_DT : 0;
      if (active.stable > 0.3) { beginNext(); return; }
      if (error < active.lastMetric - 0.01) { active.lastMetric = error; active.lastProgressTime = active.elapsed; }
    } else {
      const position = active.anchor.body.translation();
      let waypoint = active.waypoints[active.waypointIndex];
      let remaining = planarDistance(position, waypoint);
      if (remaining < 0.045 && active.waypointIndex < active.waypoints.length - 1) {
        waypoint = active.waypoints[++active.waypointIndex];
        remaining = planarDistance(position, waypoint);
        active.lastMetric = Infinity;
        active.lastProgressTime = active.elapsed;
      }
      const finalDistance = planarDistance(position, active.goal);
      const finalLeg = active.waypointIndex === active.waypoints.length - 1;
      const desiredSpeed = Math.min(speedLimit, remaining * 2.5);
      const desired = remaining > 1e-7 ? { x: (waypoint.x - position.x) / remaining * desiredSpeed, z: (waypoint.z - position.z) / remaining * desiredSpeed } : { x: 0, z: 0 };
      // Ideal omni-traction preserves the starting heading during translation;
      // it does not claim a physically detailed differential-wheel model.
      applyDrive(active.group, active.drives, desired, active.holdYaw, active.mass, active.anchor.body);
      active.stable = finalLeg && finalDistance < 0.035 && planarSpeed < 0.065 ? active.stable + FIXED_DT : 0;
      if (active.stable > 0.25) { beginNext(); return; }
      if (remaining < active.lastMetric - 0.008) { active.lastMetric = remaining; active.lastProgressTime = active.elapsed; }
    }
    if (active && active.elapsed - active.lastProgressTime > 3.5) fail('Движение остановлено: конструкция застряла.');
  }

  function updateMetrics() {
    const pairs = new Set();
    for (const [id, entry] of entries) {
      const p = vec(entry.body.translation());
      const previous = lastPositions.get(id);
      totalDistance += p.distanceTo(previous);
      lastPositions.set(id, p);
      maxSpeed = Math.max(maxSpeed, vec(entry.body.linvel()).length());
      for (const collider of entry.colliders) world.contactPairsWith(collider, (other) => {
        let touching = false;
        world.contactPair(collider, other, (manifold) => {
          for (let i = 0; i < manifold.numContacts(); i++) if (manifold.contactDist(i) <= 0.003) touching = true;
        });
        if (touching) pairs.add([collider.handle, other.handle].sort((a, b) => a - b).join(':'));
      });
    }
    contacts = pairs.size;
  }

  function updateMotors() {
    for (const entry of joints.values()) if (entry.revolute) {
      const error = wrapped(entry.target - jointAngle(entry));
      // A bounded outer feedback loop compensates gravity/friction using the
      // measured angle. It changes native motor commands, never body poses.
      if (entry.connection.axis === 'z' && Math.abs(error) < 0.2) entry.integral = clamp(entry.integral + error * FIXED_DT * 1.8, -0.15, 0.15);
      const desired = clamp(entry.target + entry.integral, -entry.limit, entry.limit);
      entry.motorSetpoint += clamp(desired - entry.motorSetpoint, -0.9 * FIXED_DT, 0.9 * FIXED_DT);
      entry.joint.configureMotorPosition(entry.motorSetpoint, entry.stiffness, entry.damping);
      if (Math.abs(error) > 0.005) { entry.a.body.wakeUp(); entry.b.body.wakeUp(); }
    }
  }

  function snapshot() {
    if (disposed) throw new Error('Симуляция уже освобождена.');
    return {
      objects: [...entries].map(([id, entry]) => {
        const p = entry.body.translation();
        const q = entry.body.rotation();
        const velocity = entry.body.linvel();
        return { id, position: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w], velocity: [velocity.x, velocity.y, velocity.z] };
      }),
      time, status, message, missionIndex, missionCount, activeMission: active ? { ...active.mission } : null,
      metrics: { maxSpeed, contacts, energy: mechanicalWork, distance: totalDistance },
      jointAngles: Object.fromEntries([...joints].filter(([, entry]) => entry.revolute).map(([id, entry]) => [id, jointAngle(entry) / DEG])),
    };
  }

  function execute(mission) {
    if (disposed) throw new Error('Симуляция уже освобождена.');
    queue = (Array.isArray(mission) ? mission : [mission]).filter(Boolean).map((item) => ({ ...item }));
    missionCount = queue.length;
    missionIndex = 0;
    if (!queue.length) { fail('Не задана команда.'); return snapshot(); }
    active = null;
    beginNext();
    return snapshot();
  }

  function stop() {
    if (disposed) return;
    active = null;
    queue = [];
    status = 'idle';
    message = 'Команда остановлена; физика продолжает работать';
    holdJoints();
    for (const entry of entries.values()) if (!entry.fixed) { entry.body.resetForces(false); entry.body.resetTorques(false); }
    return snapshot();
  }

  function step(dt) {
    if (disposed) throw new Error('Симуляция уже освобождена.');
    accumulator += clamp(finite(dt, 0), 0, 0.25);
    while (accumulator + 1e-10 >= FIXED_DT) {
      control();
      updateMotors();
      // Fixed 60 Hz control with four solver substeps for small, stiff joints.
      for (let substep = 0; substep < 4; substep++) {
        world.step();
        for (const entry of entries.values()) maxSpeed = Math.max(maxSpeed, vec(entry.body.linvel()).length());
      }
      time += FIXED_DT;
      accumulator -= FIXED_DT;
      updateMetrics();
      if ([...entries.values()].some((entry) => !Number.isFinite(entry.body.translation().y) || entry.body.translation().y < -3)) fail('Физическая модель стала неустойчивой.');
    }
    return snapshot();
  }

  return { step, execute, stop, snapshot, dispose() { if (!disposed) { disposed = true; world.free(); } } };
}
