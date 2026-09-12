// Keccak-256 (original padding, matching Solana's `keccak` syscall) as a
// WebGPU compute shader, searching for a nonce whose hash clears a target
// leading-zero-bit count.
//
// WGSL has no native 64-bit integer type, so every 64-bit lane is a
// vec2<u32>(lo, hi). The permutation tables below (RC, ROTC) were generated
// from -- and are byte-for-byte identical to -- the tested TypeScript
// implementation in cpu_keccak.ts, not retyped by hand.
//
// CRITICAL: per CLAUDE.md and cpu_keccak.ts, this shader NEVER reports a
// hash, only a per-nonce "depth" (leading-zero-bit count). Every promising
// depth is recomputed on the CPU (see gpu_miner.ts) before it is trusted --
// a shader bug here can only cost wasted search time, never an invalid
// on-chain submission, because nothing found here is trusted directly.

struct Params {
  miner: array<u32, 8>,          // 32 bytes, raw u32 words, little-endian within each word
  last_winning_hash: array<u32, 8>,
  anchor_hash: array<u32, 8>,
  base_nonce_lo: u32,
  base_nonce_hi: u32,
}

// `uniform` address space requires array element strides to be multiples of
// 16 bytes, which a packed `array<u32, 8>` violates -- `storage` has no such
// restriction, so the params buffer lives there instead.
@group(0) @binding(0) var<storage, read> params: Params;
@group(0) @binding(1) var<storage, read_write> depths: array<u32>;

fn xor2(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
  return vec2<u32>(a.x ^ b.x, a.y ^ b.y);
}
fn and2(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
  return vec2<u32>(a.x & b.x, a.y & b.y);
}
fn not2(a: vec2<u32>) -> vec2<u32> {
  return vec2<u32>(~a.x, ~a.y);
}

fn rotl64(v: vec2<u32>, n: u32) -> vec2<u32> {
  if (n == 0u) {
    return v;
  } else if (n < 32u) {
    let lo = (v.x << n) | (v.y >> (32u - n));
    let hi = (v.y << n) | (v.x >> (32u - n));
    return vec2<u32>(lo, hi);
  } else if (n == 32u) {
    return vec2<u32>(v.y, v.x);
  } else {
    let m = n - 32u;
    let lo = (v.y << m) | (v.x >> (32u - m));
    let hi = (v.x << m) | (v.y >> (32u - m));
    return vec2<u32>(lo, hi);
  }
}

const RC: array<vec2<u32>, 24> = array<vec2<u32>, 24>(
  vec2<u32>(0x1u, 0x0u),
  vec2<u32>(0x8082u, 0x0u),
  vec2<u32>(0x808au, 0x80000000u),
  vec2<u32>(0x80008000u, 0x80000000u),
  vec2<u32>(0x808bu, 0x0u),
  vec2<u32>(0x80000001u, 0x0u),
  vec2<u32>(0x80008081u, 0x80000000u),
  vec2<u32>(0x8009u, 0x80000000u),
  vec2<u32>(0x8au, 0x0u),
  vec2<u32>(0x88u, 0x0u),
  vec2<u32>(0x80008009u, 0x0u),
  vec2<u32>(0x8000000au, 0x0u),
  vec2<u32>(0x8000808bu, 0x0u),
  vec2<u32>(0x8bu, 0x80000000u),
  vec2<u32>(0x8089u, 0x80000000u),
  vec2<u32>(0x8003u, 0x80000000u),
  vec2<u32>(0x8002u, 0x80000000u),
  vec2<u32>(0x80u, 0x80000000u),
  vec2<u32>(0x800au, 0x0u),
  vec2<u32>(0x8000000au, 0x80000000u),
  vec2<u32>(0x80008081u, 0x80000000u),
  vec2<u32>(0x8080u, 0x80000000u),
  vec2<u32>(0x80000001u, 0x0u),
  vec2<u32>(0x80008008u, 0x80000000u)
);

// Flat-indexed by idx(x, y) = x + 5*y, identical table to cpu_keccak.ts.
const ROTC: array<u32, 25> = array<u32, 25>(
  0u, 1u, 62u, 28u, 27u,
  36u, 44u, 6u, 55u, 20u,
  3u, 10u, 43u, 25u, 39u,
  41u, 45u, 15u, 21u, 8u,
  18u, 2u, 61u, 56u, 14u
);

fn idx(x: i32, y: i32) -> u32 {
  let xm = u32(((x % 5) + 5) % 5);
  let ym = u32(((y % 5) + 5) % 5);
  return xm + 5u * ym;
}

