//! Stock-priced coins' settings (ADR 0007 decision 4): the quote manager, named by the upgrade authority alone, writes
//! each quote's `QuoteSettings`, whose Fair Open config must be shaped as Heat's SOL one in every byte that does not
//! follow the quote, and `create_launch` takes its config and step from them.
#![allow(clippy::result_large_err)]
mod common;

use {
    anchor_lang::{solana_program::pubkey::Pubkey, Discriminator, Space},
    common::*,
    fair_open::{
        dbc, Launch, LaunchParams, ProgramConfig, QuoteManagerSet, QuoteSettings, QuoteSettingsChanged,
        PROGRAM_CONFIG_SEED,
    },
    solana_keypair::Keypair,
    solana_signer::Signer,
};

fn params() -> LaunchParams {
    LaunchParams { deposits_open_at: WINDOW_OPENS + 3600, min_raise: 0, identity_hash: [5; 32] }
}

#[test]
fn takes_its_quote_manager_from_the_upgrade_authority_alone() {
    let mut t = Test::deployed();
    let authority = t.upgrade_authority.insecure_clone();
    t.initialize_as(&authority, t.settings()).unwrap();
    let stranger = Keypair::new();
    let manager = Pubkey::new_unique();
    refused(t.set_quote_manager_as(&stranger, manager), Code::NotUpgradeAuthority);
    refused(t.set_quote_manager_as(&authority, Pubkey::default()), Code::MissingSetting);
    let done = t.set_quote_manager_as(&authority, manager).unwrap();
    assert_eq!(t.read::<ProgramConfig>(&program_config_address()).quote_manager, manager);
    assert_eq!(events::<QuoteManagerSet>(&done)[0].quote_manager, manager);

    // Rotating the other settings keeps the quote manager.
    t.update_as(&authority, t.settings()).unwrap();
    assert_eq!(t.read::<ProgramConfig>(&program_config_address()).quote_manager, manager);
}

#[test]
fn grows_a_program_config_made_before_the_quote_manager() {
    // Devnet's ProgramConfig was made with four keys and a bump; naming the quote manager grows it in place.
    let mut t = Test::deployed();
    let authority = t.upgrade_authority.insecure_clone();
    let settings = t.settings();
    let mut data = ProgramConfig::DISCRIMINATOR.to_vec();
    for key in [settings.admission_signer, settings.keeper, settings.fee_program, settings.dbc_config] {
        data.extend_from_slice(key.as_ref());
    }
    let bump = Pubkey::find_program_address(&[PROGRAM_CONFIG_SEED], &fair_open::id()).1;
    data.push(bump);
    assert_eq!(data.len(), 8 + ProgramConfig::INIT_SPACE - 32);
    t.set_account(program_config_address(), data, fair_open::id());

    let manager = Pubkey::new_unique();
    t.set_quote_manager_as(&authority, manager).unwrap();
    let account = t.svm.get_account(&program_config_address()).unwrap();
    assert_eq!(account.data.len(), 8 + ProgramConfig::INIT_SPACE);
    assert_eq!(account.lamports, t.rent(8 + ProgramConfig::INIT_SPACE));
    let config: ProgramConfig = t.read(&program_config_address());
    assert_eq!(
        (config.admission_signer, config.keeper, config.dbc_config, config.bump, config.quote_manager),
        (settings.admission_signer, settings.keeper, settings.dbc_config, bump, manager)
    );
    // The grown account reads as a ProgramConfig everywhere again: a launch schedules on it.
    let (fair_open_config, instant_config) = (t.dbc_config, t.instant_config);
    let manager_key = t.quote_manager.insecure_clone();
    t.set_quote_manager_as(&authority, manager_key.pubkey()).unwrap();
    t.set_quote_settings(&fair_open::NATIVE_MINT, fair_open_config, instant_config, STEP).unwrap();
    t.at(0);
    t.launch();
}

