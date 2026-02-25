import * as THREE from "./vendor/three.module.js";

// ── Constants ──

const RADIUS = 1.2;
const LONGITUDE_ORIENTATION = -1;
const TERRAIN_EXAGGERATION_MIN = 0.4;
const TERRAIN_EXAGGERATION_MAX = 2.4;
const BASE_RELIEF_DISPLACEMENT_SCALE = 0.115;

// Confetti-scale: slightly smaller than the original big bursts
const S = 0.005;
const GRAVITY = 9.8 * S;
const PEAK_MIN = 20 * S;          // 0.10
const PEAK_MAX = 35 * S;          // 0.175
const EXPLODE_SPEED_MIN = 8 * S;  // 0.04
const EXPLODE_SPEED_MAX = 20 * S; // 0.10
const DRAG = 0.96;
const LATERAL_WOBBLE = 0.3 * S;

const MAX_PARTICLES = 24000;

// How many days around the current day a festival is eligible to fire
const DATE_WINDOW = 5;

// Confetti palette: no red, purple, orange — bright festive blues, greens, golds, pinks, cyans
const PALETTES = [
  [0.15, 0.55, 0.95],  // sky blue
  [0.05, 0.75, 0.35],  // emerald
  [0.92, 0.82, 0.12],  // gold
  [0.0, 0.78, 0.88],   // cyan
  [0.95, 0.45, 0.65],  // pink
  [0.25, 0.35, 0.85],  // royal blue
  [0.4, 0.85, 0.4],    // lime green
  [0.15, 0.62, 0.72],  // teal
];

// ── Module state ──

let festivals = null;
let fireworksPoints = null;
let particles = [];
let currentExaggeration = TERRAIN_EXAGGERATION_MIN;
let _heightSampler = null;
let _landMaskData = null;
let _landMaskWidth = 0;
let _landMaskHeight = 0;
let currentDayOfYear = 0;

// Per-festival independent re-launch timers (continuous flow)
let festivalNextLaunch = null; // Float32Array — next launch time per festival
let lastEligible = [];
const RELAUNCH_MIN = 1.5; // seconds between re-launches per festival
const RELAUNCH_MAX = 3.5;

// Per-festival surface positions (for click detection)
let festivalPositions = null; // Float32Array(n*3), world-space positions on surface

// Pre-computed per-festival: dayOfYear for eligible window
let festivalDays = null; // Int16Array — day of year (0-364) per festival, -1 if no date

// ── Duplicated helpers (same as globe.js, avoids refactoring exports) ──

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function sampleMaskNearest(maskData, width, height, u, v) {
  if (!maskData) return 0;
  const wrappedU = ((u % 1) + 1) % 1;
  const clampedV = clamp(v, 0, 1);
  const x = clamp(Math.round(wrappedU * (width - 1)), 0, width - 1);
  const y = clamp(Math.round(clampedV * (height - 1)), 0, height - 1);
  return maskData[y * width + x] / 255;
}

function lonLatToDirection(lonDeg, latDeg) {
  const lon = THREE.MathUtils.degToRad(lonDeg * LONGITUDE_ORIENTATION);
  const lat = THREE.MathUtils.degToRad(latDeg);
  const cosLat = Math.cos(lat);
  return new THREE.Vector3(cosLat * Math.cos(lon), Math.sin(lat), cosLat * Math.sin(lon));
}

function decodeSignedElevation(heightValue) {
  const seaLevel = 0.5;
  if (heightValue >= seaLevel) return (heightValue - seaLevel) / Math.max(1e-6, 1 - seaLevel);
  return (heightValue - seaLevel) / Math.max(1e-6, seaLevel);
}

function computeLandRelief(heightValue, landWeight = 1) {
  const signedElevation = decodeSignedElevation(heightValue);
  const landElevation = Math.max(0, signedElevation);
  const base = Math.pow(landElevation, 0.98);
  const summitMask = smoothstep(0.56, 0.98, landElevation);
  const summitBoost = Math.pow(summitMask, 2.4) * 0.33;
  return clamp01(base + summitBoost) * landWeight;
}

