//! Scheduling a Fair Open (spec 2.1 steps 4 to 7): `create_launch` keeps the window, the minimum raise, the identity
//! hash and the nonce, takes the pot's cap from Heat's Fair Open config, and is refused anything else.
#![allow(clippy::result_large_err)]
mod common;

use {
    anchor_lang::{solana_program::pubkey::Pubkey, Space},
    common::*,
    fair_open::{allocation, Launch, LaunchCreated, LaunchParams, LaunchStatus, Vault},
    solana_keypair::Keypair,
    solana_signer::Signer,
};

fn params() -> LaunchParams {
    LaunchParams { deposits_open_at: WINDOW_OPENS + 3600, min_raise: SOL / 2, identity_hash: [5; 32] }
}

#[test]
fn schedules_a_window_with_its_terms() {
    let mut t = Test::new();
    let keeper = t.keeper.insecure_clone();
    let creator = t.creator.insecure_clone();
    let nonce = t.nonce_held_by(&keeper.pubkey());
    let before = t.lamports(&creator.pubkey());
    let done = t.create_launch(&creator, &keeper, nonce, t.dbc_config, params()).unwrap();
    let keys = launch_keys(nonce);

    let launch: Launch = t.read(&keys.launch);
    assert_eq!(launch.creator, creator.pubkey());
    assert_eq!(launch.nonce, nonce);
    assert_eq!(launch.dbc_config, t.dbc_config);
    assert_eq!(launch.quote_mint, fair_open::NATIVE_MINT);
    assert_eq!(launch.identity_hash, [5; 32]);
    assert_eq!(launch.deposits_open_at, WINDOW_OPENS + 3600);
    assert_eq!(launch.opens_at, WINDOW_OPENS + 3600 + 600);
    assert_eq!(launch.min_raise, SOL / 2);
    // 20% of the devnet Graduation Target of 8.5 SOL (spec 12).
    assert_eq!(launch.pot_cap, 1_700_000_000);
    assert_eq!(launch.lowest_rung, allocation::lowest_rung(1_700_000_000));
    assert_eq!(launch.step, STEP);
    assert_eq!(launch.status, LaunchStatus::Scheduled);
    assert_eq!(launch.seats, 0);
    assert_eq!(t.read::<Vault>(&keys.vault).launch, keys.launch);

    // The creator prepays the rent of the launch and its vault and of what the open will make, and the transaction's
    // fee (spec 2.1 step 7); the vault holds the open's rent.
    let rent = t.rent(8 + Launch::INIT_SPACE) + t.rent(8 + Vault::INIT_SPACE);
    assert_eq!(before - t.lamports(&creator.pubkey()), rent + t.open_rent() + 10_000);
    assert_eq!((launch.open_rent, t.vault_holds(&keys)), (t.open_rent(), t.open_rent()));
    let created = events::<LaunchCreated>(&done);
    assert_eq!(created.len(), 1);
    assert_eq!(created[0].launch, keys.launch);
    assert_eq!(created[0].pot_cap, launch.pot_cap);
    println!(
        "create_launch: {} compute units, launch account {} bytes ({} lamports of rent), vault {} lamports",
        done.compute_units_consumed,
        8 + Launch::INIT_SPACE,
        t.rent(8 + Launch::INIT_SPACE),
        t.rent(8 + Vault::INIT_SPACE),
    );
}

#[test]
fn needs_the_keepers_signature() {
    let mut t = Test::new();
    let creator = t.creator.insecure_clone();
    let impostor = Keypair::new();
    let nonce = t.nonce_held_by(&t.keeper.pubkey());
    refused(t.create_launch(&creator, &impostor, nonce, t.dbc_config, params()), Code::NotTheKeeper);
}

