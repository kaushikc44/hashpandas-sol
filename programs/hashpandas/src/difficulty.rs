//! Pure, panic-free difficulty and streak retargeting. No Anchor types, no
//! accounts, no I/O -- mirrors the style of `economics.rs`.
//!
//! Retargets every `RETARGET_MINTS` mints against a `TARGET_INTERVAL_SECS`
//! target, clamped to at most 4x harder / 2x easier per window. "4x harder"
//! in bits is +2 (each bit doubles the work), "2x easier" is -1.
//!
//! The streak is a separate, faster-reacting throttle: it climbs by one bit
//! (capped at `MAX_STREAK`) on every mint that lands faster than one target
//! interval after the previous one, and cools by one bit per target interval
//! of mints that don't. `base_difficulty + streak` is what a submission is
//! actually checked against (see `instructions::mint`).

/// Retarget cadence: recompute `base_difficulty` every 8 mints.
pub const RETARGET_MINTS: u8 = 8;
/// Target seconds between mints.
pub const TARGET_INTERVAL_SECS: i64 = 10;
/// Target seconds for a full retarget window of `RETARGET_MINTS` mints.
pub const RETARGET_WINDOW_SECS: i64 = RETARGET_MINTS as i64 * TARGET_INTERVAL_SECS;

pub const MAX_STREAK: u8 = 16;
/// Hard ceiling so `base_difficulty + MAX_STREAK` can never approach the
/// 256-bit width of a keccak256 hash (which would make mining impossible).
pub const MAX_BASE_DIFFICULTY: u8 = 240;

/// Leading-zero-bit floor the original (Ethereum) design used per epoch.
const ETH_REFERENCE_FLOOR_BITS: u8 = 26;
/// Solana slots (~400ms) land far more often than Ethereum blocks (~13s), so
/// the floor is scaled down by this many bits before being applied here.
/// This is a starting point, not a derived constant -- CLAUDE.md is explicit
/// that whoever ships this must pick a floor that makes a mint take ~10s on
/// a mid-range GPU and hold it there; tune this against real hashrate
/// numbers before mainnet, per the "no deploy without an audit" rule.
const SOLANA_DIFFICULTY_SCALE_DOWN_BITS: u8 = 8;

/// The difficulty floor for `epoch`: never retarget below this.
pub fn epoch_floor_bits(epoch: u8) -> u8 {
    ETH_REFERENCE_FLOOR_BITS
        .saturating_add(epoch)
        .saturating_sub(SOLANA_DIFFICULTY_SCALE_DOWN_BITS)
}

/// Recompute `base_difficulty` at an 8-mint retarget boundary.
///
/// `elapsed_secs` is wall-clock time since the window opened. Comparisons
/// are all integer multiplication -- no floats, per CLAUDE.md.
pub fn retarget_base_difficulty(current: u8, elapsed_secs: i64, epoch: u8) -> u8 {
    let elapsed = elapsed_secs.max(1);
    let target = RETARGET_WINDOW_SECS;

    let delta: i16 = if elapsed.saturating_mul(4) <= target {
        2 // mints landed >=4x faster than target -> max 4x harder (+2 bits)
    } else if elapsed.saturating_mul(2) <= target {
        1 // >=2x faster -> 2x harder (+1 bit)
    } else if elapsed >= target.saturating_mul(2) {
        -1 // >=2x slower -> 2x easier (-1 bit)
    } else {
        0
    };

    let floor = epoch_floor_bits(epoch);
    (current as i16 + delta).clamp(floor as i16, MAX_BASE_DIFFICULTY as i16) as u8
}

/// Streak update for a single mint.
///
/// `gap_secs` is time since the PREVIOUS mint. `since_last_cool_secs` is
/// time since the streak counter last moved. Returns the new streak value
/// and whether the "last moved" timestamp should be reset to now.
pub fn update_streak(streak: u8, gap_secs: i64, since_last_cool_secs: i64) -> (u8, bool) {
    if gap_secs < TARGET_INTERVAL_SECS {
        (streak.saturating_add(1).min(MAX_STREAK), true)
    } else {
        let cooled_steps = (since_last_cool_secs.max(0) / TARGET_INTERVAL_SECS) as u8;
        if cooled_steps > 0 {
            (streak.saturating_sub(cooled_steps), true)
        } else {
            (streak, false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floor_rises_with_epoch_and_is_scaled_down_for_solana() {
        assert_eq!(epoch_floor_bits(0), 18);
        assert_eq!(epoch_floor_bits(6), 24);
    }

    #[test]
    fn retarget_caps_at_4x_harder_per_window() {
        // Mints landed instantly (elapsed ~0) -- max 2-bit increase, not more.
        assert_eq!(retarget_base_difficulty(30, 0, 6), 32);
        assert_eq!(retarget_base_difficulty(30, 1, 6), 32);
    }

    #[test]
    fn retarget_caps_at_2x_easier_per_window() {
        assert_eq!(retarget_base_difficulty(30, RETARGET_WINDOW_SECS * 10, 6), 29);
    }

    #[test]
    fn retarget_never_drops_below_epoch_floor() {
        let floor = epoch_floor_bits(0);
        assert_eq!(
            retarget_base_difficulty(floor, RETARGET_WINDOW_SECS * 10, 0),
            floor
        );
    }

    #[test]
    fn retarget_no_change_within_half_to_double_band() {
        assert_eq!(retarget_base_difficulty(30, RETARGET_WINDOW_SECS, 6), 30);
    }

    #[test]
    fn streak_climbs_on_fast_mints_and_caps_at_16() {
        let mut streak = 0u8;
        for _ in 0..20 {
            let (s, _) = update_streak(streak, 1, 100);
            streak = s;
        }
        assert_eq!(streak, MAX_STREAK);
    }

    #[test]
    fn streak_cools_one_step_per_interval_of_slow_mints() {
        let (s, moved) = update_streak(10, TARGET_INTERVAL_SECS, TARGET_INTERVAL_SECS * 3);
        assert_eq!(s, 7);
        assert!(moved);
    }

    #[test]
    fn streak_does_not_cool_before_a_full_interval_elapses() {
        let (s, moved) = update_streak(10, TARGET_INTERVAL_SECS, TARGET_INTERVAL_SECS - 1);
        assert_eq!(s, 10);
        assert!(!moved);
    }
}
