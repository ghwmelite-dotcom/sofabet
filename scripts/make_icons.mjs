/**
 * Generates the PWA icons (public/icons/icon-192.png, icon-512.png) with zero
 * dependencies — hand-rolled PNG encoder on node:zlib. Design: dark rounded
 * square (#0f172a), white circle, green dot (#22c55e). Run: npm run icons.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePngRgba(size, pixelAt) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      const o = rowStart + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function iconPixel(size) {
  const corner = size * 0.22;
  const cx = size / 2;
  const circleR = size * 0.3;
  const dotR = size * 0.14;
  return (x, y) => {
    // Rounded-square silhouette (transparent outside).
    const rx = Math.min(x, size - 1 - x);
    const ry = Math.min(y, size - 1 - y);
    if (rx < corner && ry < corner) {
      const dx = corner - rx - 0.5;
      const dy = corner - ry - 0.5;
      if (dx * dx + dy * dy > corner * corner) return [0, 0, 0, 0];
    }
    const ddx = x + 0.5 - cx;
    const ddy = y + 0.5 - cx;
    const dist2 = ddx * ddx + ddy * ddy;
    if (dist2 <= dotR * dotR) return [0x22, 0xc5, 0x5e, 255];
    if (dist2 <= circleR * circleR) return [0xf8, 0xfa, 0xfc, 255];
    return [0x0f, 0x17, 0x2a, 255];
  };
}

for (const size of [192, 512]) {
  const path = `public/icons/icon-${size}.png`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodePngRgba(size, iconPixel(size)));
  console.log(`wrote ${path}`);
}