fn keccak_f1600(state_in: array<vec2<u32>, 25>) -> array<vec2<u32>, 25> {
  var a = state_in;

  for (var round = 0u; round < 24u; round = round + 1u) {
    // theta
    var c: array<vec2<u32>, 5>;
    for (var x = 0; x < 5; x = x + 1) {
      c[x] = xor2(xor2(xor2(xor2(a[idx(x, 0)], a[idx(x, 1)]), a[idx(x, 2)]), a[idx(x, 3)]), a[idx(x, 4)]);
    }
    var d: array<vec2<u32>, 5>;
    for (var x = 0; x < 5; x = x + 1) {
      let xp1 = (x + 1) % 5;
      let xm1 = (x + 4) % 5;
      d[x] = xor2(c[xm1], rotl64(c[xp1], 1u));
    }
    for (var x = 0; x < 5; x = x + 1) {
      for (var y = 0; y < 5; y = y + 1) {
        a[idx(x, y)] = xor2(a[idx(x, y)], d[x]);
      }
    }

    // rho + pi
    var b: array<vec2<u32>, 25>;
    for (var x = 0; x < 5; x = x + 1) {
      for (var y = 0; y < 5; y = y + 1) {
        let dest = idx(y, 2 * x + 3 * y);
        b[dest] = rotl64(a[idx(x, y)], ROTC[idx(x, y)]);
      }
    }

    // chi
    var next: array<vec2<u32>, 25>;
    for (var x = 0; x < 5; x = x + 1) {
      for (var y = 0; y < 5; y = y + 1) {
        next[idx(x, y)] = xor2(b[idx(x, y)], and2(not2(b[idx(x + 1, y)]), b[idx(x + 2, y)]));
      }
    }

    // iota
    next[0] = xor2(next[0], RC[round]);

    a = next;
  }

  return a;
}

// Absorbs a fixed 104-byte preimage (miner || nonce || last_winning_hash ||
// anchor_hash), which fits in a single 136-byte rate block after padding,
// and returns the first 32 bytes of the resulting state as 8 u32 words.
fn keccak256_preimage(nonce_lo: u32, nonce_hi: u32) -> array<u32, 8> {
  var state: array<vec2<u32>, 25>;
  for (var i = 0; i < 25; i = i + 1) {
    state[i] = vec2<u32>(0u, 0u);
  }

  // Byte layout of the 104-byte message, packed little-endian into 17
  // lanes (136 bytes) of rate, with Keccak's original pad10*1 (0x01 ... 0x80).
  //   bytes 0..32   = miner            (lanes 0..4)
  //   bytes 32..40  = nonce, u64 LE     (lane 4, high half; see packing below)
  //   bytes 40..72  = last_winning_hash (lanes 5..9)
  //   bytes 72..104 = anchor_hash       (lanes 9..13, low half)
  //   byte 104      = 0x01 (pad start)
  //   byte 135      = 0x80 (pad end)
  //
  // Lane packing is done word-by-word (32 bits = half a lane) since the
  // inputs are u32 arrays already; each pair of u32 words forms one lane
  // as (lo=first word, hi=second word).
  var words: array<u32, 34>; // 17 lanes * 2 words = 34 words = 136 bytes
  for (var i = 0; i < 8; i = i + 1) {
    words[i] = params.miner[i];
  }
  words[8] = nonce_lo;
  words[9] = nonce_hi;
  for (var i = 0; i < 8; i = i + 1) {
    words[10 + i] = params.last_winning_hash[i];
  }
  for (var i = 0; i < 8; i = i + 1) {
    words[18 + i] = params.anchor_hash[i];
  }
  // Byte 104 is the first byte of word index 26 (104 / 4 = 26, offset 0).
  words[26] = 0x00000001u;
  for (var i = 27; i < 33; i = i + 1) {
    words[i] = 0u;
  }
  // Byte 135 is the last byte of word index 33 (135 / 4 = 33, offset 3).
  words[33] = 0x80000000u;

  for (var lane = 0; lane < 17; lane = lane + 1) {
    state[lane] = vec2<u32>(words[lane * 2], words[lane * 2 + 1]);
  }

  state = keccak_f1600(state);

  var out: array<u32, 8>;
  for (var i = 0; i < 4; i = i + 1) {
    out[i * 2] = state[i].x;
    out[i * 2 + 1] = state[i].y;
  }
  return out;
}

fn leading_zero_bits(h: array<u32, 8>) -> u32 {
  // `h` words are in little-endian byte order within each u32 (word i
  // holds bytes [4i, 4i+1, 4i+2, 4i+3] of the hash, least-significant byte
  // first), matching how keccak256_preimage packs the squeezed state.
  var bits: u32 = 0u;
  for (var w = 0; w < 8; w = w + 1) {
    // Walk this word's 4 bytes in hash-byte-order (byte 0 = lowest bits).
    for (var byteIdx = 0; byteIdx < 4; byteIdx = byteIdx + 1) {
      let byte = (h[w] >> u32(byteIdx * 8)) & 0xffu;
      if (byte == 0u) {
        bits = bits + 8u;
      } else {
        bits = bits + u32(countLeadingZeros(byte)) - 24u; // byte is in the low 8 bits of a u32
        return bits;
      }
    }
  }
  return bits;
}

// Adds `n` (a u32 value) to a little-endian u64 given as (lo, hi).
fn add_u64_u32(lo: u32, hi: u32, n: u32) -> vec2<u32> {
  let sum = lo + n;
  let carry = select(0u, 1u, sum < lo);
  return vec2<u32>(sum, hi + carry);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  let nonce = add_u64_u32(params.base_nonce_lo, params.base_nonce_hi, i);
  let h = keccak256_preimage(nonce.x, nonce.y);
  depths[i] = leading_zero_bits(h);
}
