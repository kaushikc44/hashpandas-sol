"""
Hashpandas economics.

The model is reconstructed from the figures published by the prior-art
Ethereum collection this design is adapted from, and verified against them --
the ETH-denominated values in check() are THEIR numbers, used purely as a
correctness oracle. Hashpandas itself is denominated in lamports; see
docs/TOKENOMICS.md for the SOL-side constants.

This file is the SOURCE OF TRUTH for the Anchor program's math module.
If you change a formula here, change economics.rs to match, and vice versa.
"""

from fractions import Fraction as F

# ---------------------------------------------------------------------------
# Structural constants (dimensionless -- identical on ETH and Solana)
# ---------------------------------------------------------------------------

FIRST_EPOCH_SIZE = 8      # epoch 0 holds 8 pandas, each next epoch doubles
HOLDER_BPS = 7000         # 70% of every mint accrues to earlier pandas
HOOK_BPS = 3000           # 30% of every mint goes to the buyback/treasury
BURN_BASE_UNITS = 1000    # tokens returned for a panda burned in its own epoch


# ---------------------------------------------------------------------------
# Supply / epoch geometry
# ---------------------------------------------------------------------------

def epoch_start_supply(e: int) -> int:
    """Number of pandas that already existed when epoch `e` opened.

    Epoch sizes are 8, 16, 32, ... so the running total before epoch e is
    8 * (2^e - 1). This is the single most important number in the design:
    it is BOTH the price multiplier AND the exact count of rent recipients.
    """
    return FIRST_EPOCH_SIZE * ((1 << e) - 1)


def epoch_size(e: int) -> int:
    return FIRST_EPOCH_SIZE << e


def epoch_of_cat(index_1based: int) -> int:
    """Which epoch a panda belongs to. Panda #1 is the first panda ever."""
    e = 0
    while index_1based > epoch_start_supply(e + 1):
        e += 1
    return e


# ---------------------------------------------------------------------------
# Price
# ---------------------------------------------------------------------------

def entry_price(e: int, step: F, epoch0_flat: F) -> F:
    """Price is FLAT inside an epoch and fixed at the epoch boundary.

    price(e) = (pandas alive when epoch e opened) * step

    Epoch 0 is the exception: there is nobody to pay rent to yet, so it is a
    flat price and 100% of it goes to the hook.
    """
    if e == 0:
        return epoch0_flat
    return epoch_start_supply(e) * step


def rent_step(step: F) -> F:
    """What ONE mint owes to ONE eligible panda. A constant, by construction.

    70% of price / recipients
      = 0.70 * (epoch_start_supply * step) / epoch_start_supply
      = 0.70 * step
    The epoch_start_supply cancels. That cancellation is why the price can be
    flat inside an epoch while the per-panda rate never moves.
    """
    return step * F(HOLDER_BPS, 10_000)


# ---------------------------------------------------------------------------
# Eligibility
# ---------------------------------------------------------------------------

def eligibility_supply(mint_epoch: int) -> int:
    """A panda is paid only by mints of LATER epochs, never by its neighbours.

    So it starts earning at the boundary of the next epoch, i.e. once total
    supply reaches epoch_start_supply(mint_epoch + 1).
    """
    return epoch_start_supply(mint_epoch + 1)


def rent_earned_no_burns(mint_epoch: int, current_supply: int, step: F) -> F:
    """Closed form, valid only while nothing has ever been burned.

    Once burns exist the rate is path-dependent and you MUST use the
    accumulator in Ledger below. This function exists to validate the
    accumulator, not to be used in production.
    """
    paying_mints = max(0, current_supply - eligibility_supply(mint_epoch))
    return paying_mints * rent_step(step)


# ---------------------------------------------------------------------------
# Burn returns
# ---------------------------------------------------------------------------

def burn_units(epochs_waited: int) -> int:
    """1000 tokens in the panda's own epoch, halving per epoch waited."""
    return BURN_BASE_UNITS >> epochs_waited


def token_price_ceiling(current_epoch: int, step: F, epoch0_flat: F) -> F:
    """Above this, mint-and-burn is free money, so arbitrage pins the token.

    ceiling = current entry price / 1000
    It doubles every epoch, driven by nothing but the cost of the next panda.
    """
    return entry_price(current_epoch, step, epoch0_flat) / BURN_BASE_UNITS


# ---------------------------------------------------------------------------
# The accumulator -- the part that actually has to be implemented on chain
# ---------------------------------------------------------------------------

