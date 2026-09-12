# hashpandas-sol

A proof-of-work NFT collection on Solana. Pandas are not sold — the only way one
comes into existence is a keccak256 hash below the current target, paid for at
the current epoch's entry price.

## Read this first

The economics are **already solved and verified**. Do not re-derive them.

- `sim/economics.py` — the source of truth. Run `python3 sim/economics.py`;
  all 22 checks must pass before and after any economics change.
- `programs/hashpandas/src/economics.rs` — the Rust mirror, pure integer math,
  with unit tests that encode the same reference values.
- `docs/TOKENOMICS.md` — why each formula is what it is, and the Solana-specific
  traps (epoch-0 rent floor, rounding, the missing hook).

If you change a formula in one, change it in the other and re-run both.

## Invariants — treat these as unbreakable

1. `eligible_living + eligible_burned == epoch_start_supply(epoch)` at all times.
2. `to_holders + to_hook == price` exactly. No dust, ever.
3. No floating point anywhere in `programs/`.
4. Vault lamports >= (sum of all unclaimed rent). Add a test that mints,
   burns and claims in random order and asserts this after every operation.
5. A panda's rent cursor is `epoch_acc_snapshot[mint_epoch + 1]` — never the
   accumulator value at its own mint.

## Build order

Do these in sequence. Do not start a later one before the earlier one has
passing tests.

1. **Economics module** — `economics.rs` exists; make `cargo test` pass.
2. **State + init** — `state.rs` exists; write `initialize`, size the Config
   account correctly (the two fixed arrays are large — compute, don't guess).
3. **Mint instruction, PoW verification only.** No NFT yet. Verify:
   - preimage = `keccak256(miner_pubkey || nonce || last_winning_hash || anchor)`
   - `anchor` is read from the **SlotHashes sysvar** — do NOT deserialize the
     whole 20KB account; parse the bytes directly and check the supplied slot
     is within the recent window.
   - leading zero bits >= `base_difficulty + streak`
   - `last_mint_slot != Clock::slot` (the one-panda-per-slot ceiling)
   - `keccak` is a syscall (`anchor_lang::solana_program::keccak`), cheap.
4. **Difficulty** — retarget every 8 mints against a 10s target interval, max
   4× harder / 2× easier per window, never below the epoch floor
   (`26 + epoch` bits, scale down for Solana's faster slots — pick a floor that
   makes a mint take ~10s on a mid-range GPU, then hold it).
   Streak doubles per recent mint, cools one step per interval, capped at 16.
5. **Rent split + accumulator update** — wire `split_mint` into the mint path.
   Epoch rollover must snapshot `acc` and fold `pending_burns` in.
6. **Claim instruction** — check the caller owns the Core asset *now*, not that
   they minted it. The claim follows the panda.
7. **Burn instruction** — two gates: at least one later panda exists, and 10
   minutes since mint. Settle accrued rent first, then mark burned, then move
   the cohort counters, then mint $PANDA.
8. **Metaplex Core CPI** — asset creation into the collection, Royalties plugin
   at collection level. Only now does an NFT actually appear.
9. **Treasury crank** — permissionless buyback instruction with per-block price
   impact and spend caps. Be explicit in the docs that this is a keeper, not a
   protocol guarantee.
10. **Renderer + miner** — separate packages, see below.

## Off-chain packages (not started)

- `miner/` — WebGPU compute shader running keccak256, WASM fallback for CPU.
  The card reports depths, not hashes; every promising result is **recomputed
  on the CPU** before it becomes a transaction, and a card that disagrees is
  dropped. Do not skip that check.
- `renderer/` — deterministic seed → PNG. Sprite atlas lives in program-owned
  accounts; the renderer reads chain data and is reproducible by anyone.
  Solana has no free `eth_call`, so rendering is client-side. Say that plainly
  rather than claiming "fully on-chain art".

## Style

- Anchor, latest stable. `#[derive(Accounts)]` with explicit `seeds` + `bump`.
- Every arithmetic op on money is `checked_*` or has a proof-comment.
- Errors in a single `#[error_code]` enum per module.
- Tests: `cargo test` for pure math, `anchor test` (litesvm preferred) for
  instruction flows.

## Do not

- Do not loop over holders to pay rent. Ever. That is what the accumulator is for.
- Do not store rent state in the Core Attributes plugin.
- Do not use a `Vec` in `Config`. Reallocating a hot global account mid-run is
  a failure mode with no recovery.
- Do not deploy to mainnet without an audit. This holds other people's SOL.
