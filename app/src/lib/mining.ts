import { keccak256v, leadingZeroBits } from "./keccak";
import { GpuMiner, isWebGpuAvailable, type GpuAdapterInfo } from "./gpuMiner";

export { isWebGpuAvailable, getGpuAdapterInfo, type GpuAdapterInfo } from "./gpuMiner";

export interface MiningTarget {
  miner: Uint8Array; // 32 bytes
  lastWinningHash: Uint8Array; // 32 bytes
  anchorHash: Uint8Array; // 32 bytes
  targetBits: number;
}

export interface Attempt {
  nonce: bigint;
  hash: Uint8Array;
  bits: number;
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

/** The exact preimage `instructions::mint::handle_mint` hashes. */
export function hashForNonce(target: MiningTarget, nonce: bigint): Uint8Array {
  return keccak256v([target.miner, u64ToLeBytes(nonce), target.lastWinningHash, target.anchorHash]);
}

export interface MineOptions {
  onProgress?: (hashesTried: bigint) => void;
  /** Fired once per batch with the single best (highest-bits) attempt from
   * that batch, purely for the "recent attempts" feed -- not every hash,
   * or a React re-render per hash would itself become the bottleneck. */
  onAttempt?: (attempt: Attempt) => void;
  /** Yield to the event loop every this many hashes, so the tab stays
   * responsive (and the Cancel button remains clickable) during a search. */
  batchSize?: number;
  signal?: AbortSignal;
}

/** CPU proof-of-work search, single-threaded (one browser tab = one JS
 * thread), batched so it doesn't freeze the tab. */
export async function mineInBrowser(
  target: MiningTarget,
  options: MineOptions = {},
): Promise<{ nonce: bigint; hash: Uint8Array }> {
  const batchSize = BigInt(options.batchSize ?? 2000);
  let nonce = 0n;

  for (;;) {
    const batchEnd = nonce + batchSize;
    let best: Attempt | null = null;
    for (; nonce < batchEnd; nonce++) {
      if (options.signal?.aborted) {
        throw new DOMException("Mining cancelled", "AbortError");
      }
      const hash = hashForNonce(target, nonce);
      const bits = leadingZeroBits(hash);
      if (!best || bits > best.bits) best = { nonce, hash, bits };
      if (bits >= target.targetBits) {
        return { nonce, hash };
      }
    }
    options.onProgress?.(nonce);
    if (best) options.onAttempt?.(best);
    // Yield to the event loop between batches.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export interface GpuMineOptions extends MineOptions {
  /** Fired whenever the GPU reports a candidate that the mandatory CPU
   * re-check then rejects -- a false positive, dropped per spec, never
   * trusted into a transaction. */
  onDroppedCandidate?: (nonce: bigint, reportedDepth: number) => void;
  /** Fired once, as soon as the adapter is ready -- which physical GPU
   * WebGPU actually picked. */
  onGpuInfo?: (info: GpuAdapterInfo | null) => void;
}

/** GPU-accelerated search via WebGPU. The GPU only ever reports a depth
 * (leading-zero-bit count) per nonce, never a hash -- every candidate that
 * clears the target is re-hashed here on the CPU before being trusted, so
 * a shader bug can cost search time but can never reach a transaction. */
export async function mineOnGpu(
  target: MiningTarget,
  options: GpuMineOptions = {},
): Promise<{ nonce: bigint; hash: Uint8Array }> {
  const miner = await GpuMiner.create();
  options.onGpuInfo?.(miner.adapterInfo);
  const batchSize = options.batchSize ?? 1 << 16;
  let baseNonce = 0n;

  for (;;) {
    if (options.signal?.aborted) {
      throw new DOMException("Mining cancelled", "AbortError");
    }
    const { depths } = await miner.runBatch({
      miner: target.miner,
      lastWinningHash: target.lastWinningHash,
      anchorHash: target.anchorHash,
      baseNonce,
      batchSize,
    });

    let bestIndex = 0;
    let bestDepth = -1;
    for (let i = 0; i < depths.length; i++) {
      const reportedDepth = depths[i];
      if (reportedDepth >= target.targetBits) {
        const nonce = baseNonce + BigInt(i);
        const hash = hashForNonce(target, nonce);
        const bits = leadingZeroBits(hash);
        if (bits >= target.targetBits) {
          return { nonce, hash };
        }
        options.onDroppedCandidate?.(nonce, reportedDepth);
      }
      if (reportedDepth > bestDepth) {
        bestDepth = reportedDepth;
        bestIndex = i;
      }
    }
    options.onProgress?.(baseNonce + BigInt(depths.length));
    if (options.onAttempt) {
      // The GPU only ever reports a depth, never a hash (per spec) -- this
      // one extra CPU hash, just for the feed's best-of-batch display, is
      // real, not synthesized.
      const bestNonce = baseNonce + BigInt(bestIndex);
      const bestHash = hashForNonce(target, bestNonce);
      options.onAttempt({ nonce: bestNonce, hash: bestHash, bits: leadingZeroBits(bestHash) });
    }

    baseNonce += BigInt(batchSize);
  }
}
