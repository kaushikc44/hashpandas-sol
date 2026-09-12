import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSeed } from "./render.ts";
import { toPngBytes } from "./index.ts";

test("renderSeed is reproducible: same seed -> identical pixels", () => {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = (i * 5 + 11) % 256;

  const imgA = renderSeed(seed);
  const imgB = renderSeed(seed.slice());
  assert.equal(imgA.width, imgB.width);
  assert.equal(imgA.height, imgB.height);
  assert.deepEqual(imgA.data, imgB.data);
});

test("renderSeed produces different pixels for different seeds", () => {
  const seedA = new Uint8Array(32).fill(10);
  const seedB = new Uint8Array(32).fill(200);
  const imgA = renderSeed(seedA);
  const imgB = renderSeed(seedB);
  assert.notDeepEqual(imgA.data, imgB.data);
});

test("toPngBytes produces a real, valid PNG (magic bytes + non-trivial size)", async () => {
  const seed = new Uint8Array(32).fill(42);
  const img = renderSeed(seed);
  const png = await toPngBytes(img);

  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  assert.deepEqual(Array.from(png.subarray(0, 8)), PNG_MAGIC);
  assert.ok(png.length > 1000, `expected a non-trivial PNG, got ${png.length} bytes`);
});
