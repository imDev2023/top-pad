//! The fee program (spec 5.2): the partner and fee claimer on every config, forever, so it should rarely change.
//! Empty until "Instant launch from the launch flow" adds `register_coin`; its id is fixed before the configs name its
//! PDA.
use anchor_lang::prelude::*;

declare_id!("GE2pTRgdvaHtZzejvD99gdphxoqiZh6baoxjpw5MBt8B");

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "Top-pad fee program",
    project_url: "https://github.com/imDev2023/top-pad",
    contacts: "link:https://github.com/imDev2023/top-pad/security/advisories/new",
    policy: "https://github.com/imDev2023/top-pad/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/imDev2023/top-pad"
}

#[program]
pub mod fee {}
