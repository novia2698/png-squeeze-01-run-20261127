// png-squeeze-01-run-20261127 — lossless PNG squeezer, written fresh.
//
// One program answers all 8 screenshots of a set in a single run:
//   input  /input/<id>/image.png   (1280x720 RGBA, stored PNG)
//   output /output/<id>/image.png  (lossless, bit depth 8, non-interlaced)
//
// How it squeezes:
//   1. Decode the input PNG (any of colour types 0/2/3/4/6, bit depth 8).
//   2. Build every lossless representation the pixels allow: palette
//      (ordered by frequency, by luminance, and transparent-first when
//      the image has transparency), grey, grey+alpha, RGB, or RGBA.
//   3. For each representation try three filterings per row — unfiltered,
//      per-row cheapest residual (None/Sub/Up/Average/Paeth by least
//      absolute residual), and all-Paeth — and screen each with zlib
//      level 6, keeping the smallest total PNG. (Unfiltered often wins:
//      on noisy photo-like rows a filter adds entropy that zlib cannot
//      take back, and the per-row heuristic is only a heuristic.)
//   4. Recompress the winner with zlib level 9 under two strategies
//      (default and filtered) and keep the smallest.
// Pure Node built-ins only. Deterministic: no clock, no randomness, no
// network, no environment-dependent branching.

import { deflateSync, inflateSync, constants as zlibConstants } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------- CRC32

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ------------------------------------------------------------ PNG chunks

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function assemblePng(parts) {
  let total = 8;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let off = 8;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ------------------------------------------------------------ PNG decode

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilterRow(filter, row, prev, bpp, out) {
  const n = row.length;
  if (filter === 0) {
    out.set(row);
    return;
  }
  if (filter === 1) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? out[i - bpp] : 0;
      out[i] = (row[i] + a) & 0xff;
    }
    return;
  }
  if (filter === 2) {
    for (let i = 0; i < n; i++) out[i] = (row[i] + prev[i]) & 0xff;
    return;
  }
  if (filter === 3) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? out[i - bpp] : 0;
      out[i] = (row[i] + ((a + prev[i]) >> 1)) & 0xff;
    }
    return;
  }
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? out[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    out[i] = (row[i] + paethPredictor(a, b, c)) & 0xff;
  }
}

// Decode a bit-depth-8, non-interlaced PNG into { width, height, rgba }.
function decodePng(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== sig[i]) throw new Error('input is not a PNG');
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let plte = null;
  let trns = null;
  const idatParts = [];
  while (pos + 8 <= bytes.length) {
    const len =
      (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
      height = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      plte = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('input PNG is not bit depth 8');
  if (interlace !== 0) throw new Error('input PNG is interlaced');
  const channelsByType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByType[colorType];
  if (channels === undefined) throw new Error('input PNG has an unsupported colour type');
  let zTotal = 0;
  for (const part of idatParts) zTotal += part.length;
  const zipped = new Uint8Array(zTotal);
  let zOff = 0;
  for (const part of idatParts) {
    zipped.set(part, zOff);
    zOff += part.length;
  }
  const raw = inflateSync(zipped);
  const rowBytes = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  const recon = new Uint8Array(rowBytes);
  const prev = new Uint8Array(rowBytes);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const row = raw.subarray(p, p + rowBytes);
    p += rowBytes;
    unfilterRow(filter, row, prev, channels, recon);
    const base = y * width * 4;
    if (colorType === 6) {
      rgba.set(recon, base);
    } else if (colorType === 2) {
      for (let x = 0; x < width; x++) {
        const s = x * 3;
        const d = base + x * 4;
        rgba[d] = recon[s];
        rgba[d + 1] = recon[s + 1];
        rgba[d + 2] = recon[s + 2];
        rgba[d + 3] = 255;
      }
    } else if (colorType === 0) {
      for (let x = 0; x < width; x++) {
        const d = base + x * 4;
        rgba[d] = recon[x];
        rgba[d + 1] = recon[x];
        rgba[d + 2] = recon[x];
        rgba[d + 3] = 255;
      }
    } else if (colorType === 4) {
      for (let x = 0; x < width; x++) {
        const s = x * 2;
        const d = base + x * 4;
        rgba[d] = recon[s];
        rgba[d + 1] = recon[s];
        rgba[d + 2] = recon[s];
        rgba[d + 3] = recon[s + 1];
      }
    } else {
      // Colour type 3: palette index, alpha from tRNS (or opaque).
      for (let x = 0; x < width; x++) {
        const idx = recon[x];
        const s = idx * 3;
        const d = base + x * 4;
        rgba[d] = plte[s];
        rgba[d + 1] = plte[s + 1];
        rgba[d + 2] = plte[s + 2];
        rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
    prev.set(recon);
  }
  return { width, height, rgba };
}

// ----------------------------------------------------------- PNG filters

function filterRow(filter, cur, prev, bpp, out) {
  const n = cur.length;
  if (filter === 0) {
    out.set(cur);
    return;
  }
  if (filter === 1) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      out[i] = (cur[i] - a) & 0xff;
    }
    return;
  }
  if (filter === 2) {
    for (let i = 0; i < n; i++) out[i] = (cur[i] - prev[i]) & 0xff;
    return;
  }
  if (filter === 3) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      out[i] = (cur[i] - ((a + prev[i]) >> 1)) & 0xff;
    }
    return;
  }
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    out[i] = (cur[i] - paethPredictor(a, b, c)) & 0xff;
  }
}

