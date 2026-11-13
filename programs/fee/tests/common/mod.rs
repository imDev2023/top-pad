//! What the fee program's LiteSVM tests share: the built program (target/deploy/fee.so, from `pnpm programs`), a
//! FeeConfig, and DBC pools and configs written in DBC's layout. DBC itself never runs here, only our stand-in for its
//! partner fee claim (tests/dbc-stand-in, built by `pnpm programs`), so a claim moves real tokens out of a pool's vault;
//! the devnet tests check the same claims against the real DBC. Graduation's claims run against our stand-ins for DBC's
//! surplus and leftover and for DAMM v2's position fee claim (tests/damm-stand-in) in the same way. A market's quote is
//! an SPL Token mint, or an xStock: mainnet NVDAx's own Token-2022 mint account with every extension, its issuer powers
//! handed to the test's issuer, so a claim can be watched to wait while the issuer pauses it (ADR 0007).
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
const DAMM_STAND_IN: &[u8] = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/damm_stand_in.so"));

/// The upgradeable loader, which owns every ProgramData account.
pub const UPGRADEABLE_LOADER: Pubkey = anchor_lang::solana_program::bpf_loader_upgradeable::ID;
pub const TOKEN_PROGRAM: Pubkey = anchor_lang::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022: Pubkey = anchor_lang::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/// Mainnet NVDAx's mint account (`pnpm --filter @top-pad/chain quote-check`), which the Fair Open program's tests use too.
const NVDAX: &str = include_str!("../../../../packages/chain/src/fixtures/xstock-nvdax.json");
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
    FairOpenTaxShare,
    NotTheCreatorsAccount,
    NotTheTreasurysAccount,
    NotTheFeeClaimersAccount,
    CreatorRoleHeldByFeeClaimer,
    NotTheFairOpenProgram,
    NotAFairOpen,
    NotTheTaxShare,
    NotATokenAccount,
    UnexpectedBalance,
    NotADammV2Account,
}

/// A pool and config written with DBC's layout and owner, as DBC would have left them.
#[derive(Clone, Copy)]
pub struct DbcCoin {
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub config: Pubkey,
    pub creator: Pubkey,
}

/// What a market's quote is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuoteKind {
    /// A new SPL Token mint of 6 decimals, so the tests also show the program never assumes SOL (spec 5.1).
    Spl,
    /// An xStock: NVDAx's Token-2022 mint, 8 decimals, Permanent Delegate, Pausable, Scaled UI Amount and the rest.
    Xstock,
}

/// A coin's pool with its vaults as real token accounts, on a config whose quote is `quote_mint`: what a claim reads.
#[derive(Clone, Copy)]
pub struct Market {
    pub coin: DbcCoin,
    pub quote_mint: Pubkey,
    /// The quote's token program, which every claim names for it.
    pub quote_program: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
}

pub struct Test {
    pub svm: LiteSVM,
    pub upgrade_authority: Keypair,
    pub launch_key: Keypair,
    pub payer: Keypair,
    pub fee_settings: FeeSettings,
    /// Holds every issuer power of an xStock quote: it pauses and resumes it.
    pub issuer: Keypair,
}

impl Test {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(fee::id(), PROGRAM).unwrap();
        svm.add_program(dbc::PROGRAM_ID, DBC_STAND_IN).unwrap();
        svm.add_program(fee::damm_v2::PROGRAM_ID, DAMM_STAND_IN).unwrap();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
        let launch_key = Keypair::new();
        let fee_settings = FeeSettings {
            treasury: Pubkey::new_unique(),
            launch_key: launch_key.pubkey(),
            fair_open_program: Pubkey::new_unique(),
        };
        let mut t =
            Test { svm, upgrade_authority: Keypair::new(), launch_key, payer, fee_settings, issuer: Keypair::new() };
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

