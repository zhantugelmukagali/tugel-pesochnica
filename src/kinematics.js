import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { OBB } from 'three/addons/math/OBB.js';

export const DEFAULT_CONFIG = Object.freeze({
  count: 12, size: 0.08, gap: 0.04, mass: 0.06,
  maxAngle: 85, torqueLimit: 0.25, axes: 'spatial',
});

const GRAVITY = 9.81;
const EPSILON = 1e-7;
const DEG = Math.PI / 180;

function configuration(input = {}) {
  const c = { ...DEFAULT_CONFIG, ...input };
  if (!Number.isInteger(c.count) || c.count < 1 || c.count > 100) throw new RangeError('count must be an integer from 1 to 100');
  for (const key of ['size', 'gap', 'mass', 'maxAngle', 'torqueLimit']) {
    if (!Number.isFinite(c[key]) || c[key] < 0) throw new RangeError(`${key} must be a finite nonnegative number`);
  }
  if (c.size === 0 || c.maxAngle === 0 || c.maxAngle > 180) throw new RangeError('size must be positive and maxAngle must be in (0, 180]');
  if (!['planar', 'spatial'].includes(c.axes)) throw new RangeError('axes must be planar or spatial');
  return c;
}

function checkAngles(angles, count) {
  if (!Array.isArray(angles) || angles.length !== count - 1 || angles.some(a => !Number.isFinite(a))) {
    throw new RangeError(`Expected ${count - 1} finite joint angles in degrees`);
  }
}

/**
 * Serial chain, metres/kg/degrees. Module zero is fixed; Y is up.
 * Every hinge has two rigid half-pitch arms. Positive local Z pitch raises +X.
 * Collision geometry covers cube bodies, not hinge arms, cables or motors.
 * Torque is only gravity projected onto each actuated axis: no dynamics,
 * friction, ground-contact reactions or structural strength calculation.
 */
export function computeChain(anglesDegrees, input = {}) {
  const config = configuration(input);
  checkAngles(anglesDegrees, config.count);
  const halfPitch = (config.size + config.gap) / 2;
  const modules = [{ position: new Vector3(0, config.size / 2 + 0.005, 0), quaternion: new Quaternion() }];
  const joints = [];
  for (let i = 0; i < anglesDegrees.length; i++) {
    const parent = modules[i];
    const localAxis = config.axes === 'spatial' && i % 2 === 1 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
    const position = new Vector3(halfPitch, 0, 0).applyQuaternion(parent.quaternion).add(parent.position);
    const quaternion = parent.quaternion.clone().multiply(new Quaternion().setFromAxisAngle(localAxis, anglesDegrees[i] * DEG)).normalize();
    const childPosition = new Vector3(halfPitch, 0, 0).applyQuaternion(quaternion).add(position);
    joints.push({ position, axis: localAxis.applyQuaternion(parent.quaternion), angle: anglesDegrees[i], torque: 0 });
    modules.push({ position: childPosition, quaternion });
  }

  let height = 0;
  const floorCollisions = [];
  const boxes = modules.map((module, index) => {
    let lowest = Infinity;
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
      const corner = new Vector3(x, y, z).multiplyScalar(config.size / 2).applyQuaternion(module.quaternion).add(module.position);
      lowest = Math.min(lowest, corner.y);
      height = Math.max(height, corner.y);
    }
    if (lowest < -EPSILON) floorCollisions.push(index);
    // Shrink by a tiny tolerance so exact surface contact is not penetration.
    const halfSize = new Vector3().setScalar(Math.max(config.size / 2 - EPSILON, config.size / 4));
    const rotation = new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(module.quaternion));
    return new OBB(module.position.clone(), halfSize, rotation);
  });
  const collisions = [];
  for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
    // Adjacent modules are intentionally checked as well: small gaps can clash.
    if (boxes[a].intersectsOBB(boxes[b], 1e-10)) collisions.push({ a, b });
  }

  let maxTorque = 0;
  for (let i = 0; i < joints.length; i++) {
    const moment = new Vector3();
    for (let j = i + 1; j < modules.length; j++) {
      const arm = modules[j].position.clone().sub(joints[i].position);
      moment.add(arm.cross(new Vector3(0, -config.mass * GRAVITY, 0)));
    }
    joints[i].torque = Math.abs(moment.dot(joints[i].axis));
    maxTorque = Math.max(maxTorque, joints[i].torque);
  }
  return {
    modules, joints, collisions, floorCollisions, maxTorque,
    reach: modules.at(-1).position.distanceTo(modules[0].position),
    height, totalMass: config.count * config.mass,
    warnings: maxTorque > config.torqueLimit + EPSILON ? ['torque-limit'] : [],
  };
}

