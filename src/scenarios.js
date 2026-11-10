import { createProject } from './project.js';

/** Checked demonstrations using actual contacts, joint motors and drive forces. */
export function withScenario(template = 'rover') {
  const project = createProject(template);
  const joint = (connection, angle, name) => ({ type: 'joint', connectionId: `connection-${connection}`, angle, name });
  const move = { type: 'move', objectId: 'drive-1', x: 0.45, z: -0.25, name: 'Переместиться в свободную зону' };
  const missions = template === 'rover' ? [
    joint(1, 25, 'Согнуть корпус'),
    { type: 'wait', seconds: 0.6, name: 'Показать новую форму' },
    joint(1, 0, 'Выпрямить корпус'),
    move,
    { type: 'turn', objectId: 'drive-1', angle: 90, name: 'Повернуть на 90°' },
  ] : template === 'arm' ? [
    joint(1, 40, 'Поднять плечо'),
    joint(2, -25, 'Согнуть локоть'),
    joint(3, 15, 'Повернуть наконечник'),
    { type: 'wait', seconds: 0.8, name: 'Удерживать конфигурацию' },
    joint(3, 0, 'Вернуть наконечник'),
    joint(2, 0, 'Выпрямить локоть'),
    joint(1, 0, 'Опустить плечо'),
  ] : template === 'platform' ? [
    joint(2, 25, 'Поднять левое крыло'),
    joint(3, 25, 'Поднять правое крыло'),
    { type: 'wait', seconds: 0.6, name: 'Показать складную форму' },
    joint(2, 0, 'Опустить левое крыло'),
    joint(3, 0, 'Опустить правое крыло'),
    move,
  ] : [];
  project.missions = missions.map((mission, i) => ({ id: `mission-${i + 1}`, ...mission }));
  return project;
}
