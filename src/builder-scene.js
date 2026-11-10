import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const UP = new THREE.Vector3(0, 1, 0);
const FRONT = new THREE.Vector3(0, 0, 1);
const BLUE = 0x3972e5;

function vec(value, fallback = [0, 0, 0]) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return new THREE.Vector3(...Array.from(value).slice(0, 3).map((n, i) => Number.isFinite(Number(n)) ? Number(n) : fallback[i]));
  if (value && Number.isFinite(value.x)) return new THREE.Vector3(value.x, value.y || 0, value.z || 0);
  return new THREE.Vector3(...fallback);
}

function quat(pose) {
  if (pose?.quaternion) {
    const q = pose.quaternion;
    if (Array.isArray(q) || ArrayBuffer.isView(q)) return new THREE.Quaternion(q[0], q[1], q[2], q[3]).normalize();
    return new THREE.Quaternion(q.x || 0, q.y || 0, q.z || 0, q.w ?? 1).normalize();
  }
  const rotation = vec(pose?.rotation);
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation.x, rotation.y, rotation.z, 'XYZ'));
}

function dimensions(object) {
  const defaults = object.type === 'obstacle' ? [0.4, 0.25, 0.4] : object.type === 'payload' ? [0.24, 0.2, 0.24] : [0.2, 0.2, 0.2];
  return vec(object.size, defaults).toArray().map((value, i) => Math.max(0.015, Number.isFinite(value) && value > 0 ? value : defaults[i]));
}

