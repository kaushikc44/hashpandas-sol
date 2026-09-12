import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, keccak256v, leadingZeroBits } from "./cpu_keccak.ts";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

test("keccak256 of empty input matches the known test vector", () => {
  assert.equal(
    hex(keccak256(new Uint8Array(0))),
    "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  );
});

test("keccak256 of 'abc' matches the known test vector", () => {
  assert.equal(
    hex(keccak256(new TextEncoder().encode("abc"))),
    "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
  );
});

test("keccak256 handles a message exactly at the rate boundary (136 bytes)", () => {
  const msg = new Uint8Array(136).fill(0x61); // 136 'a's, forces the padding-fills-a-whole-extra-block path
  const h = keccak256(msg);
  assert.equal(h.length, 32);
  // No fixed reference value memorized for this one; just check it's stable
  // and re-running gives the identical hash (determinism smoke test).
  assert.equal(hex(h), hex(keccak256(msg)));
});

test("keccak256v matches keccak256 of the concatenation", () => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([4, 5]);
  const concat = new Uint8Array([1, 2, 3, 4, 5]);
  assert.equal(hex(keccak256v([a, b])), hex(keccak256(concat)));
});

test("leadingZeroBits counts across byte boundaries like the Rust mirror", () => {
  const h = fromHex(
    "00" + "0f" + "ff".repeat(30),
  );
  assert.equal(leadingZeroBits(h), 12); // 8 zero bits, then 4 more in 0x0f
  assert.equal(leadingZeroBits(new Uint8Array(32)), 256);
  assert.equal(leadingZeroBits(new Uint8Array(32).fill(0xff)), 0);
});