#[test]
fn writes_quote_settings_by_the_quote_manager_alone() {
    let mut t = Test::new();
    let settings: QuoteSettings = t.read(&quote_settings_address(&fair_open::NATIVE_MINT));
    assert_eq!(
        (settings.quote_mint, settings.fair_open_config, settings.instant_config, settings.step),
        (fair_open::NATIVE_MINT, t.dbc_config, t.instant_config, STEP)
    );
    println!(
        "QuoteSettings: {} bytes ({} lamports of rent)",
        8 + QuoteSettings::INIT_SPACE,
        t.rent(8 + QuoteSettings::INIT_SPACE)
    );

    let stranger = Keypair::new();
    let (fair_open_config, instant_config) = (t.dbc_config, t.instant_config);
    let refusal = t.set_quote_settings_as(&stranger, &fair_open::NATIVE_MINT, fair_open_config, instant_config, STEP);
    refused(refusal, Code::NotTheQuoteManager);
    refused(t.set_quote_settings(&fair_open::NATIVE_MINT, fair_open_config, instant_config, 0), Code::OffStep);

    // The manager rewrites them as prices move.
    let done = t.set_quote_settings(&fair_open::NATIVE_MINT, fair_open_config, instant_config, 2 * STEP).unwrap();
    assert_eq!(t.read::<QuoteSettings>(&quote_settings_address(&fair_open::NATIVE_MINT)).step, 2 * STEP);
    assert_eq!(events::<QuoteSettingsChanged>(&done)[0].step, 2 * STEP);
}

#[test]
fn refuses_configs_in_another_quote_or_not_dbcs() {
    let mut t = Test::new();
    let quote = Pubkey::new_unique();
    t.set_account(quote, mint_data(8), TOKEN_PROGRAM);
    let sol_config = t.dbc_config;
    let theirs = Pubkey::new_unique();
    t.set_account(theirs, dbc_config_data(&quote, GRADUATION_TARGET), dbc::PROGRAM_ID);
    // A SOL config named for another quote, either side of the pair.
    refused(t.set_quote_settings(&quote, sol_config, theirs, STEP), Code::NotThisQuote);
    refused(t.set_quote_settings(&quote, theirs, sol_config, STEP), Code::NotThisQuote);
    // A config DBC does not own.
    let fake = Pubkey::new_unique();
    t.set_account(fake, dbc_config_data(&quote, GRADUATION_TARGET), fair_open::id());
    refused(t.set_quote_settings(&quote, fake, theirs, STEP), Code::NotADbcConfig);
    // A mint no token program owns.
    let not_a_mint = Pubkey::new_unique();
    t.set_account(not_a_mint, mint_data(8), fair_open::id());
    refused(t.set_quote_settings(&not_a_mint, theirs, theirs, STEP), Code::NotThisQuote);
    // Its own pair is taken, at any target.
    t.set_quote_settings(&quote, theirs, theirs, 1_234).unwrap();
}

/// A config in `quote`, Heat-shaped as the SOL one is, with byte `at` of it flipped.
fn config_with(t: &mut Test, quote: &Pubkey, at: Option<usize>) -> Pubkey {
    let mut data = t.svm.get_account(&t.dbc_config).unwrap().data;
    data[dbc::CONFIG_QUOTE_MINT_OFFSET..][..32].copy_from_slice(quote.as_ref());
    if let Some(at) = at {
        data[at] ^= 0x5a;
    }
    let address = Pubkey::new_unique();
    t.set_account(address, data, dbc::PROGRAM_ID);
    address
}

#[test]
fn refuses_a_fair_open_config_not_shaped_as_heats() {
    let mut t = Test::new();
    let quote = Pubkey::new_unique();
    t.set_account(quote, mint_data(8), TOKEN_2022);
    // Every byte that makes a launch Heat's, one at a time: the fee claimer, the leftover receiver, the sniper tax's
    // integers, the dynamic fee, LP vesting, the base mint's transfer fee, the collect fee mode, the migration option,
    // the activation type, the decimals, the token type, every LP bucket, the migration fees, the creator fee, the
    // update authority, the migrated pool's fees and the pool creation fee.
    for at in dbc::CONFIG_SHAPE.iter().flat_map(|range| range.clone()) {
        let config = config_with(&mut t, &quote, Some(at));
        let instant = config_with(&mut t, &quote, None);
        refused(t.set_quote_settings(&quote, config, instant, STEP), Code::NotHeatsConfigShape);
    }
    // What follows the quote may differ: its token program flag, DBC's version, the target, the curve and supplies.
    for at in [236, 238, 264, 300, 392, 500, 1047] {
        let config = config_with(&mut t, &quote, Some(at));
        let instant = config_with(&mut t, &quote, None);
        t.set_quote_settings(&quote, config, instant, STEP).unwrap();
    }
    // The Instant config is not held to the Fair Open shape.
    let config = config_with(&mut t, &quote, None);
    let instant = config_with(&mut t, &quote, Some(232));
    t.set_quote_settings(&quote, config, instant, STEP).unwrap();
}

