# hashpandas-sol

A proof-of-work NFT collection on Solana. Pandas are not sold — the only way one
comes into existence is a keccak256 hash below the current target, paid for at
the current epoch's entry price. Every earlier panda earns rent from every
mint that comes after it.

- **Tokenomics / docs:** https://claude.ai/code/artifact/efda0aaa-50fb-4bed-a40a-262e723adc61
- **Live app (devnet):** ask in the repo, or run `cd app && npm install && npm run build && npm run start`
- **Program:** `97c5ZbrrVVJa8jY1vVHX1tpKtZXrUBp7YyfpfhKnxpmK` (devnet)

> **Status:** devnet only. Not audited. Do not point this at mainnet or real
> funds without an independent security review.

## Layout

```
programs/hashpandas/   Anchor program: economics, PoW mint, claim, burn,
                        treasury crank, Metaplex Core integration
sim/economics.py        Reference economics model, verified against the
                        original project's published figures (22 checks)
docs/TOKENOMICS.md       Why each formula is what it is
app/                    Next.js frontend (mining UI, wallet connect, gallery)
miner/                  WebGPU + pure-TS keccak256 proof-of-work miner
renderer/               Deterministic seed -> PNG panda renderer
scripts/                One-off devnet deploy/initialize/admin scripts
```

## Running the program tests

```
cd programs/hashpandas
cargo test              # pure math + a 6,000-op randomized invariant check
cargo test --test demo -- --nocapture   # real litesvm end-to-end mint, using
                                          # the actual mainnet mpl-core binary
```

```
python3 sim/economics.py   # the economics source of truth, 22 checks
```

## Running the frontend locally

```
cd app
npm install
npm run build
npm run start
```

Needs a Solana wallet (Phantom/Solflare/etc.) switched to devnet with a little
devnet SOL.

## Invariants this program treats as unbreakable

1. `eligible_living + eligible_burned == epoch_start_supply(epoch)` at all times.
2. `to_holders + to_hook == price` exactly. No dust, ever.
3. No floating point anywhere in `programs/`.
4. Vault lamports >= sum of all unclaimed rent (checked via a randomized
   mint/claim/burn simulation in `tests/invariants.rs`).
5. A panda's rent cursor is `epoch_acc_snapshot[mint_epoch + 1]` — never the
   accumulator value at its own mint.

## License

Unlicensed for now — this is a devnet experiment, not a production release.
