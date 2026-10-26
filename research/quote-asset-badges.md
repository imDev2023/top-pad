# Quote assets and Meteora token badges

Research ticket [#7](https://github.com/imDev2023/top-pad/issues/7) for the Top-pad wayfinder map, captured 2026-10-26.
The per-mint table is [quote-asset-badges.csv](quote-asset-badges.csv) (607 rows); the scripts that built it are in [scripts/](scripts/).
Every count below is a snapshot: StonkFun's pair list was generated at 2026-10-26 15:43 UTC, the mint accounts were read at 15:45 UTC (epoch 1068), and the DBC pool scan ran the same afternoon.

## Answer

StonkFun's public API lists 607 quote assets (583 under its `launchable=true` filter), 262 SPL Token mints and 345 Token-2022 mints.

| Program (deployed version) | Accepted without approval | Already badged | Needs a badge |
| --- | --- | --- | --- |
| DBC (0.2.2, deployed 2026-10-16) | 455 | 118 | 34 |
| DAMM v2 (cp_amm 0.2.5, deployed 2026-10-15) | 491 | 116 | 0 |
| DLMM (lb_clmm, deployed 2026-06-03) | 489 | 118 | 0 |

- Every stock token StonkFun offers already holds a badge in every program that needs one: 24 xStocks, 83 Backpack Token-2022 stocks, 8 PreStocks, and 2 Tessera tokens (which DAMM v2 accepts without one).
  A stock-priced coin on Top-pad therefore needs no badge request at all.
- The only gaps are 34 DBC badges, all for Token-2022 coins with a 1%, 2.69% or 3% transfer fee and no other risky extension.
  33 of them are StonkFun's own "reward" coins, whose withheld fees are collected by StonkFun's reward-token fee wallet `5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD`; the 34th is BERN, an older coin with its own fee wallet.
  DBC refuses any quote mint with a non-zero transfer fee unless it holds a badge, while DAMM v2 and DLMM accept these coins without one.
  21 keep a live transfer-fee authority held by that StonkFun wallet, BERN keeps its own, and 12 have it revoked.
  None of the 34 has a DBC config or pool today.
- 10 of the 118 DBC-badged quotes (8 PreStocks at a 1% fee, 2 Tessera at 0.2%) carry a non-zero transfer fee and a live fee authority, so DBC 0.2.2 accepts them only through `create_config2`.
  Such a config must use a fixed supply with equal pre- and post-migration supply, no locked vesting, `MigrationFeeOption::Customizable` and `MigratedCollectFeeMode::Compounding`; the same restrictions would apply to the 34 gaps if they were badged.
- Freeze authority: 117 of StonkFun's Token-2022 quotes have one, and all 117 already hold a DLMM badge.
  The 18 SPL Token quotes with a freeze authority (USDC, USDT, EURC, WBTC and others) need nothing.
  A simulated DLMM pool creation shows what the "additional review" is: DLMM fails a Token-2022 mint with a freeze authority with `UnsupportedTokenMint` (6073) unless that mint's DLMM token badge is passed, so the review is the ordinary badge request.
- Transfer hooks: no StonkFun quote has an active hook.
  116 of them (xStocks, Backpack, PreStocks and PUMP) carry a TransferHook extension with no hook program but a live hook authority, so the issuer could switch a hook on later.
  If that happened, DAMM v2 transfers and DBC quote transfers would fail even with a badge, because neither program forwards hook accounts for those transfers; DLMM does forward them ([dlmm-sdk CHANGELOG line 415, `getExtraAccountMetasForTransferHook`](https://github.com/MeteoraAg/dlmm-sdk/blob/af36dd53ab180783ccecda306926189a4700953c/CHANGELOG.md?plain=1#L415)).
- Alpha Vault, which Fair Open uses, has no extension check and no badge of its own: it moves tokens with `transfer_checked` through the token program of the connected DLMM or DAMM v2 pool, so it accepts whatever quote mint that pool accepted.
  Its documentation lists support only for SPL Token, transfer fees, transfer memos and DLMM transfer hooks, and none of the 1,244 Alpha Vaults on mainnet uses a stock token as its quote, so an Alpha Vault priced in a Pausable, Permanent Delegate, Scaled UI Amount stock token should be accepted (inferred from the IDL) but is untested.
- On DBC today, 236 of the 607 quotes have at least one pool; 90 of those are badged stock or special tokens.
- How a badge is requested: one Google Form per mint, then one ticket in Meteora's Discord.
  The form takes a single mint address, the extensions, project details and three contact handles; it does not ask which program, and Meteora documents no bulk path, criteria or turnaround.
  Every one of the 7,252 badges in the three programs was created by one of three Meteora keys signing alone and paying the rent itself (7,185 by `8dgGvhgEpJrz1HQAATMJR3ydfE5TXVQ4BzKbjF1yW5AE`), so the on-chain record never shows who asked.
  The DBC stock badges came from bulk runs over whole issuer catalogs, not from per-coin requests: 1,212 badges on 2026-09-09 (all 740 xStocks and all 443 Ondo tokens), 1,114 Backpack tokens in all three programs on 2026-09-21, and the 10 fee-bearing PreStocks and 3 Tessera tokens on 2026-10-16, the day DBC 0.2.2 shipped.
  New Backpack listings now get all three badges on the day they are minted, while other recent tokens waited 23 to 31 days for a DLMM badge.
- The drafted bulk request is in [Draft bulk request](#draft-bulk-request); because the only gaps are fee-bearing coins, 33 of them a competitor's, sending it is a product decision rather than a prerequisite.

## Draft bulk request

The form accepts one mint per submission, so the plan is one form for the first mint with the full list in its free-text field, then one Discord ticket that links the list and asks whether the team accepts the batch from that single ticket.

Form fields (first submission):

- Token Contract Address on Solana: `FeDrozMMWvy1MjV7Y5pcgssxiN42TR1fV3GqYmohqA6W`
- Required Token 2022 Extensions: TransferFeeConfig, MetadataPointer, TokenMetadata
- Special requests: the text below
- Project name, description, website, X, Discord and the three contact handles: Top-pad's own, to be filled in by the owner.

Ticket and special-request text:

> Hi Meteora team, we are building Top-pad, a fair-launch launchpad on DBC with DAMM v2 graduation and Alpha Vault openings.
> We would like DBC token badges (DBC program only, not DAMM v2 or DLMM) for 34 Token-2022 quote mints so creators can price a coin in them.
> All 34 are Token-2022 mints whose only extensions are TransferFeeConfig and, for 33 of them, MetadataPointer and TokenMetadata; none has a freeze authority, a mint authority, a transfer hook or a permanent delegate.
> Their transfer fee is non-zero (1%, 2.69% or 3%), which is why DBC 0.2.2 needs a badge; DAMM v2 and DLMM already accept them permissionlessly.
> We will create every config for these quotes with `create_config2` and the transfer-fee restrictions it enforces (fixed supply, no locked vesting, Customizable migration fee, Compounding fee mode).
> 12 mints have the transfer-fee config authority revoked, so their fee can never change:
> FeDrozMMWvy1MjV7Y5pcgssxiN42TR1fV3GqYmohqA6W, HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR, 8RNUw4N655VSrZKuhGdywhbSMDTrheguFPfxbpE2NZHQ, 4tkupXEGfbYPCVN37CagviJd3tgWnudT9avKZvouT3Dm, E4Ap4icMLwKot8rkkTbq5JkS5kZxt5XCE3yfxbzYBjHx, HyZLwid1NYTyjRaKQJKmxnhATBPff67aTdy1gnwQuEAz, vAddewUHuYgRDrL6n3kXtBXMT635evJz8K93j6Wm1Ba, 7tWFogvm3EyPmHsGMrQBiw1wBpXxdF88dZW5HkeTL4tH, 2zcgjEptFV8crPbj5j2ZDHgxhKsQX5MHuKZQxUwNqtjE, EbT2jpoeRJVFNWAFJE97EGfQF3iwHsEY8sh17fGbL5ER, GWTP6M5bxhaJ1k2Kxvf8hhYaHE6jZMhh4cKzFuCpnc83, CaWZeUM4FvX9dPkjGc2xHS6tSN3qJfTWyvaG77aM5o7h.
> 22 mints keep a live transfer-fee config authority (21 held by `5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD`, 1 by `BeRNwDN8aGHvxYRVhNyMkF1wsxuEeceux2xn5deFWyEe`); we understand from the 0.2.2 changelog that a badge does not cap later fee changes, so if you only badge mints with a revoked authority, please treat this second group as optional:
> 8RVBk8vxLiUHueLUW1f4izFVqN3nWippLhkohKg6EGkS, AGi2s9zPRPHs3zEDPhPTroumTEXK5ufymYSfEFndCSSW, 6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr, HTmQz7My6MehV7bjhJ6jde8nDND1yvsz68d24LP7YgUQ, 72yxYmhLgDGwdyi2b9GjDynBB6VuG3kDxNKqDbzXh5bi, HgcxVs6kJhPAaGqnPNGaa7zYgNT49hJrLufiqcNMuYZT, 4rkGWJNSUPBcMicXMRAzohEyeJLFG8gUjwiWaz7Pddr3, HuAXPyDWDaMYFKuwQHpqL1oPnj93zdzWmtvFGzCeCUa7, 8t5C4AWDg4CroMChxdo7rG2e8nJM31QG2GG7Czx9X7x2, 6XhzSy3VTTkwqMUSQsStM3ncGy6ozcPnzLVmv4HZ64cC, 7MCgYMzq3fov6oERdtTMAYbN2U9LZrrSYS1MBhjixZFr, 7ypCq2CJ4fnbtS3z2B1W1UT2he5E3u7Md6Gy1ri7uGrQ, 6kNNgyrdvjkRC8eRGQqx5sLfZG2jTmg3NCFmkX2hYP4j, CKfatsPMUf8SkiURsDXs7eK6GWb4Jsd6UDbs7twMCWxo, 4MMQY9bwkxxTtsK3W227Q5ABT6yFY8Pmn9Ze7wmAXKY8, 6JrR1iqPdinYTNvNPWTR2P7e2wSJ1rwdsrKGyhnzjUVr, DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP, 68AGsjomsgTtiTaDhF6XGCeVJDnFeh415ngYYgVxGzns, 9h5AzEQzYu9CV5K6uLtFRMD1KcbxZSFNxZEgBTNfw5Na, 9CPfv7rc6vxBd3jtovmZtf5Zy8bdvssv8c4BwzbGk147, B2GESkSErPjuCq6n4LcaJP5v2z1kJnw3xHVZnop2sZx, 79hQSeQtMsVLFH8vCT8LysFnJDqiwSxQyTA7cMVgyaHB.
> The full table with each mint's extensions, fee and authorities is at https://github.com/imDev2023/top-pad/blob/research/quote-asset-badges/research/quote-asset-badges.csv (rows whose `dbc_status` is `needs badge`).
> Could you tell us whether one ticket covers the batch or you need one form per mint, and roughly how long a batch takes?
> Thank you.

## Evidence

### What each program accepts without a badge

- DBC 0.2.2 accepts an SPL Token quote mint always, and a Token-2022 quote mint only when every extension is MetadataPointer, TokenMetadata, or a TransferFeeConfig whose fee is zero (current and any scheduled fee) and whose fee-config authority is revoked ([`is_permissionless_supported_quote_mint`, token.rs line 344](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/91e696eef6a3764157220f6c104f079b7830fc04/programs/dynamic-bonding-curve/src/utils/token.rs#L344), [`is_transfer_fee_zero`, line 277](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/91e696eef6a3764157220f6c104f079b7830fc04/programs/dynamic-bonding-curve/src/utils/token.rs#L277)).
  Any other Token-2022 quote needs a badge, which `get_mint_score` checks at remaining-account index 0 ([line 306](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/91e696eef6a3764157220f6c104f079b7830fc04/programs/dynamic-bonding-curve/src/utils/token.rs#L306)).
- A badged quote with a non-zero fee or a live fee authority scores `PermissionedWithTransferFee`, which only `create_config2` accepts; `create_config` and `create_config_with_transfer_hook` require `PermissionedWithoutTransferFee` ([ix_create_config2.rs line 20](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/91e696eef6a3764157220f6c104f079b7830fc04/programs/dynamic-bonding-curve/src/instructions/partner/create_config/ix_create_config2.rs#L20), [ix_create_config.rs line 46](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/91e696eef6a3764157220f6c104f079b7830fc04/programs/dynamic-bonding-curve/src/instructions/partner/create_config/ix_create_config.rs#L46)).
- The 0.2.2 changelog states the new rules, the `create_config2` restrictions (fixed supply with equal pre- and post-migration supply, no locked vesting, Customizable migration fee, Compounding fee mode), and that a badge does not stop the mint's manager from raising the fee later ([CHANGELOG.md, 0.2.2 section](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/91e696eef6a3764157220f6c104f079b7830fc04/CHANGELOG.md?plain=1#L24)); the live docs say the same ([DBC Token 2022 Support](https://docs.meteora.ag/core-products/dbc/token-2022-support), source [MeteoraAg/docs ceee476](https://github.com/MeteoraAg/docs/blob/ceee4762690067f7b42d2fc5c4994470d432f1bd/core-products/dbc/token-2022-support.mdx)).
- DBC forwards transfer-hook accounts only for the base mint: a swap passes hook accounts to the base side and `None` to the quote side ([process_swap.rs lines 289 to 291](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/91e696eef6a3764157220f6c104f079b7830fc04/programs/dynamic-bonding-curve/src/instructions/swap/process_swap.rs#L289)), and a transfer of a mint with a hook program and no hook accounts fails with `MissingRemainingAccountForTransferHook` ([token.rs `transfer_token_from_user`, line 94](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/91e696eef6a3764157220f6c104f079b7830fc04/programs/dynamic-bonding-curve/src/utils/token.rs#L94)).
- DAMM v2 accepts an SPL Token mint always, and a Token-2022 mint when every extension is TransferFeeConfig (any fee), MetadataPointer, TokenMetadata, or a TransferHook with both program and authority unset ([`is_permissionless_supported_mint`, token.rs line 223](https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/utils/token.rs#L223)); otherwise it needs a badge unless the config holds `CreatePoolWithoutMintValidation` ([`validate_mint`, line 264](https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/utils/token.rs#L264)).
  DAMM v2 has no freeze-authority check, and its transfers never add hook accounts ([`transfer_from_user`, line 157](https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/utils/token.rs#L157)).
  DBC graduation uses DAMM v2 configs that hold `CreatePoolWithoutMintValidation`, so a DBC-badged quote graduates without a DAMM v2 badge ([DAMM v2 Token 2022 Support](https://docs.meteora.ag/core-products/damm-v2/token-2022-support)).
- DLMM's program source is not public.
  Its docs give the same extension allowlist as DAMM v2 and add that Token-2022 mints with a freeze authority are not accepted permissionlessly ([DLMM Token 2022 Support](https://docs.meteora.ag/core-products/dlmm/token-2022-support)); the simulation below confirms both on mainnet.
- None of the three programs lets an operator badge a mint it already accepts: DBC requires `MintScore::Unsupported` ([ix_create_token_badge.rs line 44](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/91e696eef6a3764157220f6c104f079b7830fc04/programs/dynamic-bonding-curve/src/instructions/operator/ix_create_token_badge.rs#L44)) and DAMM v2 returns `CannotCreateTokenBadgeOnSupportedMint` ([ix_create_token_badge.rs](https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/instructions/operator/ix_create_token_badge.rs)).
  That is why the 2 Tessera mints have DBC and DLMM badges but no DAMM v2 badge.

### Which version is live

- The DBC program data was last written at slot 457,502,600 (2026-10-16 04:23 UTC), and the deployed binary contains the `CreateConfig2` instruction name, so 0.2.2 is live on mainnet.
- DAMM v2 was last deployed at slot 457,080,014 (2026-10-15 03:00 UTC), 18 minutes before the 0.2.5 head commit of `MeteoraAg/damm-v2` that this note reads.
- DLMM was last deployed at slot 423,977,638 (2026-06-03) and Alpha Vault at slot 349,243,341 (2025-06-26); all four programs share the upgrade authority `JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd`.
- The knowledge-base mirror of the DBC page (captured 2026-10-04) describes 0.2.1, where a badge never allowed a non-zero transfer fee and a zero-fee TransferFeeConfig still needed a badge; both rules changed with 0.2.2.
  The charting digest ([research/reference-launchpads.md](https://github.com/imDev2023/top-pad/blob/research/reference-launchpads/research/reference-launchpads.md)) repeats the 0.2.1 rule that a badge never allows a non-zero quote transfer fee; that is no longer true.
- The DBC mirror and the live DAMM v2 page both give `So11111111111111111111111111111111111111112` as the Token-2022 native mint, but that is the SPL Token wrapped SOL mint; the Token-2022 native mint the programs reject is `9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP`, as the live DBC page now says.

### Badge accounts on-chain

- In all three programs a TokenBadge is the same 168-byte zero-copy account: discriminator `[116, 219, 204, 229, 249, 116, 255, 150]`, then `token_mint`, then 128 bytes of padding ([DBC token_badge.rs](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/91e696eef6a3764157220f6c104f079b7830fc04/programs/dynamic-bonding-curve/src/state/token_badge.rs), [DAMM v2 token_badge.rs](https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/state/token_badge.rs), [DLMM IDL](https://github.com/MeteoraAg/dlmm-sdk/blob/af36dd53ab180783ccecda306926189a4700953c/idls/dlmm.json)).
- Its address is the PDA of `["token_badge", mint]` under each program ([DBC constants.rs line 125](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/91e696eef6a3764157220f6c104f079b7830fc04/programs/dynamic-bonding-curve/src/constants.rs#L125), [DAMM v2 constants.rs line 195](https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/constants.rs#L195), [DLMM commons pda.rs line 153](https://github.com/MeteoraAg/dlmm-sdk/blob/af36dd53ab180783ccecda306926189a4700953c/commons/src/pda.rs#L153)).
- A full scan found 2,390 badges in DBC, 2,395 in DAMM v2 and 2,467 in DLMM; 2,387 mints are badged in all three, and no badge is for an SPL Token mint.
  By issuer: 1,183 Backpack Securities, 740 xStocks, 443 Ondo Global Markets, 11 PreStocks, 4 Tessera, and 88 others, among them PYUSD and USDG, Shift and rStock tokens, and 22 mints with PreStocks' `Pre` address prefix whose metadata now reads REFUNDED or REPLACED.
- 71 badges exist only in DLMM.
  One is a Token-2022 mint with only metadata extensions and a freeze authority, which only DLMM refuses; the rest are stock, test, refunded and stablecoin mints (USDG among them) that also carry extensions DBC or DAMM v2 would refuse but were never badged there.
- Deriving the PDA for each of the 607 StonkFun mints and reading those addresses gave exactly the badge set of the scan in all three programs (0 mismatches), which confirms the seeds.
- The DBC count grew from 2,368 in Stoker's 2026-09-26 scan to 2,390, and one DBC badge from that scan is gone: GIDDY Gold (CADG, `CADGKVBTfVqcTaTAFko4P6Vd5ZMMr7tXYs5Sn1GyLoyu`) was badged on 2026-09-09 and closed by the operator on 2026-10-07, while its DAMM v2 and DLMM badges remain.
  A badge can therefore be withdrawn; existing pools keep trading but no new config or pool can use the mint ([DBC Token 2022 Support](https://docs.meteora.ag/core-products/dbc/token-2022-support)).

### DLMM freeze-authority simulation

`scripts/dlmm_freeze_simulation.py` builds an unsigned DLMM `initialize_lb_pair2` transaction (mint against wrapped SOL, preset parameter `12KDrVfYrbdUgVJLU8JLEVTmMsKSDXfbFoksMULSyjH`) and runs `simulateTransaction` with signature checks off; nothing is signed or sent.

| Mint | Program | Freeze authority | Extensions | Badge passed | Result |
| --- | --- | --- | --- | --- | --- |
| tOpenAI `oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ` | Token-2022 | yes | TransferFeeConfig, MetadataPointer, TokenMetadata | no | `UnsupportedTokenMint` (6073) |
| tOpenAI | Token-2022 | yes | same | yes | success |
| ANSEM `9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump` | Token-2022 | no | MetadataPointer, TokenMetadata | no | success |
| EURC `HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr` | SPL Token | yes | none | no | success |
| SPYx `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W` | Token-2022 | yes | eight, incl. PermanentDelegate, Pausable, ScaledUiAmount | no | `UnsupportedTokenMint` (6073) |
| SPYx | Token-2022 | yes | same | yes | success |

The freeze-authority rule is therefore enforced by the DLMM program, applies to Token-2022 only, and is cleared by the same token badge as any other unsupported extension.

### StonkFun's quote assets

- The list comes from StonkFun's keyless `GET https://stonkfun.xyz/api/public/v1/pairs`, described in its [OpenAPI spec](https://stonkfun.xyz/api/public/v1/openapi.json) as the quote tokens a launch can pair against.
  The plain call returned 607 pairs and `?launchable=true` returned 583; the 24 extra pairs are custom tokens, all reported as launchable, so the CSV keeps all 607 and flags membership in the filtered list.
- By StonkFun's own categories: 446 custom, 109 Backpack, 24 xStock, 8 PreStock, 5 currency, 5 basket, 3 leverage, 3 Solana, 2 Tessera, 2 collectible.
- The 227 custom Token-2022 quotes without a badge split into 193 with only metadata extensions (accepted everywhere) and the 34 transfer-fee coins.
- Stoker's on-chain notes identify `5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD` as StonkFun's Token-2022 transfer-fee and withdraw-withheld authority for reward tokens (`stonk-fun-solana/research/onchain/README.md`), and it is the withdraw-withheld authority of 33 of the 34 gaps.

### Extension risks of the badged stock tokens

- xStocks carry PermanentDelegate, Pausable, ScaledUiAmount, DefaultAccountState, ConfidentialTransferMint, a TransferHook with a live authority, and a freeze authority; Backpack Token-2022 stocks carry the same set.
- PreStocks add TransferFeeConfig (1% since epoch 1050, after 5% from epoch 1048) and ConfidentialTransferFeeConfig, with every authority held by one key.
- For any coin priced in one of these, the issuer can pause transfers, move tokens out of the pool vaults, change the displayed balance, or change the fee, and a badge restricts none of it.

### DBC usage

- A full scan of DBC on 2026-10-26 found 1,824,710 pools under 560,391 configs, with 1,156 distinct quote mints in use (731 in Stoker's 2026-09-26 scan) and 166 badged quote mints in use (124 then).
- Of StonkFun's 607 quotes, 236 have at least one DBC pool; the badged ones account for 3,699 pools, led by NVDAx (834), SPYx (458), SPCXx (450) and TSLAx (339).
- The scan reuses the account offsets of Stoker's `research/competitors/meteora_dbc_scan.py` (PoolState.config at byte 72, PoolConfig.quote_mint at byte 8).

### Badge requests and precedent

- The documented route is the [Google Form](https://forms.gle/59n3zDiGS2C6qMfd7) and then a ticket in the [Meteora Discord](https://discord.gg/meteo) ([DLMM Token 2022 Support](https://docs.meteora.ag/core-products/dlmm/token-2022-support), [DAMM v2 Token 2022 Support](https://docs.meteora.ag/core-products/damm-v2/token-2022-support)); the DBC page documents badges but links no form.
- The form, titled "Meteora: Solana Token 2022 Whitelist Request Form", lists the DLMM permissionless extensions, asks the requester to open a Discord support ticket after submitting, and promises review "as quickly as we can" with no criteria or timing.
  Its required fields are one mint address, the extensions (checkboxes covering every Token-2022 extension), project name, description, website, X and Discord links, and the requester's Telegram, Discord and email; a free-text field takes special requests.
- For every badge the script took the oldest successful transaction that touches the badge address and logs `CreateTokenBadge` (DBC, DAMM v2) or `InitializeTokenBadge` (DLMM); all 7,252 badges have one, in 1,556 transactions holding up to 5 badge creations each (median 3), and 370 of those transactions badge the same mints in all three programs at once.
- Signers: `8dgGvhgEpJrz1HQAATMJR3ydfE5TXVQ4BzKbjF1yW5AE` created all 2,390 DBC badges and, since 2026-01-15, 2,392 DAMM v2 and 2,403 DLMM badges; `DHLXnJdACTY83yKwnUkeoDjqi4QBbsYGa1v8tJL76ViX` created 63 (DLMM from 2025-07-09 to 2025-12-12, and 2 in DAMM v2 in 2025); `5unTfT2kssBuNvHPY6LbJfJpLqEcdMxGYLWHwShaeTLi` created 4 in 2025.
  In every creation transaction the operator key is the only signer and the fee payer, which the instruction allows because `payer` and `signer` are separate accounts that may be the same key ([DBC ix_create_token_badge.rs](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/91e696eef6a3764157220f6c104f079b7830fc04/programs/dynamic-bonding-curve/src/instructions/operator/ix_create_token_badge.rs)); a requester never pays or signs.
- DBC timeline: the first DBC badges appear on 2026-09-09, the mainnet date the knowledge base records for 0.2.1 (`meteora/03-dev-dbc-vaults-launch.md`), with 1,212 that day (740 xStocks, 443 Ondo, 19 Backpack, 10 others); 1,114 Backpack tokens follow on 2026-09-21 in DBC, DAMM v2 and DLMM together; 10 PreStocks and 3 Tessera tokens, all with a live transfer fee, follow on 2026-10-16.
  80 of StonkFun's 118 DBC-badged quotes come from those three days.
- DAMM v2's stock catalogs were bulk badged on 2026-08-12 (302) and 2026-09-09 (910); DLMM has the longest record, from 2025-03-28, with the first xStocks badged on 2025-07-09.
- Turnaround, measured from each mint's first transaction to its badge: the 14 Backpack mints created between 2026-09-23 and 2026-10-13 each got all three badges on the same day, which points to a standing arrangement with that issuer (inferred); tokenized Google and SpaceX segment tokens waited 31 and 23 days for a DLMM badge; the PreStocks and Tessera tokens waited 8 to 398 days for their DBC badge because DBC could not take a fee-bearing quote before 0.2.2.
- Taken together (inferred), Meteora badges by issuer and by program release rather than by launchpad request, and the precedent for a launchpad asking for a batch of memecoin quotes is not visible on-chain.

### Alpha Vault

- The Alpha Vault IDL ([alpha_vault 0.4.1](https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/idls/alpha_vault.json)) has no badge account and no extension error; its only mint error is `IncorrectTokenMint`, raised when the vault mints do not match the connected pool.
- Meteora's account docs say the vault uses checked transfers through the pool's token program and list Transfer Fee, Transfer Memo, DLMM transfer hooks and SPL Token as supported ([Alpha Vault accounts, Token 2022 Support](https://docs.meteora.ag/developer-guides/alpha-vault/program/accounts)); the docs mention hook accounts only for `fill_dlmm`, not for deposits, withdrawals or claims.
- Of 1,244 Alpha Vaults on mainnet (698 on DAMM v2, 411 on DLMM, 135 on DAMM v1), 1,243 use an SPL Token quote (653 USDC, 481 SOL) and one uses a metadata-only Token-2022 quote; none is priced in a stock token.

### Devnet

- On devnet the same program IDs hold only 9 DBC, 3 DAMM v2 and 22 DLMM badges, and the stock tokens do not exist there, so a devnet prototype cannot exercise a badged quote unless Meteora badges a test mint for it.

## Method

1. `scripts/quote_asset_badges.py CACHE pairs badges mints pdas dbc alpha history table` fetches the StonkFun lists, scans the three programs' TokenBadge accounts, reads every StonkFun and badged mint with `jsonParsed`, derives and reads each badge PDA, scans every DBC pool and config and every Alpha Vault, finds each badge's creation transaction, and writes the CSV.
2. Each status column applies the program's own rule as quoted above to the mint's extensions, fee (for the current epoch 1068, including any scheduled fee), hook and freeze authority, and the badge scan.
3. `scripts/dlmm_freeze_simulation.py` checks the DLMM rule on mainnet by simulation, because DLMM's source is not public.
4. All calls are read-only Helius mainnet RPC (`getProgramAccounts`, `getProgramAccountsV2`, `getMultipleAccounts`, `getTransactionsForAddress`, `getTransaction`, `simulateTransaction`) and public HTTP; no transaction was signed or sent.

CSV columns: mint, symbol, name, StonkFun category, membership in the `launchable=true` list, token program, extensions, freeze authority (flag and address), mint authority flag, current and scheduled transfer fee in basis points, fee authority live, transfer hook state (`active`, `authority only`, `revoked`), badge flags and badge creation dates per program, status per program, DBC usage (in use, pools, configs), Alpha Vaults using the mint as quote, and the three badge PDAs.

## Open questions

- Whether Top-pad should offer StonkFun's transfer-fee reward coins as quote assets at all, given that 21 of them leave the fee in a competitor's hands and that they force the `create_config2` restrictions on every coin priced in them.
- Whether Alpha Vault deposits, fills and claims work with a Pausable, Permanent Delegate, Scaled UI Amount quote, which no vault on mainnet has tried.
- How Top-pad should react when an issuer pauses a stock token, switches on its transfer hook, or Meteora closes a badge, as happened to CADG on DBC.
- How the devnet prototype exercises a stock-priced coin, when devnet has no stock tokens and only a handful of badges.
