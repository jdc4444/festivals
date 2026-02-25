import * as THREE from "./vendor/three.module.js";
import {
  getEligibleFestivalIndices,
  getFestivals,
  computeSurfacePosition,
} from "./festival-fireworks.js";

// ── Config ──

const DOT_SIZE = 0.012;
const LABEL_SCALE = 0.022;
const LABEL_OFFSET = 0.006; // tiny lift above surface
const OVERLAP_PADDING = 6; // pixels of screen-space padding between labels

// ── State ──

let labelGroup = null;
let dotsMesh = null;
let dotsGeo = null;
let labelMeshes = []; // { mesh, worldPos, screenBox, festival }
let currentEligibleKey = "";
let textureCache = new Map();
let _camera = null;
let _renderer = null;

// ── Texture rendering ──

function createLabelTexture(text) {
  const cached = textureCache.get(text);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const fontSize = 28;
  const font = `700 ${fontSize}px "Avenir Next", Avenir, "Segoe UI", sans-serif`;
  ctx.font = font;
  const metrics = ctx.measureText(text);
  const padding = 4;
  canvas.width = Math.ceil(metrics.width + padding * 2);
  canvas.height = Math.ceil(fontSize * 1.25 + padding * 2);

  ctx.font = font;
  ctx.fillStyle = "rgba(10, 18, 30, 0.82)";
  ctx.textBaseline = "middle";
  ctx.fillText(text, padding, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const result = { texture, width: canvas.width, height: canvas.height };
  textureCache.set(text, result);
  return result;
}

// ── Build tangent frame for surface-mapped orientation ──

function buildTangentFrame(normal) {
  const ref = Math.abs(normal.y) < 0.99
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(1, 0, 0);
  const tangent = new THREE.Vector3().crossVectors(ref, normal).normalize();
  const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize();
  return { tangent, bitangent };
}

// ── Public API ──

export function createLabelSystem(globeGroup, heightSampler, landMaskData, landMaskWidth, landMaskHeight, terrainExag, camera, renderer) {
  _camera = camera;
  _renderer = renderer;

  if (labelGroup) return;

  labelGroup = new THREE.Group();
  labelGroup.name = "festival-labels";
  globeGroup.add(labelGroup);

  // Dots mesh
  dotsGeo = new THREE.BufferGeometry();
  dotsGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
  const dotsMat = new THREE.PointsMaterial({
    color: 0x000000,
    size: DOT_SIZE,
    sizeAttenuation: true,
    depthTest: true,
    depthWrite: false,
  });
  dotsMesh = new THREE.Points(dotsGeo, dotsMat);
  dotsMesh.renderOrder = 4;
  labelGroup.add(dotsMesh);
}

export function updateLabels() {
  if (!labelGroup) return;

  const festivals = getFestivals();
  if (!festivals) return;

  const eligible = getEligibleFestivalIndices();
  const key = eligible.join(",");
  if (key === currentEligibleKey) return;
  currentEligibleKey = key;

  // ── Rebuild dots (all eligible) ──
  const positions = new Float32Array(eligible.length * 3);
  const surfaceData = [];

  for (let i = 0; i < eligible.length; i++) {
    const f = festivals[eligible[i]];
    const { position, normal } = computeSurfacePosition(f);
    positions[i * 3] = position.x;
    positions[i * 3 + 1] = position.y;
    positions[i * 3 + 2] = position.z;
    surfaceData.push({ position, normal, festival: f, idx: eligible[i] });
  }

  dotsGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  dotsGeo.setDrawRange(0, eligible.length);
  dotsGeo.attributes.position.needsUpdate = true;
  dotsGeo.computeBoundingSphere();

  // ── Rebuild labels (ALL festivals with city names) ──
  for (const entry of labelMeshes) {
    labelGroup.remove(entry.mesh);
    entry.mesh.material.dispose();
    entry.mesh.geometry.dispose();
  }
  labelMeshes = [];

  // Sort by interest descending so higher-interest labels win overlap tests
  const labeled = surfaceData
    .filter(d => d.festival.city)
    .sort((a, b) => b.festival.interest - a.festival.interest);

  for (const { position, normal, festival } of labeled) {
    const { texture, width, height } = createLabelTexture(festival.city);
    const { tangent, bitangent } = buildTangentFrame(normal);

    const aspect = width / height;
    const planeW = LABEL_SCALE * aspect;
    const planeH = LABEL_SCALE;

    const geo = new THREE.PlaneGeometry(planeW, planeH);
    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geo, mat);

    // Position slightly above surface
    mesh.position.copy(position).addScaledVector(normal, LABEL_OFFSET);

    // Orient: plane lies on the surface tangent plane, text reads along tangent direction
    // Build rotation matrix from tangent frame
    const m = new THREE.Matrix4();
    // columns: tangent (X), bitangent (Y), normal (Z)
    m.makeBasis(tangent, bitangent, normal);
    mesh.rotation.setFromRotationMatrix(m);

    // Store world position for overlap testing
    const worldPos = mesh.position.clone();

    labelGroup.add(mesh);
    labelMeshes.push({
      mesh,
      worldPos,
      festival,
      halfW: planeW * 0.5,
      halfH: planeH * 0.5,
    });
  }
}

