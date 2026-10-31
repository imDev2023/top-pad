//! A stand-in for Meteora's DBC in our programs' LiteSVM tests, never deployed, at DBC's address. For the fee program:
//! DBC 0.2.2's partner fee claim, `claim_trading_fee`, as its source does it (`instructions/partner/
//! ix_claim_partner_trading_fee.rs` and `VirtualPool::claim_partner_trading_fee`), over pools and configs the tests write
//! in DBC's layout. For the Fair Open program's open: a pool's creation, `initialize_virtual_pool_with_spl_token`, making
//! the coin, the pool and its vaults where DBC makes them and charging the payer what Metaplex's metadata costs it, and
//! a buy, `swap2`, at a flat made-up price, paying the ending fee if it is the pool's first swap and passes the
//! instructions sysvar, and the 99% cliff otherwise, the partner's share of the fee accruing in the pool as DBC accrues
//! it. Meteora's own binary is never loaded (spec 5.1); the devnet tests run our programs against the real DBC.
use anchor_lang::{
    prelude::Pubkey,
    solana_program::{
        account_info::AccountInfo,
        entrypoint::ProgramResult,
        instruction::{AccountMeta, Instruction},
        msg,
        program::invoke_signed,
        program_error::ProgramError,
    },
};

anchor_lang::declare_id!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");

#[cfg(not(feature = "no-entrypoint"))]
anchor_lang::solana_program::entrypoint!(process);

pub const CLAIM_TRADING_FEE_DISCRIMINATOR: [u8; 8] = [8, 236, 89, 49, 152, 125, 177, 81];
pub const VIRTUAL_POOL_DISCRIMINATOR: [u8; 8] = [213, 224, 5, 209, 98, 69, 119, 92];
pub const POOL_CONFIG_DISCRIMINATOR: [u8; 8] = [26, 108, 14, 123, 116, 230, 129, 43];
pub const POOL_AUTHORITY_SEED: &[u8] = b"pool_authority";

/// `PoolConfig`'s quote mint and fee claimer.
pub const CONFIG_QUOTE_MINT: usize = 8;
pub const CONFIG_FEE_CLAIMER: usize = 40;
/// `VirtualPool`'s fields the claim reads or writes.
pub const POOL_CONFIG: usize = 72;
pub const POOL_BASE_MINT: usize = 136;
pub const POOL_BASE_VAULT: usize = 168;
pub const POOL_QUOTE_VAULT: usize = 200;
pub const POOL_PARTNER_BASE_FEE: usize = 264;
pub const POOL_PARTNER_QUOTE_FEE: usize = 272;

/// An SPL mint's decimals.
const MINT_DECIMALS: usize = 44;
/// SPL Token's `TransferChecked`.
const TRANSFER_CHECKED: u8 = 12;

pub const INITIALIZE_POOL_DISCRIMINATOR: [u8; 8] = [140, 85, 215, 176, 102, 54, 104, 79];
pub const SWAP2_DISCRIMINATOR: [u8; 8] = [65, 75, 63, 76, 235, 91, 91, 136];
pub const POOL_SEED: &[u8] = b"pool";
pub const TOKEN_VAULT_SEED: &[u8] = b"token_vault";
/// `VirtualPool`'s size, and its fields the creation and the swap write.
pub const POOL_LEN: usize = 8 + 416;
pub const POOL_CREATOR: usize = 104;
pub const POOL_QUOTE_RESERVE: usize = 240;
pub const POOL_PROTOCOL_QUOTE_FEE: usize = 256;
pub const POOL_ACTIVATION_POINT: usize = 296;
pub const POOL_HAS_SWAP: usize = 370;
/// Every coin's supply, all of it minted to the pool's coin vault: 1,000,000,000 coins of 6 decimals (spec 3.1).
pub const SUPPLY: u64 = 1_000_000_000_000_000;
/// The made-up price: raw coin units per lamport, in thousandths.
pub const COINS_PER_LAMPORT_MILLI: u128 = 123_456_789;
/// The fee schedule's two ends on Heat's configs (spec 3.2), out of 1,000,000,000: the cliff and the ending fee.
pub const CLIFF_FEE: u128 = 989_999_960;
pub const ENDING_FEE: u128 = 12_500_000;
pub const FEE_DENOMINATOR: u128 = 1_000_000_000;
/// What Metaplex's metadata costs DBC's payer, measured on devnet (2026-10-31): a 607-byte account and a 0.01 SOL fee.
pub const METADATA_LEN: usize = 607;
pub const METAPLEX_CREATE_FEE: u64 = 10_000_000;

