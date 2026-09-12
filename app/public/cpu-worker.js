// Plain-JS CPU mining worker. Not bundled (Next.js worker bundling has
// enough cross-version quirks that a static file, loaded the same way as
// keccak.wgsl, is the safer bet) -- this is a mechanical translation of
// src/lib/keccak.ts, same tables, same algorithm, so it stays correct by
// construction rather than by re-verifying it separately.

const RATE_BYTES = 136;
const MASK64 = (1n << 64n) - 1n;

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const ROTC = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

function idx(x, y) {
  return (((x % 5) + 5) % 5) + 5 * (((y % 5) + 5) % 5);
}

function rotl64(x, n) {
  const s = ((n % 64) + 64) % 64;
  if (s === 0) return x & MASK64;
  return ((x << BigInt(s)) | (x >> BigInt(64 - s))) & MASK64;
}

function keccakF1600(state) {
  let a = state.slice();
  for (let round = 0; round < 24; round++) {
    const c = new Array(5);
    for (let x = 0; x < 5; x++) {
      c[x] = a[idx(x, 0)] ^ a[idx(x, 1)] ^ a[idx(x, 2)] ^ a[idx(x, 3)] ^ a[idx(x, 4)];
    }
    const d = new Array(5);
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        a[idx(x, y)] ^= d[x];
      }
    }
    const b = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[idx(y, 2 * x + 3 * y)] = rotl64(a[idx(x, y)], ROTC[idx(x, y)]);
      }
    }
    const next = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        next[idx(x, y)] = b[idx(x, y)] ^ (~b[idx(x + 1, y)] & b[idx(x + 2, y)] & MASK64);
      }
    }
    next[0] ^= RC[round];
    a = next;
  }
  return a;
}

function laneFromBytesLE(bytes, offset) {
  let lane = 0n;
  for (let i = 7; i >= 0; i--) {
    lane = (lane << 8n) | BigInt(bytes[offset + i]);
  }
  return lane;
}

function laneToBytesLE(lane, out, offset) {
  let v = lane;
  for (let i = 0; i < 8; i++) {
    out[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function keccak256(msg) {
  const padLen = RATE_BYTES - (msg.length % RATE_BYTES);
  const padded = new Uint8Array(msg.length + padLen);
  padded.set(msg);
  padded[msg.length] |= 0x01;
  padded[padded.length - 1] |= 0x80;

  let state = new Array(25).fill(0n);
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

function keccak256v(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    buf.set(p, offset);
    offset += p.length;
  }
  return keccak256(buf);
}

function leadingZeroBits(hash) {
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

function u64ToLeBytes(v) {
  const out = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

// -- worker protocol ---------------------------------------------------
//
// in:  { type: "start", miner, lastWinningHash, anchorHash, targetBits,
//         startNonce, stride, reportEvery }  (typed arrays / bigint-as-string)
// out: { type: "progress", tried }
//      { type: "attempt", nonce, hash, bits }   (best-of-batch, sampled)
//      { type: "found", nonce, hash }
//      { type: "stopped" }

let stop = false;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "stop") {
    stop = true;
    return;
  }
  if (msg.type !== "start") return;
  stop = false;

  const miner = new Uint8Array(msg.miner);
  const lastWinningHash = new Uint8Array(msg.lastWinningHash);
  const anchorHash = new Uint8Array(msg.anchorHash);
  const targetBits = msg.targetBits;
  const stride = BigInt(msg.stride);
  const reportEvery = msg.reportEvery ?? 500;

  let nonce = BigInt(msg.startNonce);
  let triedSinceReport = 0;
  let best = null;

  while (!stop) {
    const hash = keccak256v([miner, u64ToLeBytes(nonce), lastWinningHash, anchorHash]);
    const bits = leadingZeroBits(hash);
    if (!best || bits > best.bits) best = { nonce, hash, bits };

    if (bits >= targetBits) {
      self.postMessage({ type: "found", nonce: nonce.toString(), hash: Array.from(hash) });
      return;
    }

    triedSinceReport++;
    if (triedSinceReport >= reportEvery) {
      self.postMessage({ type: "progress", tried: triedSinceReport });
      if (best) {
        self.postMessage({
          type: "attempt",
          nonce: best.nonce.toString(),
          hash: Array.from(best.hash),
          bits: best.bits,
        });
      }
      triedSinceReport = 0;
      best = null;
    }

    nonce += stride;
  }
  self.postMessage({ type: "stopped" });
};