    /// A Heat config's pool, opened at `ACTIVATION`, with its two vaults and its quote: a new SPL Token mint of 6
    /// decimals.
    pub fn market(&mut self) -> Market {
        self.market_in(QuoteKind::Spl)
    }

    /// The same, its quote of `kind`: every account of the quote under the quote's own token program.
    pub fn market_in(&mut self, kind: QuoteKind) -> Market {
        let coin = self.dbc_coin(fee::FEE_CLAIMER);
        let quote_mint = Pubkey::new_unique();
        let base_vault = Pubkey::new_unique();
        self.set_token_account_data(coin.mint, mint_data(6));
        let authority = dbc::POOL_AUTHORITY;
        self.set_token_account_data(base_vault, token_account_data(&coin.mint, &authority, 800_000_000_000_000));
        let (quote_program, quote_vault) = match kind {
            QuoteKind::Spl => {
                let vault = Pubkey::new_unique();
                self.set_token_account_data(quote_mint, mint_data(6));
                self.set_token_account_data(vault, token_account_data(&quote_mint, &authority, 0));
                (TOKEN_PROGRAM, vault)
            }
            QuoteKind::Xstock => {
                let data = xstock_mint_data(&self.issuer.pubkey());
                self.set_program_account(quote_mint, data, TOKEN_2022);
                (TOKEN_2022, self.open_token_account(&authority, &quote_mint, &TOKEN_2022))
            }
        };
        let mut config = self.svm.get_account(&coin.config).unwrap();
        put(&mut config.data, 8, quote_mint.as_ref());
        self.svm.set_account(coin.config, config).unwrap();
        self.edit_pool(&coin.pool, |pool| {
            put(pool, POOL_BASE_VAULT_OFFSET, base_vault.as_ref());
            put(pool, POOL_QUOTE_VAULT_OFFSET, quote_vault.as_ref());
            put(pool, dbc::POOL_ACTIVATION_POINT_OFFSET, &(ACTIVATION as u64).to_le_bytes());
        });
        Market { coin, quote_mint, quote_program, base_vault, quote_vault }
    }

    /// `owner`'s associated account of `mint` under `program`, opened empty by the associated token program, which
    /// gives a Token-2022 account every extension its mint asks of it.
    pub fn open_token_account(&mut self, owner: &Pubkey, mint: &Pubkey, program: &Pubkey) -> Pubkey {
        let address = associated_token_address_in(owner, mint, program);
        let create = Instruction {
            program_id: fee::ASSOCIATED_TOKEN_PROGRAM,
            accounts: vec![
                AccountMeta::new(self.payer.pubkey(), true),
                AccountMeta::new(address, false),
                AccountMeta::new_readonly(*owner, false),
                AccountMeta::new_readonly(*mint, false),
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(*program, false),
            ],
            data: vec![1],
        };
        self.send(&[create], &[]).unwrap();
        address
    }

