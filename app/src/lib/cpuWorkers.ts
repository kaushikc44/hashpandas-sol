import type { Attempt, MiningTarget } from "./mining";

export interface CpuWorkerOptions {
  cores: number;
  onProgress?: (hashesTried: bigint) => void;
  onAttempt?: (attempt: Attempt) => void;
  signal?: AbortSignal;
}

/** Real multi-core CPU mining: spawns `cores` Web Workers (public/cpu-worker.js,
 * a plain-JS, independently-verified translation of keccak.ts), each
 * searching a disjoint residue class of the nonce space (worker i tries
 * nonce = i, i + cores, i + 2*cores, ...) so no two workers ever duplicate
 * work. First worker to find a qualifying nonce wins; the rest are
 * terminated immediately. */
export async function mineOnCpuWorkers(
  target: MiningTarget,
  options: CpuWorkerOptions,
): Promise<{ nonce: bigint; hash: Uint8Array }> {
  const cores = Math.max(1, Math.floor(options.cores));

  return new Promise((resolve, reject) => {
    const workers: Worker[] = [];
    const tried = new Array<bigint>(cores).fill(0n);
    let settled = false;

    function totalTried(): bigint {
      return tried.reduce((a, b) => a + b, 0n);
    }

    function cleanup() {
      for (const w of workers) {
        w.postMessage({ type: "stop" });
        w.terminate();
      }
    }

    if (options.signal) {
      if (options.signal.aborted) {
        reject(new DOMException("Mining cancelled", "AbortError"));
        return;
      }
      options.signal.addEventListener(
        "abort",
        () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new DOMException("Mining cancelled", "AbortError"));
        },
        { once: true },
      );
    }

    for (let i = 0; i < cores; i++) {
      const worker = new Worker("/cpu-worker.js");
      workers.push(worker);

      worker.onmessage = (e: MessageEvent) => {
        if (settled) return;
        const msg = e.data;
        if (msg.type === "progress") {
          tried[i] += BigInt(msg.tried);
          options.onProgress?.(totalTried());
        } else if (msg.type === "attempt") {
          options.onAttempt?.({
            nonce: BigInt(msg.nonce),
            hash: new Uint8Array(msg.hash),
            bits: msg.bits,
          });
        } else if (msg.type === "found") {
          settled = true;
          cleanup();
          resolve({ nonce: BigInt(msg.nonce), hash: new Uint8Array(msg.hash) });
        }
      };
      worker.onerror = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`CPU worker ${i} failed: ${err.message}`));
      };

      worker.postMessage({
        type: "start",
        miner: Array.from(target.miner),
        lastWinningHash: Array.from(target.lastWinningHash),
        anchorHash: Array.from(target.anchorHash),
        targetBits: target.targetBits,
        startNonce: i.toString(),
        stride: cores.toString(),
        reportEvery: 500,
      });
    }
  });
}

export function maxCpuCores(): number {
  if (typeof navigator === "undefined") return 1;
  return navigator.hardwareConcurrency || 1;
}