#[test]
fn runs_only_on_heats_fair_open_config() {
    let mut t = Test::new();
    let (creator, keeper) = (t.creator.insecure_clone(), t.keeper.insecure_clone());
    let other = Pubkey::new_unique();
    t.set_account(other, dbc_config_data(&fair_open::NATIVE_MINT, GRADUATION_TARGET), fair_open::dbc::PROGRAM_ID);
    let nonce = t.nonce_held_by(&keeper.pubkey());
    refused(t.create_launch(&creator, &keeper, nonce, other, params()), Code::NotTheFairOpenConfig);
}

#[test]
fn takes_sol_only() {
    // A config in another quote, even named by the program config, is refused until a non-SOL quote's deposits exist.
    let mut t = Test::new();
    t.set_account(t.dbc_config, dbc_config_data(&Pubkey::new_unique(), GRADUATION_TARGET), fair_open::dbc::PROGRAM_ID);
    let (creator, keeper) = (t.creator.insecure_clone(), t.keeper.insecure_clone());
    let nonce = t.nonce_held_by(&keeper.pubkey());
    refused(t.create_launch(&creator, &keeper, nonce, t.dbc_config, params()), Code::QuoteNotSupported);
}

#[test]
fn refuses_a_minimum_raise_the_pot_can_never_reach() {
    let mut t = Test::new();
    let (creator, keeper) = (t.creator.insecure_clone(), t.keeper.insecure_clone());
    let nonce = t.nonce_held_by(&keeper.pubkey());
    let params = LaunchParams { min_raise: 1_700_000_001, ..params() };
    refused(t.create_launch(&creator, &keeper, nonce, t.dbc_config, params), Code::MinRaiseAboveCap);
}

#[test]
fn schedules_up_to_seven_days_ahead_and_never_a_window_already_over() {
    let mut t = Test::new();
    let (creator, keeper) = (t.creator.insecure_clone(), t.keeper.insecure_clone());
    let now = t.now();
    let try_at = |t: &mut Test, deposits_open_at: i64| {
        let nonce = t.nonce_held_by(&keeper.pubkey());
        t.create_launch(&creator, &keeper, nonce, t.dbc_config, LaunchParams { deposits_open_at, ..params() })
    };
    refused(try_at(&mut t, now + 7 * 24 * 3600 + 1), Code::TooFarAhead);
    try_at(&mut t, now + 7 * 24 * 3600).unwrap();
    refused(try_at(&mut t, now - 600), Code::WindowOver);
    // A window already running may still be scheduled, as long as it has not closed.
    try_at(&mut t, now - 599).unwrap();
}

#[test]
fn needs_an_identity_to_seal() {
    let mut t = Test::new();
    let (creator, keeper) = (t.creator.insecure_clone(), t.keeper.insecure_clone());
    let nonce = t.nonce_held_by(&keeper.pubkey());
    let params = LaunchParams { identity_hash: [0; 32], ..params() };
    refused(t.create_launch(&creator, &keeper, nonce, t.dbc_config, params), Code::NoIdentity);
}

#[test]
fn needs_a_nonce_only_the_keeper_can_advance() {
    // A nonce the creator holds would let them spoil the signed ladder (spec 2.1 step 6).
    let mut t = Test::new();
    let (creator, keeper) = (t.creator.insecure_clone(), t.keeper.insecure_clone());
    let theirs = t.nonce_held_by(&creator.pubkey());
    refused(t.create_launch(&creator, &keeper, theirs, t.dbc_config, params()), Code::NotOurNonce);
    // Nor will a plain account do.
    let plain = Pubkey::new_unique();
    t.set_account(plain, vec![0; 80], anchor_lang::solana_program::system_program::ID);
    refused(t.create_launch(&creator, &keeper, plain, t.dbc_config, params()), Code::NotOurNonce);
}

#[test]
fn takes_one_launch_per_nonce() {
    let mut t = Test::new();
    let (creator, keeper) = (t.creator.insecure_clone(), t.keeper.insecure_clone());
    let nonce = t.nonce_held_by(&keeper.pubkey());
    t.create_launch(&creator, &keeper, nonce, t.dbc_config, params()).unwrap();
    t.at(1);
    assert!(t.create_launch(&creator, &keeper, nonce, t.dbc_config, params()).is_err());
}
