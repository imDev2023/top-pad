//! The window (spec 2.1 step 9): deposits with our admission server's signature, one seat per person, caps in 0.01 SOL
//! steps, and withdrawals until the window closes. Each refusal the ticket names is shown on chain here: a second wallet
//! of a seated person, a deposit over the cap or off the step, and one without a valid, unexpired admission.
#![allow(clippy::result_large_err)]
mod common;

use {
    anchor_lang::{solana_program::pubkey::Pubkey, Space},
    common::*,
    fair_open::{Admission, Deposited, Launch, Seat, Tier, Withdrawn},
    solana_keypair::Keypair,
    solana_signer::Signer,
};

#[test]
fn seats_a_depositor_who_prepays_both_rents() {
    let mut t = Test::new();
    let launch = t.launch();
    let d = t.depositor(Tier::Scored);
    let before = t.lamports(&d.wallet.pubkey());
    let done = t.deposit(&launch, &d, 30 * STEP).unwrap();

    let seat: Seat = t.read(&d.seat(&launch));
    assert_eq!((seat.wallet, seat.person, seat.tier), (d.wallet.pubkey(), d.person, Tier::Scored));
    assert_eq!(seat.cap, SOL / 2);
    assert_eq!(seat.deposit, 30 * STEP);
    let coin_rent = t.rent(fair_open::TOKEN_ACCOUNT_LEN);
    let seat_rent = t.rent(8 + Seat::INIT_SPACE);
    assert_eq!(seat.coin_rent, coin_rent);
    // The deposit, both rents, and a fee for two signatures: the wallet's and the admission's (spec 5.3).
    assert_eq!(before - t.lamports(&d.wallet.pubkey()), 30 * STEP + coin_rent + seat_rent + 10_000);
    assert_eq!(t.vault_holds(&launch), 30 * STEP + coin_rent);

    let l: Launch = t.read(&launch.launch);
    assert_eq!((l.seats, l.scored_deposits, l.coin_rent), (1, 30 * STEP, coin_rent));
    assert_eq!(l.counts[29], 1);
    let event = &events::<Deposited>(&done)[0];
    assert!(event.new_seat);
    assert_eq!((event.amount, event.deposit, event.pot, event.seats), (30 * STEP, 30 * STEP, 30 * STEP, 1));
    println!(
        "deposit: {} compute units for a new seat; seat {} bytes ({seat_rent} lamports), coin account {coin_rent}",
        done.compute_units_consumed,
        8 + Seat::INIT_SPACE,
    );
}

#[test]
fn adds_to_a_seat_and_moves_it_between_steps() {
    let mut t = Test::new();
    let launch = t.launch();
    let d = t.depositor(Tier::Verified);
    t.deposit(&launch, &d, 50 * STEP).unwrap();
    let before = t.lamports(&d.wallet.pubkey());
    let done = t.deposit(&launch, &d, 70 * STEP).unwrap();
    // A top-up pays no rent again.
    assert_eq!(before - t.lamports(&d.wallet.pubkey()), 70 * STEP + 10_000);
    let l: Launch = t.read(&launch.launch);
    assert_eq!((l.counts[49], l.counts[119], l.verified_deposits, l.seats), (0, 1, 120 * STEP, 1));
    assert!(!events::<Deposited>(&done)[0].new_seat);
    println!("deposit: {} compute units for a top-up", done.compute_units_consumed);
}

#[test]
fn moves_a_seat_to_its_new_tier_when_its_admission_rises() {
    // An Unverified depositor links X and is Scored: the same seat now counts with the Scored seats.
    let mut t = Test::new();
    let launch = t.launch();
    let mut d = t.depositor(Tier::Unverified);
    t.deposit(&launch, &d, 10 * STEP).unwrap();
    d.tier = Tier::Scored;
    t.deposit(&launch, &d, 20 * STEP).unwrap();
    let l: Launch = t.read(&launch.launch);
    assert_eq!((l.unverified_counts[9], l.unverified_deposits), (0, 0));
    assert_eq!((l.counts[29], l.scored_deposits, l.seats), (1, 30 * STEP, 1));
    assert_eq!(t.read::<Seat>(&d.seat(&launch)).tier, Tier::Scored);
}

#[test]
fn refuses_a_second_wallet_of_a_seated_person() {
    let mut t = Test::new();
    let launch = t.launch();
    let first = t.depositor(Tier::Scored);
    t.deposit(&launch, &first, 10 * STEP).unwrap();
    // The same person, as our admission server knows them, through another wallet.
    let mut second = t.depositor(Tier::Scored);
    second.person = first.person;
    refused(t.deposit(&launch, &second, 10 * STEP), Code::SeatHeldByAnotherWallet);
    assert_eq!(t.read::<Launch>(&launch.launch).seats, 1);
}

