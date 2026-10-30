//! The vault always holds at least what it owes (spec 5.3): after every instruction of a long, random window, and through
//! the failure path to the last refund, it holds every seat's deposit and prepaid coin-account rent, counted from the
//! seats themselves rather than from the launch's own totals.
#![allow(clippy::result_large_err)]
mod common;

use {
    common::*,
    fair_open::{Launch, Seat, Tier},
    solana_keypair::Keypair,
    solana_signer::Signer,
};

/// A small deterministic generator, so the test needs no crate.
struct Rng(u64);
impl Rng {
    fn next(&mut self, below: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0 % below
    }
}

/// Checks the vault against the seats on chain, and the launch's counts against the same seats.
fn check(t: &Test, launch: &LaunchKeys) {
    let seats: Vec<Seat> = t.seats_of(launch);
    let owed: u64 = seats.iter().map(|s| s.deposit + s.coin_rent).sum();
    assert!(t.vault_holds(launch) >= owed, "the vault holds {} and owes {owed}", t.vault_holds(launch));
    // Nothing else is ever paid in, so it holds exactly that.
    assert_eq!(t.vault_holds(launch), owed);
    let l: Launch = t.read(&launch.launch);
    assert_eq!(l.seats as usize, seats.len());
    let mut counts = [0u32; 200];
    let mut unverified = [0u32; 10];
    for s in &seats {
        let k = (s.deposit / STEP - 1) as usize;
        match s.tier {
            Tier::Unverified => unverified[k] += 1,
            _ => counts[k] += 1,
        }
    }
    assert_eq!(l.counts, counts);
    assert_eq!(l.unverified_counts, unverified);
}

#[test]
fn holds_what_it_owes_after_every_instruction() {
    let mut t = Test::new();
    let launch = t.launch();
    let tiers = [Tier::Unverified, Tier::Scored, Tier::Verified];
    let mut people: Vec<Depositor> = (0..24).map(|i| t.depositor(tiers[i % 3])).collect();
    let mut rng = Rng(0xfa1);
    let mut sent = 0;
    for second in 0..600 {
        t.at(second);
        for _ in 0..rng.next(3) {
            let i = rng.next(people.len() as u64) as usize;
            let d = &people[i];
            let seat = t.svm.get_account(&d.seat(&launch)).filter(|a| a.lamports > 0);
            let held = seat.map_or(0, |a| {
                use anchor_lang::AccountDeserialize;
                Seat::try_deserialize(&mut a.data.as_slice()).unwrap().deposit
            });
            let cap_steps = d.tier.cap(STEP) / STEP;
            let result = if held > 0 && rng.next(3) == 0 {
                t.withdraw(&launch, d, (rng.next(held / STEP) + 1) * STEP)
            } else {
                // Sometimes over the cap, which is refused and changes nothing.
                t.deposit(&launch, d, (rng.next(cap_steps + 2) + 1) * STEP)
            };
            if result.is_ok() {
                sent += 1;
            }
            check(&t, &launch);
            // Now and then an Unverified person is Scored by the time they deposit again.
            if rng.next(50) == 0 && people[i].tier == Tier::Unverified {
                people[i].tier = Tier::Scored;
            }
        }
    }
    assert!(sent > 300, "only {sent} instructions landed");

    t.at(600 + 900);
    t.mark_failed(&launch).unwrap();
    check(&t, &launch);
    let sender = Keypair::new();
    t.svm.airdrop(&sender.pubkey(), SOL).unwrap();
    for d in &people {
        if t.exists(&d.seat(&launch)) {
            t.withdraw_failed(&launch, d, &sender).unwrap();
            check(&t, &launch);
        }
    }
    assert_eq!(t.vault_holds(&launch), 0);
}
