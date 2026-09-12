import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveTraits } from "./traits.ts";

test("deriveTraits is a pure deterministic function of the seed", () => {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = (i * 7 + 3) % 256;

  const a = deriveTraits(seed);
  const b = deriveTraits(seed.slice()); // fresh copy, same bytes
  assert.deepEqual(a, b);
});

test("deriveTraits changes when the seed changes", () => {
  const seedA = new Uint8Array(32).fill(1);
  const seedB = new Uint8Array(32).fill(2);
  assert.notDeepEqual(deriveTraits(seedA), deriveTraits(seedB));
});

test("deriveTraits rejects a seed of the wrong length", () => {
  assert.throws(() => deriveTraits(new Uint8Array(31)));
  assert.throws(() => deriveTraits(new Uint8Array(33)));
});

test("all trait values stay within their documented ranges across many seeds", () => {
  for (let trial = 0; trial < 256; trial++) {
    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) seed[i] = (trial * 31 + i * 17) % 256;
    const t = deriveTraits(seed);
    assert.ok(t.backgroundHue >= 0 && t.backgroundHue < 360);
    assert.ok(t.bodyHue >= 0 && t.bodyHue < 360);
    assert.ok(t.eyeStyle >= 0 && t.eyeStyle < 4);
    assert.ok(t.accessory >= 0 && t.accessory < 5);
    assert.ok(t.patternDensity >= 0 && t.patternDensity < 6);
    assert.ok(t.pose >= 0 && t.pose < 3);
  }
});
