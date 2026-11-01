//! A Fair Open's allocation (spec 2.1 step 11): everyone buys at one price, and when more is asked than the pot can
//! spend, everyone gets the same amount, the level, while anyone who asked for less gets all of theirs. Unverified
//! fills add up to at most a quarter of what the pot spends: when their asks would take more, Unverified seats get their
//! own, lower level and everyone else shares the rest.
//!
//! The launch keeps no list of seats, only how many ask each amount: `counts[k]` seats ask exactly `(k + 1) * step`. So
//! the allocation is found in one pass over those counts, with no input from a server, and `@top-pad/chain`'s reference
//! calculation, which the Fair Open page shows, must give the same numbers to the lamport. Levels are floored to the
//! lamport (spec 12).

/// The ladder's rungs (spec 2.1 step 6): at most 64, falling from the pot's cap in 5% steps.
pub const RUNGS: usize = 64;

/// How many seats ask each amount: the counts of one tier, or two tiers' counts added up.
trait Counts {
    fn len(&self) -> usize;
    fn at(&self, k: usize) -> u128;
}

impl Counts for [u32] {
    fn len(&self) -> usize {
        <[u32]>::len(self)
    }
    fn at(&self, k: usize) -> u128 {
        self.get(k).map_or(0, |&n| n as u128)
    }
}

/// Two tiers' counts as one: every seat, whatever its tier.
struct Both<'a>(&'a [u32], &'a [u32]);

impl Counts for Both<'_> {
    fn len(&self) -> usize {
        self.0.len().max(self.1.len())
    }
    fn at(&self, k: usize) -> u128 {
        self.0.at(k) + self.1.at(k)
    }
}

/// A level and what the seats fill up to it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Level {
    /// Every seat fills its ask or this much, whichever is less: the largest ask when every ask fits.
    pub level: u64,
    /// What the fills add up to.
    pub filled: u64,
    /// Whether some ask is larger than the level, and so was cut to it.
    pub limited: bool,
}

/// Everything the seats ask for.
fn asked(counts: &(impl Counts + ?Sized), step: u64) -> u128 {
    (0..counts.len()).map(|k| counts.at(k) * (k as u128 + 1) * step as u128).sum()
}

/// The largest ask, or 0 when nobody asks.
fn largest(counts: &(impl Counts + ?Sized), step: u64) -> u64 {
    (0..counts.len()).rev().find(|&k| counts.at(k) > 0).map_or(0, |k| (k as u64 + 1) * step)
}

/// What the seats fill when each takes its ask or `level`, whichever is less.
fn filled(counts: &(impl Counts + ?Sized), step: u64, level: u64) -> u128 {
    (0..counts.len()).map(|k| counts.at(k) * ((k as u128 + 1) * step as u128).min(level as u128)).sum()
}

/// The largest level, to the lamport, at which the seats' fills add up to at most `budget`. Between two asks the fills
/// grow by one lamport per seat still above the level for each lamport the level rises, so walking the asks upwards
/// finds the stretch where the budget runs out, and the level inside it is the budget left over shared by those seats.
fn level_within(counts: &(impl Counts + ?Sized), step: u64, budget: u64) -> Level {
    let budget = budget as u128;
    // Below the current ask: what the seats asking less fill (all of it), and how many seats ask this much or more.
    let mut below: u128 = 0;
    let mut above: u128 = (0..counts.len()).map(|k| counts.at(k)).sum();
    for k in 0..counts.len() {
        let ask = (k as u128 + 1) * step as u128;
        if below + above * ask > budget {
            // `above` is not 0: with no seat left above, the fills would be `below`, which fit the last check.
            let level = (budget - below) / above;
            return Level { level: level as u64, filled: (below + above * level) as u64, limited: true };
        }
        below += counts.at(k) * ask;
        above -= counts.at(k);
    }
    Level { level: largest(counts, step), filled: below as u64, limited: false }
}

/// How a pot's deposits would buy if its window closed now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Allocation {
    /// What the pot spends: every seat's fill added up, at most the pot's cap.
    pub spend: u64,
    /// The level every seat but an Unverified one fills up to, and what those fills add up to.
    pub others: Level,
    /// The level Unverified seats fill up to: the same as everyone's unless their asks would take more than a quarter of
    /// the spend.
    pub unverified: Level,
}

