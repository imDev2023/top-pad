//! The program's allocation against the reference calculation (spec 2.1 step 11): `@top-pad/chain` writes 404 pots and
//! the allocation it gives each to `packages/chain/src/fixtures/allocations.json` (`pnpm --filter @top-pad/chain
//! allocation-cases`), the numbers the Fair Open page shows, and the program must give the same to the lamport.
use {fair_open::allocation::allocate, serde_json::Value};

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
    }
}