// ── Per-frame overlap culling (call from render loop) ──

const _projVec = new THREE.Vector3();
const _screenBoxes = [];

export function updateLabelVisibility(camera, globeGroup) {
  if (!labelMeshes.length || !camera) return;

  const w = _renderer ? _renderer.domElement.clientWidth : window.innerWidth;
  const h = _renderer ? _renderer.domElement.clientHeight : window.innerHeight;
  const halfW = w * 0.5;
  const halfH = h * 0.5;

  _screenBoxes.length = 0;

  // Globe center in world space for back-face check
  const globeCenter = new THREE.Vector3();
  globeGroup.getWorldPosition(globeCenter);
  const camPos = camera.position;

  for (const entry of labelMeshes) {
    // Project world position to screen
    const worldP = _projVec.copy(entry.worldPos);
    // Transform from labelGroup (globeGroup) local to world
    labelGroup.localToWorld(worldP);

    // Back-face culling: is this point on the side facing the camera?
    const toCamera = new THREE.Vector3().subVectors(camPos, worldP);
    const surfaceNormal = new THREE.Vector3().subVectors(worldP, globeCenter).normalize();
    const dot = toCamera.dot(surfaceNormal);
    if (dot < 0.05) {
      entry.mesh.visible = false;
      continue;
    }

    // Project to NDC
    const projected = worldP.project(camera);
    const sx = projected.x * halfW + halfW;
    const sy = -projected.y * halfH + halfH;

    // Approximate screen-space bounding box (rough estimate from scale)
    const dist = camPos.distanceTo(worldP);
    const pixelScale = (halfH * 2) / (2 * dist * Math.tan(camera.fov * Math.PI / 360));
    const bw = entry.halfW * pixelScale + OVERLAP_PADDING;
    const bh = entry.halfH * pixelScale + OVERLAP_PADDING;

    const box = { x: sx, y: sy, hw: bw, hh: bh };

    // Check overlap with already-placed labels
    let overlapping = false;
    for (const placed of _screenBoxes) {
      if (
        Math.abs(box.x - placed.x) < (box.hw + placed.hw) &&
        Math.abs(box.y - placed.y) < (box.hh + placed.hh)
      ) {
        overlapping = true;
        break;
      }
    }

    if (overlapping) {
      entry.mesh.visible = false;
    } else {
      entry.mesh.visible = true;
      _screenBoxes.push(box);
    }
  }
}

export function destroyLabels() {
  if (!labelGroup) return;

  for (const entry of labelMeshes) {
    labelGroup.remove(entry.mesh);
    entry.mesh.material.dispose();
    entry.mesh.geometry.dispose();
  }
  labelMeshes = [];

  if (dotsGeo) {
    dotsGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
    dotsGeo.setDrawRange(0, 0);
  }

  currentEligibleKey = "";
}

export function setLabelTerrainExag(exag) {
  currentEligibleKey = ""; // force rebuild
}
