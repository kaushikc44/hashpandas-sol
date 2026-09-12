import { test } from "node:test";
import assert from "node:assert/strict";
import { hashForNonce, searchOnCpu, verifyOnCpu, type MiningTarget } from "./index.ts";
import { leadingZeroBits } from "./cpu_keccak.ts";

function target(targetBits: number): MiningTarget {
  return {
    miner: new Uint8Array(32).fill(9),
    lastWinningHash: new Uint8Array(32).fill(3),
    anchorHash: new Uint8Array(32).fill(4),
    anchorSlot: 12345n,
    targetBits,
  };
}

test("searchOnCpu finds a nonce whose hash actually clears the target", () => {
  const t = target(4); // cheap enough to find quickly and exhaustively check
  const gen = searchOnCpu(t, 0n);
  const solution = gen.next().value!;
  assert.ok(leadingZeroBits(solution.hash) >= 4);
  assert.equal(solution.hash.length, 32);
  // and it must be the *real* hash for that nonce, not a stand-in
  assert.deepEqual(solution.hash, hashForNonce(t, solution.nonce));
});

test("verifyOnCpu rejects a nonce that doesn't actually clear the target", () => {
  const t = target(4);
  // Find any nonce and compute its true depth; construct a target one bit
  // above that depth so this specific nonce must fail verification.
  const nonce = 0n;
  const hash = hashForNonce(t, nonce);
  const actualDepth = leadingZeroBits(hash);
  const tooStrict = { ...t, targetBits: actualDepth + 1 };
  assert.equal(verifyOnCpu(tooStrict, nonce), null);
});

test("verifyOnCpu accepts a nonce that does clear the target", () => {
  const t = target(4);
  const nonce = 0n;
  const hash = hashForNonce(t, nonce);
  const actualDepth = leadingZeroBits(hash);
  const lenient = { ...t, targetBits: actualDepth };
  assert.deepEqual(verifyOnCpu(lenient, nonce), hash);
});