/** Presets are geometric targets, not promises of load capacity or safe transitions. */
export function presetAngles(name, input = {}) {
  const c = configuration(input);
  const length = c.count - 1;
  const angles = Array(length).fill(0);
  const yawIndices = angles.map((_, i) => i).filter(i => c.axes === 'planar' || i % 2 === 0);
  const pitchIndices = angles.map((_, i) => i).filter(i => c.axes === 'spatial' && i % 2 === 1);
  const clamp = value => Math.max(-c.maxAngle, Math.min(c.maxAngle, value));
  const setYaw = (fn) => yawIndices.forEach((index, order) => { angles[index] = clamp(fn(order, yawIndices.length)); });
  switch (name) {
    case 'line': break;
    case 'arc': setYaw((_, n) => 140 / Math.max(1, n)); break;
    case 's': setYaw((i, n) => 35 * Math.sin((i + 0.5) / n * Math.PI * 2)); break;
    case 'wave': setYaw((i, n) => 28 * Math.sin((i + 0.5) / n * Math.PI * 4)); break;
    case 'arch': {
      if (!pitchIndices.length) {
        setYaw((_, n) => 140 / Math.max(1, n));
        break;
      }
      // Raise the chain, then flatten it; cumulative pitch never becomes negative.
      // Unlike a closed arch, this open bridge does not imply a second support.
      const rise = Math.min(c.maxAngle, 50);
      angles[pitchIndices[0]] = rise;
      if (pitchIndices.length > 1) {
        const remaining = pitchIndices.length - 1;
        pitchIndices.slice(1).forEach(index => { angles[index] = -rise / remaining; });
      }
      break;
    }
    case 'spring': {
      setYaw((_, n) => Math.min(38, 200 / Math.max(1, n)));
      // Modest positive pitch gives a lifted spatial curve, not a real spring.
      pitchIndices.forEach((index, i) => { angles[index] = clamp(i === 0 ? 30 : 4); });
      break;
    }
    default: throw new RangeError(`Unknown preset: ${name}`);
  }
  return angles;
}

/**
 * Conservative sampled validation of a straight interpolation in joint space.
 * At most 2 degrees per joint between samples; NOT continuous collision proof.
 * `at` is interpolation fraction 0..1. Zero gravity torque in planar mode does
 * not imply that motors need no torque; friction is outside this model.
 */
export function validateTransition(from, to, input = {}) {
  let c;
  try {
    c = configuration(input);
    checkAngles(from, c.count);
    checkAngles(to, c.count);
  } catch (error) {
    return { ok: false, reason: 'invalid-input', at: 0, report: null, message: error.message };
  }
  const violation = values => values.some(a => Math.abs(a) > c.maxAngle + EPSILON);
  if (violation(from)) return { ok: false, reason: 'angle-limit', at: 0, report: computeChain(from, c) };
  if (violation(to)) return { ok: false, reason: 'angle-limit', at: 1, report: computeChain(to, c) };
  const steps = Math.max(1, Math.ceil(Math.max(0, ...from.map((value, i) => Math.abs(to[i] - value))) / 2));
  let report;
  for (let step = 0; step <= steps; step++) {
    const at = step / steps;
    report = computeChain(from.map((value, i) => value + (to[i] - value) * at), c);
    if (report.floorCollisions.length) return { ok: false, reason: 'floor', at, report };
    if (report.collisions.length) return { ok: false, reason: 'collision', at, report };
  }
  return { ok: true, reason: null, at: 1, report };
}