/** White-studio constructor viewport. All world dimensions are in metres, Y is up. */
export function createBuilderScene(container, { onSelect = () => {}, onGroundClick = () => {}, onTransform = () => {} } = {}) {
  if (!container) throw new Error('TUGEL: viewport container is missing.');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  } catch (error) {
    throw new Error('3D-конструктору необходим WebGL. Включите аппаратное ускорение браузера и обновите страницу.', { cause: error });
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.16;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none;';
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', '3D-конструктор TUGEL. Нажмите на объект для выбора. Перетаскивайте для вращения камеры, колёсико для масштаба.');
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf5f6f8);
  scene.fog = new THREE.Fog(0xf5f6f8, 15, 55);
  const camera = new THREE.PerspectiveCamera(36, 1, 0.005, 120);
  camera.position.set(2.8, 2.2, 3.1);
  const orbit = new OrbitControls(camera, canvas);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.minDistance = 0.18;
  orbit.maxDistance = 45;
  orbit.maxPolarAngle = Math.PI * 0.49;
  orbit.target.set(0, 0.15, 0);
  orbit.listenToKeyEvents(canvas);

  const transform = new TransformControls(camera, canvas);
  transform.setSize(0.82);
  transform.setTranslationSnap(0.2);
  transform.setRotationSnap(Math.PI / 2);
  transform.setSpace('world');
  const transformHelper = transform.getHelper();
  scene.add(transformHelper);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.035);
  room.dispose();
  pmrem.dispose();
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.82;
  scene.add(new THREE.HemisphereLight(0xffffff, 0xc1c6cc, 1.25));
  const key = new THREE.DirectionalLight(0xfffcf7, 3.4);
  key.position.set(-3.5, 7, 4.5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.00008;
  key.shadow.normalBias = 0.0012;
  key.shadow.radius = 4;
  Object.assign(key.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.1, far: 30 });
  scene.add(key, key.target);
  const rim = new THREE.DirectionalLight(0xe9f1ff, 1.8);
  rim.position.set(4, 4, -4);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0xffffff, 0.45);
  fill.position.set(-4, 2, -3);
  scene.add(fill);

  const materials = {};
  const ownedTextures = new Set();
  const ownedMaterials = new Set();
  const ownMaterial = (material) => { ownedMaterials.add(material); return material; };
  const ownTexture = (texture) => { ownedTextures.add(texture); return texture; };
  const standard = (properties) => ownMaterial(new THREE.MeshStandardMaterial(properties));
  materials.shell = standard({ color: 0xdbdee1, metalness: 0.52, roughness: 0.32 });
  materials.panel = standard({ color: 0xe9ebec, metalness: 0.18, roughness: 0.38 });
  materials.aluminum = standard({ color: 0xbac0c5, metalness: 0.92, roughness: 0.28 });
  materials.steel = standard({ color: 0x9ca5ae, metalness: 0.94, roughness: 0.24 });
  materials.graphite = standard({ color: 0x343a42, metalness: 0.38, roughness: 0.4 });
  materials.dark = standard({ color: 0x171c23, metalness: 0.15, roughness: 0.6 });
  materials.rubber = standard({ color: 0x24262a, metalness: 0.02, roughness: 0.89 });
  materials.tread = standard({ color: 0x181a1d, metalness: 0, roughness: 0.94 });
  materials.brass = standard({ color: 0xad9061, metalness: 0.82, roughness: 0.3 });
  materials.woodEdge = standard({ color: 0xa88051, metalness: 0, roughness: 0.78 });
  materials.connection = standard({ color: 0x66717c, metalness: 0.8, roughness: 0.33 });

  function noiseTexture(kind) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const pixels = ctx.createImageData(256, 256);
    let seed = 417;
    const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const offset = (y * 256 + x) * 4;
      if (kind === 'wood') {
        const grain = Math.sin(y * 0.75 + Math.sin(x * 0.024) * 1.7) * 7 + (rand() - 0.5) * 12;
        pixels.data[offset] = 167 + grain;
        pixels.data[offset + 1] = 129 + grain;
        pixels.data[offset + 2] = 84 + grain;
      } else {
        const grain = (rand() - 0.5) * 23 + (rand() > 0.994 ? -35 : 0);
        pixels.data[offset] = 176 + grain;
        pixels.data[offset + 1] = 179 + grain;
        pixels.data[offset + 2] = 180 + grain;
      }
      pixels.data[offset + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    const texture = ownTexture(new THREE.CanvasTexture(c));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2, 2);
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return texture;
  }
  const woodTexture = noiseTexture('wood');
  const concreteTexture = noiseTexture('concrete');
  materials.wood = standard({ color: 0xffffff, map: woodTexture, roughness: 0.8, metalness: 0, bumpMap: woodTexture, bumpScale: 0.00035 });
  materials.concrete = standard({ color: 0xffffff, map: concreteTexture, roughness: 0.96, metalness: 0, bumpMap: concreteTexture, bumpScale: 0.0012 });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), standard({ color: 0xf3f4f6, metalness: 0, roughness: 0.96 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.001;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.Group();
  const minorGrid = new THREE.GridHelper(24, 120, 0xc1c8d1, 0xd1d7df);
  const majorGrid = new THREE.GridHelper(24, 24, 0xaab5c2, 0xbac3ce);
  for (const [item, opacity] of [[minorGrid, 0.42], [majorGrid, 0.28]]) {
    item.material.transparent = true;
    item.material.opacity = opacity;
    item.material.depthWrite = false;
    grid.add(item);
  }
  grid.position.y = 0.0002;
  scene.add(grid);

  const objectsRoot = new THREE.Group();
  const connectionsRoot = new THREE.Group();
  scene.add(objectsRoot, connectionsRoot);
  const records = new Map();
  let connectionRecords = [];
  let project = { objects: [], connections: [] };
  let selectedId = null;
  let tool = 'select';
  let simulation = false;
  let dragging = false;
  let transformStart = null;
  let pointerStart = null;
  let currentView = 'iso';
  let disposed = false;
  let frame = 0;
  let hasFramed = false;
  let hoverId = null;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const groundPlane = new THREE.Plane(UP, 0);
  const elapsed = new THREE.Clock();

  const selectionGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  const selectionMaterial = ownMaterial(new THREE.LineBasicMaterial({ color: BLUE, transparent: true, opacity: 0.86, depthWrite: false }));
  const selectionOutline = new THREE.LineSegments(selectionGeometry, selectionMaterial);
  selectionOutline.visible = false;
  selectionOutline.renderOrder = 4;
  scene.add(selectionOutline);
  const labelMaterial = ownMaterial(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: false }));
  const label = new THREE.Sprite(labelMaterial);
  label.visible = false;
  label.renderOrder = 8;
  scene.add(label);
  let labelTexture = null;
  let labelKey = '';

  const waypoint = new THREE.Group();
  const waypointMaterial = ownMaterial(new THREE.MeshBasicMaterial({ color: BLUE, transparent: true, opacity: 0.78, depthWrite: false }));
  const waypointRingGeometry = new THREE.RingGeometry(0.065, 0.079, 48);
  const waypointRing = new THREE.Mesh(waypointRingGeometry, waypointMaterial);
  waypointRing.rotation.x = -Math.PI / 2;
  waypoint.add(waypointRing);
  const waypointDotGeometry = new THREE.CircleGeometry(0.012, 24);
  const waypointDot = new THREE.Mesh(waypointDotGeometry, waypointMaterial);
  waypointDot.rotation.x = -Math.PI / 2;
  waypointDot.position.y = 0.0003;
  waypoint.add(waypointDot);
  waypoint.visible = false;
  scene.add(waypoint);
  const groundHover = new THREE.Group();
  const hoverRingGeometry = new THREE.RingGeometry(0.034, 0.043, 40);
  const hoverDiscGeometry = new THREE.CircleGeometry(0.034, 40);
  const hoverRingMaterial = ownMaterial(new THREE.MeshBasicMaterial({ color: 0x6d829f, transparent: true, opacity: 0.52, depthWrite: false }));
  const hoverWhiteMaterial = ownMaterial(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }));
  const hoverRing = new THREE.Mesh(hoverRingGeometry, hoverRingMaterial);
  const hoverDisc = new THREE.Mesh(hoverDiscGeometry, hoverWhiteMaterial);
  const hoverDot = new THREE.Mesh(waypointDotGeometry, hoverRingMaterial);
  for (const part of [hoverRing, hoverDisc, hoverDot]) part.rotation.x = -Math.PI / 2;
  hoverDot.scale.setScalar(0.38);
  hoverDot.position.y = 0.0003;
  groundHover.add(hoverRing, hoverDisc, hoverDot);
  groundHover.visible = false;
  scene.add(groundHover);

  // Each object owns its geometry; materials are shared across all instances.
  function createObject(object) {
    const [w, h, d] = dimensions(object);
    const group = new THREE.Group();
    group.name = `tugel-${object.type}-${object.id}`;
    group.userData.objectId = object.id;
    const geometries = new Set();
    const objectMaterials = new Set();
    const objectTextures = new Set();
    const wheelSpinners = [];
    const own = (geometry) => { geometries.add(geometry); return geometry; };
    const mesh = (geometry, material, parent = group) => {
      const item = new THREE.Mesh(geometry, material);
      item.castShadow = true;
      item.receiveShadow = true;
      item.userData.objectId = object.id;
      parent.add(item);
      return item;
    };
    const rounded = (x, y, z, radius = Math.min(x, y, z) * 0.07) => own(new RoundedBoxGeometry(x, y, z, 3, Math.min(radius, x / 2, y / 2, z / 2)));
    const instances = new Map();
    const queueInstance = (key, geometry, material, position, orientation = new THREE.Quaternion(), scale = new THREE.Vector3(1, 1, 1)) => {
      if (!instances.has(key)) instances.set(key, { geometry, material, matrices: [] });
      instances.get(key).matrices.push(new THREE.Matrix4().compose(position, orientation, scale));
    };
    const minimum = Math.min(w, h, d);
    const screwRadius = minimum * 0.016;
    const screwGeometry = own(new THREE.CylinderGeometry(screwRadius, screwRadius, minimum * 0.008, 16));
    const hexGeometry = own(new THREE.CylinderGeometry(screwRadius * 0.48, screwRadius * 0.48, minimum * 0.002, 6));
    function screwAt(position, normal = UP, radiusScale = 1) {
      const orientation = new THREE.Quaternion().setFromUnitVectors(UP, normal);
      const scale = new THREE.Vector3(radiusScale, 1, radiusScale);
      queueInstance('screws', screwGeometry, materials.steel, position, orientation, scale);
      queueInstance('hex', hexGeometry, materials.dark, position.clone().addScaledVector(normal, minimum * 0.0047), orientation, scale);
    }

    function dockingFace(center, normal, width, height, detailed = true) {
      const face = new THREE.Group();
      face.position.copy(center);
      face.quaternion.setFromUnitVectors(FRONT, normal);
      group.add(face);
      const thickness = minimum * 0.017;
      const panel = mesh(rounded(width * 0.81, height * 0.81, thickness, thickness * 0.42), materials.panel, face);
      panel.position.z = thickness * 0.05;
      const ringRadius = Math.min(width, height) * 0.175;
      const socketGeometry = own(new THREE.CylinderGeometry(ringRadius, ringRadius, thickness * 0.8, 32));
      const socket = mesh(socketGeometry, materials.graphite, face);
      socket.rotation.x = Math.PI / 2;
      socket.position.z = thickness * 0.61;
      const ringGeometry = own(new THREE.TorusGeometry(ringRadius * 0.96, ringRadius * 0.10, 8, 32));
      const ring = mesh(ringGeometry, materials.aluminum, face);
      ring.position.z = thickness * 0.95;
      const innerGeometry = own(new THREE.CylinderGeometry(ringRadius * 0.62, ringRadius * 0.62, thickness * 0.3, 24));
      const inner = mesh(innerGeometry, materials.dark, face);
      inner.rotation.x = Math.PI / 2;
      inner.position.z = thickness * 0.9;
      const faceMatrix = new THREE.Matrix4().compose(center, face.quaternion, new THREE.Vector3(1, 1, 1));
      for (const x of [-1, 1]) for (const y of [-1, 1]) {
        const pos = new THREE.Vector3(x * width * 0.325, y * height * 0.325, thickness * 0.61).applyMatrix4(faceMatrix);
        screwAt(pos, normal);
      }
      if (detailed) {
        const pinGeometry = own(new THREE.CylinderGeometry(minimum * 0.009, minimum * 0.009, thickness * 0.85, 10));
        const pinQ = new THREE.Quaternion().setFromUnitVectors(UP, normal);
        for (let index = 0; index < 4; index++) {
          const angle = Math.PI / 4 + index * Math.PI / 2;
          const pos = new THREE.Vector3(Math.cos(angle) * ringRadius * 0.61, Math.sin(angle) * ringRadius * 0.61, thickness * 1.1).applyMatrix4(faceMatrix);
          queueInstance('pins', pinGeometry, materials.brass, pos, pinQ);
        }
      }
      // A small bank of recessed ventilation slots, kept clear of the docking ring.
      if (normal.z > 0.5) {
        const ventGeometry = own(new THREE.BoxGeometry(width * 0.022, height * 0.095, thickness * 0.12));
        for (let index = 0; index < 6; index++) {
          const pos = new THREE.Vector3((index - 2.5) * width * 0.047, -height * 0.30, thickness * 0.61).applyMatrix4(faceMatrix);
          queueInstance('vents', ventGeometry, materials.dark, pos, face.quaternion);
        }
      }
    }

    function robotShell(bodyWidth, bodyHeight, bodyDepth, centerY = 0) {
      const shell = mesh(rounded(bodyWidth, bodyHeight, bodyDepth, minimum * 0.045), materials.shell);
      shell.position.y = centerY;
      const seam = mesh(rounded(bodyWidth * 1.002, minimum * 0.012, bodyDepth * 1.002, minimum * 0.005), materials.graphite);
      seam.position.y = centerY - bodyHeight * 0.32;
      dockingFace(new THREE.Vector3(0, centerY, bodyDepth / 2), FRONT, bodyWidth, bodyHeight);
      dockingFace(new THREE.Vector3(0, centerY, -bodyDepth / 2), new THREE.Vector3(0, 0, -1), bodyWidth, bodyHeight);
      dockingFace(new THREE.Vector3(bodyWidth / 2, centerY, 0), new THREE.Vector3(1, 0, 0), bodyDepth, bodyHeight);
      dockingFace(new THREE.Vector3(-bodyWidth / 2, centerY, 0), new THREE.Vector3(-1, 0, 0), bodyDepth, bodyHeight);
      dockingFace(new THREE.Vector3(0, centerY + bodyHeight / 2, 0), UP, bodyWidth, bodyDepth);
      dockingFace(new THREE.Vector3(0, centerY - bodyHeight / 2, 0), new THREE.Vector3(0, -1, 0), bodyWidth, bodyDepth, false);
    }

    let wheelRadius = 0;
    if (object.type === 'drive') {
      robotShell(w * 0.83, h * 0.68, d * 0.92, h * 0.11);
      // Match the passive Rapier wheel colliders exactly: chassis size excludes
      // 20 mm bottom clearance and 9 mm tires on each Z-facing side.
      wheelRadius = Math.min(0.025, w / 5);
      const tireWidth = 0.018;
      const tireGeometry = own(new THREE.LatheGeometry([
        new THREE.Vector2(wheelRadius * 0.55, -tireWidth * 0.5),
        new THREE.Vector2(wheelRadius * 0.85, -tireWidth * 0.5),
        new THREE.Vector2(wheelRadius * 0.98, -tireWidth * 0.33),
        new THREE.Vector2(wheelRadius, -tireWidth * 0.23),
        new THREE.Vector2(wheelRadius, tireWidth * 0.23),
        new THREE.Vector2(wheelRadius * 0.98, tireWidth * 0.33),
        new THREE.Vector2(wheelRadius * 0.85, tireWidth * 0.5),
        new THREE.Vector2(wheelRadius * 0.55, tireWidth * 0.5),
      ], 40));
      const hubGeometry = own(new THREE.CylinderGeometry(wheelRadius * 0.56, wheelRadius * 0.56, tireWidth * 1.02, 24));
      const hubCapGeometry = own(new THREE.CylinderGeometry(wheelRadius * 0.32, wheelRadius * 0.32, tireWidth * 1.06, 20));
      const treadGeometry = own(new THREE.BoxGeometry(wheelRadius * 0.15, wheelRadius * 0.025, tireWidth * 0.8));
      const axleY = -h / 2 + wheelRadius - 0.02;
      const bodyBottom = -h * 0.23;
      const axleGeometry = own(new THREE.CylinderGeometry(wheelRadius * 0.13, wheelRadius * 0.13, d, 12));
      for (const end of [-1, 1]) {
        const axle = mesh(axleGeometry, materials.steel);
        axle.rotation.x = Math.PI / 2;
        axle.position.set(end * (w / 2 - wheelRadius), axleY, 0);
        for (const side of [-1, 1]) {
          const mountHeight = Math.max(0.008, bodyBottom - axleY + wheelRadius * 0.2);
          const mount = mesh(rounded(wheelRadius * 0.48, mountHeight, Math.min(d * 0.22, 0.022), 0.001), materials.graphite);
          mount.position.set(axle.position.x, axleY + mountHeight / 2 - wheelRadius * 0.1, side * d * 0.32);
        }
      }
      for (const side of [-1, 1]) for (const end of [-1, 1]) {
        const wheelMount = new THREE.Group();
        wheelMount.position.set(end * (w / 2 - wheelRadius), -h / 2 + wheelRadius - 0.02, side * d / 2);
        wheelMount.rotation.x = Math.PI / 2;
        group.add(wheelMount);
        const spinner = new THREE.Group();
        wheelMount.add(spinner);
        wheelSpinners.push(spinner);
        mesh(tireGeometry, materials.rubber, spinner);
        mesh(hubGeometry, materials.aluminum, spinner);
        mesh(hubCapGeometry, materials.graphite, spinner);
        // Individual low-profile tread bars give the tires a manufactured silhouette.
        const treads = new THREE.InstancedMesh(treadGeometry, materials.tread, 28);
        treads.castShadow = true;
        treads.userData.objectId = object.id;
        for (let tread = 0; tread < 28; tread++) {
          const angle = tread / 28 * Math.PI * 2;
          const p = new THREE.Vector3(Math.sin(angle) * wheelRadius, 0, Math.cos(angle) * wheelRadius);
          const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, angle, 0, 'YXZ'));
          treads.setMatrixAt(tread, new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)));
        }
        treads.instanceMatrix.needsUpdate = true;
        spinner.add(treads);
        const hubBoltGeometry = own(new THREE.CylinderGeometry(wheelRadius * 0.055, wheelRadius * 0.055, tireWidth * 0.022, 6));
        for (const outerSide of [-1, 1]) {
          const bolts = new THREE.InstancedMesh(hubBoltGeometry, materials.steel, 5);
          bolts.userData.objectId = object.id;
          for (let bolt = 0; bolt < 5; bolt++) {
            const angle = bolt * Math.PI * 2 / 5;
            const p = new THREE.Vector3(Math.sin(angle) * wheelRadius * 0.43, outerSide * tireWidth * 0.522, Math.cos(angle) * wheelRadius * 0.43);
            bolts.setMatrixAt(bolt, new THREE.Matrix4().compose(p, new THREE.Quaternion(), new THREE.Vector3(1, 1, 1)));
          }
          spinner.add(bolts);
        }
      }
    } else if (object.type === 'hinge') {
      const casing = mesh(rounded(w * 0.69, h * 0.76, d * 0.81, minimum * 0.045), materials.graphite);
      casing.position.y = -h * 0.04;
      const seam = mesh(rounded(w * 0.70, h * 0.018, d * 0.82, minimum * 0.008), materials.dark);
      seam.position.y = h * 0.18;
      for (const side of [-1, 1]) {
        const bracket = mesh(rounded(w * 0.13, h * 0.94, d * 0.82, minimum * 0.015), materials.aluminum);
        bracket.position.x = side * w * 0.405;
        for (const z of [-1, 1]) {
          screwAt(new THREE.Vector3(side * w * 0.477, h * 0.29, z * d * 0.29), new THREE.Vector3(side, 0, 0));
          screwAt(new THREE.Vector3(side * w * 0.477, -h * 0.29, z * d * 0.29), new THREE.Vector3(side, 0, 0));
        }
      }
      const outputGeometry = own(new THREE.CylinderGeometry(minimum * 0.24, minimum * 0.24, h * 0.12, 32));
      const output = mesh(outputGeometry, materials.steel);
      output.position.y = h * 0.42;
      const shaftGeometry = own(new THREE.CylinderGeometry(minimum * 0.085, minimum * 0.085, h * 0.05, 16));
      const shaft = mesh(shaftGeometry, materials.dark);
      shaft.position.y = h * 0.485;
      dockingFace(new THREE.Vector3(0, -h * 0.04, d * 0.41), FRONT, w * 0.68, h * 0.71);
      dockingFace(new THREE.Vector3(0, -h * 0.04, -d * 0.41), new THREE.Vector3(0, 0, -1), w * 0.68, h * 0.71);
      for (let i = 0; i < 4; i++) {
        const angle = i * Math.PI / 2 + Math.PI / 4;
        screwAt(new THREE.Vector3(Math.cos(angle) * minimum * 0.17, h * 0.485, Math.sin(angle) * minimum * 0.17));
      }
    } else if (object.type === 'payload') {
      mesh(rounded(w * 0.95, h * 0.95, d * 0.95, minimum * 0.012), materials.wood);
      const batten = minimum * 0.105;
      // Frame rails stay within the declared physical bounding box.
      for (const side of [-1, 1]) {
        for (const x of [-1, 1]) {
          const rail = mesh(rounded(batten, h, minimum * 0.036, minimum * 0.006), materials.woodEdge);
          rail.position.set(x * (w / 2 - batten / 2), 0, side * (d / 2 - minimum * 0.018));
          screwAt(new THREE.Vector3(rail.position.x, h * 0.38, side * d / 2), new THREE.Vector3(0, 0, side), 0.8);
          screwAt(new THREE.Vector3(rail.position.x, -h * 0.38, side * d / 2), new THREE.Vector3(0, 0, side), 0.8);
        }
        for (const y of [-1, 1]) {
          const rail = mesh(rounded(w - batten * 2, batten, minimum * 0.036, minimum * 0.006), materials.woodEdge);
          rail.position.set(0, y * (h / 2 - batten / 2), side * (d / 2 - minimum * 0.018));
        }
      }
      for (const x of [-1, 1]) {
        const topRail = mesh(rounded(batten, minimum * 0.036, d, minimum * 0.006), materials.woodEdge);
        topRail.position.set(x * w * 0.32, h / 2 - minimum * 0.018, 0);
      }
      const c = document.createElement('canvas');
      c.width = 384;
      c.height = 192;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ece9dd';
      ctx.fillRect(0, 0, 384, 192);
      ctx.strokeStyle = '#b9b5a8';
      ctx.lineWidth = 4;
      ctx.strokeRect(3, 3, 378, 186);
      ctx.fillStyle = '#3c3b36';
      ctx.font = '600 39px ui-monospace, monospace';
      ctx.fillText('TUGEL / CARGO', 23, 66);
      ctx.font = '25px ui-monospace, monospace';
      ctx.fillText('HANDLE WITH CARE', 23, 112);
      ctx.fillRect(24, 137, 270, 4);
      for (let x = 25; x < 295; x += 7) ctx.fillRect(x, 146, x % 3 + 2, 23);
      const texture = new THREE.CanvasTexture(c);
      texture.colorSpace = THREE.SRGBColorSpace;
      objectTextures.add(texture);
      const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.86, metalness: 0 });
      objectMaterials.add(material);
      const tag = mesh(own(new THREE.PlaneGeometry(w * 0.61, h * 0.30)), material);
      tag.position.set(0, h * 0.03, d * 0.477);
    } else if (object.type === 'obstacle') {
      mesh(rounded(w, h, d, minimum * 0.025), materials.concrete);
    } else {
      robotShell(w * 0.97, h * 0.97, d * 0.97);
    }

    instances.forEach(({ geometry, material, matrices }) => {
      const instanceMesh = new THREE.InstancedMesh(geometry, material, matrices.length);
      instanceMesh.castShadow = true;
      instanceMesh.receiveShadow = true;
      instanceMesh.userData.objectId = object.id;
      matrices.forEach((matrix, index) => instanceMesh.setMatrixAt(index, matrix));
      instanceMesh.instanceMatrix.needsUpdate = true;
      group.add(instanceMesh);
    });
    group.position.copy(vec(object.position));
    group.quaternion.copy(quat(object));
    objectsRoot.add(group);
    return {
      group, size: new THREE.Vector3(w, h, d), object, wheelRadius, wheelSpinners,
      visualSize: new THREE.Vector3(w, h + (object.type === 'drive' ? 0.02 : 0), d + (object.type === 'drive' ? 0.018 : 0)),
      visualOffset: new THREE.Vector3(0, object.type === 'drive' ? -0.01 : 0, 0),
      descriptor: `${object.type}|${w},${h},${d}`,
      dispose() {
        group.removeFromParent();
        geometries.forEach((geometry) => geometry.dispose());
        objectMaterials.forEach((material) => material.dispose());
        objectTextures.forEach((texture) => texture.dispose());
      },
    };
  }

  const connectionGeometry = new THREE.CylinderGeometry(1, 1, 1, 20);
  const connectionRingGeometry = new THREE.TorusGeometry(1, 0.14, 8, 24);
  function rebuildConnections() {
    connectionsRoot.clear();
    connectionRecords = (project.connections || []).filter((item) => records.has(item.a) && records.has(item.b)).map((connection) => {
      const group = new THREE.Group();
      const shaft = new THREE.Mesh(connectionGeometry, materials.connection);
      shaft.castShadow = true;
      const collarA = new THREE.Mesh(connectionGeometry, materials.aluminum);
      const collarB = new THREE.Mesh(connectionGeometry, materials.aluminum);
      const bearing = new THREE.Mesh(connectionGeometry, materials.graphite);
      const ringA = new THREE.Mesh(connectionRingGeometry, materials.steel);
      const ringB = new THREE.Mesh(connectionRingGeometry, materials.steel);
      group.add(shaft, collarA, collarB, bearing, ringA, ringB);
      connectionsRoot.add(group);
      return { connection, group, shaft, collarA, collarB, bearing, ringA, ringB };
    });
    updateConnections();
  }

  function surfacePoint(record, direction) {
    const localDirection = direction.clone().applyQuaternion(record.group.quaternion.clone().invert());
    const half = record.size.clone().multiplyScalar(0.5);
    const distances = [
      Math.abs(localDirection.x) > 1e-8 ? half.x / Math.abs(localDirection.x) : Infinity,
      Math.abs(localDirection.y) > 1e-8 ? half.y / Math.abs(localDirection.y) : Infinity,
      Math.abs(localDirection.z) > 1e-8 ? half.z / Math.abs(localDirection.z) : Infinity,
    ];
    return record.group.position.clone().addScaledVector(direction, Math.min(...distances));
  }

  function cylinderBetween(mesh, a, b, radius) {
    const delta = b.clone().sub(a);
    const length = delta.length();
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.scale.set(radius, Math.max(length, 0.001), radius);
    if (length > 1e-8) mesh.quaternion.setFromUnitVectors(UP, delta.multiplyScalar(1 / length));
  }

  function updateConnections() {
    connectionRecords.forEach((record) => {
      const { connection, shaft, collarA, collarB, bearing, ringA, ringB } = record;
      const a = records.get(connection.a);
      const b = records.get(connection.b);
      if (!a || !b) { record.group.visible = false; return; }
      const direction = b.group.position.clone().sub(a.group.position);
      const distance = direction.length();
      if (distance < 0.0001) { record.group.visible = false; return; }
      record.group.visible = true;
      direction.divideScalar(distance);
      let start = surfacePoint(a, direction);
      let end = surfacePoint(b, direction.clone().negate());
      const center = start.clone().add(end).multiplyScalar(0.5);
      const radius = Math.min(a.size.x, a.size.y, a.size.z, b.size.x, b.size.y, b.size.z) * 0.105;
      if (end.clone().sub(start).dot(direction) < radius * 0.3) {
        start = center.clone().addScaledVector(direction, -radius * 0.55);
        end = center.clone().addScaledVector(direction, radius * 0.55);
      }
      cylinderBetween(shaft, start, end, radius * 0.6);
      const shaftQ = new THREE.Quaternion().setFromUnitVectors(UP, direction);
      [collarA, collarB].forEach((collar, index) => {
        collar.position.copy(index ? end : start);
        collar.quaternion.copy(shaftQ);
        collar.scale.set(radius * 1.25, radius * 0.35, radius * 1.25);
      });
      const revolute = connection.type === 'revolute';
      bearing.visible = ringA.visible = ringB.visible = revolute;
      if (revolute) {
        const axis = (connection.axis === 'z' ? FRONT : UP).clone().applyQuaternion(a.group.quaternion);
        bearing.position.copy(center);
        bearing.quaternion.setFromUnitVectors(UP, axis);
        bearing.scale.set(radius * 1.3, radius * 3.6, radius * 1.3);
        [ringA, ringB].forEach((ring, index) => {
          ring.position.copy(center).addScaledVector(axis, (index ? 1 : -1) * radius * 1.4);
          ring.quaternion.setFromUnitVectors(FRONT, axis);
          ring.scale.setScalar(radius * 1.3);
        });
      }
    });
  }

  function updateLabel(record) {
    const key = `${record.object.type}|${record.object.id}`;
    if (key === labelKey) return;
    labelKey = key;
    if (labelTexture) labelTexture.dispose();
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 96;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#263142';
    ctx.beginPath();
    ctx.roundRect(8, 10, 496, 76, 14);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '500 46px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const id = String(record.object.id);
    const text = id.length > 17 ? `${id.slice(0, 14)}…` : id;
    ctx.fillText(text, 256, 50, 460);
    labelTexture = new THREE.CanvasTexture(c);
    labelTexture.colorSpace = THREE.SRGBColorSpace;
    labelMaterial.map = labelTexture;
    labelMaterial.needsUpdate = true;
  }

  function updateSelectionVisual() {
    const record = records.get(selectedId);
    selectionOutline.visible = label.visible = Boolean(record);
    if (!record) return;
    selectionOutline.position.copy(record.visualOffset).applyQuaternion(record.group.quaternion).add(record.group.position);
    selectionOutline.quaternion.copy(record.group.quaternion);
    selectionOutline.scale.copy(record.visualSize).multiplyScalar(1.04);
    const bounds = new THREE.Box3(
      record.visualSize.clone().multiplyScalar(-0.5).add(record.visualOffset), record.visualSize.clone().multiplyScalar(0.5).add(record.visualOffset),
    ).applyMatrix4(new THREE.Matrix4().compose(record.group.position, record.group.quaternion, new THREE.Vector3(1, 1, 1)));
    label.position.copy(record.group.position);
    label.position.y = bounds.max.y + Math.max(0.035, record.size.y * 0.2);
    const distance = camera.position.distanceTo(label.position);
    const scale = Math.max(0.16, distance * 0.14);
    label.scale.set(scale, scale * 96 / 512, 1);
    updateLabel(record);
  }

  function syncTransform() {
    if (simulation || !records.has(selectedId) || !['move', 'rotate'].includes(tool)) {
      transform.detach();
      return;
    }
    transform.setMode(tool === 'rotate' ? 'rotate' : 'translate');
    transform.setSpace('world');
    transform.attach(records.get(selectedId).group);
  }

  function setProject(nextProject) {
    if (disposed) return;
    project = nextProject || { objects: [], connections: [] };
    const wanted = new Set((project.objects || []).map((object) => object.id));
    for (const [id, record] of records) {
      if (!wanted.has(id)) {
        if (transform.object === record.group) transform.detach();
        record.dispose();
        records.delete(id);
      }
    }
    for (const object of project.objects || []) {
      const descriptor = `${object.type}|${dimensions(object).join(',')}`;
      let record = records.get(object.id);
      if (record && record.descriptor !== descriptor) {
        if (transform.object === record.group) transform.detach();
        record.dispose();
        records.delete(object.id);
        record = null;
      }
      if (!record) {
        record = createObject(object);
        records.set(object.id, record);
      }
      record.object = object;
      // No writes back to project: this renderer never relocates an unedited base.
      if (!(dragging && object.id === selectedId)) {
        record.group.position.copy(vec(object.position));
        record.group.quaternion.copy(quat(object));
      }
    }
    if (!records.has(selectedId)) selectedId = null;
    rebuildConnections();
    syncTransform();
    updateSelectionVisual();
    if (!hasFramed && records.size) {
      hasFramed = true;
      fit();
    }
  }

  function setSelection(id) {
    selectedId = records.has(id) ? id : null;
    syncTransform();
    updateSelectionVisual();
  }

  function setTool(nextTool) {
    tool = ['select', 'move', 'rotate', 'place', 'connect'].includes(nextTool) ? nextTool : 'select';
    canvas.style.cursor = tool === 'place' ? 'crosshair' : tool === 'connect' ? 'cell' : 'grab';
    if (tool !== 'place') groundHover.visible = false;
    syncTransform();
  }

  function setSimulation(enabled) {
    simulation = Boolean(enabled);
    syncTransform();
  }

  function updatePoses(objects) {
    if (disposed || !objects) return;
    const poses = Array.isArray(objects) ? objects : Object.entries(objects).map(([id, pose]) => ({ id, ...pose }));
    for (const pose of poses) {
      const record = records.get(pose.id);
      if (!record || (dragging && pose.id === selectedId)) continue;
      const nextPosition = vec(pose.position, record.group.position.toArray());
      if (record.wheelSpinners.length && record.wheelRadius) {
        const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(record.group.quaternion);
        const distance = nextPosition.clone().sub(record.group.position).dot(forward);
        record.wheelSpinners.forEach((spinner) => { spinner.rotation.y += distance / record.wheelRadius; });
      }
      record.group.position.copy(nextPosition);
      if (pose.quaternion || pose.rotation) record.group.quaternion.copy(quat(pose));
    }
    updateConnections();
    updateSelectionVisual();
  }

  function worldBounds() {
    const bounds = new THREE.Box3();
    records.forEach((record) => {
      const local = new THREE.Box3(record.visualSize.clone().multiplyScalar(-0.5).add(record.visualOffset), record.visualSize.clone().multiplyScalar(0.5).add(record.visualOffset));
      const matrix = new THREE.Matrix4().compose(record.group.position, record.group.quaternion, new THREE.Vector3(1, 1, 1));
      bounds.union(local.applyMatrix4(matrix));
    });
    if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-0.6, 0, -0.6), new THREE.Vector3(0.6, 0.3, 0.6));
    return bounds;
  }

  function viewDirection(view) {
    if (view === 'top') return new THREE.Vector3(0, 1, 0.0001).normalize();
    if (view === 'front') return new THREE.Vector3(0, 0.065, 1).normalize();
    return new THREE.Vector3(1, 0.78, 1.15).normalize();
  }

  function fit() {
    if (disposed) return;
    const bounds = worldBounds();
    const center = bounds.getCenter(new THREE.Vector3());
    const extent = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(0.23, extent.length() / 2);
    const halfFov = THREE.MathUtils.degToRad(camera.fov) / 2;
    const minHalfFov = Math.min(halfFov, Math.atan(Math.tan(halfFov) * camera.aspect));
    const distance = radius / Math.sin(minHalfFov) * 1.12;
    orbit.target.copy(center);
    camera.position.copy(center).addScaledVector(viewDirection(currentView), distance);
    camera.near = Math.max(0.002, distance / 700);
    camera.far = Math.max(100, distance * 20);
    camera.updateProjectionMatrix();
    orbit.maxDistance = Math.max(45, distance * 6);
    orbit.update();
    const shadowExtent = Math.max(1.5, extent.length() * 0.75);
    key.position.copy(center).add(new THREE.Vector3(-3.5, 7, 4.5).multiplyScalar(Math.max(0.6, shadowExtent / 4)));
    key.target.position.copy(center);
    Object.assign(key.shadow.camera, { left: -shadowExtent, right: shadowExtent, top: shadowExtent, bottom: -shadowExtent, far: Math.max(30, shadowExtent * 8) });
    key.shadow.camera.updateProjectionMatrix();
    updateSelectionVisual();
  }

  function setView(view) {
    if (!['iso', 'top', 'front'].includes(view)) return;
    currentView = view;
    fit();
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

  function setRay(event) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    return true;
  }

  function hitObject(event) {
    if (!setRay(event)) return null;
    scene.updateMatrixWorld(true);
    const intersections = raycaster.intersectObjects([...records.values()].map((record) => record.group), true);
    for (const hit of intersections) {
      let node = hit.object;
      while (node && node.userData.objectId === undefined) node = node.parent;
      if (node && records.has(node.userData.objectId)) return node.userData.objectId;
    }
    return null;
  }

  function pointerDown(event) {
    canvas.focus({ preventScroll: true });
    pointerStart = { x: event.clientX, y: event.clientY, button: event.button, pointerId: event.pointerId, gizmo: dragging || Boolean(transform.axis && transform.object) };
  }

  function pointerUp(event) {
    if (!pointerStart) return;
    const down = pointerStart;
    pointerStart = null;
    if (down.button !== 0 || down.pointerId !== event.pointerId || down.gizmo || dragging || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
    // The host also uses ground picking to choose a simulation destination.
    // It owns the distinction between a waypoint and an edit; transforms remain disabled.
    if (tool === 'place') {
      if (!setRay(event)) return;
      const point = raycaster.ray.intersectPlane(groundPlane, new THREE.Vector3());
      if (point) onGroundClick([point.x, 0, point.z]);
      return;
    }
    const id = hitObject(event);
    setSelection(id);
    onSelect(id);
  }

  function pointerMove(event) {
    if (event.buttons || dragging) {
      groundHover.visible = false;
      return;
    }
    if (tool === 'place') {
      canvas.style.cursor = 'crosshair';
      const point = setRay(event) ? raycaster.ray.intersectPlane(groundPlane, new THREE.Vector3()) : null;
      groundHover.visible = Boolean(point);
      if (point) groundHover.position.set(point.x, 0.004, point.z);
      return;
    }
    groundHover.visible = false;
    const id = hitObject(event);
    if (id === hoverId && tool !== 'place') return;
    hoverId = id;
    canvas.style.cursor = tool === 'place' ? 'crosshair' : tool === 'connect' ? 'cell' : id !== null ? 'pointer' : 'grab';
  }

  function pointerCancel() { pointerStart = null; }
  function pointerLeave() { groundHover.visible = false; hoverId = null; }

  function draggingChanged(event) {
    dragging = Boolean(event.value);
    orbit.enabled = !dragging;
  }

  function transformDown() {
    if (!transform.object || simulation) return;
    transformStart = {
      id: selectedId,
      position: transform.object.position.clone(),
      quaternion: transform.object.quaternion.clone(),
    };
  }

  function transformChanged() {
    updateConnections();
    updateSelectionVisual();
  }

  function transformUp() {
    const start = transformStart;
    transformStart = null;
    // Three emits mouseUp before dragging-changed(false). The host may reject
    // this edit and synchronously call setProject to restore its valid pose;
    // release our preview guard now so that rollback is applied immediately.
    dragging = false;
    orbit.enabled = true;
    if (!start || simulation || !records.has(start.id)) return;
    const group = records.get(start.id).group;
    const changed = group.position.distanceToSquared(start.position) > 1e-12 || 1 - Math.abs(group.quaternion.dot(start.quaternion)) > 1e-10;
    if (!changed) return;
    const rotation = new THREE.Euler().setFromQuaternion(group.quaternion, 'XYZ');
    onTransform(start.id, { position: group.position.toArray(), rotation: [rotation.x, rotation.y, rotation.z] });
  }

  transform.addEventListener('dragging-changed', draggingChanged);
  transform.addEventListener('mouseDown', transformDown);
  transform.addEventListener('objectChange', transformChanged);
  transform.addEventListener('mouseUp', transformUp);
  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('pointercancel', pointerCancel);
  canvas.addEventListener('pointerleave', pointerLeave);
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  function animate() {
    if (disposed) return;
    frame = requestAnimationFrame(animate);
    orbit.update(Math.min(elapsed.getDelta(), 0.05));
    if (selectedId !== null) updateSelectionVisual();
    renderer.render(scene, camera);
  }
  animate();

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    canvas.removeEventListener('pointerdown', pointerDown);
    canvas.removeEventListener('pointerup', pointerUp);
    canvas.removeEventListener('pointermove', pointerMove);
    canvas.removeEventListener('pointercancel', pointerCancel);
    canvas.removeEventListener('pointerleave', pointerLeave);
    transform.removeEventListener('dragging-changed', draggingChanged);
    transform.removeEventListener('mouseDown', transformDown);
    transform.removeEventListener('objectChange', transformChanged);
    transform.removeEventListener('mouseUp', transformUp);
    transform.detach();
    transform.dispose();
    orbit.dispose();
    records.forEach((record) => record.dispose());
    records.clear();
    ownedMaterials.forEach((material) => material.dispose());
    ownedTextures.forEach((texture) => texture.dispose());
    labelTexture?.dispose();
    selectionGeometry.dispose();
    connectionGeometry.dispose();
    connectionRingGeometry.dispose();
    waypointRingGeometry.dispose();
    waypointDotGeometry.dispose();
    hoverRingGeometry.dispose();
    hoverDiscGeometry.dispose();
    floor.geometry.dispose();
    [minorGrid, majorGrid].forEach((item) => { item.geometry.dispose(); item.material.dispose(); });
    environment.dispose();
    key.shadow.dispose();
    renderer.dispose();
    canvas.remove();
  }

  return {
    setProject, setSelection, setTool, setSimulation, updatePoses, setView, fit, resize, dispose,
    setGrid(visible) { grid.visible = Boolean(visible); },
    capture() { renderer.render(scene, camera); return canvas.toDataURL('image/png'); },
    setWaypoint(position) {
      waypoint.visible = position !== null && position !== undefined;
      if (waypoint.visible) {
        waypoint.position.copy(vec(position));
        waypoint.position.y = Math.max(0.004, waypoint.position.y + 0.004);
      }
    },
  };
}