function computeShapedReliefDisplacement(reliefValue, exaggeration, contrast) {
  const r = clamp01(reliefValue);
  const ex = clamp(Number(exaggeration) || 1, TERRAIN_EXAGGERATION_MIN, TERRAIN_EXAGGERATION_MAX);
  const ctr = clamp(Number(contrast) || 1, 0.35, 2.5);
  const reliefGain = 0.72 + ctr * 0.28;
  const lowExBoost = clamp((1 - ex) / Math.max(1e-6, 1 - TERRAIN_EXAGGERATION_MIN), 0, 1);
  const peakMask = smoothstep(0.58, 0.985, r);
  const ridgeMask = smoothstep(0.42, 0.9, r);
  const summitLift = Math.pow(peakMask, 2.5) * (0.02 + lowExBoost * 0.16);
  const ridgeCut = Math.pow(ridgeMask, 1.8) * peakMask * (0.03 + lowExBoost * 0.07);
  const shapedRelief = clamp01(r + summitLift - ridgeCut);
  const apexMask = smoothstep(0.86, 1, shapedRelief);
  const apexClip = Math.pow(apexMask, 1.35) * (0.026 + lowExBoost * 0.034);
  const softenedRelief = clamp01(shapedRelief - apexClip);
  const peakCompensation = 1 + lowExBoost * Math.pow(peakMask, 1.6) * 0.16;
  return softenedRelief * BASE_RELIEF_DISPLACEMENT_SCALE * ex * reliefGain * peakCompensation;
}

// ── Helpers ──

function rand(a, b) { return a + Math.random() * (b - a); }

function dateToDayOfYear(dateStr) {
  if (!dateStr) return -1;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return -1;
  const start = new Date(d.getFullYear(), 0, 0);
  const diff = d - start;
  return Math.floor(diff / (1000 * 60 * 60 * 24)) - 1; // 0-based
}

function buildTangentFrame(n) {
  const ref = Math.abs(n.y) < 0.99
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(1, 0, 0);
  const tangent = new THREE.Vector3().crossVectors(ref, n).normalize();
  const bitangent = new THREE.Vector3().crossVectors(n, tangent);
  return { tangent, bitangent };
}

export function computeSurfacePosition(festival) {
  const dir = lonLatToDirection(festival.lng, festival.lat);
  const lon = Math.atan2(dir.z, dir.x) * LONGITUDE_ORIENTATION;
  const lat = Math.asin(clamp(dir.y, -1, 1));
  const u = lon / (Math.PI * 2) + 0.5;
  const v = 0.5 - lat / Math.PI;
  const heightValue = _heightSampler.sample(u, v);
  const sampledLand = sampleMaskNearest(_landMaskData, _landMaskWidth, _landMaskHeight, u, v);
  const land = _landMaskData ? sampledLand : (heightValue > 0.5002 ? 1 : 0);
  const relief = computeLandRelief(heightValue, land);
  const displacement = computeShapedReliefDisplacement(relief, currentExaggeration, 1);
  const surfaceRadius = RADIUS + displacement + 0.003;
  return {
    position: dir.clone().multiplyScalar(surfaceRadius),
    normal: dir.clone(),
  };
}

// ── Eligible festivals for current day ──

function getEligibleFestivals() {
  if (!festivals || !festivalDays) return [];
  const eligible = [];
  for (let i = 0; i < festivals.length; i++) {
    const fDay = festivalDays[i];
    if (fDay < 0) continue; // no date
    let diff = Math.abs(fDay - currentDayOfYear);
    if (diff > 182) diff = 365 - diff; // wrap around year boundary
    if (diff <= DATE_WINDOW) {
      eligible.push(i);
    }
  }
  return eligible;
}

// ── Shader — confetti style: sharp-edged squares, no glow ──

