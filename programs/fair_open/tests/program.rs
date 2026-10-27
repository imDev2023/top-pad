//! The built program (target/deploy/fair_open.so, from `anchor build`) in LiteSVM, with no other program loaded (spec 5.1).
use {
    anchor_lang::solana_program::{instruction::Instruction, pubkey::Pubkey},
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const PROGRAM: &[u8] = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/fair_open.so"));

#[test]
fn deploys_at_its_declared_id_and_refuses_an_unknown_instruction() {
    let mut svm = LiteSVM::new();
    svm.add_program(fair_open::id(), PROGRAM).unwrap();
    assert!(svm.get_account(&fair_open::id()).unwrap().executable);

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let instruction = Instruction::new_with_bytes(fair_open::id(), &[0; 8], vec![]);
    let msg = Message::new_with_blockhash(&[instruction], Some(&payer.pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&payer]).unwrap();
    let err = svm.send_transaction(tx).unwrap_err();
    // Anchor's InstructionFallbackNotFound (101): the program runs, and has no instruction with that discriminator.
    assert!(err.meta.logs.iter().any(|l| l.contains("InstructionFallbackNotFound")), "{:?}", err.meta.logs);
    assert_ne!(fair_open::id(), Pubkey::default());
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
