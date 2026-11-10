import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const LIME = 0xb7ef62;
const SAND = 0xc4bda8;
const RED = 0xf46b57;

/** The renderer owns only its canvas, controls and animation loop. Positions are metres. */
export function createScene(container, { onSelect = () => {} } = {}) {
  if (!container) throw new Error('TUGEL: a viewport element is required.');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  } catch (error) {
    throw new Error('Для 3D-сцены необходим WebGL. Включите аппаратное ускорение браузера и обновите страницу.', { cause: error });
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;outline:none;touch-action:none;';
  renderer.domElement.setAttribute('aria-label', 'Интерактивная 3D-модель TUGEL. Перетаскивайте для вращения, нажмите на модуль для выбора.');
  renderer.domElement.tabIndex = 0;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x131b18);
  scene.fog = new THREE.Fog(0x131b18, 3.2, 9);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.005, 40);
  camera.position.set(0.6, 0.48, 0.75);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.minDistance = 0.09;
  controls.maxDistance = 8;
  controls.maxPolarAngle = Math.PI * 0.485;
  controls.autoRotateSpeed = 0.45;
  controls.target.set(0, 0, 0);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04);
  scene.environment = environment.texture;
  room.dispose();
  pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xecf2e4, 0x263329, 1.6));
  const key = new THREE.DirectionalLight(0xfff4dc, 3.3);
  key.position.set(-0.7, 1.8, 0.8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.00012;
  key.shadow.normalBias = 0.002;
  key.shadow.radius = 3;
  Object.assign(key.shadow.camera, { left: -1.1, right: 1.1, top: 1.1, bottom: -1.1, near: 0.05, far: 8 });
  scene.add(key, key.target);
  const rim = new THREE.DirectionalLight(0xbad8cf, 2.4);
  rim.position.set(1, 0.7, -1);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0xffffff, 0.7);
  fill.position.set(-1, 0.2, -0.5);
  scene.add(fill);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.MeshStandardMaterial({ color: 0x18221d, roughness: 0.93, metalness: 0.08 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.position.y = 0;
  scene.add(floor);

  const grid = new THREE.Group();
  const minorGrid = new THREE.GridHelper(4, 80, 0x4e6251, 0x36483a);
  minorGrid.material.transparent = true;
  minorGrid.material.opacity = 0.26;
  minorGrid.material.depthWrite = false;
  const majorGrid = new THREE.GridHelper(4, 20, 0x627360, 0x455544);
  majorGrid.material.transparent = true;
  majorGrid.material.opacity = 0.22;
  majorGrid.material.depthWrite = false;
  grid.add(minorGrid, majorGrid);
  grid.position.y = floor.position.y + 0.0003;
  scene.add(grid);

  const moduleRoot = new THREE.Group();
  const ghostRoot = new THREE.Group();
  const jointRoot = new THREE.Group();
  scene.add(moduleRoot, ghostRoot, jointRoot);
  const graphite = new THREE.MeshStandardMaterial({ color: 0x343c36, metalness: 0.65, roughness: 0.38 });
  const screwMaterial = new THREE.MeshStandardMaterial({ color: 0x626960, metalness: 0.9, roughness: 0.28 });
  const insetMaterial = new THREE.MeshStandardMaterial({ color: 0x9a9b89, metalness: 0.55, roughness: 0.5 });
  const jointMaterial = new THREE.MeshStandardMaterial({ color: 0x737e6d, metalness: 0.7, roughness: 0.34 });
  const ringMaterial = new THREE.MeshStandardMaterial({ color: LIME, metalness: 0.25, roughness: 0.4, emissive: LIME, emissiveIntensity: 0.08 });
  const ghostMaterial = new THREE.LineBasicMaterial({ color: LIME, transparent: true, opacity: 0.25, depthWrite: false });
  const sharedMaterials = [graphite, screwMaterial, insetMaterial, jointMaterial, ringMaterial, ghostMaterial];

  let disposed = false;
  let animationFrame;
  let size = 0.08;
  let geometries = null;
  let modules = [];
  let currentView = 'iso';
  let selected = 0;
  let hovered = -1;
  let lastModules = [];
  let labelsVisible = true;
  let collisionSet = new Set();
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerStart = null;
  const clock = new THREE.Clock();
  const yAxis = new THREE.Vector3(0, 1, 0);

  function disposeGeometries() {
    if (geometries) Object.values(geometries).forEach((geometry) => geometry.dispose());
  }

  function makeGeometries() {
    disposeGeometries();
    geometries = {
      body: new RoundedBoxGeometry(size, size, size, 3, size * 0.065),
      panel: new RoundedBoxGeometry(size * 0.73, size * 0.015, size * 0.73, 2, size * 0.006),
      screw: new THREE.CylinderGeometry(size * 0.025, size * 0.025, size * 0.009, 12),
      slot: new THREE.BoxGeometry(size * 0.027, size * 0.002, size * 0.004),
      socket: new THREE.CylinderGeometry(size * 0.115, size * 0.115, size * 0.018, 24),
      socketInset: new THREE.CylinderGeometry(size * 0.068, size * 0.068, size * 0.021, 20),
      indicator: new THREE.BoxGeometry(size * 0.18, size * 0.021, size * 0.012),
      edge: new THREE.EdgesGeometry(new THREE.BoxGeometry(size * 1.015, size * 1.015, size * 1.015)),
      ghost: new THREE.EdgesGeometry(new THREE.BoxGeometry(size, size, size)),
      hinge: new THREE.CylinderGeometry(size * 0.105, size * 0.105, size * 0.42, 20),
      hingeRing: new THREE.CylinderGeometry(size * 0.111, size * 0.111, size * 0.035, 20),
      arm: new THREE.CylinderGeometry(size * 0.038, size * 0.038, 1, 12),
    };
  }

  function labelTexture(index) {
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#18221de8';
    ctx.beginPath();
    ctx.roundRect(34, 14, 124, 68, 14);
    ctx.fill();
    ctx.strokeStyle = '#5b6b51';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = '500 40px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e6ebdb';
    ctx.fillText(String(index + 1).padStart(2, '0'), 96, 50);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  function makeModule(index) {
    const group = new THREE.Group();
    group.userData.moduleIndex = index;
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: SAND, metalness: 0.4, roughness: 0.4 });
    const body = new THREE.Mesh(geometries.body, bodyMaterial);
    body.castShadow = true;
    body.receiveShadow = true;
    body.userData.moduleIndex = index;
    group.add(body);

    const panel = new THREE.Mesh(geometries.panel, insetMaterial);
    panel.position.y = size * 0.497;
    panel.receiveShadow = true;
    group.add(panel);
    [-1, 1].forEach((x) => [-1, 1].forEach((z) => {
      const screw = new THREE.Mesh(geometries.screw, screwMaterial);
      screw.position.set(x * size * 0.4, size * 0.498, z * size * 0.4);
      group.add(screw);
      const slot = new THREE.Mesh(geometries.slot, graphite);
      slot.position.copy(screw.position);
      slot.position.y += size * 0.005;
      slot.rotation.y = Math.PI / 4;
      group.add(slot);
    }));

    // Recessed, functional docking faces rather than decorative glowing panels.
    for (const side of [-1, 1]) {
      const socket = new THREE.Mesh(geometries.socket, graphite);
      socket.rotation.z = Math.PI / 2;
      socket.position.x = side * size * 0.496;
      group.add(socket);
      const recess = new THREE.Mesh(geometries.socketInset, screwMaterial);
      recess.rotation.z = Math.PI / 2;
      recess.position.x = side * size * 0.502;
      group.add(recess);
      const face = new THREE.Mesh(geometries.panel, insetMaterial);
      face.rotation.x = Math.PI / 2;
      face.position.z = side * size * 0.497;
      group.add(face);
    }
    const indicatorMaterial = new THREE.MeshStandardMaterial({ color: LIME, emissive: LIME, emissiveIntensity: 0.28, roughness: 0.5 });
    const indicator = new THREE.Mesh(geometries.indicator, indicatorMaterial);
    indicator.position.set(0, size * 0.24, size * 0.51);
    group.add(indicator);

    const edgeMaterial = new THREE.LineBasicMaterial({ color: LIME, transparent: true, opacity: 0.9 });
    const edge = new THREE.LineSegments(geometries.edge, edgeMaterial);
    edge.visible = false;
    group.add(edge);
    const texture = labelTexture(index);
    const labelMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: true });
    const label = new THREE.Sprite(labelMaterial);
    label.position.set(0, size * 0.77, 0);
    label.scale.set(size * 0.66, size * 0.33, 1);
    group.add(label);
    moduleRoot.add(group);
    return { group, body, bodyMaterial, edge, edgeMaterial, indicatorMaterial, label, labelMaterial, texture };
  }

  function clearModules() {
    modules.forEach((module) => {
      module.bodyMaterial.dispose();
      module.edgeMaterial.dispose();
      module.indicatorMaterial.dispose();
      module.labelMaterial.dispose();
      module.texture.dispose();
    });
    modules = [];
    moduleRoot.clear();
  }

  function paintModules() {
    modules.forEach((module, index) => {
      const colliding = collisionSet.has(index);
      const active = selected === index;
      const over = hovered === index;
      module.bodyMaterial.color.setHex(colliding ? 0xce8070 : active ? 0xd1d2b8 : SAND);
      module.bodyMaterial.emissive.setHex(colliding ? RED : LIME);
      module.bodyMaterial.emissiveIntensity = colliding ? 0.12 : active ? 0.028 : over ? 0.02 : 0;
      module.edge.visible = active || colliding || over;
      module.edgeMaterial.color.setHex(colliding ? RED : LIME);
      module.edgeMaterial.opacity = active || colliding ? 0.92 : 0.38;
      module.indicatorMaterial.color.setHex(colliding ? RED : LIME);
      module.indicatorMaterial.emissive.setHex(colliding ? RED : LIME);
      module.label.visible = labelsVisible;
    });
  }

  function vector(value, fallback = new THREE.Vector3()) {
    if (!value) return fallback.clone();
    if (Array.isArray(value)) return new THREE.Vector3(Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0);
    return new THREE.Vector3(Number(value.x) || 0, Number(value.y) || 0, Number(value.z) || 0);
  }

  function quaternion(value) {
    if (!value) return new THREE.Quaternion();
    if (Array.isArray(value)) return new THREE.Quaternion(...value).normalize();
    return new THREE.Quaternion(value.x || 0, value.y || 0, value.z || 0, value.w ?? 1).normalize();
  }

  function boundsFor(data) {
    const box = new THREE.Box3();
    const local = new THREE.Box3(new THREE.Vector3(-size / 2, -size / 2, -size / 2), new THREE.Vector3(size / 2, size / 2, size / 2));
    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3(1, 1, 1);
    data.forEach((module) => {
      matrix.compose(vector(module.position), quaternion(module.quaternion), scale);
      box.union(local.clone().applyMatrix4(matrix));
    });
    if (box.isEmpty()) box.set(new THREE.Vector3(-0.12, -0.04, -0.12), new THREE.Vector3(0.12, 0.04, 0.12));
    return box;
  }

  function readCollisions(collisions) {
    const result = new Set();
    const add = (index) => { if (Number.isInteger(index)) result.add(index); };
    for (const collision of collisions || []) {
      if (Number.isInteger(collision)) add(collision);
      else if (Array.isArray(collision)) collision.forEach(add);
      else if (collision) {
        ['a', 'b', 'i', 'j', 'moduleA', 'moduleB', 'index'].forEach((key) => add(collision[key]));
        if (Array.isArray(collision.indices)) collision.indices.forEach(add);
      }
    }
    return result;
  }

  function drawJoints(joints, data, mode) {
    jointRoot.clear();
    const items = joints?.length ? joints : mode === 'chain' ? data.slice(1).map((_, i) => ({ a: i, b: i + 1 })) : [];
    items.forEach((joint, i) => {
      const a = joint.a ?? joint.from ?? i;
      const b = joint.b ?? joint.to ?? i + 1;
      const pa = data[a] ? vector(data[a].position) : null;
      const pb = data[b] ? vector(data[b].position) : null;
      const explicit = joint.position || joint.center || joint.anchor;
      if (!explicit && (!pa || !pb || pa.distanceTo(pb) > size * 1.7)) return;
      const center = explicit ? vector(explicit) : pa.clone().add(pb).multiplyScalar(0.5);
      const axis = typeof joint.axis === 'string'
        ? new THREE.Vector3(joint.axis === 'x' ? 1 : 0, joint.axis === 'y' ? 1 : 0, joint.axis === 'z' ? 1 : 0)
        : vector(joint.axis, yAxis);
      if (axis.lengthSq() < 1e-8) axis.copy(yAxis);
      axis.normalize();
      const hinge = new THREE.Group();
      hinge.position.copy(center);
      hinge.quaternion.setFromUnitVectors(yAxis, axis);
      const barrel = new THREE.Mesh(geometries.hinge, jointMaterial);
      barrel.castShadow = true;
      hinge.add(barrel);
      for (const sign of [-1, 1]) {
        const ring = new THREE.Mesh(geometries.hingeRing, ringMaterial);
        ring.position.y = sign * size * 0.15;
        hinge.add(ring);
      }
      jointRoot.add(hinge);
      // Short links make the joint legible without drawing rods through entire modules.
      for (const point of [pa, pb]) {
        if (!point) continue;
        const direction = point.clone().sub(center);
        const length = Math.min(direction.length(), size * 0.3);
        if (length < 1e-6) continue;
        direction.normalize();
        const arm = new THREE.Mesh(geometries.arm, graphite);
        arm.scale.y = length;
        arm.position.copy(center).addScaledVector(direction, length / 2);
        arm.quaternion.setFromUnitVectors(yAxis, direction);
        arm.castShadow = true;
        jointRoot.add(arm);
      }
    });
  }

  function update(data = [], options = {}) {
    if (disposed) return;
    const nextSize = Number.isFinite(options.size) && options.size > 0 ? options.size : size;
    if (nextSize !== size || !geometries) {
      clearModules();
      ghostRoot.clear();
      jointRoot.clear();
      size = nextSize;
      makeGeometries();
    }
    if (modules.length !== data.length) {
      clearModules();
      modules = data.map((_, i) => makeModule(i));
    }
    lastModules = data;
    selected = options.selected ?? 0;
    labelsVisible = options.showLabels ?? true;
    collisionSet = readCollisions(options.collisions);
    data.forEach((module, i) => {
      modules[i].group.position.copy(vector(module.position));
      modules[i].group.quaternion.copy(quaternion(module.quaternion));
    });
    paintModules();
    ghostRoot.clear();
    if (options.showGhost !== false) {
      (options.ghostModules || []).forEach((module) => {
        const ghost = new THREE.LineSegments(geometries.ghost, ghostMaterial);
        ghost.position.copy(vector(module.position));
        ghost.quaternion.copy(quaternion(module.quaternion));
        ghostRoot.add(ghost);
      });
    }
    jointRoot.visible = options.showJoints !== false;
    drawJoints(options.joints || [], data, options.mode || 'chain');
    // The engineering ground is fixed at Y=0. Moving it with a configuration
    // would conceal a chain's penetration of the floor.
    floor.position.y = 0;
    grid.position.y = 0.0003;
  }

  function viewDirection(view) {
    if (view === 'top') return new THREE.Vector3(0, 1, 0.0001).normalize();
    if (view === 'front') return new THREE.Vector3(0, 0.055, 1).normalize();
    return new THREE.Vector3(0.95, 0.8, 1.1).normalize();
  }

  function fit(data = lastModules) {
    if (disposed) return;
    const bounds = boundsFor(data);
    const center = bounds.getCenter(new THREE.Vector3());
    const extent = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(extent.length() * 0.5, size);
    const vertical = THREE.MathUtils.degToRad(camera.fov) / 2;
    const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
    const distance = Math.max(0.2, radius / Math.sin(Math.min(vertical, horizontal)) * 1.12);
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(viewDirection(currentView), distance);
    camera.near = Math.max(0.001, distance / 500);
    camera.far = Math.max(20, distance * 20);
    camera.updateProjectionMatrix();
    controls.maxDistance = Math.max(8, distance * 6);
    controls.update();
    const shadowSize = Math.max(0.3, extent.length() * 0.75);
    key.position.copy(center).add(new THREE.Vector3(-0.7, 1.8, 0.8).multiplyScalar(Math.max(1, shadowSize)));
    key.target.position.copy(center);
    Object.assign(key.shadow.camera, { left: -shadowSize, right: shadowSize, top: shadowSize, bottom: -shadowSize, far: Math.max(8, shadowSize * 8) });
    key.shadow.camera.updateProjectionMatrix();
  }

  function setView(view) {
    if (!['iso', 'top', 'front'].includes(view)) return;
    currentView = view;
    fit(lastModules);
  }

  function resize() {
    if (disposed) return;
    const rect = container.getBoundingClientRect();
    const width = Math.max(1, rect.width || container.clientWidth || 640);
    const height = Math.max(1, rect.height || container.clientHeight || 480);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function hit(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return -1;
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const intersections = raycaster.intersectObjects(modules.map((module) => module.body), false);
    return intersections[0]?.object.userData.moduleIndex ?? -1;
  }
  function onPointerDown(event) {
    pointerStart = { x: event.clientX, y: event.clientY, button: event.button };
  }
  function onPointerUp(event) {
    if (!pointerStart || pointerStart.button !== 0) return;
    const distance = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
    pointerStart = null;
    if (distance > 5) return;
    const index = hit(event);
    if (index >= 0) {
      selected = index;
      paintModules();
      onSelect(index);
    }
  }
  function onPointerMove(event) {
    if (event.buttons) return;
    const index = hit(event);
    if (index !== hovered) {
      hovered = index;
      renderer.domElement.style.cursor = index >= 0 ? 'pointer' : 'grab';
      paintModules();
    }
  }
  function onPointerLeave() {
    hovered = -1;
    paintModules();
  }
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerleave', onPointerLeave);
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  makeGeometries();

  function animate() {
    if (disposed) return;
    animationFrame = requestAnimationFrame(animate);
    controls.update(Math.min(clock.getDelta(), 0.05));
    renderer.render(scene, camera);
  }
  animate();

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(animationFrame);
    observer.disconnect();
    renderer.domElement.removeEventListener('pointerdown', onPointerDown);
    renderer.domElement.removeEventListener('pointerup', onPointerUp);
    renderer.domElement.removeEventListener('pointermove', onPointerMove);
    renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
    controls.dispose();
    clearModules();
    disposeGeometries();
    sharedMaterials.forEach((material) => material.dispose());
    floor.geometry.dispose();
    floor.material.dispose();
    [minorGrid, majorGrid].forEach((item) => {
      item.geometry.dispose();
      item.material.dispose();
    });
    environment.dispose();
    key.shadow.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }

  return {
    update, fit, setView, resize, dispose,
    setGrid(visible) { grid.visible = Boolean(visible); },
    setAutoRotate(enabled) { controls.autoRotate = Boolean(enabled); },
    capture() {
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL('image/png');
    },
  };
}
