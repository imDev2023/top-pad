//! The built program (target/deploy/fee.so, from `anchor build`) in LiteSVM, with no other program loaded (spec 5.1).
//! DBC never runs here: `register_coin` only reads a pool and a config, so the tests write accounts with DBC's layout
//! and owner, and the devnet tests check the same reads against real pools.
// LiteSVM's failed-transaction metadata is large by design; the helpers here only hand it back to the test.
#![allow(clippy::result_large_err)]
use {
    anchor_lang::{
        solana_program::{instruction::Instruction, pubkey::Pubkey, system_program},
        AccountDeserialize, AnchorDeserialize, Discriminator, InstructionData, Space, ToAccountMetas,
    },
    fee::{dbc, CoinRecord, CoinRegistered, FeeConfig, FeeSettings, LaunchMode},
    litesvm::{
        types::{FailedTransactionMetadata, TransactionMetadata},
        LiteSVM,
    },
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const PROGRAM: &[u8] = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/fee.so"));

/// The upgradeable loader, which owns every ProgramData account.
const UPGRADEABLE_LOADER: Pubkey = anchor_lang::solana_program::bpf_loader_upgradeable::ID;

#[test]
fn deploys_at_its_declared_id_and_refuses_an_unknown_instruction() {
    let mut svm = LiteSVM::new();
    svm.add_program(fee::id(), PROGRAM).unwrap();
    assert!(svm.get_account(&fee::id()).unwrap().executable);

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let instruction = Instruction::new_with_bytes(fee::id(), &[0; 8], vec![]);
    let err = send(&mut svm, &[instruction], &payer, &[]).unwrap_err();
    // Anchor's InstructionFallbackNotFound (101): the program runs, and has no instruction with that discriminator.
    assert!(err.meta.logs.iter().any(|l| l.contains("InstructionFallbackNotFound")), "{:?}", err.meta.logs);
    assert_ne!(fee::id(), Pubkey::default());
}

#[test]
fn derives_the_fee_claimer_every_config_names() {
    // Heat's DBC configs name this address as partner, fee claimer and leftover receiver, and cannot be changed.
    assert_eq!(fee_claimer().to_string(), "4Garg7N38ShAr8z38ZKkHrgP9Lj5nRKiy3HGtNDqTpko");
    assert_eq!(fee_claimer(), fee::FEE_CLAIMER);
}

#[test]
fn is_built_for_an_sbpf_version_devnet_and_mainnet_run() {
    // ELF e_flags carry the SBPF version. v2 is the newest active on devnet and mainnet; a bare `anchor build` makes v3.
    let version = u32::from_le_bytes(PROGRAM[48..52].try_into().unwrap());
    assert!(version <= 2, "built for SBPF v{version}: build with `pnpm programs` (SBPF v2)");
}

#[test]
fn carries_its_security_txt() {
    let text = String::from_utf8_lossy(PROGRAM);
    let start = text.find("=======BEGIN SECURITY.TXT V1=======").expect("security.txt is in the binary");
    let end = text.find("=======END SECURITY.TXT V1=======").expect("security.txt ends");
    let fields: Vec<&str> = text[start..end].split('\0').collect();
    for field in ["name", "project_url", "contacts", "policy", "source_code"] {
        let at = fields.iter().position(|f| f.ends_with(field)).unwrap_or_else(|| panic!("{field} is missing"));
        assert!(!fields[at + 1].is_empty(), "{field} is empty");
    }
}

#[test]
fn only_the_upgrade_authority_initializes_the_fee_config() {
    let mut t = Test::new();
    let settings = t.settings();
    let stranger = Keypair::new();
    let err = t.initialize_as(&stranger, settings).unwrap_err();
    assert_eq!(custom_error(&err), Some(FeeErrorCode::NotUpgradeAuthority as u32), "{:?}", err.meta.logs);

    let upgrade_authority = t.upgrade_authority.insecure_clone();
    t.initialize_as(&upgrade_authority, settings).unwrap();
    let config: FeeConfig = t.read(&fee_config_address());
    assert_eq!(
        (config.treasury, config.launch_key, config.fair_open_program),
        (settings.treasury, settings.launch_key, settings.fair_open_program)
    );

    // There is one FeeConfig; a second initialize cannot replace it. A new blockhash makes the retry a new
    // transaction: LiteSVM refuses an exact repeat as already processed, with no logs to say so.
    t.svm.expire_blockhash();
    let err = t.initialize_as(&upgrade_authority, t.settings()).unwrap_err();
    assert!(err.meta.logs.iter().any(|l| l.contains("already in use")), "{:?}", err.meta.logs);
}

#[test]
fn a_program_without_an_upgrade_authority_has_no_one_to_initialize_it() {
    // An immutable deploy has ProgramData with no authority: nobody passes the check, the deployer included.
    let mut t = Test::new();
    t.set_upgrade_authority(None);
    let upgrade_authority = t.upgrade_authority.insecure_clone();
    let err = t.initialize_as(&upgrade_authority, t.settings()).unwrap_err();
    assert_eq!(custom_error(&err), Some(FeeErrorCode::NotUpgradeAuthority as u32), "{:?}", err.meta.logs);
}

#[test]
fn refuses_a_setting_left_at_the_default_address() {
    let mut t = Test::new();
    let upgrade_authority = t.upgrade_authority.insecure_clone();
    let settings = FeeSettings { launch_key: Pubkey::default(), ..t.settings() };
    let err = t.initialize_as(&upgrade_authority, settings).unwrap_err();
    assert_eq!(custom_error(&err), Some(FeeErrorCode::MissingSetting as u32), "{:?}", err.meta.logs);
}

#[test]
fn the_upgrade_authority_rotates_the_launch_key_and_no_one_else_can() {
    let mut t = Test::initialized();
    let rotated = FeeSettings { launch_key: Pubkey::new_unique(), ..t.fee_settings };

    let stranger = Keypair::new();
    let err = t.update_as(&stranger, rotated).unwrap_err();
    assert_eq!(custom_error(&err), Some(FeeErrorCode::NotUpgradeAuthority as u32), "{:?}", err.meta.logs);

    let upgrade_authority = t.upgrade_authority.insecure_clone();
    t.update_as(&upgrade_authority, rotated).unwrap();
    let config: FeeConfig = t.read(&fee_config_address());
    assert_eq!(config.launch_key, rotated.launch_key);
    assert_eq!(config.treasury, t.fee_settings.treasury);
}

#[test]
fn registers_an_instant_launch_coin_with_the_launch_keys_signature() {
    let mut t = Test::initialized();
    let coin = t.dbc_coin(fee_claimer());
    let payer_before = t.svm.get_balance(&t.payer.pubkey()).unwrap();

    let launch_key = t.launch_key.insecure_clone();
    let done = t.register(&coin, &launch_key).unwrap();

    let record: CoinRecord = t.read(&coin_record_address(&coin.mint));
    assert_eq!((record.mint, record.pool), (coin.mint, coin.pool));
    assert_eq!(record.launch_mode, LaunchMode::Instant);
    assert_eq!(
        (record.fair_open_launch, record.pot_fee, record.window_claimed, record.earnings_recipient),
        (None, 0, false, None)
    );
    assert_eq!(record.registered_at, t.svm.get_sysvar::<anchor_lang::prelude::Clock>().unix_timestamp);

    // The payer, the creator in an Instant launch, pays the record's rent; the launch key pays nothing.
    let rent = t.svm.get_account(&coin_record_address(&coin.mint)).unwrap().lamports;
    assert_eq!(payer_before - t.svm.get_balance(&t.payer.pubkey()).unwrap(), rent + done.fee);
    assert_eq!(t.svm.get_balance(&t.launch_key.pubkey()), None);

    let event = registered_event(&done).expect("CoinRegistered is emitted through the event authority");
    assert_eq!(
        (event.mint, event.pool, event.config, event.creator),
        (coin.mint, coin.pool, coin.config, coin.creator)
    );
    assert_eq!(event.launch_mode, LaunchMode::Instant);
    println!(
        "register_coin: {} compute units, {} bytes of rent-paid data",
        done.compute_units_consumed,
        8 + CoinRecord::INIT_SPACE
    );
}

#[test]
fn refuses_a_coin_the_launch_key_did_not_sign() {
    let mut t = Test::initialized();
    let coin = t.dbc_coin(fee_claimer());
    let impostor = Keypair::new();
    let err = t.register(&coin, &impostor).unwrap_err();
    assert_eq!(custom_error(&err), Some(FeeErrorCode::NotTheLaunchKey as u32), "{:?}", err.meta.logs);
}

#[test]
fn refuses_a_pool_dbc_does_not_own() {
    let mut t = Test::initialized();
    let coin = t.dbc_coin(fee_claimer());
    let mut pool = t.svm.get_account(&coin.pool).unwrap();
    pool.owner = Pubkey::new_unique();
    t.svm.set_account(coin.pool, pool).unwrap();
    let launch_key = t.launch_key.insecure_clone();
    let err = t.register(&coin, &launch_key).unwrap_err();
    assert_eq!(custom_error(&err), Some(FeeErrorCode::NotADbcPool as u32), "{:?}", err.meta.logs);
}

#[test]
fn refuses_a_dbc_account_that_is_not_a_pool() {
    let mut t = Test::initialized();
    let coin = t.dbc_coin(fee_claimer());
    let mut pool = t.svm.get_account(&coin.pool).unwrap();
    pool.data[..8].copy_from_slice(&dbc::POOL_CONFIG_DISCRIMINATOR);
    t.svm.set_account(coin.pool, pool).unwrap();
    let launch_key = t.launch_key.insecure_clone();
    let err = t.register(&coin, &launch_key).unwrap_err();
    assert_eq!(custom_error(&err), Some(FeeErrorCode::NotADbcPool as u32), "{:?}", err.meta.logs);
}

#[test]
fn refuses_a_mint_or_config_that_is_not_the_pools() {
    let mut t = Test::initialized();
    let coin = t.dbc_coin(fee_claimer());
    let launch_key = t.launch_key.insecure_clone();

    let other_mint = DbcCoin { mint: Pubkey::new_unique(), ..coin };
    let err = t.register(&other_mint, &launch_key).unwrap_err();
    assert_eq!(custom_error(&err), Some(FeeErrorCode::PoolMintMismatch as u32), "{:?}", err.meta.logs);

    let other = t.dbc_coin(fee_claimer());
    let other_config = DbcCoin { config: other.config, ..coin };
    let err = t.register(&other_config, &launch_key).unwrap_err();
    assert_eq!(custom_error(&err), Some(FeeErrorCode::PoolConfigMismatch as u32), "{:?}", err.meta.logs);
}

#[test]
fn refuses_a_pool_whose_config_does_not_pay_the_fee_program() {
    // A config naming any other fee claimer is not Heat's, whoever made it and whatever else it copies.
    let mut t = Test::initialized();
    let coin = t.dbc_coin(Pubkey::new_unique());
    let launch_key = t.launch_key.insecure_clone();
    let err = t.register(&coin, &launch_key).unwrap_err();
    assert_eq!(custom_error(&err), Some(FeeErrorCode::NotAHeatConfig as u32), "{:?}", err.meta.logs);
}

#[test]
fn refuses_a_dbc_account_that_is_not_a_config() {
    let mut t = Test::initialized();
    let coin = t.dbc_coin(fee_claimer());
    let mut config = t.svm.get_account(&coin.config).unwrap();
    config.data[..8].copy_from_slice(&dbc::VIRTUAL_POOL_DISCRIMINATOR);
    t.svm.set_account(coin.config, config).unwrap();
    let launch_key = t.launch_key.insecure_clone();
    let err = t.register(&coin, &launch_key).unwrap_err();
    assert_eq!(custom_error(&err), Some(FeeErrorCode::NotADbcConfig as u32), "{:?}", err.meta.logs);
}

#[test]
fn registers_a_coin_once() {
    let mut t = Test::initialized();
    let coin = t.dbc_coin(fee_claimer());
    let launch_key = t.launch_key.insecure_clone();
    t.register(&coin, &launch_key).unwrap();
    t.svm.expire_blockhash();
    let err = t.register(&coin, &launch_key).unwrap_err();
    assert!(err.meta.logs.iter().any(|l| l.contains("already in use")), "{:?}", err.meta.logs);
}

#[test]
fn a_rotated_launch_key_takes_over_and_the_old_one_stops_working() {
    let mut t = Test::initialized();
    let rotated = Keypair::new();
    let upgrade_authority = t.upgrade_authority.insecure_clone();
    t.update_as(&upgrade_authority, FeeSettings { launch_key: rotated.pubkey(), ..t.fee_settings }).unwrap();

    let coin = t.dbc_coin(fee_claimer());
    let old = t.launch_key.insecure_clone();
    let err = t.register(&coin, &old).unwrap_err();
    assert_eq!(custom_error(&err), Some(FeeErrorCode::NotTheLaunchKey as u32), "{:?}", err.meta.logs);
    t.register(&coin, &rotated).unwrap();
}

/// The program's error codes, in declaration order from Anchor's 6000.
#[repr(u32)]
enum FeeErrorCode {
    NotUpgradeAuthority = 6000,
    MissingSetting,
    NotTheLaunchKey,
    NotADbcPool,
    NotADbcConfig,
    PoolConfigMismatch,
    PoolMintMismatch,
    NotAHeatConfig,
}

/// A pool and config written with DBC's layout and owner, as DBC would have left them.
#[derive(Clone, Copy)]
struct DbcCoin {
    mint: Pubkey,
    pool: Pubkey,
    config: Pubkey,
    creator: Pubkey,
}

struct Test {
    svm: LiteSVM,
    upgrade_authority: Keypair,
    launch_key: Keypair,
    payer: Keypair,
    fee_settings: FeeSettings,
}

impl Test {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(fee::id(), PROGRAM).unwrap();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
        let launch_key = Keypair::new();
        let fee_settings = FeeSettings {
            treasury: Pubkey::new_unique(),
            launch_key: launch_key.pubkey(),
            fair_open_program: Pubkey::new_unique(),
        };
        let mut t = Test { svm, upgrade_authority: Keypair::new(), launch_key, payer, fee_settings };
        t.set_upgrade_authority(Some(t.upgrade_authority.pubkey()));
        t
    }

    fn initialized() -> Self {
        let mut t = Test::new();
        let upgrade_authority = t.upgrade_authority.insecure_clone();
        t.initialize_as(&upgrade_authority, t.fee_settings).unwrap();
        t
    }

    fn settings(&self) -> FeeSettings {
        self.fee_settings
    }

    /// LiteSVM deploys with no upgrade authority; this rewrites the ProgramData header (the loader's bincode:
    /// a u32 variant tag 3, the deploy slot, then an optional authority) as a real deploy leaves it.
    fn set_upgrade_authority(&mut self, authority: Option<Pubkey>) {
        let address = program_data_address();
        let mut account = self.svm.get_account(&address).unwrap();
        assert_eq!(u32::from_le_bytes(account.data[..4].try_into().unwrap()), 3, "not a ProgramData account");
        match authority {
            Some(key) => {
                account.data[12] = 1;
                account.data[13..45].copy_from_slice(key.as_ref());
            }
            None => {
                account.data[12] = 0;
                account.data[13..45].fill(0);
            }
        }
        self.svm.set_account(address, account).unwrap();
    }

    fn initialize_as(
        &mut self,
        authority: &Keypair,
        settings: FeeSettings,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let accounts = fee::accounts::Initialize {
            fee_config: fee_config_address(),
            authority: authority.pubkey(),
            program_data: program_data_address(),
            payer: self.payer.pubkey(),
            system_program: system_program::ID,
            event_authority: event_authority(),
            program: fee::id(),
        };
        let ix = instruction(accounts.to_account_metas(None), fee::instruction::Initialize { settings }.data());
        let payer = self.payer.insecure_clone();
        send(&mut self.svm, &[ix], &payer, &[authority])
    }

    fn update_as(
        &mut self,
        authority: &Keypair,
        settings: FeeSettings,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let accounts = fee::accounts::UpdateFeeConfig {
            fee_config: fee_config_address(),
            authority: authority.pubkey(),
            program_data: program_data_address(),
            event_authority: event_authority(),
            program: fee::id(),
        };
        let ix = instruction(accounts.to_account_metas(None), fee::instruction::UpdateFeeConfig { settings }.data());
        let payer = self.payer.insecure_clone();
        send(&mut self.svm, &[ix], &payer, &[authority])
    }

    fn register(
        &mut self,
        coin: &DbcCoin,
        launch_key: &Keypair,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let accounts = fee::accounts::RegisterCoin {
            fee_config: fee_config_address(),
            launch_key: launch_key.pubkey(),
            payer: self.payer.pubkey(),
            mint: coin.mint,
            pool: coin.pool,
            config: coin.config,
            coin_record: coin_record_address(&coin.mint),
            system_program: system_program::ID,
            event_authority: event_authority(),
            program: fee::id(),
        };
        let ix = instruction(accounts.to_account_metas(None), fee::instruction::RegisterCoin {}.data());
        let payer = self.payer.insecure_clone();
        send(&mut self.svm, &[ix], &payer, &[launch_key])
    }

    /// A DBC config naming `fee_claimer`, and a pool on it trading a new mint.
    fn dbc_coin(&mut self, fee_claimer: Pubkey) -> DbcCoin {
        let coin = DbcCoin {
            mint: Pubkey::new_unique(),
            pool: Pubkey::new_unique(),
            config: Pubkey::new_unique(),
            creator: Pubkey::new_unique(),
        };
        let mut config = vec![0u8; 1048];
        config[..8].copy_from_slice(&dbc::POOL_CONFIG_DISCRIMINATOR);
        config[8..40].copy_from_slice(Pubkey::new_unique().as_ref());
        config[dbc::CONFIG_FEE_CLAIMER_OFFSET..dbc::CONFIG_FEE_CLAIMER_OFFSET + 32]
            .copy_from_slice(fee_claimer.as_ref());
        let mut pool = vec![0u8; 424];
        pool[..8].copy_from_slice(&dbc::VIRTUAL_POOL_DISCRIMINATOR);
        pool[dbc::POOL_CONFIG_OFFSET..dbc::POOL_CONFIG_OFFSET + 32].copy_from_slice(coin.config.as_ref());
        pool[dbc::POOL_CREATOR_OFFSET..dbc::POOL_CREATOR_OFFSET + 32].copy_from_slice(coin.creator.as_ref());
        pool[dbc::POOL_BASE_MINT_OFFSET..dbc::POOL_BASE_MINT_OFFSET + 32].copy_from_slice(coin.mint.as_ref());
        for (address, data) in [(coin.config, config), (coin.pool, pool)] {
            let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
            let account =
                solana_account::Account { lamports, data, owner: dbc::PROGRAM_ID, executable: false, rent_epoch: 0 };
            self.svm.set_account(address, account).unwrap();
        }
        coin
    }

    fn read<T: AccountDeserialize>(&self, address: &Pubkey) -> T {
        let account = self.svm.get_account(address).unwrap_or_else(|| panic!("no account at {address}"));
        T::try_deserialize(&mut account.data.as_slice()).unwrap()
    }
}

