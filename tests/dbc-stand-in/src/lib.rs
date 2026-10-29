//! A stand-in for Meteora's DBC in the fee program's LiteSVM tests, never deployed: DBC 0.2.2's partner fee claim,
//! `claim_trading_fee`, as its source does it (`instructions/partner/ix_claim_partner_trading_fee.rs` and
//! `VirtualPool::claim_partner_trading_fee`), at DBC's address, over pools and configs the tests write in DBC's layout.
//! Meteora's own binary is never loaded (spec 5.1); the devnet tests check the fee program against the real DBC.
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

pub fn process(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match data.split_at_checked(8) {
        Some((discriminator, args)) if discriminator == CLAIM_TRADING_FEE_DISCRIMINATOR => {
            claim_trading_fee(accounts, args)
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
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
    invoke_signed(
        &instruction,
        &[from.clone(), mint.clone(), to.clone(), authority.clone(), token_program.clone()],
        &[signer],
    )
}
