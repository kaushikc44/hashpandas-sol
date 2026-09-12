/**
 * Ties the GPU search and the mandatory CPU re-check together.
 *
 * CLAUDE.md is explicit: "The card reports depths, not hashes; every
 * promising result is recomputed on the CPU before it becomes a
 * transaction, and a card that disagrees is dropped. Do not skip that
 * check." This module is that check, plus the search loop around it.
 *
 * The CPU path here is pure TypeScript (cpu_keccak.ts), not WASM. A real
 * deployment would want the hot loop (the CPU-only fallback, and the
 * per-candidate re-verify) compiled to WASM -- e.g. a small Rust crate via
 * wasm-bindgen sharing the exact permutation tables -- for throughput. The
 * TypeScript version is correctness-verified (see cpu_keccak.test.ts and
 * the Rust-vs-JS cross-check in this package's history) but not fast; swap
 * the implementation behind `keccak256v`/`leadingZeroBits` without changing
 * this file's control flow when that's worth doing.
 */

import { GpuMiner, type MinerBatchParams } from "./gpu_miner.ts";
import { keccak256v, leadingZeroBits } from "./cpu_keccak.ts";

export interface MiningTarget {
  miner: Uint8Array; // 32 bytes: the miner's own pubkey
  lastWinningHash: Uint8Array; // 32 bytes: Config.last_winning_hash on-chain
  anchorHash: Uint8Array; // 32 bytes: hash fetched from SlotHashes for anchorSlot
  anchorSlot: bigint;
  targetBits: number; // config.base_difficulty + config.streak
}

export interface MinedSolution {
  nonce: bigint;
  hash: Uint8Array;
  anchorSlot: bigint;
}

function u64ToLeBytes(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** Full keccak256 over the exact preimage the on-chain program checks. */
export function hashForNonce(target: MiningTarget, nonce: bigint): Uint8Array {
  return keccak256v([
    target.miner,
    u64ToLeBytes(nonce),
    target.lastWinningHash,
    target.anchorHash,
  ]);
}

/** Recomputes and re-verifies a GPU-reported candidate. Returns the real
 * hash if the GPU's depth claim holds up, or null if it was a false
 * positive -- which per spec means the candidate is dropped, not retried. */
export function verifyOnCpu(target: MiningTarget, nonce: bigint): Uint8Array | null {
  const hash = hashForNonce(target, nonce);
  return leadingZeroBits(hash) >= target.targetBits ? hash : null;
}

/** Pure-CPU brute-force search, used when no WebGPU device is available.
 * Every hash here is real (there's no separate "depth vs hash" gap to
 * bridge), so no extra re-check is needed on top of it. */
export function* searchOnCpu(
  target: MiningTarget,
  startNonce: bigint = 0n,
): Generator<MinedSolution, never, unknown> {
  let nonce = startNonce;
  for (;;) {
    const hash = hashForNonce(target, nonce);
    if (leadingZeroBits(hash) >= target.targetBits) {
      yield { nonce, hash, anchorSlot: target.anchorSlot };
    }
    nonce += 1n;
  }
}

export interface GpuSearchOptions {
  wgslSource: string;
  batchSize?: number;
  /** Called for every GPU-reported candidate that failed CPU re-verification. */
  onDroppedCandidate?: (nonce: bigint, reportedDepth: number) => void;
}

/** GPU-accelerated search. Yields only CPU-verified solutions -- a nonce
 * the GPU claims clears the target but the CPU disagrees on is dropped
 * silently except for the optional `onDroppedCandidate` callback. */
export async function* searchOnGpu(
  target: MiningTarget,
  options: GpuSearchOptions,
): AsyncGenerator<MinedSolution, never, unknown> {
  const miner = await GpuMiner.create(options.wgslSource);
  const batchSize = options.batchSize ?? 1 << 16;
  let baseNonce = 0n;

  for (;;) {
    const batchParams: MinerBatchParams = {
      miner: target.miner,
      lastWinningHash: target.lastWinningHash,
      anchorHash: target.anchorHash,
      baseNonce,
      batchSize,
    };
    const { depths } = await miner.runBatch(batchParams);

    for (let i = 0; i < depths.length; i++) {
      if (depths[i] >= target.targetBits) {
        const nonce = baseNonce + BigInt(i);
        const verified = verifyOnCpu(target, nonce);
        if (verified) {
          yield { nonce, hash: verified, anchorSlot: target.anchorSlot };
        } else {
          options.onDroppedCandidate?.(nonce, depths[i]);
        }
      }
    }

    baseNonce += BigInt(batchSize);
  }
}