const VERTEX_SHADER = `
attribute float size;
attribute float alpha;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = color;
  vAlpha = alpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * (42.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAGMENT_SHADER = `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 p = gl_PointCoord - vec2(0.5);
  // Rotated square mask for confetti look
  float angle = vAlpha * 3.14;
  float ca = cos(angle), sa = sin(angle);
  vec2 rp = vec2(ca * p.x - sa * p.y, sa * p.x + ca * p.y);
  float box = max(abs(rp.x), abs(rp.y));
  if (box > 0.42) discard;
  float edge = 1.0 - smoothstep(0.32, 0.42, box);
  vec3 bright = mix(vColor, vec3(1.0), 0.25);
  gl_FragColor = vec4(bright, vAlpha * edge * 0.92);
}
`;

// ── Particle buffers ──

let pos, col, siz, alp, geo;

// ── Launch & explode ──

function launch(festivalIndex) {
  const festival = festivals[festivalIndex];
  const { position, normal } = computeSurfacePosition(festival);
  const { tangent, bitangent } = buildTangentFrame(normal);

  // Store surface position for click detection
  if (festivalPositions) {
    festivalPositions[festivalIndex * 3] = position.x;
    festivalPositions[festivalIndex * 3 + 1] = position.y;
    festivalPositions[festivalIndex * 3 + 2] = position.z;
  }

  const peakH = rand(PEAK_MIN, PEAK_MAX);
  const vUp = Math.sqrt(2 * GRAVITY * peakH);
  const color = PALETTES[Math.floor(Math.random() * PALETTES.length)];

  // Rocket velocity: mostly along surface normal with tiny lateral wobble
  const vx = normal.x * vUp + tangent.x * rand(-LATERAL_WOBBLE, LATERAL_WOBBLE) + bitangent.x * rand(-LATERAL_WOBBLE, LATERAL_WOBBLE);
  const vy = normal.y * vUp + tangent.y * rand(-LATERAL_WOBBLE, LATERAL_WOBBLE) + bitangent.y * rand(-LATERAL_WOBBLE, LATERAL_WOBBLE);
  const vz = normal.z * vUp + tangent.z * rand(-LATERAL_WOBBLE, LATERAL_WOBBLE) + bitangent.z * rand(-LATERAL_WOBBLE, LATERAL_WOBBLE);

  particles.push({
    x: position.x, y: position.y, z: position.z,
    vx, vy, vz,
    gx: -normal.x * GRAVITY,
    gy: -normal.y * GRAVITY,
    gz: -normal.z * GRAVITY,
    nx: normal.x, ny: normal.y, nz: normal.z,
    tx: tangent.x, ty: tangent.y, tz: tangent.z,
    bx: bitangent.x, by: bitangent.y, bz: bitangent.z,
    r: 0.7, g: 0.65, b: 0.3,  // gold trail
    life: vUp / GRAVITY,
    maxLife: vUp / GRAVITY,
    size: 2.5,
    rocket: true,
    color,
    festivalIndex,
  });
}

function explode(p) {
  const ox = p.x, oy = p.y, oz = p.z;
  const [cr, cg, cb] = p.color;
  // Fewer particles per burst for confetti look
  const n = 40 + Math.floor(Math.random() * 30);
  const style = Math.random();

  for (let i = 0; i < n; i++) {
    let localX, localY, localZ;

    if (style < 0.5) {
      // Sphere scatter
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const s = rand(EXPLODE_SPEED_MIN, EXPLODE_SPEED_MAX);
      localX = Math.sin(phi) * Math.cos(theta) * s;
      localY = Math.sin(phi) * Math.sin(theta) * s;
      localZ = Math.cos(phi) * s;
    } else {
      // Upward fountain
      const theta = Math.random() * Math.PI * 2;
      const s = rand(EXPLODE_SPEED_MIN * 0.6, EXPLODE_SPEED_MAX * 0.5);
      const upS = rand(EXPLODE_SPEED_MIN, EXPLODE_SPEED_MAX * 0.8);
      localX = Math.cos(theta) * s;
      localY = upS; // biased upward along normal
      localZ = Math.sin(theta) * s;
    }

    // Transform local frame to world: tangent=X, normal=Y, bitangent=Z
    const vx = p.tx * localX + p.nx * localY + p.bx * localZ;
    const vy = p.ty * localX + p.ny * localY + p.by * localZ;
    const vz = p.tz * localX + p.nz * localY + p.bz * localZ;

    const life = rand(1.0, 2.2);
    // Mix individual color variation for confetti
    const colorChoice = Math.random() < 0.3 ? PALETTES[Math.floor(Math.random() * PALETTES.length)] : p.color;
    const [cr2, cg2, cb2] = colorChoice;

    particles.push({
      x: ox, y: oy, z: oz,
      vx, vy, vz,
      gx: p.gx, gy: p.gy, gz: p.gz,
      nx: 0, ny: 0, nz: 0, tx: 0, ty: 0, tz: 0, bx: 0, by: 0, bz: 0,
      r: Math.min(1, Math.max(0, cr2 + rand(-0.1, 0.1))),
      g: Math.min(1, Math.max(0, cg2 + rand(-0.1, 0.1))),
      b: Math.min(1, Math.max(0, cb2 + rand(-0.1, 0.1))),
      life, maxLife: life,
      size: rand(1.2, 2.8),
      rocket: false,
      color: null,
      festivalIndex: p.festivalIndex,
    });
  }
}

// ── Public API ──

export async function loadFestivalData() {
  const resp = await fetch("./data/festivals-2026.json");
  if (!resp.ok) throw new Error(`Failed to load festivals: ${resp.status}`);
  festivals = await resp.json();

  // Pre-compute day of year for each festival
  festivalDays = new Int16Array(festivals.length);
  for (let i = 0; i < festivals.length; i++) {
    festivalDays[i] = dateToDayOfYear(festivals[i].start);
  }

  // Allocate surface positions for click detection
  festivalPositions = new Float32Array(festivals.length * 3);

  // Allocate per-festival re-launch timers (all start at 0 = launch immediately)
  festivalNextLaunch = new Float32Array(festivals.length);

  // Default to today's day of year
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 0);
  currentDayOfYear = Math.floor((now - startOfYear) / (1000 * 60 * 60 * 24)) - 1;

  return festivals;
}

export function createFireworks({
  radius,
  heightSampler,
  landMaskData,
  landMaskWidth,
  landMaskHeight,
  terrainExaggeration,
}) {
  _heightSampler = heightSampler;
  _landMaskData = landMaskData;
  _landMaskWidth = landMaskWidth;
  _landMaskHeight = landMaskHeight;
  currentExaggeration = terrainExaggeration;

  pos = new Float32Array(MAX_PARTICLES * 3);
  col = new Float32Array(MAX_PARTICLES * 3);
  siz = new Float32Array(MAX_PARTICLES);
  alp = new Float32Array(MAX_PARTICLES);

  geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("size", new THREE.BufferAttribute(siz, 1));
  geo.setAttribute("alpha", new THREE.BufferAttribute(alp, 1));

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });

  fireworksPoints = new THREE.Points(geo, material);
  fireworksPoints.renderOrder = 3;
  particles = [];

  // Pre-compute surface positions for all eligible festivals (for immediate click detection)
  if (festivalPositions && _heightSampler) {
    const eligible = getEligibleFestivals();
    lastEligible = eligible;
    for (const idx of eligible) {
      const { position } = computeSurfacePosition(festivals[idx]);
      festivalPositions[idx * 3] = position.x;
      festivalPositions[idx * 3 + 1] = position.y;
      festivalPositions[idx * 3 + 2] = position.z;
    }
  }

  return fireworksPoints;
}

export function updateFireworks(dt) {
  if (!fireworksPoints || !festivals) return;

  // Per-festival continuous launching: each eligible festival has its own timer
  const now = performance.now() / 1000;
  const eligible = getEligibleFestivals();
  lastEligible = eligible;
  for (const idx of eligible) {
    if (now >= festivalNextLaunch[idx]) {
      launch(idx);
      // Stagger re-launch so confetti flows continuously
      festivalNextLaunch[idx] = now + rand(RELAUNCH_MIN, RELAUNCH_MAX);
    }
  }

  // Update particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;

    if (p.life <= 0) {
      if (p.rocket) explode(p);
      particles.splice(i, 1);
      continue;
    }

    // Gravity (toward globe center, constant direction per-launch)
    p.vx += p.gx * dt;
    p.vy += p.gy * dt;
    p.vz += p.gz * dt;

    // Drag (explosion particles only — heavier for confetti flutter)
    if (!p.rocket) {
      const d = Math.pow(DRAG, dt * 60);
      p.vx *= d; p.vy *= d; p.vz *= d;
      // Confetti flutter: tiny random lateral perturbation
      p.vx += rand(-0.001, 0.001);
      p.vy += rand(-0.001, 0.001);
      p.vz += rand(-0.001, 0.001);
    }

    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;

    // Rocket trail (small confetti sparks)
    if (p.rocket && Math.random() < 0.3) {
      particles.push({
        x: p.x + rand(-0.001, 0.001), y: p.y + rand(-0.001, 0.001), z: p.z + rand(-0.001, 0.001),
        vx: rand(-0.001, 0.001), vy: rand(-0.001, 0.001), vz: rand(-0.001, 0.001),
        gx: p.gx * 0.2, gy: p.gy * 0.2, gz: p.gz * 0.2,
        nx: 0, ny: 0, nz: 0, tx: 0, ty: 0, tz: 0, bx: 0, by: 0, bz: 0,
        r: 0.7, g: 0.65, b: 0.3,
        life: rand(0.1, 0.25), maxLife: 0.2,
        size: rand(0.4, 0.8),
        rocket: false,
        color: null,
        festivalIndex: -1,
      });
    }
  }

  // Overflow protection
  while (particles.length > MAX_PARTICLES) particles.shift();

  // Write buffers
  const n = Math.min(particles.length, MAX_PARTICLES);
  for (let i = 0; i < MAX_PARTICLES; i++) {
    if (i < n) {
      const p = particles[i];
      const fade = Math.max(0, p.life / p.maxLife);
      pos[i * 3] = p.x;
      pos[i * 3 + 1] = p.y;
      pos[i * 3 + 2] = p.z;
      col[i * 3] = p.r;
      col[i * 3 + 1] = p.g;
      col[i * 3 + 2] = p.b;
      siz[i] = p.size * (0.4 + 0.6 * fade);
      alp[i] = fade * fade;
    } else {
      alp[i] = 0;
      siz[i] = 0;
    }
  }

  geo.attributes.position.needsUpdate = true;
  geo.attributes.color.needsUpdate = true;
  geo.attributes.size.needsUpdate = true;
  geo.attributes.alpha.needsUpdate = true;
}

export function setTerrainExaggeration(exag) {
  currentExaggeration = exag;
}

export function setDayOfYear(day) {
  currentDayOfYear = clamp(Math.round(day), 0, 364);
  // Reset all per-festival timers so new eligible festivals launch immediately
  if (festivalNextLaunch) festivalNextLaunch.fill(0);
  // Pre-compute surface positions for all eligible festivals (for immediate click detection)
  if (festivalPositions && _heightSampler) {
    const eligible = getEligibleFestivals();
    lastEligible = eligible;
    for (const idx of eligible) {
      const { position } = computeSurfacePosition(festivals[idx]);
      festivalPositions[idx * 3] = position.x;
      festivalPositions[idx * 3 + 1] = position.y;
      festivalPositions[idx * 3 + 2] = position.z;
    }
  }
}

export function getFireworksPoints() {
  return fireworksPoints;
}

// ── Click detection: find nearest festival to a world-space ray intersection ──

export function hitTestFestival(raycaster, globeGroup) {
  if (!festivals || !festivalPositions) return null;
  const eligible = lastEligible.length > 0 ? lastEligible : getEligibleFestivals();
  if (eligible.length === 0) return null;

  // Intersect ray with sphere slightly above globe surface
  const sphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), RADIUS + 0.06);
  const intersection = new THREE.Vector3();
  // Transform ray into globeGroup local space
  const inverseMatrix = new THREE.Matrix4().copy(globeGroup.matrixWorld).invert();
  const localRay = raycaster.ray.clone().applyMatrix4(inverseMatrix);

  if (!localRay.intersectSphere(sphere, intersection)) return null;

  // Find nearest eligible festival to the intersection point
  let bestDist = Infinity;
  let bestIdx = -1;
  for (const idx of eligible) {
    const px = festivalPositions[idx * 3];
    const py = festivalPositions[idx * 3 + 1];
    const pz = festivalPositions[idx * 3 + 2];
    // Skip if position not yet computed
    if (px === 0 && py === 0 && pz === 0) continue;
    const dx = intersection.x - px;
    const dy = intersection.y - py;
    const dz = intersection.z - pz;
    const dist = dx * dx + dy * dy + dz * dz;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = idx;
    }
  }

  // Threshold: ~8 degrees arc on the globe surface
  const threshold = 0.04;
  if (bestIdx >= 0 && bestDist < threshold) {
    return festivals[bestIdx];
  }
  return null;
}

export function getFestivals() {
  return festivals;
}

export function getEligibleFestivalIndices() {
  return lastEligible.length > 0 ? lastEligible : getEligibleFestivals();
}