#[test]
fn refuses_a_deposit_over_the_cap() {
    let mut t = Test::new();
    let launch = t.launch();
    let d = t.depositor(Tier::Unverified);
    refused(t.deposit(&launch, &d, 11 * STEP), Code::OverCap);
    t.deposit(&launch, &d, 10 * STEP).unwrap();
    // Nor can the cap be passed a step at a time.
    refused(t.deposit(&launch, &d, STEP), Code::OverCap);
}

#[test]
fn refuses_a_deposit_off_the_step() {
    let mut t = Test::new();
    let launch = t.launch();
    let d = t.depositor(Tier::Scored);
    refused(t.deposit(&launch, &d, STEP + 1), Code::OffStep);
    refused(t.deposit(&launch, &d, STEP / 2), Code::OffStep);
    refused(t.deposit(&launch, &d, 0), Code::OffStep);
}

#[test]
fn refuses_an_admission_cap_above_its_tier() {
    // Even our own admission key cannot admit anyone above their tier's cap.
    let mut t = Test::new();
    let launch = t.launch();
    let d = t.depositor(Tier::Unverified);
    let admission = Admission { cap: 11 * STEP, ..t.admission(&d) };
    let signed = t.signed(&t.admission_key.insecure_clone(), &launch, &d.wallet.pubkey(), &admission);
    refused(t.deposit_with(&launch, &d.wallet, 11 * STEP, admission, &[signed]), Code::CapOverTier);
}

#[test]
fn refuses_a_deposit_without_an_admission() {
    let mut t = Test::new();
    let launch = t.launch();
    let d = t.depositor(Tier::Verified);
    let admission = t.admission(&d);
    refused(t.deposit_with(&launch, &d.wallet, STEP, admission, &[]), Code::NoAdmission);
}

#[test]
fn refuses_an_admission_signed_by_anyone_else() {
    let mut t = Test::new();
    let launch = t.launch();
    let d = t.depositor(Tier::Verified);
    let admission = t.admission(&d);
    let signed = t.signed(&Keypair::new(), &launch, &d.wallet.pubkey(), &admission);
    refused(t.deposit_with(&launch, &d.wallet, STEP, admission, &[signed]), Code::NotOurAdmission);
}

#[test]
fn refuses_someone_elses_admission() {
    // A Verified depositor's admission, replayed from another wallet or for another launch.
    let mut t = Test::new();
    let launch = t.launch();
    let other_launch = t.launch();
    let d = t.depositor(Tier::Verified);
    let admission = t.admission(&d);
    let key = t.admission_key.insecure_clone();
    let theirs = t.signed(&key, &launch, &d.wallet.pubkey(), &admission);
    let thief = t.depositor(Tier::Unverified);
    refused(t.deposit_with(&launch, &thief.wallet, STEP, admission, &[theirs]), Code::NotThisAdmission);
    let elsewhere = t.signed(&key, &other_launch, &d.wallet.pubkey(), &admission);
    refused(t.deposit_with(&launch, &d.wallet, STEP, admission, &[elsewhere]), Code::NotThisAdmission);
    // Or with the tier raised after signing.
    let raised = Admission { tier: Tier::Verified, ..t.admission(&thief) };
    let signed_lower = t.signed(&key, &launch, &thief.wallet.pubkey(), &t.admission(&thief));
    refused(t.deposit_with(&launch, &thief.wallet, STEP, raised, &[signed_lower]), Code::NotThisAdmission);
}

#[test]
fn refuses_an_expired_admission() {
    let mut t = Test::new();
    let launch = t.launch();
    let d = t.depositor(Tier::Scored);
    let admission = Admission { expires_at: t.now(), ..t.admission(&d) };
    let signed = t.signed(&t.admission_key.insecure_clone(), &launch, &d.wallet.pubkey(), &admission);
    refused(t.deposit_with(&launch, &d.wallet, STEP, admission, &[signed]), Code::AdmissionExpired);
}

#[test]
fn refuses_a_precompile_pointed_at_another_instruction() {
    // The precompile verifies a real admission held in another instruction, while its own data claims a different
    // one: the program must read only what the precompile itself verified.
    let mut t = Test::new();
    let launch = t.launch();
    let d = t.depositor(Tier::Verified);
    let key = t.admission_key.insecure_clone();
    let admission = t.admission(&d);
    let mut signed = t.signed(&key, &launch, &d.wallet.pubkey(), &admission);
    // Its message now names instruction 0, itself, by index rather than by u16::MAX.
    signed.data[14..16].copy_from_slice(&0u16.to_le_bytes());
    refused(t.deposit_with(&launch, &d.wallet, STEP, admission, &[signed]), Code::NoAdmission);
}

