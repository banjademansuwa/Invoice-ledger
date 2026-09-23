// Regenerates samples/test-receipt.png — a small, synthetic, printed-text
// receipt image used purely as a reproducibility fixture for smoke-testing
// the OCR pipeline. Real demo recordings should use a real receipt photo.
//
// Written with zero image dependencies: a minimal hand-rolled PNG encoder
// with a tiny 5x7 bitmap font, enough for EasyOCR to read as text.
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const W = 600;
const H = 260;

const FONT = {
  " ": ["00000","00000","00000","00000","00000","00000","00000"],
  T:   ["11111","00100","00100","00100","00100","00100","00100"],
  E:   ["11111","10000","10000","11110","10000","10000","11111"],
  S:   ["01111","10000","10000","01110","00001","00001","11110"],
  C:   ["01111","10000","10000","10000","10000","10000","01111"],
  A:   ["01110","10001","10001","11111","10001","10001","10001"],
  F:   ["11111","10000","10000","11110","10000","10000","10000"],
  O:   ["01110","10001","10001","10001","10001","10001","01110"],
  ":": ["00000","00100","00100","00000","00100","00100","00000"],
  "1": ["00100","01100","00100","00100","00100","00100","01110"],
  "2": ["01110","10001","00001","00010","00100","01000","11111"],
  "3": ["01110","10001","00001","00110","00001","10001","01110"],
  "4": ["00010","00110","01010","10010","11111","00010","00010"],
  "5": ["11111","10000","11110","00001","00001","10001","01110"],
  "6": ["00110","01000","10000","11110","10001","10001","01110"],
  "7": ["11111","00001","00010","00100","01000","01000","01000"],
  "8": ["01110","10001","10001","01110","10001","10001","01110"],
  "9": ["01110","10001","10001","01111","00001","00010","01100"],
  "0": ["01110","10001","10011","10101","11001","10001","01110"],
  ".": ["00000","00000","00000","00000","00000","00100","00100"],
};

const canvas = new Uint8Array(W * H).fill(255);

function drawGlyph(glyph, x0, y0, scale) {
  for (let ry = 0; ry < 7; ry++) {
    for (let rx = 0; rx < 5; rx++) {
      if (glyph[ry][rx] !== "1") continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = x0 + rx * scale + dx;
          const py = y0 + ry * scale + dy;
          if (px < 0 || py < 0 || px >= W || py >= H) continue;
          canvas[py * W + px] = 0;
        }
      }
    }
  }
}

function drawText(text, x, y, scale) {
  let cx = x;
  for (const ch of text) {
    const glyph = FONT[ch] || FONT[" "];
    drawGlyph(glyph, cx, y, scale);
    cx += 6 * scale;
  }
}

drawText("TEST CAFE", 40, 30, 4);
drawText("COFFEE 3.50", 40, 100, 3);
drawText("TOTAL 3.50", 40, 170, 3);

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 0;
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc(H * (W + 1));
for (let y = 0; y < H; y++) {
  raw[y * (W + 1)] = 0;
  for (let x = 0; x < W; x++) {
    raw[y * (W + 1) + 1 + x] = canvas[y * W + x];
  }
}
const idat = deflateSync(raw);

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  pngChunk("IHDR", ihdr),
  pngChunk("IDAT", idat),
  pngChunk("IEND", Buffer.alloc(0)),
]);

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "samples", "test-receipt.png");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`Wrote ${out} (${png.length} bytes)`);