/// SPL Token and the system program, and what the creation asks of them.
const TOKEN_PROGRAM: Pubkey = anchor_lang::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM_PROGRAM: Pubkey = anchor_lang::pubkey!("11111111111111111111111111111111");
const INSTRUCTIONS_SYSVAR: Pubkey = anchor_lang::pubkey!("Sysvar1nstructions1111111111111111111111111");
const MINT_LEN: u64 = 82;
const TOKEN_ACCOUNT_LEN: u64 = 165;

pub fn process(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match data.split_at_checked(8) {
        Some((discriminator, args)) if discriminator == CLAIM_TRADING_FEE_DISCRIMINATOR => {
            claim_trading_fee(accounts, args)
        }
        Some((discriminator, _)) if discriminator == INITIALIZE_POOL_DISCRIMINATOR => initialize_pool(accounts),
        Some((discriminator, args)) if discriminator == SWAP2_DISCRIMINATOR => swap2(accounts, args),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn put(data: &mut [u8], offset: usize, bytes: &[u8]) {
    data[offset..offset + bytes.len()].copy_from_slice(bytes);
}

fn rent(len: u64) -> Result<u64, ProgramError> {
    use anchor_lang::prelude::SolanaSysvar;
    Ok(anchor_lang::prelude::Rent::get()?.minimum_balance(len as usize))
}

fn system<'info>(instruction: Instruction, infos: &[AccountInfo<'info>], signer: &[&[u8]]) -> ProgramResult {
    let signers: &[&[&[u8]]] = if signer.is_empty() { &[] } else { &[signer] };
    invoke_signed(&instruction, infos, signers)
}

/// The system program's `CreateAccount` (0): `space` bytes owned by `owner`, funded by `payer`.
fn create_account<'info>(
    payer: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    space: u64,
    owner: &Pubkey,
    signer: &[&[u8]],
) -> ProgramResult {
    let mut data = vec![0, 0, 0, 0];
    data.extend_from_slice(&rent(space)?.to_le_bytes());
    data.extend_from_slice(&space.to_le_bytes());
    data.extend_from_slice(owner.as_ref());
    let instruction = Instruction {
        program_id: SYSTEM_PROGRAM,
        accounts: vec![AccountMeta::new(*payer.key, true), AccountMeta::new(*account.key, true)],
        data,
    };
    system(instruction, &[payer.clone(), account.clone()], signer)
}

/// The system program's `Transfer` (2).
fn transfer_lamports<'info>(from: &AccountInfo<'info>, to: &AccountInfo<'info>, lamports: u64) -> ProgramResult {
    let mut data = vec![2, 0, 0, 0];
    data.extend_from_slice(&lamports.to_le_bytes());
    let instruction = Instruction {
        program_id: SYSTEM_PROGRAM,
        accounts: vec![AccountMeta::new(*from.key, true), AccountMeta::new(*to.key, false)],
        data,
    };
    system(instruction, &[from.clone(), to.clone()], &[])
}

fn token<'info>(
    data: Vec<u8>,
    metas: Vec<AccountMeta>,
    infos: &[AccountInfo<'info>],
    signer: &[&[u8]],
) -> ProgramResult {
    system(Instruction { program_id: TOKEN_PROGRAM, accounts: metas, data }, infos, signer)
}

