// ── Pure Temperature Rendering ──
// Ported from thermal globe – shared by main thread and Web Worker.
// Bicubic (Catmull-Rom) interpolation + box blur on a 2° temperature grid.

// ── Grid Config ──

export const GRID_STEP = 2;
export const LAT_MIN = -90;
export const LAT_MAX = 90;
export const LNG_MIN = -180;
export const LNG_MAX = 180;
export const NUM_LAT = Math.floor((LAT_MAX - LAT_MIN) / GRID_STEP) + 1; // 91
export const NUM_LNG = Math.floor((LNG_MAX - LNG_MIN) / GRID_STEP) + 1; // 181
export const NUM_POINTS = NUM_LAT * NUM_LNG; // 16 471

export const RENDER_WIDTH = 1024;
export const RENDER_HEIGHT = 512;

// ── Color Ramps ──

const THERMAL_STOPS = [
  { t: -30, c: [20, 40, 150] },
  { t:   5, c: [60, 130, 255] },
  { t:  10, c: [255, 255, 255] },
  { t:  15.5, c: [255, 255, 255] },
  { t:  18, c: [255, 235, 50] },
  { t:  25, c: [255, 220, 40] },
  { t:  26.7, c: [255, 160, 20] },
  { t:  32, c: [255, 40, 20] },
  { t:  50, c: [150, 0, 0] },
];

const CLASSIC_STOPS = [
  { t: -20, c: [30, 100, 240] },
  { t:  -5, c: [50, 160, 200] },
  { t:  10, c: [60, 200, 90] },
  { t:  25, c: [235, 220, 55] },
  { t:  40, c: [210, 50, 30] },
];

const EARTH_STOPS = [
  { t: -30, c: [15, 25, 110] },
  { t:   5, c: [55, 110, 225] },
  { t:  10, c: [200, 190, 85] },
  { t:  16, c: [220, 190, 55] },
  { t:  18, c: [225, 175, 40] },
  { t:  25, c: [220, 145, 30] },
  { t:  27, c: [215, 110, 20] },
  { t:  32, c: [200, 40, 15] },
  { t:  50, c: [120, 0, 0] },
];

const VIVID_STOPS = [
  { t:   4, c: [30, 100, 240] },
  { t:  10, c: [80, 180, 255] },
  { t:  18, c: [255, 235, 0] },
  { t:  24, c: [255, 130, 0] },
  { t:  32, c: [240, 10, 0] },
];

export const COLORWAY_MAP = {
  thermal: THERMAL_STOPS,
  classic: CLASSIC_STOPS,
  earth: EARTH_STOPS,
  vivid: VIVID_STOPS,
};

// ── Color Mapping ──

export function tempToRGB(t, stops) {
  // Ocean / missing → white (multiply-blend identity for porcelain globe)
  if (t === null || t !== t) return [255, 255, 255];

  if (t <= stops[0].t) return stops[0].c;
  if (t >= stops[stops.length - 1].t) return stops[stops.length - 1].c;

  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (t >= a.t && t <= b.t) {
      const p = (t - a.t) / (b.t - a.t);
      return [
        Math.round(a.c[0] + (b.c[0] - a.c[0]) * p),
        Math.round(a.c[1] + (b.c[1] - a.c[1]) * p),
        Math.round(a.c[2] + (b.c[2] - a.c[2]) * p),
      ];
    }
  }

  return [255, 255, 255];
}

// ── Bicubic Interpolation ──

function catmullRomWeights(t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return [
    (-t3 + 2 * t2 - t) / 2,
    (3 * t3 - 5 * t2 + 2) / 2,
    (-3 * t3 + 4 * t2 + t) / 2,
    (t3 - t2) / 2,
  ];
}

function getGridTemp(temps, latIdx, lngIdx) {
  latIdx = Math.max(0, Math.min(NUM_LAT - 1, latIdx));
  if (lngIdx < 0) lngIdx += NUM_LNG;
  else if (lngIdx >= NUM_LNG) lngIdx -= NUM_LNG;
  return temps[latIdx * NUM_LNG + lngIdx];
}

