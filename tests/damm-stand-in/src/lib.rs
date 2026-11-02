//! A stand-in for Meteora's DAMM v2 in the fee program's LiteSVM tests, never deployed, at DAMM v2's address: its
//! `claim_position_fee` as release 0.2.5's `ix_claim_position_fee.rs` does it, over pools and positions the tests write
//! in DAMM v2's layout with their fees already accrued. Only the owner of the position's NFT account may claim, and
//! each pending fee is paid out of its vault and reset. Meteora's own binary is never loaded (spec 5.1); the devnet
//! tests run the fee program against the real DAMM v2.
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

anchor_lang::declare_id!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");

#[cfg(not(feature = "no-entrypoint"))]
anchor_lang::solana_program::entrypoint!(process);

pub const CLAIM_POSITION_FEE_DISCRIMINATOR: [u8; 8] = [180, 38, 154, 17, 133, 33, 162, 211];
pub const POOL_DISCRIMINATOR: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
pub const POSITION_DISCRIMINATOR: [u8; 8] = [170, 188, 143, 228, 122, 64, 247, 208];
pub const POOL_AUTHORITY_SEED: &[u8] = b"pool_authority";

/// `Pool`'s mints and vaults.
pub const POOL_TOKEN_A_MINT: usize = 168;
pub const POOL_TOKEN_B_MINT: usize = 200;
pub const POOL_TOKEN_A_VAULT: usize = 232;
pub const POOL_TOKEN_B_VAULT: usize = 264;
pub const POOL_LEN: usize = 1112;
/// `Position`'s pool, NFT mint and pending fees.
pub const POSITION_POOL: usize = 8;
pub const POSITION_NFT_MINT: usize = 40;
pub const POSITION_FEE_A_PENDING: usize = 136;
pub const POSITION_FEE_B_PENDING: usize = 144;
pub const POSITION_LEN: usize = 408;

/// An SPL mint's decimals, and a token account's mint, owner and amount.
const MINT_DECIMALS: usize = 44;
const TOKEN_MINT: usize = 0;
const TOKEN_OWNER: usize = 32;
const TOKEN_AMOUNT: usize = 64;
/// SPL Token's `TransferChecked`.
const TRANSFER_CHECKED: u8 = 12;

pub fn process(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match data.get(..8) {
        Some(discriminator) if discriminator == CLAIM_POSITION_FEE_DISCRIMINATOR => claim_position_fee(accounts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn claim_position_fee(accounts: &[AccountInfo]) -> ProgramResult {
    let [pool_authority, pool, position, token_a_account, token_b_account, token_a_vault, token_b_vault, token_a_mint, token_b_mint, position_nft_account, signer, token_a_program, token_b_program, _event_authority, _program] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (authority, bump) = Pubkey::find_program_address(&[POOL_AUTHORITY_SEED], &ID);
    require(*pool_authority.key == authority, "not the pool authority")?;
    require(pool.owner == &ID && position.owner == &ID, "not DAMM v2's")?;
    {
        let data = pool.try_borrow_data()?;
        require(data.starts_with(&POOL_DISCRIMINATOR), "not a pool")?;
        require(address(&data, POOL_TOKEN_A_MINT)? == *token_a_mint.key, "the pool's token A mint")?;
        require(address(&data, POOL_TOKEN_B_MINT)? == *token_b_mint.key, "the pool's token B mint")?;
        require(address(&data, POOL_TOKEN_A_VAULT)? == *token_a_vault.key, "the pool's token A vault")?;
        require(address(&data, POOL_TOKEN_B_VAULT)? == *token_b_vault.key, "the pool's token B vault")?;
    }
    let (fee_a, fee_b) = {
        let mut data = position.try_borrow_mut_data()?;
        require(data.starts_with(&POSITION_DISCRIMINATOR), "not a position")?;
        require(address(&data, POSITION_POOL)? == *pool.key, "the position's pool")?;
        // The position's NFT, held by whoever signs: DAMM v2's `assert_authority_with_owner_destinations` for an owner.
        let nft = position_nft_account.try_borrow_data()?;
        require(address(&nft, TOKEN_MINT)? == address(&data, POSITION_NFT_MINT)?, "the position's NFT")?;
        require(number(&nft, TOKEN_AMOUNT)? == 1, "the NFT account holds the NFT")?;
        require(signer.is_signer && address(&nft, TOKEN_OWNER)? == *signer.key, "the NFT's owner signs")?;
        let fees = (number(&data, POSITION_FEE_A_PENDING)?, number(&data, POSITION_FEE_B_PENDING)?);
        data[POSITION_FEE_A_PENDING..POSITION_FEE_B_PENDING + 8].fill(0);
        fees
    };
    msg!("DAMM v2 stand-in: position fees {} and {}", fee_a, fee_b);
    let seeds: &[&[u8]] = &[POOL_AUTHORITY_SEED, &[bump]];
    if fee_a > 0 {
        transfer(token_a_program, token_a_vault, token_a_mint, token_a_account, pool_authority, fee_a, seeds)?;
    }
    if fee_b > 0 {
        transfer(token_b_program, token_b_vault, token_b_mint, token_b_account, pool_authority, fee_b, seeds)?;
    }
    Ok(())
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
        msg!("DAMM v2 stand-in refused: {}", what);
        Err(ProgramError::InvalidArgument)
    }
}

fn transfer<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    seeds: &[&[u8]],
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
        &[seeds],
    )
}