/// `initialize_virtual_pool_with_spl_token`, as far as an open needs it: the coin's mint with DBC's pool authority as
/// its mint authority, the pool at its PDA naming its config, creator, coin and vaults, both vaults at their PDAs, the
/// whole supply in the coin vault, and the payer charged for all of it, the metadata's rent and Metaplex's fee included.
fn initialize_pool(accounts: &[AccountInfo]) -> ProgramResult {
    let [config, pool_authority, creator, base_mint, quote_mint, pool, base_vault, quote_vault, mint_metadata, _metadata_program, payer, _token_quote_program, _token_program, _system_program, _event_authority, _program] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    require(config.owner == &ID, "the config is not DBC's")?;
    let config_data = config.try_borrow_data()?;
    require(config_data.starts_with(&POOL_CONFIG_DISCRIMINATOR), "not a config")?;
    require(*quote_mint.key == address(&config_data, CONFIG_QUOTE_MINT)?, "not the config's quote mint")?;
    drop(config_data);
    require(creator.is_signer && base_mint.is_signer && payer.is_signer, "a signature is missing")?;
    let (authority, authority_bump) = Pubkey::find_program_address(&[POOL_AUTHORITY_SEED], &ID);
    require(*pool_authority.key == authority, "not the pool authority")?;
    let (larger, smaller) =
        if base_mint.key > quote_mint.key { (base_mint.key, quote_mint.key) } else { (quote_mint.key, base_mint.key) };
    let pool_seeds: &[&[u8]] = &[POOL_SEED, config.key.as_ref(), larger.as_ref(), smaller.as_ref()];
    let (pool_address, pool_bump) = Pubkey::find_program_address(pool_seeds, &ID);
    require(*pool.key == pool_address, "not the pool's address")?;

    // The coin, with the pool authority minting it.
    create_account(payer, base_mint, MINT_LEN, &TOKEN_PROGRAM, &[])?;
    let mut data = vec![20, 6];
    data.extend_from_slice(authority.as_ref());
    data.push(0);
    token(data, vec![AccountMeta::new(*base_mint.key, false)], std::slice::from_ref(base_mint), &[])?;

    // The pool.
    let bump = [pool_bump];
    let signer = [pool_seeds, &[&bump[..]]].concat();
    create_account(payer, pool, POOL_LEN as u64, &ID, &signer)?;
    // The vaults, both owned by the pool authority.
    for (vault, mint) in [(base_vault, base_mint), (quote_vault, quote_mint)] {
        let seeds: &[&[u8]] = &[TOKEN_VAULT_SEED, mint.key.as_ref(), pool.key.as_ref()];
        let (address, bump) = Pubkey::find_program_address(seeds, &ID);
        require(*vault.key == address, "not the vault's address")?;
        let bump = [bump];
        let signer = [seeds, &[&bump[..]]].concat();
        create_account(payer, vault, TOKEN_ACCOUNT_LEN, &TOKEN_PROGRAM, &signer)?;
        let mut data = vec![18];
        data.extend_from_slice(authority.as_ref());
        let metas = vec![AccountMeta::new(*vault.key, false), AccountMeta::new_readonly(*mint.key, false)];
        token(data, metas, &[vault.clone(), mint.clone()], &[])?;
    }
    // What Metaplex's metadata costs the payer.
    transfer_lamports(payer, mint_metadata, rent(METADATA_LEN as u64)? + METAPLEX_CREATE_FEE)?;
    // The supply, all in the coin vault.
    let mut data = vec![7];
    data.extend_from_slice(&SUPPLY.to_le_bytes());
    let metas = vec![
        AccountMeta::new(*base_mint.key, false),
        AccountMeta::new(*base_vault.key, false),
        AccountMeta::new_readonly(authority, true),
    ];
    token(
        data,
        metas,
        &[base_mint.clone(), base_vault.clone(), pool_authority.clone()],
        &[POOL_AUTHORITY_SEED, &[authority_bump]],
    )?;

    use anchor_lang::prelude::SolanaSysvar;
    let now = anchor_lang::prelude::Clock::get()?.unix_timestamp as u64;
    let mut data = pool.try_borrow_mut_data()?;
    put(&mut data, 0, &VIRTUAL_POOL_DISCRIMINATOR);
    put(&mut data, POOL_CONFIG, config.key.as_ref());
    put(&mut data, POOL_CREATOR, creator.key.as_ref());
    put(&mut data, POOL_BASE_MINT, base_mint.key.as_ref());
    put(&mut data, POOL_BASE_VAULT, base_vault.key.as_ref());
    put(&mut data, POOL_QUOTE_VAULT, quote_vault.key.as_ref());
    put(&mut data, POOL_ACTIVATION_POINT, &now.to_le_bytes());
    Ok(())
}