class Ledger:
    """O(1) rent accounting for an unbounded number of holders.

    You cannot loop over 16,000 recipients in one Solana instruction, so rent
    is never transferred at mint time. Instead a single global number goes up,
    and each panda subtracts the value that number had when it became eligible.

        claimable(panda) = acc - cursor(panda) - already_claimed(panda)

    Burns make `acc` path-dependent, which is why it must be stored rather
    than derived from supply:

        a burned panda keeps its slot in the recipient count, but its share is
        re-split 70/30 -- 70% to the pandas still alive, 30% to the hook. So
        every burn permanently raises the rate for everyone still holding.
    """

    def __init__(self, step: F, epoch0_flat: F):
        self.step = step
        self.epoch0_flat = epoch0_flat
        self.supply = 0                 # pandas ever minted
        self.epoch = 0
        self.acc = F(0)                 # cumulative rent per LIVING eligible panda
        self.epoch_acc_snapshot = [F(0)]  # snapshot[e] = acc when epoch e opened
        self.eligible_living = 0        # eligible pandas not yet burned
        self.eligible_burned = 0        # eligible pandas that have been burned
        self.pending_burns = {}         # burns of pandas not yet eligible, by epoch
        self.hook_total = F(0)
        self.holder_total = F(0)

    # -- internal ----------------------------------------------------------

    def _roll_epoch_if_needed(self):
        """Promote the finished cohort into the eligible set."""
        while self.supply >= epoch_start_supply(self.epoch + 1):
            closing = self.epoch
            cohort = epoch_size(closing)
            burned_in_cohort = self.pending_burns.pop(closing, 0)
            self.eligible_living += cohort - burned_in_cohort
            self.eligible_burned += burned_in_cohort
            self.epoch += 1
            self.epoch_acc_snapshot.append(self.acc)

    # -- public ------------------------------------------------------------

    def mint(self) -> dict:
        """Mint one panda. Returns the split for this single mint."""
        self._roll_epoch_if_needed()
        e = self.epoch
        price = entry_price(e, self.step, self.epoch0_flat)
        recipients = epoch_start_supply(e)          # eligible slots, alive or not
        rs = rent_step(self.step)

        if recipients == 0:
            # Epoch 0: no one to pay, everything funds the hook.
            to_hook = price
            to_holders = F(0)
        else:
            assert self.eligible_living + self.eligible_burned == recipients, (
                self.eligible_living, self.eligible_burned, recipients
            )
            dead_share = self.eligible_burned * rs
            living_share = self.eligible_living * rs
            # the dead pandas' share is re-split by the same 70/30 rule
            to_holders = living_share + dead_share * F(HOLDER_BPS, 10_000)
            to_hook = price * F(HOOK_BPS, 10_000) + dead_share * F(HOOK_BPS, 10_000)
            if self.eligible_living > 0:
                self.acc += to_holders / self.eligible_living
            else:
                # everyone burned: holders' share also goes to the hook
                to_hook += to_holders
                to_holders = F(0)

        assert to_holders + to_hook == price, (to_holders, to_hook, price)

        self.supply += 1
        self.hook_total += to_hook
        self.holder_total += to_holders
        return {
            "panda": self.supply,
            "epoch": e,
            "price": price,
            "to_holders": to_holders,
            "to_hook": to_hook,
            "hook_bps_effective": (to_hook / price) if price else F(0),
        }

    def cursor_for(self, mint_epoch: int) -> F:
        """Rent baseline for a panda -- the acc value when it became eligible.

        Resolved lazily at claim time. If its epoch has not closed yet the panda
        is not earning, so it has nothing to claim.
        """
        target = mint_epoch + 1
        if target >= len(self.epoch_acc_snapshot):
            return None  # not eligible yet
        return self.epoch_acc_snapshot[target]

    def claimable(self, mint_epoch: int, already_claimed: F = F(0)) -> F:
        cur = self.cursor_for(mint_epoch)
        if cur is None:
            return F(0)
        return self.acc - cur - already_claimed

    def burn(self, mint_epoch: int):
        """Mark one panda of `mint_epoch` as burned.

        Caller is responsible for having settled that panda's accrued rent first.
        """
        if mint_epoch + 1 <= self.epoch:
            self.eligible_living -= 1
            self.eligible_burned += 1
        else:
            self.pending_burns[mint_epoch] = self.pending_burns.get(mint_epoch, 0) + 1


