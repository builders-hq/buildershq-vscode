/**
 * gen-icon.js — generates icon.png (128x128) for the BuildersHQ VS Code extension.
 * Uses only Node.js built-ins (zlib, fs). Run once: node scripts/gen-icon.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const WIDTH = 128;
const HEIGHT = 128;

// Palette
const BG       = [0x1e, 0x1e, 0x2e]; // #1e1e2e dark background
const ACCENT   = [0x5a, 0xa0, 0xd6]; // #5aa0d6 blue

const BORDER_THICKNESS = 6;
const PAD = 4;
const CORNER_RADIUS = 14;

// RGBA pixel buffer
const pixels = new Uint8Array(WIDTH * HEIGHT * 4);

function setPixel(x, y, r, g, b) {
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) { return; }
  const i = (y * WIDTH + x) * 4;
  pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = 255;
}

function inRoundedRect(x, y, rx, ry, rw, rh, radius) {
  if (x < rx || x >= rx + rw || y < ry || y >= ry + rh) { return false; }
  const cx = x - rx, cy = y - ry;
  if (cx < radius && cy < radius) { return (cx - radius) ** 2 + (cy - radius) ** 2 <= radius ** 2; }
  if (cx >= rw - radius && cy < radius) { return (cx - (rw - radius - 1)) ** 2 + (cy - radius) ** 2 <= radius ** 2; }
  if (cx < radius && cy >= rh - radius) { return (cx - radius) ** 2 + (cy - (rh - radius - 1)) ** 2 <= radius ** 2; }
  if (cx >= rw - radius && cy >= rh - radius) { return (cx - (rw - radius - 1)) ** 2 + (cy - (rh - radius - 1)) ** 2 <= radius ** 2; }
  return true;
}

// Fill background
for (let y = 0; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    setPixel(x, y, ...BG);
  }
}

// Draw rounded-rect border
const innerPad = PAD + BORDER_THICKNESS;
const innerRadius = Math.max(0, CORNER_RADIUS - BORDER_THICKNESS);
for (let y = PAD; y < HEIGHT - PAD; y++) {
  for (let x = PAD; x < WIDTH - PAD; x++) {
    const inOuter = inRoundedRect(x, y, PAD, PAD, WIDTH - PAD * 2, HEIGHT - PAD * 2, CORNER_RADIUS);
    const inInner = inRoundedRect(x, y, innerPad, innerPad, WIDTH - innerPad * 2, HEIGHT - innerPad * 2, innerRadius);
    if (inOuter && !inInner) {
      setPixel(x, y, ...ACCENT);
    }
  }
}

// Draw three centered vertical activity bars (equalizer style)
const barW = 10, barGap = 7;
const barHeights = [36, 52, 36];
const totalW = barHeights.length * barW + (barHeights.length - 1) * barGap;
const startX = Math.floor((WIDTH - totalW) / 2);
const centerY = HEIGHT / 2;

for (let i = 0; i < barHeights.length; i++) {
  const bx = startX + i * (barW + barGap);
  const bh = barHeights[i];
  const by = Math.floor(centerY - bh / 2);
  for (let dy = 0; dy < bh; dy++) {
    for (let dx = 0; dx < barW; dx++) {
      setPixel(bx + dx, by + dy, ...ACCENT);
    }
  }
}

// PNG encoding
function crc32(buf) {
  if (!crc32.table) {
    crc32.table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) { c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); }
      crc32.table[i] = c;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) { c = crc32.table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; }

function makeChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  return Buffer.concat([u32(data.length), t, data, u32(crc32(Buffer.concat([t, data])))]);
}

// IHDR: 128x128, 8-bit RGBA (color type 6)
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(WIDTH, 0);
ihdr.writeUInt32BE(HEIGHT, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

// Raw image data: filter byte 0 (None) + RGBA per row
const rows = [];
for (let y = 0; y < HEIGHT; y++) {
  rows.push(0);
  for (let x = 0; x < WIDTH; x++) {
    const i = (y * WIDTH + x) * 4;
    rows.push(pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]);
  }
}

const compressed = zlib.deflateSync(Buffer.from(rows), { level: 9 });

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
  makeChunk('IHDR', ihdr),
  makeChunk('IDAT', compressed),
  makeChunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'icon.png');
fs.writeFileSync(out, png);
console.log(`icon.png written (${png.length} bytes) → ${out}`);
