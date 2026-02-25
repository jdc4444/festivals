// ── Thermal Layer for Porcelain Globe ──
// Data loading, atlas management, and texture integration.
// Ported & adapted from thermal globe's globe-texture.ts.

import {
  COLORWAY_MAP,
  NUM_POINTS,
  renderPixelData,
  tempToRGB,
} from "./thermal-render.js";

export { COLORWAY_MAP, tempToRGB };

// ── Atlas Constants (must match thermal-worker.js) ──

const ATLAS_FRAME_W = 512;
const ATLAS_FRAME_H = 256;
const ATLAS_COLS = 16;

// ── Module State ──

let worker = null;
let atlasTexture = null;
let atlasNumDays = 0;
let atlasRows = 0;

// ── Land Mask (set by setLandMask, used to stamp ocean pixels white) ──
let _landMask = null;       // Uint8Array (red channel: 255=land, 0=ocean)
let _landMaskW = 0;
let _landMaskH = 0;

/** Register the porcelain globe's land mask for ocean masking. */
export function setLandMask(mask, w, h) {
  _landMask = mask;
  _landMaskW = w;
  _landMaskH = h;
}

/**
 * Apply the land mask to RGBA pixel data (equirectangular).
 * Ocean pixels (mask=0) become white (255,255,255).
 */
function applyLandMaskToPixels(data, w, h) {
  if (!_landMask) return;
  for (let y = 0; y < h; y++) {
    // Map pixel row to mask row (bilinear nearest)
    const maskY = Math.min(_landMaskH - 1, Math.round(y / h * _landMaskH));
    for (let x = 0; x < w; x++) {
      const maskX = Math.min(_landMaskW - 1, Math.round(x / w * _landMaskW));
      const land = _landMask[maskY * _landMaskW + maskX];
      if (land < 128) {
        // Ocean → white
        const idx = (y * w + x) * 4;
        data[idx] = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
      }
    }
  }
}

/**
 * Apply the land mask to an atlas canvas (multiple tiles arranged in grid).
 * Re-draws ocean pixels as white on each tile.
 */
function applyLandMaskToAtlasCanvas(ctx, numDays, frameW, frameH, cols) {
  if (!_landMask) return;
  for (let day = 0; day < numDays; day++) {
    const col = day % cols;
    const row = Math.floor(day / cols);
    const ox = col * frameW;
    const oy = row * frameH;
    const imgData = ctx.getImageData(ox, oy, frameW, frameH);
    applyLandMaskToPixels(imgData.data, frameW, frameH);
    ctx.putImageData(imgData, ox, oy);
  }
}

// ── Data Loading ──

export async function loadThermalData() {
  const [binResp, datesResp] = await Promise.all([
    fetch("./data/globe-grid.bin"),
    fetch("./data/globe-dates.json"),
  ]);

  if (!binResp.ok) throw new Error(`Failed to load grid binary: ${binResp.status}`);
  if (!datesResp.ok) throw new Error(`Failed to load grid dates: ${datesResp.status}`);

  const [buffer, dateLabels] = await Promise.all([
    binResp.arrayBuffer(),
    datesResp.json(),
  ]);

  const header = new DataView(buffer, 0, 8);
  const numDays = header.getUint16(0, true);
  const numPoints = header.getUint16(2, true);

  console.log(`Thermal grid: ${numDays} days x ${numPoints} pts (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB)`);

  const allTemps = new Float32Array(buffer, 8);

  return { allTemps, numDays, numPoints, dateLabels };
}

// ── IndexedDB Cache ──

const DB_NAME = "porcelain-thermal";
const DB_STORE = "textures";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function atlasKey(opts) {
  const stops = opts.customStops ? JSON.stringify(opts.customStops) : opts.colorway;
  return `atlas-v2-pot-${stops}-${opts.blurRadius}`;
}

