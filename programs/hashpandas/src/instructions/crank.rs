//! Permissionless treasury buyback crank.
//!
//! docs/TOKENOMICS.md 5.3 is explicit that Solana has no Uniswap-v4-style
//! hook: nothing auto-buys anything. This instruction is the keeper that
//! does, and it is a keeper, not a protocol guarantee -- if nobody calls it,
//! nothing happens; if it's called with a dishonest `reference_price`, the
//! guardrails below are only as good as that number.
//!
//! What this program actually enforces on-chain, regardless of which AMM
//! `buyback_amm_program` points at:
//!   1. At most one crank call per slot (mirrors mint's one-per-slot rule).
//!   2. Spend is capped at `config.crank_spend_cap_lamports` per call.
//!   3. The CPI may only target the single program fixed at `initialize`.
//!   4. Tokens received must clear a floor derived from the caller's
//!      declared `reference_price` and `config.max_price_impact_bps` --
//!      checked as an actual balance delta on `buyback_dest_token_account`,
//!      not trusted from the CPI's return value or the caller's say-so.
//!   5. Treasury lamports must decrease by exactly `spend_lamports` -- no
//!      more, no less.
//!
//! What it cannot enforce: that `buyback_amm_program` is honest, or that
//! `reference_price` reflects a real market. Point this at an audited AMM
//! program and feed it a real oracle price; don't take either on faith.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::TokenAccount;

use crate::economics::BPS_DENOM;
use crate::errors::HashpandasError;
use crate::state::Config;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CrankBuybackArgs {
    /// Lamports to spend this call. Must be <= `config.crank_spend_cap_lamports`.
    pub spend_lamports: u64,
    /// Caller-declared lamports-per-token price, as a fraction
    /// `reference_price_num / reference_price_denom`. NOT a verified oracle
    /// price -- see the module docs.
    pub reference_price_num: u64,
    pub reference_price_denom: u64,
    /// Raw instruction data forwarded verbatim to `buyback_amm_program`.
    /// This program does not interpret it; it only checks the net effect.
    pub swap_ix_data: Vec<u8>,
}

#[derive(Accounts)]
pub struct CrankBuyback<'info> {
    /// Anyone. That's the point -- this is a permissionless keeper call.
    pub keeper: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    /// CHECK: lamport-only treasury; identity pinned to `config.treasury`.
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: the ONLY program this crank may ever CPI into, fixed at
    /// `initialize` and never touched again.
    #[account(address = config.buyback_amm_program)]
    pub amm_program: UncheckedAccount<'info>,

    #[account(mut, address = config.buyback_dest_token_account)]
    pub buyback_dest_token_account: Box<Account<'info, TokenAccount>>,

    pub system_program: Program<'info, System>,
    // Whatever accounts the configured AMM's swap instruction additionally
    // needs (pool, vaults, oracle, ...) arrive as remaining_accounts,
    // supplied by the keeper at call time.
}

pub fn handle_crank_buyback<'info>(
    ctx: Context<'info, CrankBuyback<'info>>,
    args: CrankBuybackArgs,
) -> Result<()> {
    let clock = Clock::get()?;

    require!(
        ctx.accounts.config.last_crank_slot != clock.slot,
        HashpandasError::CrankAlreadyRanThisSlot
    );
    require!(args.spend_lamports > 0, HashpandasError::Overflow);
    require!(
        args.spend_lamports <= ctx.accounts.config.crank_spend_cap_lamports,
        HashpandasError::CrankSpendCapExceeded
    );
    require!(
        args.reference_price_num > 0 && args.reference_price_denom > 0,
        HashpandasError::InvalidReferencePrice
    );

    // min_tokens_out = spend_lamports * (denom/num) * (1 - max_impact_bps)
    // i.e. the fewest tokens a spend of this size may buy at the declared
    // price before we call the impact too high to accept.
    let max_impact_bps = ctx.accounts.config.max_price_impact_bps as u128;
    let min_tokens_out: u64 = (args.spend_lamports as u128)
        .checked_mul(args.reference_price_denom as u128)
        .and_then(|v| v.checked_div(args.reference_price_num as u128))
        .and_then(|v| v.checked_mul((BPS_DENOM as u128).checked_sub(max_impact_bps)?))
        .and_then(|v| v.checked_div(BPS_DENOM as u128))
        .and_then(|v| u64::try_from(v).ok())
        .ok_or(HashpandasError::Overflow)?;

    let treasury_before = ctx.accounts.treasury.lamports();
    let dest_tokens_before = ctx.accounts.buyback_dest_token_account.amount;

    // Build the forwarded CPI from whatever the keeper supplied as
    // remaining_accounts. Each AccountInfo already carries the is_signer /
    // is_writable flags it was passed into this transaction with.
    let mut accounts = Vec::with_capacity(ctx.remaining_accounts.len());
    let mut account_infos = Vec::with_capacity(ctx.remaining_accounts.len() + 1);
    for info in ctx.remaining_accounts {
        accounts.push(if info.is_writable {
            AccountMeta::new(*info.key, info.is_signer)
        } else {
            AccountMeta::new_readonly(*info.key, info.is_signer)
        });
        account_infos.push(info.clone());
    }
    account_infos.push(ctx.accounts.amm_program.to_account_info());

    let ix = Instruction {
        program_id: ctx.accounts.amm_program.key(),
        accounts,
        data: args.swap_ix_data,
    };

    let treasury_bump = ctx.accounts.config.treasury_bump;
    let treasury_seeds: &[&[u8]] = &[b"treasury", &[treasury_bump]];
    invoke_signed(&ix, &account_infos, &[treasury_seeds])?;

    // Re-read real on-chain state; nothing above is trusted.
    let treasury_after = ctx.accounts.treasury.lamports();
    ctx.accounts.buyback_dest_token_account.reload()?;
    let dest_tokens_after = ctx.accounts.buyback_dest_token_account.amount;

    require_eq!(
        treasury_before.saturating_sub(treasury_after),
        args.spend_lamports,
        HashpandasError::TreasurySpendMismatch
    );
    let tokens_received = dest_tokens_after.saturating_sub(dest_tokens_before);
    require!(
        tokens_received >= min_tokens_out,
        HashpandasError::PriceImpactExceeded
    );

    let config = &mut ctx.accounts.config;
    config.last_crank_slot = clock.slot;
    config.lifetime_buyback_spent_lamports = config
        .lifetime_buyback_spent_lamports
        .checked_add(args.spend_lamports)
        .ok_or(HashpandasError::Overflow)?;
    config.lifetime_buyback_tokens_bought = config
        .lifetime_buyback_tokens_bought
        .checked_add(tokens_received)
        .ok_or(HashpandasError::Overflow)?;

    Ok(())
}
