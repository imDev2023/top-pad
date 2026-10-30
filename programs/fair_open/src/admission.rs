//! A deposit's admission (spec 5.3, 6.3): our admission server's ed25519 signature over the launch, the wallet, the
//! person's pseudonym, their Depositor tier and cap, and an expiry. The transaction carries it as an instruction of
//! Solana's Ed25519 precompile, which the runtime checks before any program runs, so the deposit only has to check that
//! the precompile verified exactly this admission by exactly our signer, through the instructions sysvar.
use {
    crate::{FairOpenError, Tier},
    anchor_lang::{prelude::*, solana_program::instruction::Instruction},
};

/// Solana's Ed25519 signature-verification precompile.
pub const ED25519_PROGRAM: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

/// What an admission's message starts with, so no other message our admission key signs can pass for one.
pub const DOMAIN: &[u8] = b"heat fair open admission v1";
/// The message: the domain, then the launch, the wallet, the person, the tier, the cap and the expiry.
pub const MESSAGE_LEN: usize = DOMAIN.len() + 32 + 32 + 32 + 1 + 8 + 8;

/// The precompile's instruction data: a signature count, a padding byte, then one 14-byte set of offsets per signature,
/// each naming the instruction that holds the public key, the signature and the message; `u16::MAX` names the
/// precompile's own instruction.
const OFFSETS_START: usize = 2;
const OFFSETS_LEN: usize = 14;
const THIS_INSTRUCTION: u16 = u16::MAX;

/// Who our admission server admitted to a launch, as the deposit carries it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Admission {
    /// The person's pseudonym in this launch: a keyed hash of their cluster id, salted per launch, so the chain never
    /// links one person's wallets across launches (spec 5.3).
    pub person: [u8; 32],
    pub tier: Tier,
    /// The most the person may have in the launch, in the quote's raw units: at most their tier's cap.
    pub cap: u64,
    /// When the admission lapses, a Unix timestamp.
    pub expires_at: i64,
}

impl Admission {
    /// The bytes our admission server signs for `wallet` in `launch`.
    pub fn message(&self, launch: &Pubkey, wallet: &Pubkey) -> [u8; MESSAGE_LEN] {
        let mut message = [0u8; MESSAGE_LEN];
        let mut at = 0;
        for part in [
            DOMAIN,
            launch.as_ref(),
            wallet.as_ref(),
            &self.person,
            &[self.tier as u8],
            &self.cap.to_le_bytes(),
            &self.expires_at.to_le_bytes(),
        ] {
            message[at..at + part.len()].copy_from_slice(part);
            at += part.len();
        }
        message
    }
}

/// Checks that `precompile` is the Ed25519 precompile verifying one signature, by `signer`, over `message`, with every
/// offset inside its own data: an offset into another instruction would let the precompile verify one thing while this
/// program read another.
pub fn check(precompile: &Instruction, signer: &Pubkey, message: &[u8]) -> Result<()> {
    require_keys_eq!(precompile.program_id, ED25519_PROGRAM, FairOpenError::NoAdmission);
    let data = &precompile.data;
    require!(data.first() == Some(&1), FairOpenError::NoAdmission);
    let offsets = data.get(OFFSETS_START..OFFSETS_START + OFFSETS_LEN).ok_or(FairOpenError::NoAdmission)?;
    let field = |i: usize| u16::from_le_bytes([offsets[2 * i], offsets[2 * i + 1]]);
    let (signature_ix, key_at, key_ix, message_at, message_len, message_ix) =
        (field(1), field(2) as usize, field(3), field(4) as usize, field(5) as usize, field(6));
    require!(
        signature_ix == THIS_INSTRUCTION && key_ix == THIS_INSTRUCTION && message_ix == THIS_INSTRUCTION,
        FairOpenError::NoAdmission
    );
    require!(data.get(key_at..key_at + 32) == Some(signer.as_ref()), FairOpenError::NotOurAdmission);
    require!(
        message_len == message.len() && data.get(message_at..message_at + message_len) == Some(message),
        FairOpenError::NotThisAdmission
    );
    Ok(())
}