/// The allocation of a pot whose seats ask `others` and `unverified` (counted per step) and which spends at most `cap`.
pub fn allocate(others: &[u32], unverified: &[u32], step: u64, cap: u64) -> Allocation {
    // One level for everyone, as long as the Unverified fills stay within a quarter of the spend: three times theirs at
    // most everyone else's.
    let one = level_within(&Both(others, unverified), step, cap);
    let unverified_filled = filled(unverified, step, one.level);
    let others_filled = one.filled as u128 - unverified_filled;
    if 3 * unverified_filled <= others_filled {
        let level = |counts: &[u32]| Level {
            level: one.level,
            filled: filled(counts, step, one.level) as u64,
            limited: largest(counts, step) > one.level,
        };
        return Allocation { spend: one.filled, others: level(others), unverified: level(unverified) };
    }
    // The Unverified asks would take more than a quarter: everyone else shares up to three quarters of the cap, and the
    // Unverified seats share a third of what that fills, within what is left of the cap.
    let others_budget = asked(others, step).min((cap - cap / 4) as u128) as u64;
    let others_level = level_within(others, step, others_budget);
    let unverified_budget = (cap - others_level.filled).min(others_level.filled / 3);
    let unverified_level = level_within(unverified, step, unverified_budget);
    Allocation {
        spend: others_level.filled + unverified_level.filled,
        others: others_level,
        unverified: unverified_level,
    }
}

/// The ladder's rungs, largest first: the pot's cap, then each rung 95% of the one before, rounded down.
pub fn rungs(cap: u64) -> impl Iterator<Item = u64> {
    core::iter::successors(Some(cap), |&rung| Some((rung as u128 * 19 / 20) as u64)).take(RUNGS)
}

/// The smallest rung: a pot that would spend less than this cannot open.
pub fn lowest_rung(cap: u64) -> u64 {
    rungs(cap).last().unwrap_or(cap)
}

/// The rung the open spends for a pot that would spend `spend`: the largest at or below it, if any.
pub fn rung_at_or_below(cap: u64, spend: u64) -> Option<u64> {
    rungs(cap).find(|&rung| rung <= spend)
}

/// A seat's part of the open (spec 2.1 step 11): a seat whose fill is `fill`, in a pot whose fills add up to `spend` and
/// which spent the rung `spent` for `coins`, spent that share of the rung, rounded up, and bought that share of the coins,
/// rounded down, so every seat buys at the pot's one price. The lamports the rounding up gathers stay with depositors as
/// part of the launch's Tax Share, and the coins the rounding down leaves are burnt (spec 12). A seat never spends more
/// than its fill, since the rung is at most the spend.
pub fn share(fill: u64, spend: u64, spent: u64, coins: u64) -> (u64, u64) {
    if spend == 0 {
        return (0, 0);
    }
    let (fill, spend) = (fill as u128, spend as u128);
    ((fill * spent as u128).div_ceil(spend) as u64, (fill * coins as u128 / spend) as u64)
}

/// What every seat spent of the rung `spent`, added up (spec 2.1 step 11): each seat's share rounded up, so it is the rung
/// plus the lamport dust the rounding gathered, which joins the launch's Tax Share. Found from the counts per step, as the
/// allocation is, so no seat need be read.
pub fn seats_spent(others: &[u32], unverified: &[u32], step: u64, levels: (u64, u64), spend: u64, spent: u64) -> u64 {
    let tier = |counts: &[u32], level: u64| -> u128 {
        (0..counts.len())
            .map(|k| counts.at(k) * share(((k as u64 + 1) * step).min(level), spend, spent, 0).0 as u128)
            .sum()
    };
    (tier(others, levels.0) + tier(unverified, levels.1)) as u64
}