#[test]
fn takes_deposits_only_inside_the_window() {
    let mut t = Test::new();
    let launch = t.launch();
    let d = t.depositor(Tier::Scored);
    t.at(-1);
    refused(t.deposit(&launch, &d, STEP), Code::WindowNotStarted);
    t.at(0);
    t.deposit(&launch, &d, STEP).unwrap();
    t.at(599);
    t.deposit(&launch, &d, STEP).unwrap();
    t.at(600);
    refused(t.deposit(&launch, &d, STEP), Code::WindowClosed);
    refused(t.withdraw(&launch, &d, STEP), Code::WindowClosed);
}

#[test]
fn takes_back_part_of_a_deposit() {
    let mut t = Test::new();
    let launch = t.launch();
    let d = t.depositor(Tier::Scored);
    t.deposit(&launch, &d, 40 * STEP).unwrap();
    let before = t.lamports(&d.wallet.pubkey());
    let done = t.withdraw(&launch, &d, 15 * STEP).unwrap();
    assert_eq!(t.lamports(&d.wallet.pubkey()) - before, 15 * STEP - 5_000);
    assert_eq!(t.read::<Seat>(&d.seat(&launch)).deposit, 25 * STEP);
    let l: Launch = t.read(&launch.launch);
    assert_eq!((l.counts[39], l.counts[24], l.scored_deposits), (0, 1, 25 * STEP));
    assert!(!events::<Withdrawn>(&done)[0].closed);
    println!("withdraw: {} compute units for part of a deposit", done.compute_units_consumed);
}

#[test]
fn takes_back_everything_and_both_rents() {
    let mut t = Test::new();
    let launch = t.launch();
    let d = t.depositor(Tier::Scored);
    let start = t.lamports(&d.wallet.pubkey());
    t.deposit(&launch, &d, 40 * STEP).unwrap();
    let done = t.withdraw(&launch, &d, 40 * STEP).unwrap();
    // Only the two transactions' fees are spent: the seat closed and both rents came back.
    assert_eq!(start - t.lamports(&d.wallet.pubkey()), 10_000 + 5_000);
    assert!(!t.exists(&d.seat(&launch)));
    let l: Launch = t.read(&launch.launch);
    assert_eq!((l.seats, l.scored_deposits, l.coin_rent, l.counts[39]), (0, 0, 0, 0));
    assert_eq!(t.vault_holds(&launch), 0);
    assert!(events::<Withdrawn>(&done)[0].closed);
    println!("withdraw: {} compute units for everything, closing the seat", done.compute_units_consumed);

    // Having left, the person may take a seat again.
    t.deposit(&launch, &d, STEP).unwrap();
    assert_eq!(t.read::<Launch>(&launch.launch).seats, 1);
}

#[test]
fn refuses_to_take_back_more_than_the_seat_holds() {
    let mut t = Test::new();
    let launch = t.launch();
    let d = t.depositor(Tier::Scored);
    t.deposit(&launch, &d, 10 * STEP).unwrap();
    refused(t.withdraw(&launch, &d, 11 * STEP), Code::OverDeposit);
    refused(t.withdraw(&launch, &d, STEP + 1), Code::OffStep);
}

#[test]
fn lets_only_the_seats_wallet_take_it_back() {
    let mut t = Test::new();
    let launch = t.launch();
    let d = t.depositor(Tier::Scored);
    t.deposit(&launch, &d, 10 * STEP).unwrap();
    let thief = Keypair::new();
    t.svm.airdrop(&thief.pubkey(), SOL).unwrap();
    refused(t.withdraw_as(&launch, &d.seat(&launch), &thief, 10 * STEP), Code::NotYourSeat);
}

#[test]
fn keeps_one_launchs_seats_apart_from_anothers() {
    let mut t = Test::new();
    let (a, b) = (t.launch(), t.launch());
    let d = t.depositor(Tier::Scored);
    t.deposit(&a, &d, 10 * STEP).unwrap();
    // The seat in launch A, offered as if it were launch B's.
    let seat_in_a = d.seat(&a);
    let wallet = d.wallet.insecure_clone();
    assert!(t.withdraw_as(&b, &seat_in_a, &wallet, 10 * STEP).is_err());
    assert_eq!(t.read::<Seat>(&seat_in_a).deposit, 10 * STEP);
    assert_ne!(d.seat(&a), d.seat(&b));
    assert_ne!(Pubkey::default(), seat_in_a);
}
