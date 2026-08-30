// Generates PWA PNG icons (icon-192.png, icon-512.png) from scratch — a pure
// Node PNG encoder (zlib + manual CRC32), no native dependencies. Draws a
// Windows-98 style icon: teal desktop, silver beveled window, navy title bar,
// and a 3x3 pixel-grid motif.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

// ── PNG encoding ────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = size * 4;
  const raw = Buffer.alloc(size * (1 + stride));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + stride)] = 0; // filter: none
    rgba.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Drawing ─────────────────────────────────────────────────────────────────
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const fill = (x0, y0, w, h, [r, g, b]) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const i = (y * size + x) * 4;
        rgba[i] = r;
        rgba[i + 1] = g;
        rgba[i + 2] = b;
        rgba[i + 3] = 255;
      }
    }
  };

  // teal desktop
  fill(0, 0, size, size, [0x00, 0x80, 0x80]);

  // silver window
  const wx = Math.floor(size * 0.15);
  const wy = Math.floor(size * 0.18);
  const ww = Math.floor(size * 0.7);
  const wh = Math.floor(size * 0.64);
  fill(wx, wy, ww, wh, [0xc0, 0xc0, 0xc0]);

  // bevel (light top/left, dark bottom/right)
  fill(wx, wy, ww, 4, [0xdf, 0xdf, 0xdf]);
  fill(wx, wy, 4, wh, [0xdf, 0xdf, 0xdf]);
  fill(wx, wy + wh - 4, ww, 4, [0x40, 0x40, 0x40]);
  fill(wx + ww - 4, wy, 4, wh, [0x40, 0x40, 0x40]);

  // navy title bar
  const th = Math.floor(size * 0.12);
  fill(wx + 4, wy + 4, ww - 8, th, [0x00, 0x00, 0x80]);

  // 3x3 pixel-grid motif
  const cell = Math.floor(size * 0.06);
  const gap = Math.floor(cell * 0.35);
  const gridW = cell * 3 + gap * 2;
  const gx = wx + Math.floor((ww - gridW) / 2);
  const gy = wy + th + 4 + Math.floor((wh - th - 4 - gridW) / 2);
  const colors = [
    [0x00, 0x80, 0x80], [0xff, 0xff, 0x00], [0xff, 0x00, 0xff],
    [0xff, 0xff, 0x00], [0xff, 0x00, 0xff], [0x00, 0x80, 0x80],
    [0xff, 0x00, 0xff], [0x00, 0x80, 0x80], [0xff, 0xff, 0x00],
  ];
  for (let i = 0; i < 9; i++) {
    const cx = gx + (i % 3) * (cell + gap);
    const cy = gy + Math.floor(i / 3) * (cell + gap);
    fill(cx, cy, cell, cell, colors[i]);
  }

  return rgba;
}

for (const size of [192, 512]) {
  const png = encodePng(size, drawIcon(size));
  const out = join(ROOT, `icon-${size}.png`);
  writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes)`);
}
