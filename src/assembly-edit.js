import { Euler, Quaternion, Vector3 } from 'three';
import { cloneProject, connectedIds, updateObject, validateProject } from './project.js';

const validVector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const quaternion = rotation => new Quaternion().setFromEuler(new Euler(...rotation, 'XYZ'));

/**
 * Edit-time rigid transformation of a connected component about a selected part.
 * This changes the assembled starting pose, not the joints' relative angles.
 * Fixed bases can be repositioned in the editor; they remain fixed in simulation.
 * Angles here are Euler XYZ radians, unlike joint mission angles in degrees.
 */
export function transformAssembly(project, id, patch, { wholeAssembly = true } = {}) {
  if (!wholeAssembly) return updateObject(project, id, patch);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Изменение положения должно быть объектом');
  if (Object.keys(patch).some(key => !['position', 'rotation'].includes(key))) throw new Error('Для всей сборки можно менять только положение и поворот');
  const selected = project.objects.find(object => object.id === id);
  if (!selected) throw new Error(`Деталь ${id} не найдена`);
  const position = patch.position ?? selected.position;
  const rotation = patch.rotation ?? selected.rotation;
  if (!validVector(position) || !validVector(rotation)) throw new Error('Положение и поворот должны содержать по три конечных числа');
  // Explicit null is malformed rather than an instruction to retain old values.
  if (('position' in patch && !validVector(patch.position)) || ('rotation' in patch && !validVector(patch.rotation))) throw new Error('Некорректное положение или поворот');

  const next = cloneProject(project);
  const ids = new Set(connectedIds(project, id));
  const origin = new Vector3(...selected.position);
  const destination = new Vector3(...position);
  const delta = quaternion(rotation).multiply(quaternion(selected.rotation).invert()).normalize();
  const hasRotation = patch.rotation !== undefined;
  for (const object of next.objects) {
    if (!ids.has(object.id)) continue;
    object.position = new Vector3(...object.position).sub(origin).applyQuaternion(delta).add(destination).toArray();
    if (hasRotation) {
      const q = delta.clone().multiply(quaternion(object.rotation)).normalize();
      const euler = new Euler().setFromQuaternion(q, 'XYZ');
      object.rotation = [euler.x, euler.y, euler.z];
    }
    if (object.id === id) {
      object.position = [...position];
      object.rotation = [...rotation];
    }
  }
  const validation = validateProject(next);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return next;
}
