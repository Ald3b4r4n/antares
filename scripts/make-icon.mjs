// Rasterizes the Antares star (same geometry as media/antares.svg) into media/antares.png.
// Dependency-free: supersampled software rendering + zlib PNG encoder.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 256;
const SS = 4;
const SCALE = SIZE / 128;
const star = [[64, 8], [71, 57], [120, 64], [71, 71], [64, 120], [57, 71], [8, 64], [57, 57]];

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function sample(x, y) {
  const d = Math.hypot(x - 64, y - 64);
  let r = 0, g = 0, b = 0, a = 0;
  if (d <= 62) {
    const t = d / 62;
    const glow = t < 0.35 ? 0.95 - (0.4 * t) / 0.35 : 0.55 * (1 - (t - 0.35) / 0.65);
    [r, g, b, a] = t < 0.35 ? [255 - 23 * (t / 0.35), 177 - 112 * (t / 0.35), 153 - 110 * (t / 0.35), glow] : [232, 65, 43, glow];
  }
  const over = (cr, cg, cb) => {
    r = cr; g = cg; b = cb; a = 1;
  };
  if (inPolygon(x, y, star)) over(255, 90, 60);
  if (d <= 9) over(255, 241, 236);
  return [r * a, g * a, b * a, a];
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let py = 0; py < SIZE; py++) {
  raw[py * (SIZE * 4 + 1)] = 0;
  for (let px = 0; px < SIZE; px++) {
    let pr = 0, pg = 0, pb = 0, pa = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const [r, g, b, a] = sample((px + (sx + 0.5) / SS) / SCALE, (py + (sy + 0.5) / SS) / SCALE);
        pr += r; pg += g; pb += b; pa += a;
      }
    }
    const n = SS * SS;
    const o = py * (SIZE * 4 + 1) + 1 + px * 4;
    const alpha = pa / n;
    raw[o] = alpha > 0 ? Math.round(pr / n / alpha) : 0;
    raw[o + 1] = alpha > 0 ? Math.round(pg / n / alpha) : 0;
    raw[o + 2] = alpha > 0 ? Math.round(pb / n / alpha) : 0;
    raw[o + 3] = Math.round(alpha * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
writeFileSync(
  new URL("../media/antares.png", import.meta.url),
  Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]),
);
console.log("wrote media/antares.png");
