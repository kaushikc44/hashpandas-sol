//! A single program-wide error enum.
//!
//! CLAUDE.md's stated style is "errors in a single `#[error_code]` enum per
//! module," but `anchor build`'s IDL generation on this toolchain hard-fails
//! with "Multiple error definitions are not allowed" the moment more than
//! one `#[error_code]` enum exists anywhere in the crate. That's a real
//! constraint of anchor-lang 1.2.0, not a style choice, so every module
//! shares this one enum instead.

use anchor_lang::prelude::*;

#[error_code]
pub enum HashpandasError {
    // -- economics (programs/hashpandas/src/economics.rs) -----------------
    #[msg("epoch exceeds MAX_EPOCH")]
    EpochOverflow,
    #[msg("no living eligible holders")]
    NoLivingHolders,

    // -- PoW freshness anchor (programs/hashpandas/src/utils/slot_anchor.rs) --
    #[msg("anchor slot is not in the past relative to the current slot")]
    AnchorInFuture,
    #[msg("anchor slot is outside the recent window")]
    AnchorTooOld,
    #[msg("failed to read the SlotHashes sysvar")]
    SysvarReadFailed,
    #[msg("anchor slot not found in SlotHashes sysvar")]
    AnchorNotFound,
    #[msg("anchor hash does not match the on-chain slot hash")]
    AnchorHashMismatch,

    // -- initialize ---------------------------------------------------------
    #[msg("step_lamports must be a positive multiple of 5, so rent_step has no truncation")]
    StepNotMultipleOfFive,
    #[msg("royalty creator percentages must sum to exactly 100")]
    CreatorPercentagesMustSumTo100,

    // -- mint ---------------------------------------------------------------
    #[msg("a panda has already been minted in this slot")]
    SlotAlreadyMinted,
    #[msg("submitted hash does not meet the required difficulty")]
    DifficultyNotMet,

    // -- claim / burn (asset + panda state) ---------------------------------
    #[msg("this panda has been burned and can no longer claim rent")]
    PandaBurned,
    #[msg("failed to deserialize the Metaplex Core asset account")]
    AssetDeserializeFailed,
    #[msg("caller does not currently own this asset")]
    NotAssetOwner,
    #[msg("nothing is currently claimable")]
    NothingToClaim,
    #[msg("this panda has already been burned")]
    AlreadyBurned,
    #[msg("at least one later panda must exist before this one can be burned")]
    NoLaterPanda,
    #[msg("a panda must exist for at least 10 minutes before it can be burned")]
    TooEarly,

    // -- treasury crank (programs/hashpandas/src/instructions/crank.rs) ----
    #[msg("the buyback crank has already run this slot")]
    CrankAlreadyRanThisSlot,
    #[msg("spend exceeds the crank's per-call spend cap")]
    CrankSpendCapExceeded,
    #[msg("reference price must be a positive fraction")]
    InvalidReferencePrice,
    #[msg("treasury lamport delta did not match the declared spend")]
    TreasurySpendMismatch,
    #[msg("tokens received fell short of the price-impact floor")]
    PriceImpactExceeded,

    // -- shared --------------------------------------------------------------
    #[msg("arithmetic overflow")]
    Overflow,
}