// Cost of a filtered row: sum of absolute values, bytes read as signed.
function rowCost(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// Filter a whole plane. mode 'none' leaves every row unfiltered, mode
// 'paeth' filters every row with Paeth, mode 'adapt' picks the cheapest
// filter per row by least absolute residual (ties prefer Paeth, then Up,
// Sub, Average, None). Returns one filter byte plus the row, per row.
function buildFiltered(plane, width, height, bpp, mode) {
  const rowBytes = width * bpp;
  const out = new Uint8Array((rowBytes + 1) * height);
  const scratch = new Uint8Array(rowBytes);
  const bestBuf = new Uint8Array(rowBytes);
  const prev = new Uint8Array(rowBytes);
  const order = [4, 2, 1, 3, 0];
  for (let y = 0; y < height; y++) {
    const cur = plane.subarray(y * rowBytes, (y + 1) * rowBytes);
    const opos = y * (rowBytes + 1);
    if (mode === 'none') {
      out[opos] = 0;
      out.set(cur, opos + 1);
    } else if (mode === 'paeth') {
      out[opos] = 4;
      filterRow(4, cur, prev, bpp, out.subarray(opos + 1, opos + 1 + rowBytes));
    } else {
      let best = 0;
      let bestScore = Infinity;
      for (const f of order) {
        filterRow(f, cur, prev, bpp, scratch);
        const s = rowCost(scratch);
        if (s < bestScore) {
          bestScore = s;
          best = f;
          bestBuf.set(scratch);
        }
      }
      out[opos] = best;
      out.set(bestBuf, opos + 1);
    }
    prev.set(cur);
  }
  return out;
}

// ------------------------------------------------- candidate representations

// Rec. 709 luminance, scaled by 10000 to stay in integers.
function luminanceOf(key) {
  const r = (key >>> 24) & 0xff;
  const g = (key >>> 16) & 0xff;
  const b = (key >>> 8) & 0xff;
  return 2126 * r + 7152 * g + 722 * b;
}

// A palette candidate: plane of indices plus PLTE and (trimmed) tRNS.
// `order` is the colour list in palette order.
function makePalette(rgba, order) {
  const index = new Map();
  const plte = new Uint8Array(order.length * 3);
  const alphas = new Uint8Array(order.length);
  let needTrns = false;
  for (let idx = 0; idx < order.length; idx++) {
    const key = order[idx].key;
    index.set(key, idx);
    plte[idx * 3] = (key >>> 24) & 0xff;
    plte[idx * 3 + 1] = (key >>> 16) & 0xff;
    plte[idx * 3 + 2] = (key >>> 8) & 0xff;
    alphas[idx] = key & 0xff;
    if ((key & 0xff) !== 255) needTrns = true;
  }
  let trns = null;
  if (needTrns) {
    let n = alphas.length;
    while (n > 0 && alphas[n - 1] === 255) n--;
    trns = alphas.subarray(0, n);
  }
  const plane = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    const key = ((rgba[i] << 24) | (rgba[i + 1] << 16) | (rgba[i + 2] << 8) | rgba[i + 3]) >>> 0;
    plane[j] = index.get(key);
  }
  return { plane, bpp: 1, colorType: 3, plte, trns };
}

function makeGrey(rgba) {
  const plane = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) plane[j] = rgba[i];
  return { plane, bpp: 1, colorType: 0, plte: null, trns: null };
}

