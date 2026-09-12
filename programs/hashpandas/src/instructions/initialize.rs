use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use mpl_core::instructions::CreateCollectionV1CpiBuilder;
use mpl_core::types::{Creator, Plugin, PluginAuthority, PluginAuthorityPair, RuleSet, Royalties};

use crate::errors::HashpandasError;
use crate::state::Config;

/// A `Vec<Creator>` won't fit as an Anchor instruction arg without pulling
/// mpl-core's own (borsh1-based) serde traits across the crate boundary, so
/// the args use plain types local to this program and get translated into
/// `mpl_core::types::*` inside the handler.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RoyaltyCreatorArg {
    pub address: Pubkey,
    pub percentage: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum RuleSetArg {
    None,
    ProgramAllowList(Vec<Pubkey>),
    ProgramDenyList(Vec<Pubkey>),
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeArgs {
    pub step_lamports: u64,
    pub epoch0_flat_lamports: u64,
    pub base_difficulty: u8,
    pub collection_name: String,
    pub collection_uri: String,
    pub royalty_bps: u16,
    pub royalty_creators: Vec<RoyaltyCreatorArg>,
    pub royalty_rule_set: RuleSetArg,
    /// The only program the buyback crank (step 9) may ever CPI into.
    pub buyback_amm_program: Pubkey,
    pub crank_spend_cap_lamports: u64,
    pub max_price_impact_bps: u16,
}

#[derive(Accounts)]
#[instruction(args: InitializeArgs)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Project admin. Kept distinct from `payer` so a hot wallet can cover
    /// fees while a colder key retains admin control.
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = Config::SPACE,
        seeds = [b"config"],
        bump,
    )]
    pub config: Box<Account<'info, Config>>,

    /// PDA lamport vault for unclaimed holder rent. Deliberately never
    /// `init`-ed: an account with no data needs no rent-exempt allocation
    /// step, only transfers in (mint) and `invoke_signed` transfers out
    /// (claim).
    /// CHECK: address fixed by the seeds constraint; holds no data.
    #[account(seeds = [b"vault"], bump)]
    pub vault: UncheckedAccount<'info>,

    /// PDA lamport account for the "hook" share: buyback crank + project cut.
    /// CHECK: address fixed by the seeds constraint; holds no data.
    #[account(seeds = [b"treasury"], bump)]
    pub treasury: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        seeds = [b"panda_mint"],
        bump,
        mint::decimals = 0,
        mint::authority = config,
    )]
    pub panda_mint: Box<Account<'info, Mint>>,

    /// The Metaplex Core collection every panda gets minted into. A fresh
    /// keypair, not a PDA: `CreateCollectionV1` requires the collection
    /// account to sign its own creation.
    #[account(mut)]
    pub collection: Signer<'info>,

    /// CHECK: address-constrained to the real Metaplex Core program.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    /// Config-owned $PANDA token account the buyback crank (step 9) buys
    /// into. Created here so the crank never needs an `init` branch.
    #[account(
        init,
        payer = payer,
        associated_token::mint = panda_mint,
        associated_token::authority = config,
    )]
    pub buyback_dest_token_account: Box<Account<'info, TokenAccount>>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

pub fn handle_initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
    require!(
        args.step_lamports > 0 && args.step_lamports % 5 == 0,
        HashpandasError::StepNotMultipleOfFive
    );

    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.treasury = ctx.accounts.treasury.key();
    config.vault = ctx.accounts.vault.key();
    config.collection = ctx.accounts.collection.key();
    config.panda_mint = ctx.accounts.panda_mint.key();

    config.step_lamports = args.step_lamports;
    config.epoch0_flat_lamports = args.epoch0_flat_lamports;

    config.supply = 0;
    config.epoch = 0;
    config.acc = 0;
    config.epoch_acc_snapshot = [0u128; crate::state::EPOCH_SLOTS];
    config.eligible_living = 0;
    config.eligible_burned = 0;
    config.pending_burns = [0u32; crate::state::EPOCH_SLOTS];

    config.last_winning_hash = [0u8; 32];
    config.base_difficulty = args.base_difficulty;
    config.last_mint_slot = 0;
    config.last_mint_unix = 0;
    config.retarget_window_start_unix = Clock::get()?.unix_timestamp;
    config.mints_since_retarget = 0;
    config.streak = 0;
    config.streak_last_cool_unix = 0;

    config.lifetime_to_holders = 0;
    config.lifetime_to_hook = 0;
    config.lifetime_claimed = 0;

    config.bump = ctx.bumps.config;
    config.vault_bump = ctx.bumps.vault;
    config.treasury_bump = ctx.bumps.treasury;

    config.buyback_amm_program = args.buyback_amm_program;
    config.buyback_dest_token_account = ctx.accounts.buyback_dest_token_account.key();
    config.crank_spend_cap_lamports = args.crank_spend_cap_lamports;
    config.max_price_impact_bps = args.max_price_impact_bps;
    config.last_crank_slot = 0;
    config.lifetime_buyback_spent_lamports = 0;
    config.lifetime_buyback_tokens_bought = 0;

    let creators: Vec<Creator> = args
        .royalty_creators
        .iter()
        .map(|c| Creator {
            address: c.address,
            percentage: c.percentage,
        })
        .collect();
    let total_pct: u16 = creators.iter().map(|c| c.percentage as u16).sum();
    require!(total_pct == 100, HashpandasError::CreatorPercentagesMustSumTo100);

    let rule_set = match args.royalty_rule_set {
        RuleSetArg::None => RuleSet::None,
        RuleSetArg::ProgramAllowList(list) => RuleSet::ProgramAllowList(list),
        RuleSetArg::ProgramDenyList(list) => RuleSet::ProgramDenyList(list),
    };

    let royalties_plugin = PluginAuthorityPair {
        plugin: Plugin::Royalties(Royalties {
            basis_points: args.royalty_bps,
            creators,
            rule_set,
        }),
        // The collection's update_authority (the config PDA) keeps the
        // ability to adjust royalties later; nobody else can.
        authority: Some(PluginAuthority::UpdateAuthority),
    };

    CreateCollectionV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
        .collection(&ctx.accounts.collection.to_account_info())
        .update_authority(Some(&ctx.accounts.config.to_account_info()))
        .payer(&ctx.accounts.payer.to_account_info())
        .system_program(&ctx.accounts.system_program.to_account_info())
        .name(args.collection_name)
        .uri(args.collection_uri)
        .plugins(vec![royalties_plugin])
        .invoke()?;

    Ok(())
}
