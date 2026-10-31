//! What the fee program's LiteSVM tests share: the built program (target/deploy/fee.so, from `pnpm programs`), a
//! FeeConfig, and DBC pools and configs written in DBC's layout. DBC itself never runs here, only our stand-in for its
//! partner fee claim (tests/dbc-stand-in, built by `pnpm programs`), so a claim moves real tokens out of a pool's vault;
//! the devnet tests check the same claims against the real DBC.
// LiteSVM's failed-transaction metadata is large by design; the helpers here only hand it back to the test.
#![allow(clippy::result_large_err, dead_code)]
use {
    anchor_lang::{
        prelude::Clock,
        solana_program::{
            instruction::{AccountMeta, Instruction},
            pubkey::Pubkey,
            system_program,
        },
        AccountDeserialize, AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas,
    },
    fee::{dbc, FeeSettings},
    litesvm::{
        types::{FailedTransactionMetadata, TransactionMetadata},
        LiteSVM,
    },
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

pub const PROGRAM: &[u8] = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/fee.so"));
const DBC_STAND_IN: &[u8] = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/dbc_stand_in.so"));

/// The upgradeable loader, which owns every ProgramData account.
pub const UPGRADEABLE_LOADER: Pubkey = anchor_lang::solana_program::bpf_loader_upgradeable::ID;
pub const TOKEN_PROGRAM: Pubkey = anchor_lang::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/// When the tests' pools open, as a Unix timestamp.
pub const ACTIVATION: i64 = 1_800_000_000;

/// The program's error codes, in declaration order from Anchor's 6000: clients match on these numbers, so a variant
/// inserted anywhere but the end would show up here.
#[repr(u32)]
pub enum FeeErrorCode {
    NotUpgradeAuthority = 6000,
    MissingSetting,
    NotTheLaunchKey,
    NotADbcPool,
    NotADbcConfig,
    PoolConfigMismatch,
    PoolMintMismatch,
    NotAHeatConfig,
    PoolMismatch,
    TaxWindowOpen,
    WindowAlreadyClaimed,
    WindowNotClaimed,
    TaxShareNotBuilt,
    NotTheCreatorsAccount,
    NotTheTreasurysAccount,
    NotTheFeeClaimersAccount,
    CreatorRoleHeldByFeeClaimer,
    NotTheFairOpenProgram,
}

/// A pool and config written with DBC's layout and owner, as DBC would have left them.
#[derive(Clone, Copy)]
pub struct DbcCoin {
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub config: Pubkey,
    pub creator: Pubkey,
}

/// A coin's pool with its vaults as real token accounts, on a config whose quote is `quote_mint`: what a claim reads.
#[derive(Clone, Copy)]
pub struct Market {
    pub coin: DbcCoin,
    pub quote_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
}

pub struct Test {
    pub svm: LiteSVM,
    pub upgrade_authority: Keypair,
    pub launch_key: Keypair,
    pub payer: Keypair,
    pub fee_settings: FeeSettings,
}

impl Test {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(fee::id(), PROGRAM).unwrap();
        svm.add_program(dbc::PROGRAM_ID, DBC_STAND_IN).unwrap();
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

    pub fn initialized() -> Self {
        let mut t = Test::new();
        let upgrade_authority = t.upgrade_authority.insecure_clone();
        t.initialize_as(&upgrade_authority, t.fee_settings).unwrap();
        t
    }

    pub fn settings(&self) -> FeeSettings {
        self.fee_settings
    }

    /// LiteSVM deploys with no upgrade authority; this rewrites the ProgramData header (the loader's bincode:
    /// a u32 variant tag 3, the deploy slot, then an optional authority) as a real deploy leaves it.
    pub fn set_upgrade_authority(&mut self, authority: Option<Pubkey>) {
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

    pub fn initialize_as(
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
        self.send(&[ix], &[authority])
    }

    pub fn update_as(
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
        self.send(&[ix], &[authority])
    }

    pub fn register(
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
        self.send(&[ix], &[launch_key])
    }

    /// `register_fair_open_coin`, signed by `registrar`: only the Fair Open program's coin registrar may, by CPI from its
    /// open, which the Fair Open program's own tests run.
    pub fn register_fair_open(
        &mut self,
        coin: &DbcCoin,
        registrar: &Keypair,
        launch: Pubkey,
        pot_fee: u64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let accounts = fee::accounts::RegisterFairOpenCoin {
            fee_config: fee_config_address(),
            registrar: registrar.pubkey(),
            payer: self.payer.pubkey(),
            mint: coin.mint,
            pool: coin.pool,
            config: coin.config,
            coin_record: coin_record_address(&coin.mint),
            system_program: system_program::ID,
            event_authority: event_authority(),
            program: fee::id(),
        };
        let data = fee::instruction::RegisterFairOpenCoin { launch, pot_fee }.data();
        let ix = instruction(accounts.to_account_metas(None), data);
        self.send(&[ix], &[registrar])
    }

    /// A DBC config naming `fee_claimer`, and a pool on it trading a new mint.
    pub fn dbc_coin(&mut self, fee_claimer: Pubkey) -> DbcCoin {
        let coin = DbcCoin {
            mint: Pubkey::new_unique(),
            pool: Pubkey::new_unique(),
            config: Pubkey::new_unique(),
            creator: Pubkey::new_unique(),
        };
        let mut config = vec![0u8; 1048];
        config[..8].copy_from_slice(&dbc::POOL_CONFIG_DISCRIMINATOR);
        config[8..40].copy_from_slice(Pubkey::new_unique().as_ref());
        put(&mut config, dbc::CONFIG_FEE_CLAIMER_OFFSET, fee_claimer.as_ref());
        let mut pool = vec![0u8; 424];
        pool[..8].copy_from_slice(&dbc::VIRTUAL_POOL_DISCRIMINATOR);
        put(&mut pool, dbc::POOL_CONFIG_OFFSET, coin.config.as_ref());
        put(&mut pool, dbc::POOL_CREATOR_OFFSET, coin.creator.as_ref());
        put(&mut pool, dbc::POOL_BASE_MINT_OFFSET, coin.mint.as_ref());
        self.set_dbc_account(coin.config, config);
        self.set_dbc_account(coin.pool, pool);
        coin
    }

    /// A Heat config's pool, opened at `ACTIVATION`, with its two vaults and its quote: a new mint of 6 decimals, so the
    /// tests also show the program never assumes SOL (spec 5.1).
    pub fn market(&mut self) -> Market {
        let coin = self.dbc_coin(fee::FEE_CLAIMER);
        let quote_mint = Pubkey::new_unique();
        let (base_vault, quote_vault) = (Pubkey::new_unique(), Pubkey::new_unique());
        self.set_token_account_data(quote_mint, mint_data(6));
        self.set_token_account_data(coin.mint, mint_data(6));
        let authority = dbc::POOL_AUTHORITY;
        self.set_token_account_data(base_vault, token_account_data(&coin.mint, &authority, 800_000_000_000_000));
        self.set_token_account_data(quote_vault, token_account_data(&quote_mint, &authority, 0));
        let mut config = self.svm.get_account(&coin.config).unwrap();
        put(&mut config.data, 8, quote_mint.as_ref());
        self.svm.set_account(coin.config, config).unwrap();
        self.edit_pool(&coin.pool, |pool| {
            put(pool, POOL_BASE_VAULT_OFFSET, base_vault.as_ref());
            put(pool, POOL_QUOTE_VAULT_OFFSET, quote_vault.as_ref());
            put(pool, dbc::POOL_ACTIVATION_POINT_OFFSET, &(ACTIVATION as u64).to_le_bytes());
        });
        Market { coin, quote_mint, base_vault, quote_vault }
    }

    /// Trades on a pool as DBC records them: the partner's quote fee grows, and its quote vault holds the fee.
    pub fn accrue(&mut self, market: &Market, partner_fee: u64) {
        let before = self.partner_quote_fee(market);
        self.edit_pool(&market.coin.pool, |pool| {
            put(pool, dbc::POOL_PARTNER_QUOTE_FEE_OFFSET, &(before + partner_fee).to_le_bytes())
        });
        let mut vault = self.svm.get_account(&market.quote_vault).unwrap();
        let held = u64::from_le_bytes(vault.data[64..72].try_into().unwrap());
        vault.data[64..72].copy_from_slice(&(held + partner_fee).to_le_bytes());
        self.svm.set_account(market.quote_vault, vault).unwrap();
    }

    /// `transfer_pool_creator`, as DBC leaves the pool after it: the creator role is someone else's.
    pub fn transfer_pool_creator(&mut self, market: &mut Market, new_creator: Pubkey) {
        self.edit_pool(&market.coin.pool, |pool| put(pool, dbc::POOL_CREATOR_OFFSET, new_creator.as_ref()));
        market.coin.creator = new_creator;
    }

    pub fn partner_quote_fee(&self, market: &Market) -> u64 {
        let pool = self.svm.get_account(&market.coin.pool).unwrap();
        dbc::u64_at(&pool.data, dbc::POOL_PARTNER_QUOTE_FEE_OFFSET).unwrap()
    }

    /// The clock `seconds` after the tests' pools opened.
    pub fn at(&mut self, seconds: i64) {
        let clock = Clock { unix_timestamp: ACTIVATION + seconds, ..self.svm.get_sysvar::<Clock>() };
        self.svm.set_sysvar(&clock);
        // A new blockhash too, so the same transaction sent again is a new one.
        self.svm.expire_blockhash();
    }

    /// `owner`'s associated account for the market's quote, opened empty if it is not there yet.
    pub fn quote_account(&mut self, market: &Market, owner: &Pubkey) -> Pubkey {
        let address = associated_token_address(owner, &market.quote_mint);
        if self.svm.get_account(&address).is_none() {
            self.set_token_account_data(address, token_account_data(&market.quote_mint, owner, 0));
        }
        address
    }

    pub fn token_balance(&self, account: &Pubkey) -> u64 {
        self.svm.get_account(account).map(|a| u64::from_le_bytes(a.data[64..72].try_into().unwrap())).unwrap_or(0)
    }

    pub fn read<T: AccountDeserialize>(&self, address: &Pubkey) -> T {
        let account = self.svm.get_account(address).unwrap_or_else(|| panic!("no account at {address}"));
        T::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    pub fn send(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let payer = self.payer.insecure_clone();
        send(&mut self.svm, ixs, &payer, signers)
    }

    fn edit_pool(&mut self, pool: &Pubkey, edit: impl FnOnce(&mut Vec<u8>)) {
        let mut account = self.svm.get_account(pool).unwrap();
        edit(&mut account.data);
        self.svm.set_account(*pool, account).unwrap();
    }

    fn set_dbc_account(&mut self, address: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        let account =
            solana_account::Account { lamports, data, owner: dbc::PROGRAM_ID, executable: false, rent_epoch: 0 };
        self.svm.set_account(address, account).unwrap();
    }

    fn set_token_account_data(&mut self, address: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        let account =
            solana_account::Account { lamports, data, owner: TOKEN_PROGRAM, executable: false, rent_epoch: 0 };
        self.svm.set_account(address, account).unwrap();
    }
}

/// Where DBC 0.2.2 keeps a pool's vaults; only the tests write them, since the fee program never reads them.
const POOL_BASE_VAULT_OFFSET: usize = 168;
const POOL_QUOTE_VAULT_OFFSET: usize = 200;

fn put(data: &mut [u8], offset: usize, bytes: &[u8]) {
    data[offset..offset + bytes.len()].copy_from_slice(bytes);
}

/// An initialized SPL mint with no authorities.
fn mint_data(decimals: u8) -> Vec<u8> {
    let mut data = vec![0u8; 82];
    data[44] = decimals;
    data[45] = 1;
    data
}

/// An initialized SPL token account, with no delegate and no close authority.
fn token_account_data(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut data = vec![0u8; 165];
    put(&mut data, 0, mint.as_ref());
    put(&mut data, 32, owner.as_ref());
    put(&mut data, 64, &amount.to_le_bytes());
    data[108] = 1;
    data
}

pub fn instruction(accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction { program_id: fee::id(), accounts, data }
}

pub fn send(
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
pub fn custom_error(err: &FailedTransactionMetadata) -> Option<u32> {
    let text = format!("{:?}", err.err);
    let at = text.find("Custom(")? + "Custom(".len();
    text[at..].split(')').next()?.parse().ok()
}

/// The events of type `E` a transaction emitted through Anchor's event CPI, in order.
pub fn events<E: AnchorDeserialize + Discriminator>(done: &TransactionMetadata) -> Vec<E> {
    let tag = anchor_lang::event::EVENT_IX_TAG_LE;
    done.inner_instructions
        .iter()
        .flatten()
        .filter_map(|inner| {
            let data = &inner.instruction.data;
            let body = data.strip_prefix(tag)?.strip_prefix(E::DISCRIMINATOR)?;
            E::try_from_slice(body).ok()
        })
        .collect()
}

pub fn fee_claimer() -> Pubkey {
    Pubkey::find_program_address(&[fee::FEE_CLAIMER_SEED], &fee::id()).0
}

pub fn fee_config_address() -> Pubkey {
    Pubkey::find_program_address(&[fee::FEE_CONFIG_SEED], &fee::id()).0
}

pub fn coin_record_address(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[fee::COIN_RECORD_SEED, mint.as_ref()], &fee::id()).0
}

pub fn window_claim_address(pool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[fee::WINDOW_CLAIM_SEED, pool.as_ref()], &fee::id()).0
}

pub fn event_authority() -> Pubkey {
    Pubkey::find_program_address(&[b"__event_authority"], &fee::id()).0
}

pub fn program_data_address() -> Pubkey {
    Pubkey::find_program_address(&[fee::id().as_ref()], &UPGRADEABLE_LOADER).0
}

pub fn associated_token_address(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), TOKEN_PROGRAM.as_ref(), mint.as_ref()],
        &fee::ASSOCIATED_TOKEN_PROGRAM,
    )
    .0
}
