/**
 * Generate the PWA icons.
 *
 * Writes real PNGs with no dependencies, using node's built-in zlib. The
 * alternative was committing binaries nobody in the repo can regenerate or
 * review, or adding an image toolchain to a project that deliberately has no
 * build step.
 *
 *   npm run icons
 *
 * The artwork is a loop: a ring with a start dot on it, which is literally
 * what the app produces. Everything sits inside the central 66% so the icon
 * survives Android's maskable crop.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'icons');

const BACKGROUND = [11, 114, 133, 255]; // #0b7285, matches theme-color
const RING = [255, 255, 255, 255];
const START_DOT = [232, 89, 12, 255];   // #e8590c, matches the drawn route

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));

  return Buffer.concat([length, typeAndData, crc]);
}

/** @param {Buffer} rgba width*height*4 */
function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;  // bit depth
  header[9] = 6;  // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type. 0 (none) keeps this
  // simple; the images are small and flat, so deflate handles them well.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- artwork ----------------------------------------------------------------

/** Blend `src` over `dst` by `alpha` (0..1). */
function blend(dst, offset, src, alpha) {
  for (let i = 0; i < 3; i += 1) {
    dst[offset + i] = Math.round(dst[offset + i] * (1 - alpha) + src[i] * alpha);
  }
  dst[offset + 3] = 255;
}

/**
 * Coverage of a pixel by a shape edge, as a 0..1 value.
 *
 * `distance` is how far inside the shape the pixel centre is, in pixels.
 * Fading across roughly one pixel is what keeps the curves from looking
 * jagged at 192px.
 */
const coverage = (distance) => Math.max(0, Math.min(1, distance + 0.5));

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);

  // Background fill.
  for (let i = 0; i < size * size; i += 1) {
    rgba[i * 4] = BACKGROUND[0];
    rgba[i * 4 + 1] = BACKGROUND[1];
    rgba[i * 4 + 2] = BACKGROUND[2];
    rgba[i * 4 + 3] = BACKGROUND[3];
  }

  const centre = size / 2;
  const ringRadius = size * 0.26;      // inside the maskable safe zone
  const ringHalfWidth = size * 0.055;

  // The start dot sits on the ring, at the top.
  const dotX = centre;
  const dotY = centre - ringRadius;
  const dotRadius = size * 0.085;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;

      // Ring: distance from the circle outline, as a signed band.
      const fromCentre = Math.hypot(px - centre, py - centre);
      const intoRing = ringHalfWidth - Math.abs(fromCentre - ringRadius);
      const ringAlpha = coverage(intoRing);
      if (ringAlpha > 0) blend(rgba, offset, RING, ringAlpha);

      // Start dot, drawn over the ring.
      const dotAlpha = coverage(dotRadius - Math.hypot(px - dotX, py - dotY));
      if (dotAlpha > 0) blend(rgba, offset, START_DOT, dotAlpha);
    }
  }

  return encodePng(size, size, rgba);
}

// --- write ------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });

for (const size of [192, 512]) {
  const png = drawIcon(size);
  const path = join(OUT_DIR, 'icon-' + size + '.png');
  writeFileSync(path, png);
  console.log('wrote ' + path + ' (' + png.length + ' bytes)');
}
