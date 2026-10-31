//! The program's allocation against the reference calculation (spec 2.1 step 11): `@top-pad/chain` writes 404 pots and
//! the allocation it gives each to `packages/chain/src/fixtures/allocations.json` (`pnpm --filter @top-pad/chain
//! allocation-cases`), the numbers the Fair Open page shows, and the program must give the same to the lamport; and for
//! each pot that can open, the rung and what its seats spend of it and buy, added up.
use {
    fair_open::allocation::{allocate, rung_at_or_below, share},
    serde_json::Value,
};

const CASES: &str = include_str!("../../../packages/chain/src/fixtures/allocations.json");

fn number(v: &Value) -> u64 {
    v.as_str().expect("amounts are strings").parse().unwrap()
}

/// Counts from the fixture's [step index, seats] pairs.
fn counts(pairs: &Value, len: usize) -> Vec<u32> {
    let mut counts = vec![0u32; len];
    for pair in pairs.as_array().unwrap() {
        counts[pair[0].as_u64().unwrap() as usize] = pair[1].as_u64().unwrap() as u32;
    }
    counts
}

#[test]
fn matches_the_reference_calculation_to_the_lamport() {
    let cases: Vec<Value> = serde_json::from_str(CASES).unwrap();
    assert!(cases.len() > 400);
    for c in &cases {
        let a = allocate(
            &counts(&c["counts"], 200),
            &counts(&c["unverifiedCounts"], 10),
            number(&c["step"]),
            number(&c["cap"]),
        );
        let name = c["name"].as_str().unwrap();
        assert_eq!(a.spend, number(&c["spend"]), "{name}: spend");
        for (level, expected) in [(a.others, &c["others"]), (a.unverified, &c["unverified"])] {
            assert_eq!(level.level, number(&expected["level"]), "{name}: level");
            assert_eq!(level.filled, number(&expected["filled"]), "{name}: filled");
            assert_eq!(level.limited, expected["limited"].as_bool().unwrap(), "{name}: limited");
        }

        let rung = rung_at_or_below(number(&c["cap"]), a.spend).filter(|_| a.spend > 0);
        let open = &c["open"];
        assert_eq!(rung.is_some(), !open.is_null(), "{name}: opens");
        let Some(rung) = rung else { continue };
        assert_eq!(rung, number(&open["rung"]), "{name}: rung");
        let coins = number(&open["coins"]);
        let (mut spent, mut bought) = (0u128, 0u128);
        for (pairs, len, level) in [(&c["counts"], 200, a.others.level), (&c["unverifiedCounts"], 10, a.unverified.level)] {
            for (k, n) in counts(pairs, len).into_iter().enumerate() {
                let fill = ((k as u64 + 1) * number(&c["step"])).min(level);
                let (s, b) = share(fill, a.spend, rung, coins);
                spent += s as u128 * n as u128;
                bought += b as u128 * n as u128;
            }
        }
        assert_eq!(spent, number(&open["spent"]) as u128, "{name}: spent");
        assert_eq!(bought, number(&open["bought"]) as u128, "{name}: bought");
    }
}