/// A seat's Tax Share (spec 2.1 step 14): the Tax Share `total` is paid in proportion to each seat's fill, which is in
/// proportion to what it spent, among seats whose fills add up to `basis`. Each seat paid moves `paid` on by its fill,
/// and gets what that move adds to the total's share rounded down, so the shares add up to the total to the lamport once
/// every seat is paid, whatever order they are paid in.
pub fn tax_share(total: u64, basis: u64, paid: u64, fill: u64) -> u64 {
    if basis == 0 {
        return 0;
    }
    let upto = |fills: u64| (total as u128 * fills.min(basis) as u128 / basis as u128) as u64;
    upto(paid + fill) - upto(paid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pays_the_tax_share_to_the_lamport_in_any_order() {
        let fills = [425_000_000u64, 425_000_000, 70_833_333, 70_833_333, 1];
        let basis: u64 = fills.iter().sum();
        for total in [0, 1, 7, 990_000, 123_456_789_011] {
            for order in [[0, 1, 2, 3, 4], [4, 3, 2, 1, 0], [2, 4, 0, 3, 1]] {
                let mut paid = 0;
                let mut out = 0;
                for i in order {
                    let share = tax_share(total, basis, paid, fills[i]);
                    // Within a lamport of its exact share.
                    let exact = total as f64 * fills[i] as f64 / basis as f64;
                    assert!((share as f64 - exact).abs() < 1.0, "{share} vs {exact}");
                    paid += fills[i];
                    out += share;
                }
                assert_eq!(out, total);
            }
        }
        assert_eq!(tax_share(100, 0, 0, 5), 0);
    }

    #[test]
    fn adds_up_what_the_seats_spent() {
        // Spec 2.1 step 11's devnet pot: 3 Verified seats asking 0.6 SOL and 6 Unverified asking 0.1 SOL, opened on the
        // 1.615 SOL rung; each seat's share is rounded up, so they add up to a little more than the rung.
        let others = counts(200, &[(60, 3)]);
        let unverified = counts(10, &[(10, 6)]);
        let a = allocate(&others, &unverified, STEP, 1_700_000_000);
        let rung = 1_615_000_000;
        let total = seats_spent(&others, &unverified, STEP, (a.others.level, a.unverified.level), a.spend, rung);
        let each = |level: u64| share(level, a.spend, rung, 0).0;
        assert_eq!(total, 3 * each(a.others.level) + 6 * each(a.unverified.level));
        assert!(total >= rung && total - rung < 9);
    }

    const STEP: u64 = 10_000_000;
    const SOL: u64 = 1_000_000_000;

    /// Counts per step from (ask in steps, seats) pairs.
    fn counts(len: usize, asks: &[(usize, u32)]) -> Vec<u32> {
        let mut counts = vec![0; len];
        for &(steps, seats) in asks {
            counts[steps - 1] += seats;
        }
        counts
    }

    #[test]
    fn fills_everyone_when_the_pot_holds_every_ask() {
        let others = counts(200, &[(50, 2), (10, 1)]);
        let unverified = counts(10, &[(10, 3)]);
        let a = allocate(&others, &unverified, STEP, 17 * SOL);
        assert_eq!(a.spend, 11 * SOL / 10 + 3 * SOL / 10);
        assert!(!a.others.limited && !a.unverified.limited);
        assert_eq!(a.others.level, SOL / 2);
    }

    #[test]
    fn gives_the_worked_example_its_level() {
        // Spec 2.1 step 11: a 15 SOL pot, 30 people asking 0.1 SOL and 50 asking 0.5 to 2 SOL: the 30 get 0.1 each and
        // the 50 get 0.24 each, (15 - 3) / 50.
        let mut asks = vec![(10, 30)];
        asks.extend((0..50).map(|i| (50 + (i * 3) as usize, 1)));
        let others = counts(200, &asks);
        let a = allocate(&others, &[0; 10], STEP, 15 * SOL);
        assert_eq!(a.others.level, 240_000_000);
        assert_eq!(a.spend, 15 * SOL);
        assert!(a.others.limited);
    }

    #[test]
    fn floors_the_level_to_the_lamport() {
        // Three seats asking 1 SOL into a 1 SOL pot: a third of a SOL each, rounded down, a lamport left unspent.
        let a = allocate(&counts(200, &[(100, 3)]), &[0; 10], STEP, SOL);
        assert_eq!(a.others.level, 333_333_333);
        assert_eq!(a.spend, 999_999_999);
    }

    #[test]
    fn keeps_unverified_fills_within_a_quarter_of_the_spend() {
        // 100 Unverified seats asking 0.1 SOL and 5 Scored asking 0.5, into a 17 SOL pot: one level would give the
        // Unverified 10 of 12.5 SOL, so they share a third of the 2.5 SOL everyone else fills.
        let others = counts(200, &[(50, 5)]);
        let unverified = counts(10, &[(10, 100)]);
        let a = allocate(&others, &unverified, STEP, 17 * SOL);
        assert_eq!(a.others.filled, 5 * SOL / 2);
        assert!(!a.others.limited);
        assert_eq!(a.unverified.filled, 833_333_300);
        assert_eq!(a.unverified.level, 8_333_333);
        assert!(3 * a.unverified.filled <= a.others.filled);
        assert_eq!(a.spend, a.others.filled + a.unverified.filled);
    }

    #[test]
    fn cuts_both_tiers_when_both_ask_too_much() {
        // 400 Unverified seats asking 0.1 SOL and 20 Verified asking 2 SOL, into a 17 SOL pot.
        let others = counts(200, &[(200, 20)]);
        let unverified = counts(10, &[(10, 400)]);
        let a = allocate(&others, &unverified, STEP, 17 * SOL);
        assert_eq!(a.others.level, 637_500_000);
        assert_eq!(a.unverified.level, 10_625_000);
        assert!(a.others.limited && a.unverified.limited);
        assert_eq!(a.spend, 17 * SOL);
        assert!(3 * a.unverified.filled <= a.others.filled);
    }

    #[test]
    fn spends_nothing_from_an_empty_pot() {
        let a = allocate(&[0; 200], &[0; 10], STEP, 17 * SOL);
        assert_eq!(a.spend, 0);
        assert_eq!(a.others, Level { level: 0, filled: 0, limited: false });
    }

    #[test]
    fn spends_nothing_when_only_unverified_seats_ask() {
        // A quarter of what Unverified seats spend must be matched three times over by everyone else, who asks nothing.
        let a = allocate(&[0; 200], &counts(10, &[(10, 9)]), STEP, 17 * SOL);
        assert_eq!(a.spend, 0);
        assert!(a.unverified.limited);
    }

    #[test]
    fn lets_rungs_fall_five_percent_at_a_time() {
        let all: Vec<u64> = rungs(17 * SOL).collect();
        assert_eq!(all.len(), RUNGS);
        assert_eq!(all[0], 17 * SOL);
        assert_eq!(all[1], 16_150_000_000);
        assert!(all.windows(2).all(|w| w[1] == (w[0] as u128 * 19 / 20) as u64));
        // A 26x range: the lowest rung is about 4% of the cap.
        assert_eq!(lowest_rung(17 * SOL), all[63]);
        assert!(17 * SOL / lowest_rung(17 * SOL) >= 25);
        assert_eq!(rung_at_or_below(17 * SOL, 16_200_000_000), Some(16_150_000_000));
        assert_eq!(rung_at_or_below(17 * SOL, all[63] - 1), None);
    }

    #[test]
    fn shares_the_rung_and_the_coins_at_one_price() {
        // Spec 2.1 step 11's worked example opening on a rung: 15 SOL of fills spend a 14.25 SOL rung, so every fill is
        // scaled by 0.95, and the coins go out in proportion to the fills.
        let (spend, spent, coins) = (15 * SOL, 14_250_000_000, 300_000_000_000_000);
        assert_eq!(share(240_000_000, spend, spent, coins), (228_000_000, 4_800_000_000_000));
        assert_eq!(share(100_000_000, spend, spent, coins), (95_000_000, 2_000_000_000_000));
        // A third of a lamport rounds the spend up and the coins down.
        assert_eq!(share(1, 3, 2, 2), (1, 0));
        assert_eq!(share(0, spend, spent, coins), (0, 0));
        assert_eq!(share(5, 0, 0, 0), (0, 0));
    }

    #[test]
    fn never_pays_out_more_coins_or_takes_less_than_the_rung() {
        let mut rng = Rng(0xc01d);
        for _ in 0..2_000 {
            let cap = rng.next(20 * SOL) + 1;
            let (others, unverified) = pot(&mut rng);
            let a = allocate(&others, &unverified, STEP, cap);
            let Some(rung) = rung_at_or_below(cap, a.spend) else { continue };
            let coins = rng.next(400_000_000_000_000) + 1;
            let (mut spent_sum, mut coins_sum) = (0u128, 0u128);
            for (counts, level) in [(&others, a.others.level), (&unverified, a.unverified.level)] {
                for (k, &n) in counts.iter().enumerate() {
                    let fill = ((k as u64 + 1) * STEP).min(level);
                    let (spent, bought) = share(fill, a.spend, rung, coins);
                    assert!(spent <= fill);
                    spent_sum += spent as u128 * n as u128;
                    coins_sum += bought as u128 * n as u128;
                }
            }
            let seats: u128 = others.iter().chain(&unverified).map(|&n| n as u128).sum();
            // The seats spend the rung, and at most a lamport more each; they get the coins, at most one less each.
            assert!(spent_sum >= rung as u128 && spent_sum < rung as u128 + seats.max(1), "{spent_sum} for {rung}");
            assert!(coins_sum <= coins as u128 && coins_sum + seats >= coins as u128, "{coins_sum} of {coins}");
        }
    }

    /// A small deterministic generator, so the property test below needs no crate.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self, below: u64) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0 % below
        }
    }

    /// Random counts: up to 40 asks of Scored or Verified sizes, and up to 20 of Unverified ones.
    fn pot(rng: &mut Rng) -> (Vec<u32>, Vec<u32>) {
        let mut others = vec![0u32; 200];
        let mut unverified = vec![0u32; 10];
        for _ in 0..rng.next(40) {
            let max = if rng.next(2) == 0 { 50 } else { 200 };
            others[rng.next(max) as usize] += rng.next(30) as u32 + 1;
        }
        for _ in 0..rng.next(20) {
            unverified[rng.next(10) as usize] += rng.next(200) as u32 + 1;
        }
        (others, unverified)
    }

    #[test]
    fn finds_the_largest_level_within_any_budget() {
        // Against a binary search over every level up to the largest ask, the slow way.
        let mut rng = Rng(0x1e7e1);
        for _ in 0..5_000 {
            let (others, _) = pot(&mut rng);
            let budget = rng.next(30 * SOL);
            let found = level_within(&others[..], STEP, budget);
            let top = largest(&others[..], STEP);
            let (mut lo, mut hi) = (0u64, top);
            while lo < hi {
                let mid = lo + (hi - lo).div_ceil(2);
                if filled(&others[..], STEP, mid) <= budget as u128 {
                    lo = mid;
                } else {
                    hi = mid - 1;
                }
            }
            assert_eq!(found.level, lo, "budget {budget}");
            assert_eq!(found.filled as u128, filled(&others[..], STEP, lo));
            assert_eq!(found.limited, lo < top);
        }
    }

    #[test]
    fn holds_its_rules_for_any_pot() {
        let mut rng = Rng(0x5eed);
        for _ in 0..20_000 {
            let cap = rng.next(20 * SOL) + 1;
            let (others, unverified) = pot(&mut rng);
            let a = allocate(&others, &unverified, STEP, cap);
            let fill = |counts: &[u32], level: u64| filled(counts, STEP, level) as u64;
            assert!(a.spend <= cap);
            assert_eq!(a.spend, a.others.filled + a.unverified.filled);
            assert_eq!(a.others.filled, fill(&others, a.others.level));
            assert_eq!(a.unverified.filled, fill(&unverified, a.unverified.level));
            assert_eq!(a.others.limited, largest(&others[..], STEP) > a.others.level);
            assert_eq!(a.unverified.limited, largest(&unverified[..], STEP) > a.unverified.level);
            // Unverified fills are at most a quarter of the spend, to the lamport.
            assert!(3 * a.unverified.filled as u128 <= a.others.filled as u128, "{a:?}");
            // Nobody else is cut below what an Unverified seat fills.
            if a.others.limited {
                assert!(a.unverified.level <= a.others.level, "{a:?}");
            }
            // A pot whose asks all fit, within the quarter, spends every ask.
            let (all_others, all_unverified) = (asked(&others[..], STEP), asked(&unverified[..], STEP));
            if all_others + all_unverified <= cap as u128 && 3 * all_unverified <= all_others {
                assert_eq!(a.spend as u128, all_others + all_unverified);
            }
        }
    }
}