fn instruction(accounts: Vec<anchor_lang::solana_program::instruction::AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction { program_id: fee::id(), accounts, data }
}

fn send(
    svm: &mut LiteSVM,
    ixs: &[Instruction],
    payer: &Keypair,
    signers: &[&Keypair],
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &svm.latest_blockhash());
    let mut all: Vec<&Keypair> = vec![payer];
    all.extend(signers.iter().copied().filter(|s| s.pubkey() != payer.pubkey()));
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &all).unwrap();
    svm.send_transaction(tx)
}

/// The custom error a failed instruction returned, if any.
fn custom_error(err: &FailedTransactionMetadata) -> Option<u32> {
    let text = format!("{:?}", err.err);
    let at = text.find("Custom(")? + "Custom(".len();
    text[at..].split(')').next()?.parse().ok()
}

/// The `CoinRegistered` event a transaction emitted through Anchor's event CPI, if any.
fn registered_event(done: &TransactionMetadata) -> Option<CoinRegistered> {
    let tag = anchor_lang::event::EVENT_IX_TAG_LE;
    done.inner_instructions.iter().flatten().find_map(|inner| {
        let data = &inner.instruction.data;
        let body = data.strip_prefix(tag)?.strip_prefix(CoinRegistered::DISCRIMINATOR)?;
        CoinRegistered::try_from_slice(body).ok()
    })
}

fn fee_claimer() -> Pubkey {
    Pubkey::find_program_address(&[fee::FEE_CLAIMER_SEED], &fee::id()).0
}

fn fee_config_address() -> Pubkey {
    Pubkey::find_program_address(&[fee::FEE_CONFIG_SEED], &fee::id()).0
}

fn coin_record_address(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[fee::COIN_RECORD_SEED, mint.as_ref()], &fee::id()).0
}

fn event_authority() -> Pubkey {
    Pubkey::find_program_address(&[b"__event_authority"], &fee::id()).0
}

fn program_data_address() -> Pubkey {
    Pubkey::find_program_address(&[fee::id().as_ref()], &UPGRADEABLE_LOADER).0
}