    /// The issuer pauses an xStock quote (Token-2022's `Pausable`: every transfer of it fails), or resumes it.
    pub fn pause_quote(&mut self, market: &Market, paused: bool) {
        assert_eq!(market.quote_program, TOKEN_2022, "only an xStock can be paused");
        let ix = Instruction {
            program_id: TOKEN_2022,
            accounts: vec![
                AccountMeta::new(market.quote_mint, false),
                AccountMeta::new_readonly(self.issuer.pubkey(), true),
            ],
            data: vec![44, if paused { 1 } else { 2 }],
        };
        let issuer = self.issuer.insecure_clone();
        self.send(&[ix], &[&issuer]).unwrap();
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
        let address = associated_token_address_in(owner, &market.quote_mint, &market.quote_program);
        if self.svm.get_account(&address).is_none() {
            if market.quote_program == TOKEN_PROGRAM {
                self.set_token_account_data(address, token_account_data(&market.quote_mint, owner, 0));
            } else {
                self.open_token_account(owner, &market.quote_mint, &market.quote_program);
            }
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

    pub fn edit_pool(&mut self, pool: &Pubkey, edit: impl FnOnce(&mut Vec<u8>)) {
        let mut account = self.svm.get_account(pool).unwrap();
        edit(&mut account.data);
        self.svm.set_account(*pool, account).unwrap();
    }

    fn set_dbc_account(&mut self, address: Pubkey, data: Vec<u8>) {
        self.set_program_account(address, data, dbc::PROGRAM_ID);
    }

    /// An account `owner` holds, with `data`, rent-exempt.
    pub fn set_program_account(&mut self, address: Pubkey, data: Vec<u8>, owner: Pubkey) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        let account = solana_account::Account { lamports, data, owner, executable: false, rent_epoch: 0 };
        self.svm.set_account(address, account).unwrap();
    }

    pub fn set_token_account_data(&mut self, address: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        let account =
            solana_account::Account { lamports, data, owner: TOKEN_PROGRAM, executable: false, rent_epoch: 0 };
        self.svm.set_account(address, account).unwrap();
    }
}

/// Where DBC 0.2.2 keeps a pool's vaults; only the tests write them, since the fee program never reads them.
const POOL_BASE_VAULT_OFFSET: usize = 168;
const POOL_QUOTE_VAULT_OFFSET: usize = 200;

pub fn put(data: &mut [u8], offset: usize, bytes: &[u8]) {
    data[offset..offset + bytes.len()].copy_from_slice(bytes);
}

/// An initialized SPL mint with no authorities.
pub fn mint_data(decimals: u8) -> Vec<u8> {
    let mut data = vec![0u8; 82];
    data[44] = decimals;
    data[45] = 1;
    data
}

/// An initialized SPL token account, with no delegate and no close authority.
pub fn token_account_data(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
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
    associated_token_address_in(owner, mint, &TOKEN_PROGRAM)
}

pub fn associated_token_address_in(owner: &Pubkey, mint: &Pubkey, program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), program.as_ref(), mint.as_ref()], &fee::ASSOCIATED_TOKEN_PROGRAM).0
}

/// Token-2022's extensions on NVDAx whose first 32 bytes are an authority the issuer holds: the metadata pointer's,
/// the permanent delegate, the confidential transfer mint's, the transfer hook's, the token metadata's update
/// authority, the scaled UI amount's and the pause authority.
const ISSUER_EXTENSIONS: [u16; 7] = [18, 12, 4, 14, 19, 25, 26];

/// Mainnet NVDAx's mint account, every extension an xStock carries, with no supply and every authority handed to
/// `issuer`.
pub fn xstock_mint_data(issuer: &Pubkey) -> Vec<u8> {
    let fixture: serde_json::Value = serde_json::from_str(NVDAX).unwrap();
    let mut data = base64_decode(fixture["data"].as_str().unwrap());
    data[4..36].copy_from_slice(issuer.as_ref());
    data[36..44].fill(0);
    data[50..82].copy_from_slice(issuer.as_ref());
    let mut at = 166;
    while at + 4 <= data.len() {
        let kind = u16::from_le_bytes([data[at], data[at + 1]]);
        let len = u16::from_le_bytes([data[at + 2], data[at + 3]]) as usize;
        if kind == 0 {
            break;
        }
        if ISSUER_EXTENSIONS.contains(&kind) {
            data[at + 4..at + 36].copy_from_slice(issuer.as_ref());
        }
        at += 4 + len;
    }
    data
}

/// Standard base64, so the tests need no crate for the fixture.
fn base64_decode(text: &str) -> Vec<u8> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => panic!("not base64: {c}"),
    };
    let digits: Vec<u8> = text.bytes().filter(|&c| c != b'=').map(value).collect();
    let mut out = vec![];
    for chunk in digits.chunks(4) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, &d)| n | (d as u32) << (18 - 6 * i));
        out.extend_from_slice(&n.to_be_bytes()[1..chunk.len()]);
    }
    out
}