function makeGreyAlpha(rgba) {
  const plane = new Uint8Array((rgba.length / 4) * 2);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 2) {
    plane[j] = rgba[i];
    plane[j + 1] = rgba[i + 3];
  }
  return { plane, bpp: 2, colorType: 4, plte: null, trns: null };
}

function makeRgb(rgba) {
  const plane = new Uint8Array((rgba.length / 4) * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    plane[j] = rgba[i];
    plane[j + 1] = rgba[i + 1];
    plane[j + 2] = rgba[i + 2];
  }
  return { plane, bpp: 3, colorType: 2, plte: null, trns: null };
}

// ------------------------------------------------------------ PNG encode

// Analyse the pixels, screen every lossless representation the pixels
// allow under three filterings each (zlib level 6, total PNG bytes),
// then write the winner with zlib level 9 and keep the smaller of two
// deflate strategies.
function encodePng(rgba, width, height) {
  let allOpaque = true;
  let isGrey = true;
  const counts = new Map();
  let overPalette = false;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const a = rgba[i + 3];
    if (a !== 255) allOpaque = false;
    if (r !== g || g !== b) isGrey = false;
    if (!overPalette) {
      const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      counts.set(key, (counts.get(key) || 0) + 1);
      if (counts.size > 256) {
        overPalette = true;
        counts.clear();
      }
    }
  }

  const candidates = [];
  if (!overPalette) {
    const colours = [...counts.entries()].map(([key, count]) => ({ key, count }));
    const byCount = [...colours].sort((x, y) => y.count - x.count || x.key - y.key);
    const byLum = [...colours].sort(
      (x, y) => luminanceOf(x.key) - luminanceOf(y.key) || x.key - y.key,
    );
    candidates.push(makePalette(rgba, byCount));
    candidates.push(makePalette(rgba, byLum));
    if (!allOpaque) {
      // Transparent entries first, so tRNS stays short.
      const byTrans = [...colours].sort(
        (x, y) =>
          ((x.key & 0xff) !== 255 ? 0 : 1) - ((y.key & 0xff) !== 255 ? 0 : 1) ||
          y.count - x.count ||
          x.key - y.key,
      );
      candidates.push(makePalette(rgba, byTrans));
    }
    if (isGrey) {
      if (allOpaque) candidates.push(makeGrey(rgba));
      else candidates.push(makeGreyAlpha(rgba));
    }
  } else if (isGrey && allOpaque) {
    candidates.push(makeGrey(rgba));
  } else if (isGrey) {
    candidates.push(makeGreyAlpha(rgba));
  } else if (allOpaque) {
    candidates.push(makeRgb(rgba));
  } else {
    candidates.push({ plane: rgba, bpp: 4, colorType: 6, plte: null, trns: null });
  }

  const modes = ['none', 'adapt', 'paeth'];
  let best = null;
  for (const cand of candidates) {
    const overhead =
      8 + 25 + (cand.plte ? 12 + cand.plte.length : 0) + (cand.trns ? 12 + cand.trns.length : 0) + 12 + 12;
    for (const mode of modes) {
      const filtered = buildFiltered(cand.plane, width, height, cand.bpp, mode);
      const z = deflateSync(filtered, { level: 6, memLevel: 9 });
      const total = overhead + z.length;
      if (best === null || total < best.total) best = { total, filtered, cand };
    }
  }

  const zlibOpts = { level: 9, memLevel: 9 };
  const zDefault = deflateSync(best.filtered, zlibOpts);
  const zFiltered = deflateSync(best.filtered, { ...zlibOpts, strategy: zlibConstants.Z_FILTERED });
  const z = zDefault.length <= zFiltered.length ? zDefault : zFiltered;

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = best.cand.colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const parts = [chunk('IHDR', ihdr)];
  if (best.cand.plte !== null) parts.push(chunk('PLTE', best.cand.plte));
  if (best.cand.trns !== null) parts.push(chunk('tRNS', best.cand.trns));
  parts.push(chunk('IDAT', new Uint8Array(z)));
  parts.push(chunk('IEND', new Uint8Array(0)));
  return assemblePng(parts);
}

// ------------------------------------------------------------------ main

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(INPUT_DIR).sort()) {
  const bytes = new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png')));
  const image = decodePng(bytes);
  const png = encodePng(image.rgba, image.width, image.height);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), png);
}
