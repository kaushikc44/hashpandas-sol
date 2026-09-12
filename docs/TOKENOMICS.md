# Tokenomics

Every formula below was reconstructed from the published Hashpandas figures and
then verified against them. `sim/economics.py` reproduces all 22 reference
numbers, including the lifetime totals (1,787 SOL-equivalent collected,
536.085 to the hook, over 16,376 pandas). Do not change a formula here without
re-running that file.

---

## 1. The identity everything rests on

Epoch sizes double: 8, 16, 32, 64, ... So the supply when epoch `e` opens is

```
epoch_start_supply(e) = 8 * (2^e - 1)
```

Two separate things are set by that one number:

- **the price** — `entry_price(e) = epoch_start_supply(e) * STEP`
- **the recipient count** — a panda is paid by mints of *later* epochs only,
  so the eligible set is exactly the pandas alive when the epoch opened

Therefore the rent one mint owes one panda is:

```
70% * (epoch_start_supply * STEP) / epoch_start_supply  =  0.70 * STEP
```

The supply term cancels. **That cancellation is the entire design.** It is why
the price can stay flat across a whole epoch while the per-panda rate never
moves, and why "one rate to every earlier panda" is an arithmetic identity rather
than a distribution policy you have to enforce.

Verified: epoch 6 opens at 504 pandas, price 504 × 0.00002 = 0.01008, rent per
panda 0.000014, and 504 × 0.000014 = 0.007056 = exactly 70% of the price.

## 2. Why "your own epoch does not pay you" is load-bearing

If neighbours paid each other, the recipient count would grow *during* an
epoch, the cancellation above would break, and the price would have to move
mid-epoch to keep the rate constant. Deferring eligibility to the next epoch
boundary is what buys the flat price.

Implementation: a panda minted in epoch `E` takes its rent cursor from
`epoch_acc_snapshot[E + 1]`, not from the accumulator value at its mint.

## 3. The accumulator

You cannot iterate 16,000 recipients in one Solana instruction, so no rent is
ever *transferred* at mint time. A single global number rises; each panda
subtracts the value that number had when it became eligible.

```
claimable(panda) = acc_now - epoch_acc_snapshot[mint_epoch + 1] - claimed
```

With zero burns this collapses to a closed form — `acc` would simply be
`supply * rent_step`. **Burns break that**, which is why `acc` must be a stored
u128 rather than derived from supply.

## 4. What a burn does

A burned panda keeps its slot in the recipient count, but its share is re-split
by the same 70/30 rule: 70% to the pandas still alive, 30% to the hook.

```
survivor_multiplier = 1 + (burned / living) * 0.70
hook_effective_bps  = 3000 + burned_fraction * 0.70 * 3000
```

Verified against their stated case: at 50% burned, survivors earn **1.70×** and
the hook's take rises to **40.5%**. One exit feeds both sides — that is the
flywheel, and it is real, not marketing.

Burn returns halve per epoch waited (1000 / 500 / 250 / 125 ...), and the token
is pinned above by `entry_price / 1000`, because past that, mint-and-burn is
cheaper than buying. The ceiling doubles every epoch on its own.

## 5. Solana-specific decisions you must make

### 5.1 The epoch-0 price floor — a real trap

On Ethereum the miner pays gas; the contract stores nothing per token. On
Solana **you** pay rent-exemption for every account you create:

| Account | Cost |
|---|---|
| Metaplex Core asset | ~0.0029 SOL |
| `Panda` PDA (rent record) | ~0.0018 SOL |
| Transaction fee + priority | ~0.0001+ SOL |

So `epoch0_flat_lamports` **must** comfortably exceed ~0.005 SOL or the
protocol subsidises every mint in epoch 0 and never recovers it. The original's
0.000069 ETH first-epoch price has no safe direct translation. Suggested
starting values:

```
STEP              = 500_000 lamports (0.0005 SOL)   -> epoch 6 costs 0.252 SOL
EPOCH0_FLAT       =  10_000_000 lamports (0.01 SOL) -> covers rent with margin
```

`STEP` must be a multiple of 5 so `STEP * 7000 / 10000` is exact with no
truncation.

### 5.2 Rounding

`split_mint` computes the holder side from the per-panda rate and derives the
hook side as `price - to_holders`. Never compute both independently — the two
would disagree by a lamport or two and strand dust in the vault forever. A test
asserts exactness across all 505 burn levels.

The accumulator is scaled by 1e12 and `claimed_scaled` is stored scaled, so
repeated partial claims cannot lose sub-lamport remainders.

### 5.3 The hook has no equivalent

Uniswap v4 hooks do not exist on Solana. The 30% does not auto-buy anything.
You need a permissionless crank instruction plus a keeper, and the buyback
limits (1% price impact per block, spend cap) have to be enforced by your own
program against whichever AMM you use. **Be honest in your docs about this
being weaker than the original.** It is a keeper, not a protocol guarantee.

### 5.4 Creator fee

Two distinct things, do not conflate them:

1. **Mint-time split** — fully enforceable, your program moves the lamports.
   This is your actual revenue. Take the project share out of the hook's 30%
   before the buyback queue, exactly as the original does.
2. **Secondary royalty** — Metaplex Core Royalties plugin, basis points, up to
   5 creators, with a `ruleSet` allowlist/denylist of marketplace programs.
   Stronger than legacy Solana royalties, but still depends on marketplaces
   honouring the plugin. **Do not model revenue assuming it arrives.**

Set it at the *collection* level so all 16k assets inherit it in one
transaction, and leave the asset-level override unused.

## 6. Open decisions

- [ ] `STEP` and `EPOCH0_FLAT` in lamports (see the floor above)
- [ ] Where the wall sits — the original ends at ~16,376 by difficulty, not by
      a supply cap. Do you keep "no supply cap" honestly?
- [ ] $PANDA genesis supply and initial pool depth
- [ ] Project share of the hook (original: 30% of the 30%)
- [ ] Trading gate: pandas, not dates (original: 1,016)
