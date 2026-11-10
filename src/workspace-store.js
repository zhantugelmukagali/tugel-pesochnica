import { validateProject } from './project.js';

export const WORKSPACE_STORAGE_KEY = 'tugel-workspace-v2';
const MAX_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

/** Reject non-JSON data and dangerous object keys before cloning or validation. */
function inspectData(value) {
  const stack = [{ value, depth: 0 }];
  const ancestors = new Set();
  let nodes = 0;
  while (stack.length) {
    const { value: item, depth, leave } = stack.pop();
    if (leave) { ancestors.delete(item); continue; }
    if (++nodes > 30000 || depth > 64) throw new Error('Структура проекта слишком сложная.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue;
    if (typeof item === 'number' && Number.isFinite(item)) continue;
    if (typeof item !== 'object') throw new Error('Проект должен содержать только конечные числа и JSON-данные.');
    if (ancestors.has(item)) throw new Error('Проект содержит циклическую ссылку.');
    ancestors.add(item);
    stack.push({ value: item, depth, leave: true });
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
      throw new Error('Проект содержит неподдерживаемый объект.');
    }
    if (Array.isArray(item) && Object.keys(item).length !== item.length) throw new Error('Проект содержит неполный массив.');
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) {
        throw new Error('Проект содержит недопустимое имя свойства.');
      }
      if (Array.isArray(item) && !/^(0|[1-9]\d*)$/.test(key)) throw new Error('Проект содержит неподдерживаемое свойство массива.');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) {
        throw new Error('Проект содержит неподдерживаемое свойство.');
      }
      stack.push({ value: descriptor.value, depth: depth + 1 });
    }
  }
}

function requireV2(project) {
  if (project?.version === 1) {
    throw new Error('Сцена версии 1 не поддерживается конструктором v2. Создай новый проект; исходный файл останется без изменений.');
  }
  if (project?.version !== 2) throw new Error('Ожидается проект TUGEL версии 2.');
}

function serialize(project, formatted = false) {
  inspectData(project);
  requireV2(project);
  const validation = validateProject(project);
  if (!validation.ok) {
    const details = validation.errors.slice(0, 5).join('; ');
    throw new Error(`Некорректный проект: ${details || 'проверь структуру файла'}`);
  }
  const text = JSON.stringify(project, null, formatted ? 2 : undefined);
  if (encoder.encode(text).byteLength > MAX_BYTES) throw new Error('Файл проекта превышает 1 МБ.');
  return text;
}

function snapshot(project) {
  return JSON.parse(serialize(project));
}

/** A branchable snapshot history. max is the number of available undo steps. */
export function createHistory(initial, max = 60) {
  if (!Number.isInteger(max) || max < 1 || max > 200) throw new RangeError('Размер истории должен быть целым числом от 1 до 200.');
  let entries = [{ project: snapshot(initial), label: 'Начальное состояние' }];
  let cursor = 0;
  return {
    get current() { return structuredClone(entries[cursor].project); },
    get canUndo() { return cursor > 0; },
    get canRedo() { return cursor < entries.length - 1; },
    get lastLabel() { return entries[cursor].label; },
    commit(next, label = 'Изменение') {
      if (typeof label !== 'string' || label.length > 200) throw new Error('Название изменения должно быть строкой до 200 символов.');
      const project = snapshot(next); // Validate before changing cursor or redo history.
      entries = entries.slice(0, cursor + 1);
      entries.push({ project, label: label.trim() || 'Изменение' });
      if (entries.length > max + 1) entries.shift();
      cursor = entries.length - 1;
      return structuredClone(project);
    },
    undo() {
      if (cursor > 0) cursor--;
      return structuredClone(entries[cursor].project);
    },
    redo() {
      if (cursor < entries.length - 1) cursor++;
      return structuredClone(entries[cursor].project);
    },
  };
}

export function exportProject(project) {
  return serialize(project, true);
}

export function importProject(text) {
  if (typeof text !== 'string') throw new Error('Для импорта нужен текст JSON-файла.');
  if (encoder.encode(text).byteLength > MAX_BYTES) throw new Error('Файл проекта превышает 1 МБ.');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('Не удалось прочитать JSON. Проверь, что выбран файл проекта TUGEL.'); }
  return snapshot(parsed);
}

export function saveWorkspace(project, storage = globalThis.localStorage) {
  const text = serialize(project);
  if (!storage || typeof storage.setItem !== 'function') throw new Error('Локальное сохранение недоступно. Используй экспорт JSON.');
  try { storage.setItem(WORKSPACE_STORAGE_KEY, text); }
  catch { throw new Error('Не удалось сохранить проект в браузере. Возможно, хранилище заполнено или заблокировано. Используй экспорт JSON.'); }
  return true;
}

export function loadWorkspace(storage = globalThis.localStorage) {
  if (!storage || typeof storage.getItem !== 'function') throw new Error('Локальное хранилище недоступно. Используй импорт JSON.');
  let text;
  try { text = storage.getItem(WORKSPACE_STORAGE_KEY); }
  catch { throw new Error('Не удалось прочитать сохранённый проект. Используй импорт JSON.'); }
  if (text === null) return null;
  return importProject(text);
}