# ---------------------------------------------------------------------------
# VERIFICATION against the figures Hashpandas publishes
# ---------------------------------------------------------------------------

def check():
    ETH_STEP = F(2, 100_000)          # 0.00002 ETH
    ETH_EPOCH0 = F(69, 1_000_000)     # 0.000069 ETH
    ok = []

    def eq(label, got, want):
        got_f, want_f = float(got), float(want)
        assert abs(got_f - want_f) < 1e-9 * max(1, abs(want_f)), f"{label}: {got_f} != {want_f}"
        ok.append(f"  OK  {label:<44} {got_f:.10g}")

    # -- price / supply geometry
    eq("epoch 6 opens with N pandas", epoch_start_supply(6), 504)
    eq("epoch 6 entry price (ETH)", entry_price(6, ETH_STEP, ETH_EPOCH0), F(1008, 100_000))
    eq("epoch 8 entry price (ETH)", entry_price(8, ETH_STEP, ETH_EPOCH0), F(408, 10_000))
    eq("epoch 5 price = cheap band cap", entry_price(5, ETH_STEP, ETH_EPOCH0), F(496, 100_000))
    eq("first 6 epochs = 504 pandas", epoch_start_supply(6), 504)
    eq("trading gate = end of epoch 6", epoch_start_supply(7), 1016)
    eq("panda #505 sits in epoch 6", epoch_of_cat(505), 6)
    eq("panda #64 sits in epoch 3", epoch_of_cat(64), 3)

    # -- the identity the whole design rests on
    eq("rent per panda per mint (ETH)", rent_step(ETH_STEP), F(14, 1_000_000))
    eq("504 x 0.000014 = 70% of price",
       504 * rent_step(ETH_STEP), entry_price(6, ETH_STEP, ETH_EPOCH0) * F(7, 10))

    # -- worked example: panda #64, epoch 3, three epochs later
    eq("panda #64 paid to mint (ETH)", entry_price(3, ETH_STEP, ETH_EPOCH0), F(112, 100_000))
    eq("panda #64 rent after 3 epochs (ETH)",
       rent_earned_no_burns(3, epoch_start_supply(7), ETH_STEP), F(12544, 1_000_000))
    eq("panda #64 burn return after 3 epochs", burn_units(3), 125)
    eq("that burn valued at the ceiling (ETH)",
       burn_units(3) * token_price_ceiling(6, ETH_STEP, ETH_EPOCH0), F(126, 100_000))

    # -- burn redistribution: 50% burned => x1.70 survivors, 40.5% to hook
    led2 = Ledger(ETH_STEP, ETH_EPOCH0)
    for _ in range(epoch_start_supply(7)):
        led2.mint()
    led2._roll_epoch_if_needed()
    total_eligible = led2.eligible_living
    led2.eligible_living = total_eligible // 2
    led2.eligible_burned = total_eligible - total_eligible // 2
    before = led2.acc
    row = led2.mint()
    delta_burned = led2.acc - before

    led3 = Ledger(ETH_STEP, ETH_EPOCH0)
    for _ in range(epoch_start_supply(7)):
        led3.mint()
    led3._roll_epoch_if_needed()
    before3 = led3.acc
    led3.mint()
    delta_clean = led3.acc - before3

    eq("rent per survivor at 50% burned", delta_burned / delta_clean, F(17, 10))
    eq("hook take at 50% burned", row["hook_bps_effective"], F(405, 1000))

    # -- accumulator must agree with the closed form when nothing is burned
    led4 = Ledger(ETH_STEP, ETH_EPOCH0)
    for _ in range(epoch_start_supply(8)):
        led4.mint()
    led4._roll_epoch_if_needed()
    for me in range(0, 6):
        eq(f"accumulator vs closed form, epoch {me}",
           led4.claimable(me),
           rent_earned_no_burns(me, led4.supply, ETH_STEP))

    # -- whole-run totals quoted by the project
    led5 = Ledger(ETH_STEP, ETH_EPOCH0)
    while led5.supply < 16376:
        led5.mint()
    total = led5.hook_total + led5.holder_total
    ok.append(f"  --  collected over 16,376 pandas               {float(total):.3f} ETH (they quote 1787)")
    ok.append(f"  --  of which reaches the hook                {float(led5.hook_total):.3f} ETH (they quote 536.085)")

    print("\n".join(ok))
    print(f"\n{len([l for l in ok if l.startswith('  OK')])} checks passed.")


if __name__ == "__main__":
    check()
