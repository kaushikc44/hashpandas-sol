/**
 * Deterministic seed -> trait derivation.
 *
 * `Panda.seed` on-chain is already `keccak(work_hash, minted_unix)` (see
 * `handle_mint` in the Rust program), so it's already uniformly distributed
 * -- deriving traits is just slicing bytes out of it, no further hashing
 * needed. Anyone with the seed gets the exact same traits; that's the whole
 * point ("the renderer reads chain data and is reproducible by anyone").
 */

export interface PandaTraits {
  backgroundHue: number; // 0..359
  bodyHue: number; // 0..359
  eyeStyle: number; // 0..3
  accessory: number; // 0..4 (0 = none)
  patternDensity: number; // 0..5
  pose: number; // 0..2
}

export function deriveTraits(seed: Uint8Array): PandaTraits {
  if (seed.length !== 32) {
    throw new Error(`expected a 32-byte seed, got ${seed.length} bytes`);
  }
  return {
    backgroundHue: seed[0]! * (360 / 256),
    bodyHue: seed[1]! * (360 / 256),
    eyeStyle: seed[2]! % 4,
    accessory: seed[3]! % 5,
    patternDensity: seed[4]! % 6,
    pose: seed[5]! % 3,
  };
}