#[test]
fn schedules_on_the_quotes_config_with_its_step() {
    let mut t = Test::new();
    let (fair_open_config, instant_config) = (t.dbc_config, t.instant_config);
    t.set_quote_settings(&fair_open::NATIVE_MINT, fair_open_config, instant_config, 3 * STEP).unwrap();
    let first = t.launch();
    assert_eq!(t.read::<Launch>(&first.launch).step, 3 * STEP);
    // A launch keeps the step it was scheduled with when the settings move on.
    t.set_quote_settings(&fair_open::NATIVE_MINT, fair_open_config, instant_config, STEP).unwrap();
    assert_eq!(t.read::<Launch>(&first.launch).step, 3 * STEP);
    let second = t.launch_with(params());
    assert_eq!(t.read::<Launch>(&second.launch).step, STEP);
    println!("Launch: {} bytes", 8 + Launch::INIT_SPACE);
}

#[test]
fn refuses_a_config_the_settings_do_not_name_or_that_lost_heats_shape() {
    let mut t = Test::new();
    let (creator, keeper) = (t.creator.insecure_clone(), t.keeper.insecure_clone());
    // The Instant config is SOL's too, but not its Fair Open config.
    let instant = t.instant_config;
    let nonce = t.nonce_held_by(&keeper.pubkey());
    refused(t.create_launch(&creator, &keeper, nonce, instant, params()), Code::NotTheFairOpenConfig);

    // Settings naming another quote's mint for SOL's config are refused when they are written, and a config whose
    // shape no longer matches the reference is refused when a launch is scheduled.
    let quote = Pubkey::new_unique();
    t.set_account(quote, mint_data(8), TOKEN_PROGRAM);
    let config = config_with(&mut t, &quote, None);
    t.set_quote_settings(&quote, config, config, STEP).unwrap();
    let mut data = t.svm.get_account(&config).unwrap().data;
    data[245] = 50;
    t.set_account(config, data, dbc::PROGRAM_ID);
    let nonce = t.nonce_held_by(&keeper.pubkey());
    refused(t.create_launch_in(&quote, &creator, &keeper, nonce, config, params()), Code::NotHeatsConfigShape);
}

#[test]
fn reference_config_is_the_program_configs() {
    let mut t = Test::new();
    let quote = Pubkey::new_unique();
    t.set_account(quote, mint_data(8), TOKEN_PROGRAM);
    let config = config_with(&mut t, &quote, None);
    // Naming the candidate itself as the reference is refused by address.
    let manager = t.quote_manager.insecure_clone();
    let mut accounts = fair_open::accounts::SetQuoteSettings {
        program_config: program_config_address(),
        quote_manager: manager.pubkey(),
        payer: t.payer.pubkey(),
        quote_mint: quote,
        quote_settings: quote_settings_address(&quote),
        fair_open_config: config,
        instant_config: config,
        reference_config: config,
        system_program: anchor_lang::system_program::ID,
        event_authority: event_authority(),
        program: fair_open::id(),
    };
    let data = anchor_lang::InstructionData::data(&fair_open::instruction::SetQuoteSettings { step: STEP });
    let ix = instruction(anchor_lang::ToAccountMetas::to_account_metas(&accounts, None), data.clone());
    refused(t.send(&[ix], &[&manager]), Code::NotTheFairOpenConfig);
    accounts.reference_config = t.dbc_config;
    let ix = instruction(anchor_lang::ToAccountMetas::to_account_metas(&accounts, None), data);
    t.send(&[ix], &[&manager]).unwrap();
}
