/**
 * Pure-TypeScript Keccak-256, from scratch -- the ORIGINAL Keccak padding
 * (domain byte 0x01), not NIST SHA3-256 (0x06). Solana's `keccak` syscall
 * (and `solana_keccak_hasher`, via the `sha3` crate's `Keccak256` type on
 * the client side) is the original variant, so this must match it exactly
 * or every submission this miner finds gets rejected on-chain.
 *
 * This is the mandatory CPU re-check: the GPU shader (gpu_miner.ts) only
 * ever reports a "depth" (leading-zero-bit count) per nonce, never a hash.
 * Every nonce whose reported depth clears the target gets its full hash
 * recomputed here before it is trusted -- see docs on `verifyOnCpu` below.
 *
 * No dependencies, so there is nothing to audit here but this file.
 */

const RATE_BYTES = 136; // 1088 bits, for 256-bit output (capacity = 512 bits)
const MASK64 = (1n << 64n) - 1n;

const RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Combined rho+pi rotation offsets, flat-indexed by idx(x, y) = x + 5*y.
const ROTC: number[] = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

function idx(x: number, y: number): number {
  return ((x % 5) + 5) % 5 + 5 * ((((y % 5) + 5) % 5));
}

function rotl64(x: bigint, n: number): bigint {
  const s = ((n % 64) + 64) % 64;
  if (s === 0) return x & MASK64;
  return ((x << BigInt(s)) | (x >> BigInt(64 - s))) & MASK64;
}

function keccakF1600(state: bigint[]): bigint[] {
  let a = state.slice();

  for (let round = 0; round < 24; round++) {
    // theta
    const c = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) {
      c[x] = a[idx(x, 0)] ^ a[idx(x, 1)] ^ a[idx(x, 2)] ^ a[idx(x, 3)] ^ a[idx(x, 4)];
    }
    const d = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        a[idx(x, y)] ^= d[x];
      }
    }

    // rho + pi
    const b = new Array<bigint>(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[idx(y, 2 * x + 3 * y)] = rotl64(a[idx(x, y)], ROTC[idx(x, y)]);
      }
    }

    // chi
    const next = new Array<bigint>(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        next[idx(x, y)] =
          b[idx(x, y)] ^ (~b[idx(x + 1, y)] & b[idx(x + 2, y)] & MASK64);
      }
    }

    // iota
    next[0] ^= RC[round];

    a = next;
  }

  return a;
}

function laneFromBytesLE(bytes: Uint8Array, offset: number): bigint {
  let lane = 0n;
  for (let i = 7; i >= 0; i--) {
    lane = (lane << 8n) | BigInt(bytes[offset + i]);
  }
  return lane;
}

function laneToBytesLE(lane: bigint, out: Uint8Array, offset: number): void {
  let v = lane;
  for (let i = 0; i < 8; i++) {
    out[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

/** Keccak-256 (original padding) of arbitrary bytes. */
export function keccak256(msg: Uint8Array): Uint8Array {
  const padLen = RATE_BYTES - (msg.length % RATE_BYTES);
  const padded = new Uint8Array(msg.length + padLen);
  padded.set(msg);
  padded[msg.length] |= 0x01;
  padded[padded.length - 1] |= 0x80;

  let state = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
    for (let i = 0; i < RATE_BYTES / 8; i++) {
      state[i] ^= laneFromBytesLE(padded, offset + i * 8);
    }
    state = keccakF1600(state);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    laneToBytesLE(state[i], out, i * 8);
  }
  return out;
}

/** Keccak-256 of the concatenation of several byte arrays, matching the
 * on-chain `keccak::hashv` call in `programs/hashpandas/src/instructions/mint.rs`. */
export function keccak256v(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    buf.set(p, offset);
    offset += p.length;
  }
  return keccak256(buf);
}

/** Leading zero BITS across the full 32-byte hash -- mirrors
 * `utils::leading_zero_bits` in the Rust program exactly. */
export function leadingZeroBits(hash: Uint8Array): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    let b = byte;
    let leading = 0;
    while ((b & 0x80) === 0 && leading < 8) {
      leading += 1;
      b <<= 1;
    }
    bits += leading;
    break;
  }
  return bits;
}
