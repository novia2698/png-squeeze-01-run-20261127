// png-squeeze-01-run-20261127: squeeze a 1280x720 RGBA screenshot into the smallest
// lossless PNG. Written from scratch for this bounty (Node 22, no dependencies).
//
// Strategy, per image:
//   1. Pick the cheapest exact form: palette (<=256 colours, transparent entries
//      first, tried in count order and in luminance order), grey / grey+alpha when
//      every pixel is grey, RGB when every pixel is opaque, RGBA otherwise, and a
//      tRNS key when the image is opaque except for one fully transparent value.
//   2. Pick filters per row: fixed 0..4, minimum signed-sum, fewest distinct byte
//      pairs, and brute force (each filter weighed by a real deflate of the row
//      after the 32 KiB written before it). Every candidate is weighed by a real
//      zlib stream, PLTE/tRNS included; the smallest wins.
//   3. Re-encode the winner at zlib level 9 (memLevel 9) under a few strategies
//      and keep the smallest stream. Deterministic: every choice is by byte size,
//      first wins on a tie; no clock, no randomness, no environment input.
//
// Usage: node main.ts — reads /input/<id>/image.png (or MAKEFUN_INPUT_DIR),
// writes /output/<id>/image.png (or MAKEFUN_OUTPUT_DIR).
import { inflateSync, deflateSync, constants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------- PNG writing
const SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngOf(chunks) {
  let size = SIG.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIG, 0);
  let at = SIG.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

// ---------------------------------------------------------------- PNG reading
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilterRow(type, row, prev, bpp) {
  const n = row.length;
  if (type === 0) return;
  if (type === 1) {
    for (let i = bpp; i < n; i++) row[i] = (row[i] + row[i - bpp]) & 0xff;
  } else if (type === 2) {
    if (prev) for (let i = 0; i < n; i++) row[i] = (row[i] + prev[i]) & 0xff;
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      row[i] = (row[i] + ((a + b) >> 1)) & 0xff;
    }
  } else if (type === 4) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      row[i] = (row[i] + paeth(a, b, c)) & 0xff;
    }
  } else {
    throw new Error('unknown filter ' + type);
  }
}

// Decode a bit-depth-8, non-interlaced PNG of colour type 0/2/3/4/6 to RGBA.
function decodePng(bytes) {
  if (bytes.length < 8) throw new Error('file too short');
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) throw new Error('bad signature');
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = -1;
  let plte = null;
  let trns = null;
  const idat = [];
  while (at + 12 <= bytes.length) {
    const len = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
      height = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported IHDR');
      colourType = data[9];
    } else if (type === 'PLTE') {
      plte = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + len;
  }
  const ch = CHANNELS[colourType];
  if (!ch || !width || !height) throw new Error('bad PNG header');
  const total = idat.reduce((a, b) => a + b.length, 0);
  const z = new Uint8Array(total);
  let off = 0;
  for (const d of idat) { z.set(d, off); off += d.length; }
  const raw = inflateSync(z);
  const stride = width * ch;
  if (raw.length !== height * (stride + 1)) throw new Error('bad inflated size');
  const rgba = new Uint8Array(width * height * 4);
  let prev = null;
  for (let y = 0; y < height; y++) {
    const rowAt = y * (stride + 1);
    const f = raw[rowAt];
    const row = raw.subarray(rowAt + 1, rowAt + 1 + stride);
    unfilterRow(f, row, prev, ch);
    prev = row;
    const out = y * width * 4;
    if (colourType === 6) {
      rgba.set(row, out);
    } else if (colourType === 2) {
      for (let x = 0, s = 0; x < width; x++, s += 3) {
        rgba[out + x * 4] = row[s];
        rgba[out + x * 4 + 1] = row[s + 1];
        rgba[out + x * 4 + 2] = row[s + 2];
        rgba[out + x * 4 + 3] = 255;
      }
    } else if (colourType === 0) {
      for (let x = 0; x < width; x++) {
        const g = row[x];
        rgba[out + x * 4] = g;
        rgba[out + x * 4 + 1] = g;
        rgba[out + x * 4 + 2] = g;
        rgba[out + x * 4 + 3] = 255;
      }
    } else if (colourType === 4) {
      for (let x = 0, s = 0; x < width; x++, s += 2) {
        const g = row[s];
        rgba[out + x * 4] = g;
        rgba[out + x * 4 + 1] = g;
        rgba[out + x * 4 + 2] = g;
        rgba[out + x * 4 + 3] = row[s + 1];
      }
    } else {
      // palette
      if (!plte) throw new Error('palette image without PLTE');
      for (let x = 0; x < width; x++) {
        const idx = row[x];
        const p = idx * 3;
        rgba[out + x * 4] = plte[p];
        rgba[out + x * 4 + 1] = plte[p + 1];
        rgba[out + x * 4 + 2] = plte[p + 2];
        rgba[out + x * 4 + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
  }
  return { rgba, width, height };
}

// ------------------------------------------------------------------ filters
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

// Filter by per-row entropy cost: a first minsum pass gives a byte histogram,
// then each row takes the filter whose bytes cost least under -log2(freq),
// and the histogram is refreshed once. Two refinement passes.
function filteredEntropy(samples, width, height, bpp, raw) {
  const stride = width * bpp;
  if (!raw) raw = new Uint8Array(height * (stride + 1));
  filtered(samples, width, height, bpp, 'minsum', raw);
  const trial = [];
  for (let t = 0; t < 5; t++) trial.push(new Uint8Array(stride));
  const cost = new Float64Array(256);
  for (let pass = 0; pass < 2; pass++) {
    const hist = new Float64Array(256);
    for (let i = 0; i < raw.length; i++) hist[raw[i]]++;
    const total = raw.length + 256;
    for (let v = 0; v < 256; v++) cost[v] = -Math.log2((hist[v] + 1) / total);
    for (let y = 0; y < height; y++) {
      const cur = samples.subarray(y * stride, (y + 1) * stride);
      const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
      const at = y * (stride + 1);
      let type = 0;
      let best = Infinity;
      for (let t = 0; t < 5; t++) {
        filterRow(t, cur, prev, bpp, trial[t]);
        let c = 0;
        const row = trial[t];
        for (let i = 0; i < stride; i++) c += cost[row[i]];
        if (c < best) {
          best = c;
          type = t;
        }
      }
      raw[at] = type;
      filterRow(type, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
    }
  }
  return raw;
}

// Filter `samples` (height rows of width*bpp) by `choice`: a fixed type 0..4,
// 'minsum', 'pairs', or 'brute' (each filter weighed by a real deflate of the
// row after the 32 KiB written before it). Lower type wins ties.
function filtered(samples, width, height, bpp, choice, raw) {
  if (choice === 'entropy') return filteredEntropy(samples, width, height, bpp, raw);
  const stride = width * bpp;
  if (!raw) raw = new Uint8Array(height * (stride + 1));
  const trial = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trial.push(row);
  }
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else {
        cost = deflateSync(
          trial[t],
          before.length === 0
            ? { level: BRUTE_LEVEL, memLevel: 9 }
            : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before },
        ).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// ----------------------------------------------------------------- analysis
// One 32-bit key per colour: (r<<24)|(g<<16)|(b<<8)|a, exact in a JS number.
function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const r = rgba[d];
    const g = rgba[d + 1];
    const b = rgba[d + 2];
    const a = rgba[d + 3];
    if (a !== 255) opaque = false;
    if (r !== g || r !== b) grey = false;
    if (!many) {
      const key = r * 16777216 + g * 65536 + b * 256 + a;
      const k = counts.get(key);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(key, 1);
      } else {
        counts.set(key, k + 1);
      }
    }
  }
  let colours = null;
  if (!many) {
    colours = [...counts.entries()].map(([key, count]) => ({
      r: Math.floor(key / 16777216),
      g: Math.floor(key / 65536) % 256,
      b: Math.floor(key / 256) % 256,
      a: key % 256,
      word: key,
      count,
    }));
  }
  return { opaque, grey, colours };
}