/// `swap2` for a buy, exact in, at the made-up price: the pool's first swap pays the ending fee if it passes the
/// instructions sysvar and no referral, as DBC's first-swap discount requires, and every other buy the cliff. A fifth of
/// the fee is the protocol's and the rest the partner's (Heat's configs give the creator none), accruing in the pool.
fn swap2(accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let [pool_authority, config, pool, input, output, base_vault, quote_vault, base_mint, quote_mint, payer, token_base_program, token_quote_program, referral, _event_authority, program, rest @ ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let amount_in = number(args, 0)?;
    require(args.get(16) == Some(&0), "only exact in")?;
    require(payer.is_signer, "the payer did not sign")?;
    let (authority, authority_bump) = Pubkey::find_program_address(&[POOL_AUTHORITY_SEED], &ID);
    require(*pool_authority.key == authority, "not the pool authority")?;
    require(pool.owner == &ID, "the pool is not DBC's")?;
    let with_sysvar = rest.first().is_some_and(|a| *a.key == INSTRUCTIONS_SYSVAR);
    let no_referral = referral.key == program.key;

    let (fee, coins) = {
        let mut data = pool.try_borrow_mut_data()?;
        require(data.starts_with(&VIRTUAL_POOL_DISCRIMINATOR), "not a pool")?;
        require(address(&data, POOL_CONFIG)? == *config.key, "the pool's config")?;
        require(address(&data, POOL_BASE_MINT)? == *base_mint.key, "the pool's base mint")?;
        require(address(&data, POOL_BASE_VAULT)? == *base_vault.key, "the pool's base vault")?;
        require(address(&data, POOL_QUOTE_VAULT)? == *quote_vault.key, "the pool's quote vault")?;
        let first = data[POOL_HAS_SWAP] == 0 && with_sysvar && no_referral;
        let rate = if first { ENDING_FEE } else { CLIFF_FEE };
        let fee = (amount_in as u128 * rate).div_ceil(FEE_DENOMINATOR) as u64;
        let protocol = fee / 5;
        let coins = ((amount_in - fee) as u128 * COINS_PER_LAMPORT_MILLI / 1_000) as u64;
        let add = |data: &mut [u8], offset: usize, amount: u64| -> ProgramResult {
            let total = number(data, offset)? + amount;
            put(data, offset, &total.to_le_bytes());
            Ok(())
        };
        add(&mut data, POOL_PROTOCOL_QUOTE_FEE, protocol)?;
        add(&mut data, POOL_PARTNER_QUOTE_FEE, fee - protocol)?;
        add(&mut data, POOL_QUOTE_RESERVE, amount_in - fee)?;
        data[POOL_HAS_SWAP] = 1;
        (fee, coins)
    };
    msg!("DBC stand-in: in {}, fee {}, out {}", amount_in, fee, coins);
    // The quote in, signed for by the payer, its owner or its delegate; the coins out, signed for by the pool authority.
    transfer(token_quote_program, input, quote_mint, quote_vault, payer, amount_in, &[])?;
    let signer: &[&[u8]] = &[POOL_AUTHORITY_SEED, &[authority_bump]];
    transfer(token_base_program, base_vault, base_mint, output, pool_authority, coins, signer)
}

fn address(data: &[u8], offset: usize) -> Result<Pubkey, ProgramError> {
    let bytes: [u8; 32] = data.get(offset..offset + 32).ok_or(ProgramError::InvalidAccountData)?.try_into().unwrap();
    Ok(Pubkey::new_from_array(bytes))
}

fn number(data: &[u8], offset: usize) -> Result<u64, ProgramError> {
    let bytes = data.get(offset..offset + 8).ok_or(ProgramError::InvalidAccountData)?;
    Ok(u64::from_le_bytes(bytes.try_into().unwrap()))
}

fn require(condition: bool, what: &str) -> ProgramResult {
    if condition {
        Ok(())
    } else {
        msg!("DBC stand-in refused: {}", what);
        Err(ProgramError::InvalidArgument)
    }
}

fn claim_trading_fee(accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let [pool_authority, config, pool, token_a, token_b, base_vault, quote_vault, base_mint, quote_mint, fee_claimer, token_base_program, token_quote_program, _event_authority, _program] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let max_base = number(args, 0)?;
    let max_quote = number(args, 8)?;

    // DBC's access control: the signer is the config's fee claimer.
    require(config.owner == &ID, "the config is not DBC's")?;
    let config_data = config.try_borrow_data()?;
    require(config_data.starts_with(&POOL_CONFIG_DISCRIMINATOR), "not a config")?;
    require(
        fee_claimer.is_signer && *fee_claimer.key == address(&config_data, CONFIG_FEE_CLAIMER)?,
        "not the fee claimer",
    )?;
    require(*quote_mint.key == address(&config_data, CONFIG_QUOTE_MINT)?, "not the config's quote mint")?;
    drop(config_data);

    let (authority, bump) = Pubkey::find_program_address(&[POOL_AUTHORITY_SEED], &ID);
    require(*pool_authority.key == authority, "not the pool authority")?;
    // Anchor 1.x, which DBC is built with, refuses the same token account twice among its mutable ones.
    let mutable = [token_a.key, token_b.key, base_vault.key, quote_vault.key];
    for (i, a) in mutable.iter().enumerate() {
        require(mutable[i + 1..].iter().all(|b| b != a), "a duplicate mutable account")?;
    }

    require(pool.owner == &ID, "the pool is not DBC's")?;
    let (base_amount, quote_amount) = {
        let mut data = pool.try_borrow_mut_data()?;
        require(data.starts_with(&VIRTUAL_POOL_DISCRIMINATOR), "not a pool")?;
        require(address(&data, POOL_CONFIG)? == *config.key, "the pool's config")?;
        require(address(&data, POOL_BASE_MINT)? == *base_mint.key, "the pool's base mint")?;
        require(address(&data, POOL_BASE_VAULT)? == *base_vault.key, "the pool's base vault")?;
        require(address(&data, POOL_QUOTE_VAULT)? == *quote_vault.key, "the pool's quote vault")?;
        let base = number(&data, POOL_PARTNER_BASE_FEE)?.min(max_base);
        let quote = number(&data, POOL_PARTNER_QUOTE_FEE)?.min(max_quote);
        let left_base = number(&data, POOL_PARTNER_BASE_FEE)? - base;
        let left_quote = number(&data, POOL_PARTNER_QUOTE_FEE)? - quote;
        data[POOL_PARTNER_BASE_FEE..POOL_PARTNER_BASE_FEE + 8].copy_from_slice(&left_base.to_le_bytes());
        data[POOL_PARTNER_QUOTE_FEE..POOL_PARTNER_QUOTE_FEE + 8].copy_from_slice(&left_quote.to_le_bytes());
        (base, quote)
    };

    let signer: &[&[u8]] = &[POOL_AUTHORITY_SEED, &[bump]];
    if base_amount > 0 {
        transfer(token_base_program, base_vault, base_mint, token_a, pool_authority, base_amount, signer)?;
    }
    if quote_amount > 0 {
        transfer(token_quote_program, quote_vault, quote_mint, token_b, pool_authority, quote_amount, signer)?;
    }
    Ok(())
}

fn transfer<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    signer: &[&[u8]],
) -> ProgramResult {
    let decimals = *mint.try_borrow_data()?.get(MINT_DECIMALS).ok_or(ProgramError::InvalidAccountData)?;
    let mut data = vec![TRANSFER_CHECKED];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    let instruction = Instruction {
        program_id: *token_program.key,
        accounts: vec![
            AccountMeta::new(*from.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new(*to.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data,
    };
    // A user's transfer is signed by the user in the transaction; the pool authority's by its seeds.
    system(instruction, &[from.clone(), mint.clone(), to.clone(), authority.clone(), token_program.clone()], signer)
}