function bicubicSample(temps, lat, lng) {
  const gLat = (LAT_MAX - lat) / GRID_STEP;
  const gLng = (lng - LNG_MIN) / GRID_STEP;

  const latBase = Math.floor(gLat);
  const lngBase = Math.floor(gLng);
  const tLat = gLat - latBase;
  const tLng = gLng - lngBase;

  let validSum = 0;
  let validCount = 0;
  const raw = new Float64Array(16);

  for (let dy = -1; dy <= 2; dy++) {
    for (let dx = -1; dx <= 2; dx++) {
      const v = getGridTemp(temps, latBase + dy, lngBase + dx);
      const idx = (dy + 1) * 4 + (dx + 1);
      raw[idx] = v;
      if (v === v) {
        validSum += v;
        validCount++;
      }
    }
  }

  if (validCount === 0) return NaN;

  if (validCount < 16) {
    const fallback = validSum / validCount;
    for (let i = 0; i < 16; i++) {
      if (raw[i] !== raw[i]) raw[i] = fallback;
    }
  }

  const wLat = catmullRomWeights(tLat);
  const wLng = catmullRomWeights(tLng);

  let result = 0;
  for (let row = 0; row < 4; row++) {
    let rowVal = 0;
    for (let col = 0; col < 4; col++) {
      rowVal += wLng[col] * raw[row * 4 + col];
    }
    result += wLat[row] * rowVal;
  }

  return result;
}

// ── Box Blur ──

export function boxBlur(data, w, h, radius, passes) {
  const dst = new Uint8ClampedArray(data.length);

  for (let pass = 0; pass < passes; pass++) {
    // Horizontal: data → dst
    for (let y = 0; y < h; y++) {
      const rowOff = y * w * 4;
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0, count = 0;
        for (let x = 0; x <= radius && x < w; x++) {
          sum += data[rowOff + x * 4 + ch];
          count++;
        }
        for (let x = 0; x < w; x++) {
          dst[rowOff + x * 4 + ch] = (sum / count + 0.5) | 0;
          dst[rowOff + x * 4 + 3] = 255;
          const nx = x + radius + 1;
          if (nx < w) { sum += data[rowOff + nx * 4 + ch]; count++; }
          const ox = x - radius;
          if (ox >= 0) { sum -= data[rowOff + ox * 4 + ch]; count--; }
        }
      }
    }

    // Vertical: dst → data
    for (let x = 0; x < w; x++) {
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0, count = 0;
        for (let y = 0; y <= radius && y < h; y++) {
          sum += dst[(y * w + x) * 4 + ch];
          count++;
        }
        for (let y = 0; y < h; y++) {
          data[(y * w + x) * 4 + ch] = (sum / count + 0.5) | 0;
          const ny = y + radius + 1;
          if (ny < h) { sum += dst[(ny * w + x) * 4 + ch]; count++; }
          const oy = y - radius;
          if (oy >= 0) { sum -= dst[(oy * w + x) * 4 + ch]; count--; }
        }
      }
    }
  }
}

// ── Nearest-Neighbor Ocean Check ──
// Returns true if the nearest grid cell is NaN (ocean).

function isOceanNearest(temps, lat, lng) {
  const latIdx = Math.round((LAT_MAX - lat) / GRID_STEP);
  let lngIdx = Math.round((lng - LNG_MIN) / GRID_STEP);
  if (lngIdx < 0) lngIdx += NUM_LNG;
  else if (lngIdx >= NUM_LNG) lngIdx -= NUM_LNG;
  const clampedLat = Math.max(0, Math.min(NUM_LAT - 1, latIdx));
  const v = temps[clampedLat * NUM_LNG + lngIdx];
  return v !== v; // NaN check
}

// ── Render Full Pixel Data ──

export function renderPixelData(temps, opts, w, h) {
  if (w === undefined) w = RENDER_WIDTH;
  if (h === undefined) h = RENDER_HEIGHT;
  const stops = opts.customStops || COLORWAY_MAP[opts.colorway];
  const data = new Uint8ClampedArray(w * h * 4);

  // Build per-pixel ocean mask (true = ocean → white)
  const oceanMask = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    const lat = 90 - (y / h) * 180;
    for (let x = 0; x < w; x++) {
      const lng = (x / w) * 360 - 180;
      const ocean = isOceanNearest(temps, lat, lng);
      oceanMask[y * w + x] = ocean ? 1 : 0;

      const idx = (y * w + x) * 4;
      if (ocean) {
        data[idx] = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
        data[idx + 3] = 255;
      } else {
        const temp = bicubicSample(temps, lat, lng);
        const rgb = tempToRGB(temp !== temp ? null : temp, stops);
        data[idx] = rgb[0];
        data[idx + 1] = rgb[1];
        data[idx + 2] = rgb[2];
        data[idx + 3] = 255;
      }
    }
  }

  if (opts.blurRadius > 0) {
    const refSize = 2048;
    const scaledRadius = Math.max(1, Math.round(opts.blurRadius * w / refSize));
    boxBlur(data, w, h, scaledRadius, 3);

    // Re-stamp ocean pixels white after blur (prevents land bleeding into ocean)
    for (let i = 0; i < oceanMask.length; i++) {
      if (oceanMask[i]) {
        const idx = i * 4;
        data[idx] = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
      }
    }
  }

  return data;
}