async function loadAtlasCache(key) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const req = tx.objectStore(DB_STORE).get(key);
      req.onsuccess = () => {
        const cached = req.result;
        resolve(cached ? cached.buffer : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

async function saveAtlasCache(key, buffer, numDays) {
  try {
    const db = await openDB();
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put({ buffer, numDays }, key);
  } catch { /* ignore */ }
}

// ── Atlas Texture Creation ──

export async function createAtlasTexture(buffer, numDays, THREE) {
  const blob = new Blob([buffer], { type: "image/jpeg" });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Atlas image load failed"));
    img.src = url;
  });
  URL.revokeObjectURL(url);

  console.log(`Thermal atlas: ${img.width}x${img.height}`);

  // Draw atlas onto canvas so we can apply the land mask
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  // Apply land mask to each tile (ocean → white)
  if (_landMask) {
    applyLandMaskToAtlasCanvas(ctx, numDays, ATLAS_FRAME_W, ATLAS_FRAME_H, ATLAS_COLS);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;

  const imgRows = img.height / ATLAS_FRAME_H;
  texture.repeat.set(1 / ATLAS_COLS, 1 / imgRows);
  texture.offset.set(0, 1 - 1 / imgRows);

  atlasRows = imgRows;

  return texture;
}

// ── Atlas Day Selection ──

export function setAtlasDay(day) {
  if (!atlasTexture || atlasNumDays === 0) return;
  const d = Math.max(0, Math.min(day, atlasNumDays - 1));
  const col = d % ATLAS_COLS;
  const row = Math.floor(d / ATLAS_COLS);
  atlasTexture.offset.set(col / ATLAS_COLS, 1 - (row + 1) / atlasRows);
}

export function getAtlasTexture() {
  return atlasTexture;
}

export function isAtlasReady() {
  return atlasTexture !== null;
}

// ── Start Atlas Build ──

export function startAtlasBuild(allTemps, numDays, opts, THREE, onProgress, onReady) {
  stopAtlas();

  const key = atlasKey(opts);
  atlasNumDays = numDays;
  atlasRows = Math.ceil(numDays / ATLAS_COLS);

  // Try IDB cache first
  loadAtlasCache(key).then(async (cached) => {
    if (cached) {
      console.log(`Thermal atlas from cache (${(cached.byteLength / 1024 / 1024).toFixed(1)} MB)`);
      atlasTexture = await createAtlasTexture(cached, numDays, THREE);
      if (onProgress) onProgress(numDays, numDays);
      if (onReady) onReady(atlasTexture);
      return;
    }

    // No cache — render in worker
    worker = new Worker("./thermal-worker.js");

    worker.onmessage = async (e) => {
      const msg = e.data;

      if (msg.type === "progress") {
        if (onProgress) onProgress(msg.done, msg.total);
      }

      if (msg.type === "atlas") {
        const buf = msg.buffer;
        console.log(`Thermal atlas rendered (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB)`);

        saveAtlasCache(key, buf, numDays);

        atlasTexture = await createAtlasTexture(buf, numDays, THREE);
        if (onReady) onReady(atlasTexture);

        if (worker) { worker.terminate(); worker = null; }
      }
    };

    worker.postMessage(
      {
        type: "start",
        temps: allTemps,
        numDays,
        opts: { colorway: opts.colorway, blurRadius: opts.blurRadius, customStops: opts.customStops },
      },
      [allTemps.buffer],
    );
  });
}

export function stopAtlas() {
  if (worker) {
    worker.postMessage({ type: "cancel" });
    worker.terminate();
    worker = null;
  }
  if (atlasTexture) {
    atlasTexture.dispose();
    atlasTexture = null;
  }
  atlasNumDays = 0;
  atlasRows = 0;
}

// ── Single-Day Blended Texture (for partial opacity / before atlas ready) ──

export function createSingleDayTexture(allTemps, dayIndex, numDays, opts, opacity, THREE) {
  const day = Math.max(0, Math.min(dayIndex, numDays - 1));
  const dayTemps = allTemps.subarray(day * NUM_POINTS, (day + 1) * NUM_POINTS);
  const w = 1024;
  const h = 512;
  const pixels = renderPixelData(dayTemps, opts, w, h);

  // Apply land mask: ocean pixels → white
  applyLandMaskToPixels(pixels, w, h);

  // Lerp toward white based on opacity (white = multiply identity)
  if (opacity < 1) {
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i]     = Math.round(255 + (pixels[i]     - 255) * opacity);
      pixels[i + 1] = Math.round(255 + (pixels[i + 1] - 255) * opacity);
      pixels[i + 2] = Math.round(255 + (pixels[i + 2] - 255) * opacity);
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(pixels, w, h), 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;

  return texture;
}
