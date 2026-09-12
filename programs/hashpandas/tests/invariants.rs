//! CLAUDE.md invariant #4: "Vault lamports >= (sum of all unclaimed rent).
//! Add a test that mints, burns and claims in random order and asserts this
//! after every operation."
//!
//! This drives the exact same `Config` methods the real `mint`/`claim`/`burn`
//! instructions call (`roll_epoch_if_needed`, `economics::split_mint`,
//! `settle_panda_rent`, `record_burn`) through thousands of randomly ordered
//! operations, tracking a simulated vault balance and asserting it never goes
//! negative -- i.e. no sequence of claims can ever pay out more than the
//! mints actually deposited. It's a pure-Rust simulation (no Solana runtime),
//! so it also re-checks invariant #1 after every mint and burn.

use hashpandas::economics;
use hashpandas::state::{Config, Panda};

const STEP: u64 = 500_000; // 0.0005 SOL, per docs/TOKENOMICS.md
const EPOCH0_FLAT: u64 = 10_000_000; // 0.01 SOL

fn fresh_config() -> Config {
    Config {
        authority: Default::default(),
        treasury: Default::default(),
        vault: Default::default(),
        collection: Default::default(),
        panda_mint: Default::default(),
        step_lamports: STEP,
        epoch0_flat_lamports: EPOCH0_FLAT,
        supply: 0,
        epoch: 0,
        acc: 0,
        epoch_acc_snapshot: [0u128; hashpandas::state::EPOCH_SLOTS],
        eligible_living: 0,
        eligible_burned: 0,
        pending_burns: [0u32; hashpandas::state::EPOCH_SLOTS],
        last_winning_hash: [0u8; 32],
        base_difficulty: 20,
        last_mint_slot: 0,
        last_mint_unix: 0,
        retarget_window_start_unix: 0,
        mints_since_retarget: 0,
        streak: 0,
        streak_last_cool_unix: 0,
        lifetime_to_holders: 0,
        lifetime_to_hook: 0,
        lifetime_claimed: 0,
        bump: 0,
        vault_bump: 0,
        treasury_bump: 0,
        buyback_amm_program: Default::default(),
        buyback_dest_token_account: Default::default(),
        crank_spend_cap_lamports: 0,
        max_price_impact_bps: 0,
        last_crank_slot: 0,
        lifetime_buyback_spent_lamports: 0,
        lifetime_buyback_tokens_bought: 0,
    }
}

fn fresh_panda(index: u64, mint_epoch: u8) -> Panda {
    Panda {
        asset: Default::default(),
        index,
        mint_epoch,
        minted_unix: 0,
        seed: [0u8; 32],
        work_hash: [0u8; 32],
        claimed_scaled: 0,
        burned: false,
        bump: 0,
    }
}

/// A tiny deterministic PRNG so the test is reproducible without pulling in
/// the `rand` crate just for this.
struct Lcg(u64);
impl Lcg {
    fn next_u64(&mut self) -> u64 {
        // Numerical Recipes LCG constants.
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1);
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
}

fn assert_recipient_invariant(config: &Config) {
    if config.epoch > 0 {
        let recipients = economics::epoch_start_supply(config.epoch).unwrap();
        assert_eq!(
            config.eligible_living + config.eligible_burned,
            recipients,
            "invariant #1 broken at epoch {}",
            config.epoch
        );
    }
}

#[test]
fn vault_never_overdrawn_across_random_mint_claim_burn_sequences() {
    let mut rng = Lcg(0xC0FFEE_u64);
    let mut config = fresh_config();
    let mut pandas: Vec<Panda> = Vec::new();
    let mut vault_balance: i128 = 0;

    const OPS: usize = 6000;
    // Enough mints to cross several epoch boundaries (epoch 7 opens at 1016).
    const MAX_SUPPLY: u64 = 3000;

    for _ in 0..OPS {
        let living_pandas: Vec<usize> = pandas
            .iter()
            .enumerate()
            .filter(|(_, p)| !p.burned)
            .map(|(i, _)| i)
            .collect();

        // Weight toward minting early so there's something to claim/burn.
        let action = if pandas.is_empty() || config.supply < MAX_SUPPLY && rng.below(3) != 0 {
            0
        } else if !living_pandas.is_empty() && rng.below(2) == 0 {
            1 // claim
        } else if !living_pandas.is_empty() {
            2 // burn
        } else {
            0
        };

        match action {
            0 => {
                // -- mint --
                config.roll_epoch_if_needed().unwrap();
                assert_recipient_invariant(&config);

                let e = config.epoch;
                let split = economics::split_mint(
                    e,
                    config.step_lamports,
                    config.epoch0_flat_lamports,
                    config.eligible_living,
                    config.eligible_burned,
                )
                .unwrap();

                assert_eq!(
                    split.to_holders + split.to_hook,
                    split.price,
                    "invariant #2 broken: to_holders + to_hook != price"
                );

                vault_balance += split.to_holders as i128;
                config.acc = config.acc.checked_add(split.acc_delta).unwrap();
                config.supply += 1;

                pandas.push(fresh_panda(config.supply, e));
            }
            1 => {
                // -- claim --
                let idx = living_pandas[rng.below(living_pandas.len())];
                let lamports = config.settle_panda_rent(&mut pandas[idx]);
                assert!(
                    lamports as i128 <= vault_balance,
                    "invariant #4 broken: claim of {lamports} exceeds vault balance {vault_balance}"
                );
                vault_balance -= lamports as i128;
            }
            2 => {
                // -- burn --
                let idx = living_pandas[rng.below(living_pandas.len())];
                if config.supply <= pandas[idx].index {
                    continue; // burn gate: a later panda must exist
                }
                let settle = config.settle_panda_rent(&mut pandas[idx]);
                assert!(
                    settle as i128 <= vault_balance,
                    "invariant #4 broken: burn-settle of {settle} exceeds vault balance {vault_balance}"
                );
                vault_balance -= settle as i128;

                let mint_epoch = pandas[idx].mint_epoch;
                config.record_burn(mint_epoch).unwrap();
                pandas[idx].burned = true;
                assert_recipient_invariant(&config);
            }
            _ => unreachable!(),
        }

        assert!(vault_balance >= 0, "vault balance went negative");
    }

    // Sanity: the run actually exercised mint, claim, and burn, and crossed
    // at least one epoch boundary.
    assert!(config.supply > 1016, "test didn't mint enough to matter");
    assert!(pandas.iter().any(|p| p.burned), "test never burned a panda");
    assert!(
        pandas.iter().any(|p| p.claimed_scaled > 0),
        "test never claimed anything"
    );
}