// The one fully transparent value the image may key by tRNS instead of an
// alpha channel: every pixel opaque or that exact value at alpha 0, and no
// opaque pixel of the same value. Null when there is none.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) {
      out[s] = rgba[d];
    } else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  return [...colours].sort((x, y) => {
    const ta = x.a === 255 ? 1 : 0;
    const tb = y.a === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const key = rgba[d] * 16777216 + rgba[d + 1] * 65536 + rgba[d + 2] * 256 + rgba[d + 3];
    indices[i] = index.get(key);
  }
  return { plte, trns, indices };
}

// Every exact form the image can take, with the filter choices each is tried
// with. Palette first (a third of the bytes of RGB or less); the channel form
// follows when the image is grey (palette and grey are both tried).
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', [0, 'minsum']],
      ['luminance', [0, 'minsum', 'entropy', 'brute']],
    ]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) {
      trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
    }
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({
    colourType: ct,
    bpp,
    samples: samplesOf(rgba, ct),
    plte: null,
    trns,
    filters: [0, 1, 2, 3, 4, 'minsum', 'pairs', 'entropy', 'brute'],
  });
  return forms;
}

const chunkBytes = (form) =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };

// Screen every form and filter choice at zlib level 6; the smallest total
// (stream + PLTE/tRNS chunks) wins, first on a tie.
function screen(rgba, width, height) {
  let best = null;
  let spare = null;
  for (const form of formsOf(rgba)) {
    const size = height * (width * form.bpp + 1);
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      const data = filtered(
        form.samples,
        width,
        height,
        form.bpp,
        choice,
        spare !== null && spare.length === size ? spare : new Uint8Array(size),
      );
      spare = null;
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunks;
      if (best === null || bytes < best.bytes) {
        if (best !== null) spare = best.data;
        best = { form, choice, data, bytes };
      } else {
        spare = data;
      }
    }
  }
  return best;
}

// ------------------------------------------------------------ final encoding
// Re-encode the screened winner's filtered data at level 9 under a few
// settings; keep the smallest stream. Returns the complete PNG bytes.
function encodeBest(best, width, height) {
  const { form, data } = best;
  const tries = [
    { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY },
    { level: 9, memLevel: 9, strategy: constants.Z_FILTERED },
    { level: 9, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY },
    { level: 9, memLevel: 8, strategy: constants.Z_FILTERED },
    { level: 9, memLevel: 9, strategy: constants.Z_RLE },
    { level: 9, memLevel: 9, strategy: constants.Z_HUFFMAN_ONLY },
    { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY },
  ];
  let zlib = null;
  for (const opts of tries) {
    const s = deflateSync(data, opts);
    if (zlib === null || s.length < zlib.length) zlib = s;
  }
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', new Uint8Array(zlib.buffer, zlib.byteOffset, zlib.length)]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ---------------------------------------------------------------------- main
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  const best = screen(image.rgba, image.width, image.height);
  const png = encodeBest(best, image.width, image.height);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), png);
}
