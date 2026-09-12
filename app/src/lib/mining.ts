import { keccak256v, leadingZeroBits } from "./keccak";

export interface MiningTarget {
  miner: Uint8Array; // 32 bytes
  lastWinningHash: Uint8Array; // 32 bytes
  anchorHash: Uint8Array; // 32 bytes
  targetBits: number;
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
  /** Yield to the event loop every this many hashes, so the tab stays
   * responsive (and the Cancel button remains clickable) during a search. */
  batchSize?: number;
  signal?: AbortSignal;
}

/** CPU proof-of-work search, batched so it doesn't freeze the tab. A real
 * deployment would also offer the WebGPU path from miner/gpu_miner.ts for
 * throughput; this keeps the frontend to the simpler, always-available path. */
export async function mineInBrowser(
  target: MiningTarget,
  options: MineOptions = {},
): Promise<{ nonce: bigint; hash: Uint8Array }> {
  const batchSize = BigInt(options.batchSize ?? 2000);
  let nonce = 0n;

  for (;;) {
    const batchEnd = nonce + batchSize;
    for (; nonce < batchEnd; nonce++) {
      if (options.signal?.aborted) {
        throw new DOMException("Mining cancelled", "AbortError");
      }
      const hash = hashForNonce(target, nonce);
      if (leadingZeroBits(hash) >= target.targetBits) {
        return { nonce, hash };
      }
    }
    options.onProgress?.(nonce);
    // Yield to the event loop between batches.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
