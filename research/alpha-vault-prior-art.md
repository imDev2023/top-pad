# Who already runs capped, PDA-authority Alpha Vault sales on DAMM v2, and how do they work?

Research for ticket #29 of the Top-pad wayfinder map (issue #1), captured 2026-10-26.
It follows up the production precedent found by the Alpha Vault simulation research ([research/alpha-vault-authority.md][avauth], ticket #25, section E3).
Every claim rests on primary sources: mainnet and devnet transactions and accounts read through Helius RPC, Solscan account labels, the Internet Archive's captures of the teams' own sites, the live sites, and the teams' own X posts (read through twitterapi.io).
No transaction was signed or sent, and no program binary was downloaded.
Times are UTC.
Claims that could not be checked are marked **Unverified**.

## Answer

The two mainnet programs are one anonymous operator's single-use launchpads, and both launches ended with the operator pulling all the pool's liquidity minutes after trading opened.
The devnet programs belong to Vaultz, a small team (Phronis) that tested NFT-backed Alpha Vault presales on devnet, never launched on Solana mainnet, and has since moved to Robinhood Chain.
So, as of 2026-10-26, nobody but this operator has run capped, PDA-authority Alpha Vault sales on Solana mainnet; the mechanism works, but its only production record is a scam.

### `2nHzAKCrTNyyau8h3bMnszQohmmc4p8Ar893371JD5Hv`: Cryptstarter

- **Who runs it.** Cryptstarter, sold as "Back coins before they exist. All or nothing token launches on Solana: one price for everyone, no snipers, full refund if the goal isn't met" ([site capture][cs-home]), with the X account [@CryptstarterSol][x-cs] (created 2024-06-16, 11 followers, three posts, all on 2026-10-06).
  No person, company or team is named anywhere.
  The program was deployed by `C4mpYCuYaV1YtSRnJacMxRB2kqYSu3WUoexyS9QzCrA7` at 19:58 on 2026-10-06, nine hours after that wallet's first and only funding, 2.75 SOL withdrawn from Binance (E1, E6).
  The deployer closed the program the next day at 13:28 (E1).
- **What a join checks.** Nothing visible beyond the vault's own rules.
  `Join` takes no arguments, the user is the only signer, and no allowlist, attestation or server co-signature account is passed (E2).
  The user sends 0.01 SOL to the program's PDA, the PDA creates a capped escrow through CPI and refunds 0.00866 SOL, and the user then deposits at top level ([alpha-vault-authority E3][avauth]).
  Every escrow's cap was 1.282051282 SOL, which is the 50 SOL raise divided by 39, and none exceeded it (E2).
  Whatever else the program checked is **Unverified**: it has no published IDL and its program data account no longer exists.
- **What the sale looked like for buyers.** The platform's first and only filled campaign was its own coin, Cryptstarter (CSTARTER): a 50 SOL cap, a one-hour window, Pro Rata overflow refunds, and a DAMM v2 pool that opened one hour after the vault's buy (E3, [tweet][x-cs-funded]).
  46 wallets filled it in 22 minutes.
  At least 27 of them were the deployer's own wallets, and they swept their SOL back to the deployer within 58 seconds the next day (E5).
  Ten more came from one heavy trader's cluster, and only about nine wallets were outside both groups (E5).
  The site's footer said so in plain words: "Launch liquidity is held by the Cryptstarter program and can be withdrawn by the platform's liquidity controller" ([site capture][cs-home]).
- **How it traded after opening.** Bots bought in the opening slot at 22:13:14, and the price reached 9.3 times the vault's price within 16 seconds (E4).
  76 seconds after the open, the deployer called `PullLiquidity`, which removed all 115.52 SOL and 309.75 million CSTARTER from the pool (E3).
  Traders outside the vault lost a net 104.56 SOL in those 76 seconds, the deployer kept about 89 SOL after its own deposits, and the coin has had no liquidity since (E4).

### `83YHJYXu85Yj9JewVYcDAV8oXQ37Jc1MPhL73HwrWLTV`: Harmonized

- **Who runs it.** The same operator, rebranded as Harmonized: "Consensus launchpad on Solana. A coin only goes live when enough wallets agree" ([@HarmonizedPad][x-hp], created 2023-03-19, 55 followers, follows nobody, linking to harmonized.org).
  Its deployer `5cmQHjA96AX2TVnwV3sTD3xDXXEjLG23B3pxZRqtjb9r` was funded by a single KuCoin withdrawal on 2026-10-06, deployed the program at 00:06 on 2026-10-08, and closed it at 01:51 the same night (E1, E6).
  Five independent links tie it to Cryptstarter (E7):
  - the same global config layout and values, each with its own deployer as admin;
  - the same launch transaction, down to the lamports;
  - the same raise/39 cap rule;
  - the same 1:1 instruction set under new names;
  - both programs' joining wallets swept SOL into one wallet in the same four minutes on 2026-10-17.
  The harmonized.org domain served the coin's metadata during the launch, and it now hosts a Robinhood Chain launcher deployed on 2026-10-23 (E8).
- **What a join checks.** The same as Cryptstarter: `AddVoice` takes no arguments, the user alone signs, and the escrow cap was 1.025641025 SOL, the 40 SOL raise divided by 39 (E2).
  The new feature is a quorum: the launch carried a value of 50, which matches the pitch that a coin goes live only when enough wallets ("voices") agree, and `CountVoices` ran three times before the pool was funded (E3).
  Reading that 50 as a minimum wallet count is an inference from the pitch, not from the code.
- **What the sale looked like for buyers.** Harmonized (HMD) took 55 joins in five minutes against a 40 SOL cap and a 20-minute window, and refunded the 1.71 SOL overflow (E3).
  44 of the 55 joining wallets were less than two days old, funded in the same pattern as Cryptstarter's farm wallets.
  36 of the 55 later swept SOL into the same wallet as six of Cryptstarter's farm wallets, so the quorum of "real wallets" was mostly the operator's (E5, E7).
- **How it traded after opening.** The pool opened at 01:34:33, and the operator's X account posted the contract address 74 seconds later ([tweet][x-hp-live]).
  54 swaps by 37 wallets took the price from 1.5 to 2.2 times the vault's price (E4).
  14 minutes 53 seconds after the open, the deployer called `RetrieveLiquidity`, which removed 67.03 SOL and 550.3 million HMD, and within three minutes it closed the program and forwarded 70.31 SOL to another wallet (E3, E6).
  Traders outside the vault lost a net 26.99 SOL (E4).

### `EqFHHYMip7ZGdHH9QBw1T8bnTdsnMZ4jJReGZ2QFR5mV` and `8rpDepKoKd8jKPWwdSUFYv2zrFrVdrD1aX8pDdgUtWzU` (devnet): Vaultz

- **Who runs it.** Vaultz ([@LaunchOnVaultz][x-vz], created 2026-06-05), promoted by Phronis ([@PhronisInc][x-ph]: "Launch on Vaultz no snipers no bots Bond using @MeteoraAG Alpha Vaults!!!", 2026-06-04) and [@phronisceo][x-phceo].
  The backer NFTs' metadata (four checked) points to `https://vltz.io/vault/<vault>` ([NFT metadata][vz-nft]), and vltz.io was registered on 2026-06-02 (E9).
  `EqFH...` was deployed on 2026-05-29 by `CJUniU735JWwGDbJf7XnWPtbi3ZovG4xC2yx4zgwQr8M`, `8rpD...` on 2026-06-20 by `4rzopozRn6kd9FfaipETgx4FfvyP1eeQA3RAtpf77QVj`, and a third program, `GyfuafiBb6piWRBwCV5edkUwY1szzszJaJGNcvFg8m5y`, appears on 2026-06-18 (E9).
  None of the three program ids exists on mainnet, and the three mainnet vaults with an off-curve authority are the two Cryptstarter vaults and the one Harmonized vault (E9).
  vltz.io now reads "Vaultz - Anti-snipe launch vaults on Robinhood Chain ... Raise ETH, auto-migrate to a locked Uniswap v3 position" (E9).
- **What a join checks.** `BuyIntoVault(amount)` is signed by the user alone.
  Each vault takes one fixed amount, with 5% added on top as two 2.5% side payments.
  The escrow is owned by a custody PDA of the program, not by the user, and the deposit is made through CPI (E9).
  A separate `MintBackerCoreAsset` call mints a Metaplex Core NFT for the position, and `ClaimWithNft` claims the coins for whoever holds that NFT (E9).
  Nothing stops one wallet joining twice: on `8rpD...`, single wallets joined the same vault three times, despite the "one NFT per wallet" pitch ([tweet][x-phceo-mint], E9).
- **What the sale looked like for buyers.** It was only ever a devnet test, with 6 distinct joining wallets on `8rpD...` and 12 on `EqFH...`, most of them the team's own (E9).
- **How it traded after opening.** Not applicable: devnet only.

### What Top-pad should copy or avoid

**Copy:**
- One program owning the whole launch works in production.
  Its PDA pays for the DAMM v2 customizable pool, is the vault's `base` and `vault_authority`, and creates every capped escrow inside a one-instruction join that the user alone signs (E2, E3).
- The rent trick: the user prepays 0.01 SOL to the PDA, the PDA pays the 0.00134 SOL escrow rent and refunds the rest in the same instruction, so the PDA never needs topping up (E2).
- The timing chain: the vault closes, the program adds all the coin's supply single-sided, the vault's buy is cranked, the pool opens one hour later, and the vault unlocks one second after the open (E3).
  Both operators cranked their own vault (`FillDammV2`), which is what the DLMM research already planned for Top-pad.
- Per-wallet caps and Pro Rata overflow refunds held mechanically in every escrow (E2).
- Vaultz's custody PDA plus a transferable position NFT is a devnet-tested pattern for Fair Open slots that our program holds (so it can revoke them, per [alpha-vault-authority][avauth]) and that buyers can still trade (E9).

**Avoid:**
- **Liquidity the platform can withdraw.** In both pools the only position belonged to the program's PDA, `permanentLockLiquidity` was 0, and one call drained the pool (E3).
  Top-pad must lock the launch liquidity permanently in the same transaction that funds the pool, and show that lock on the Fairness card.
- **A program its deployer can change or close.** Both programs were closed by their deployers hours later, and the Vaultz programs are still upgradeable (E1, E9).
  Top-pad's program should be made immutable, or at least put upgrades behind a timelock, before it holds anyone's slot.
- **Caps and quorums counted in wallets.** Farm wallets seeded from four exchanges, then split through pairs of hop wallets, filled at least 27 of 46 slots in one vault and most of 55 in the other (E5).
  This confirms the bundle detection decision: caps tiered by personhood, never per bare wallet.
- **An open with no sniper fee.** Both pools charged a flat 1% with no fee scheduler and no dynamic fee, so a bot bought in the opening slot (E3, E4).
  164 transactions against the CSTARTER pool failed before the open, most likely bots firing early (E4).
- **Vault coins unlocked at the open.** The bot trader's wallets dumped their vault coins into the opening bots within 16 to 36 seconds (E5).
  A short linear vesting for vault buyers, which Alpha Vault supports, would blunt that.
- **Metadata on the platform's own domain.** cryptstarter.com no longer answers and harmonized.org now returns 404 for the coin's metadata, so both coins have lost their metadata (E8).
- **The look of this scheme.** "Fair launch, one price, refunds, Alpha Vault on Meteora" has already been used as a scam wrapper.
  Top-pad needs proofs a trader can check on chain (locked liquidity, an immutable program, personhood-gated caps) before its Fair Open looks any different.

## Unverified and open

- Who the operator is: no name, company or team appears on either site, X account, or token metadata.
  The deployers were funded through Binance and KuCoin, which can identify the account holders, but nothing public does.
- Whether the 2025 BNB Chain Cryptstarter ([@CryptstarterBNB][x-csbnb], token `$CRYPT` on PancakeSwap) is the same operator: it used the same domain ([2025 capture list][cs-cdx]), but no on-chain link was traced.
- Whether the Robinhood Chain Harmonized (`HarmonizedLauncher` `0x91993bd0a2538D2eA013571949a520b84F6dD54B`) is run by the same people today: the domain is the only link.
- Whether "Harmonized (HMZ)", a pump.fun coin of November 2025 ([HashEx page][hashex-hmz], mint `GNRZPsLwW9wxdqzDwYa3Qm9XVpQSX9rmEx49w5AHpump`), is related: its metadata names no domain.
- What else `Join` and `AddVoice` checked inside the programs (time window, launch status, quorum logic): the binaries are gone and no IDL was published.
- The meaning of the launch config fields other than the fees, caps, window and quorum (E7).
- Whether the lo0m launch on `8xgfML...` also ended in a liquidity pull: its exit was not traced (E7).
- Which wallet app added the Lighthouse assertion instructions seen in 20 of the 46 Cryptstarter joins (Phantom is known to add them).
- Whether `@hooddailynfts`, who linked vltz.io with "I had this built before I even launched my first nft over 6 months of dev work" ([tweet][x-hood]), is the Vaultz builder.

## Evidence

### E1. The programs, their deployers and their closure

| Program | Deployed (deployer, tx) | Closed (tx) | Global config admin |
| - | - | - | - |
| `2nHzAKCr...` mainnet | 2026-10-06 19:58:03, `C4mpYCuY...`, `4wY9NqkPtr8fPzRJnZccSZUKkCknmDdu51ms7ZmeA5bjowSnAq4oAiRHQy7CCKbh3hgAEtiie7rpZhhBoXYVqge9` | 2026-10-07 13:28:59, `M2ukQqX7HRDPKcfGYtSVKzdGSHYnFdj1R4HH5yFynxDJrHp7dQy5nyGqz1sbTuhAciBdmjcpNvKudeGhn7dN5Xh` | `C4mpYCuY...`, fee 20,000,000 lamports, u16 25 (`InitGlobal` `etB4DS1CLQZvagaKg5rbxHXJkriq1GxpeNTDfoh7b2NjsN44MH4s6PSBGc5UCTUxyrHa2Hwqc2UcFFg3TTZ2j6G`) |
| `83YHJYXu...` mainnet | 2026-10-08 00:06:27, `5cmQHjA9...`, `31GwQ8kbGzfUy51rTh2gsHXtLf4zAYCQnMVHHtAuzqzUCpEJWp6AB2ARv7swno4xMi9heBp8gF4ixHfpJBf6pGRQ` | 2026-10-08 01:51:09, `4WhdBNkn2Epc4T4QFzjkxvr5Xkham7rk6p1TGxdMXSPfc2t2p7fvxbSAZCQY5R3d16fGkV6y74z4ctNS6vujwXGQ` | `5cmQHjA9...`, fee 20,000,000 lamports, u16 25 (`InitGlobal` `3v61bVwa1CvmV1YPyiEn78p5feKbFMt3qjxvxccgjL9sReHz5Kg8RJqaxbSJj5FqWo6nbyFrFtq3xezaL8PzjLUT`) |
| `EqFHHYMi...` devnet | 2026-05-29 22:23:08, `CJUniU73...`, `5dWE52D4jYEJ2oFC9FwYT49mcXEZj8WZHwcRAFZeC21Fu1oi6Vb9xpP2CFw7FWywVqNGZW43d8q8v7SFwvwDM5jU` | not closed; upgrade authority `CJUniU735JWwGDbJf7XnWPtbi3ZovG4xC2yx4zgwQr8M` | - |
| `8rpDepKo...` devnet | 2026-06-20 15:17:53, `4rzopozR...`, `DVpkDzAPLtzWdyLqhTPRhYp5jsCKiBz7Px5jPo1Ua6s3kHf8tJf5kNwq22Z7XgZTPQsgxYSCDZFqgmXM7nmRAWR` | not closed; upgrade authority `4rzopozRn6kd9FfaipETgx4FfvyP1eeQA3RAtpf77QVj` | - |

- The mainnet programs' program data accounts (`FRkZ89D4A6mVv5R4LwPv4nCqfeJanJ3CqUskJmNfvcBe`, `3B3vCyYWWQQELSfBh7DRCsyUgXSfWDh1kYuXyiCZCcvB`) return no account, and each `close` refunded the rent to the deployer.
- Instructions seen in the logs:
  - `2nHz...`: `InitGlobal`, `AddLaunchConfig`, `UpdateGlobal`, `CreateLaunch`, `OpenQueue`, `Join` (46), `Commit`, `PullLiquidity`.
  - `83YH...`: `InitGlobal`, `AddLaunchConfig`, `UpdateGlobal`, `Propose`, `OpenAccord`, `AddVoice` (55), `CountVoices` (3), `Harmonize`, `RetrieveLiquidity`.
  - Vaultz: `InitializePlatform`, `RegisterVaultLaunch`, `BindProjectTreasuryMeteoraVault`, `InitBackerYieldPool`, `BindBackerCollection`, `StartCranking`, `BuyIntoVault`, `MintBackerCoreAsset`, `MarkVaultLive`, `SweepProjectTreasuryToDynamicVault`, `ClaimWithNft`, plus `RefreshBackerCoreAsset`, `MarkClaimed`, `UpdatePlatformFee` and `UpdateTreasury` on `EqFH...` and `ForceSetAdmin` on `8rpD...`.
- None of the programs has an on-chain Anchor IDL account ([alpha-vault-authority E3][avauth]).

### E2. The join, and the caps

- Cryptstarter join, user `B1ddzxpEAAMjJTstAqvTT5ukY3JVFGGQ4TWsTDiPakLf` only signer, `2e4j1gxekwAXafz2bQBC5vdZoMFVyACBfcNR2zpkCJwqanuDfZSPUqekf7VNpYUwjNeEHbp56LW9JvvWcSnn9Ceh` (2026-10-06 20:30:42):
  - the `Join` data is the 8-byte discriminator `ce37026a71dc11a3` and nothing else;
  - its accounts are the user, the global config, the PDA `J7Hj3ebEhH3pZWbicURTNSkUcdger6JejEwUJKuz9VrG`, the launch account, the vault, the pool, the escrow, Alpha Vault's event authority, Alpha Vault and the system program;
  - the user sends 10,000,000 lamports to the PDA, the PDA creates the 136-byte escrow for 1,341,120 lamports through `CreatePermissionedEscrowWithAuthority` and returns 8,658,880 lamports, and the user then wraps 1 SOL and calls `Deposit`.
- Harmonized join, user `EMooG9NKVThuVEx6BhUBF8RCjunzWLbZTfQeL21PDoS5` only signer, `3igdbQ3Dqz2mhGSNBMuPTzT1F5Q2F8LXRuSkS6RYShG7bHK2ScaKYyoXLHEWxVRMgGUGLaWNi1apjqwxphhFDUcF` (2026-10-08 00:14:42): the `AddVoice` data is the discriminator `4908368dd41924c6` alone, with the same 0.01 SOL prepay and refund through the PDA `2j7Dx9iweSTWfhunocc1MtexMRN3peHVZiWg58PhkXg8`.
- No join or vote transaction of either program failed (0 errors in 55 and 66 signatures).
- Escrows read with the Alpha Vault SDK coder:
  - vault `fkJ21UcrGGsF62P4CgNDipUDQaVJK5Ay8gayVnWMydS`: 46 escrows, all `max_cap` 1,282,051,282 lamports, 19 at cap, deposits 0.105 to 1.282 SOL;
  - vault `E5rmTS7xMdn2imSc5ZZiCZqnpmq9CojjkkAi2mVkHhzb`: 55 escrows, all `max_cap` 1,025,641,025 lamports, 2 withdrawn to zero, deposits up to 1.02 SOL.
- 50,000,000,000 / 39 = 1,282,051,282 and 40,000,000,000 / 39 = 1,025,641,025.

### E3. The two launches, step by step

Cryptstarter (CSTARTER, mint `A3ET5bFFxvxj6nDaScvvUYGchaPAn8p8Yg2rHdUYsiQ4`, pool `BuGdkbRGB539RWTLJNA9BSH16XxRdoWeKCXhZRPGniXU`, vault `fkJ21Ucr...`):

| Time 2026-10-06 | Step | Transaction |
| - | - | - |
| 20:00:43 | `InitGlobal`, then `AddLaunchConfig` at 20:00:45 | `etB4DS1C...` above, `58UCKkZ5a2EZh2miNkswCaxFXx5nED6ZDcT3HZMpo85MTms6mVsJBHVgTMkFJRHAUFjj6J9eS8k8L9PU5xaD8izd` |
| 20:08:14 | `CreateLaunch` and `OpenQueue`, signed by the deployer: mints 1,000,000,000 CSTARTER (6 decimals) to the PDA and sets the mint authority and the metadata pointer authority to none; the PDA creates a DAMM v2 customizable pool seeded with 0.001 CSTARTER and 1 lamport, keeps its position NFT, and creates the Pro Rata vault with itself as `base`; the deployer pays itself a 0.02 SOL fee | `3o5vaLFMBnn3whzFmF8f5ZKf3o39cihxKjkwiwy2wgcrhKdGFSpbhLg4y3J38UV4Q8EkBBYZ2E4soUzq3tZoGae7` |
| 20:08:49 to 20:30:42 | 46 joins | first `22WmP9nrJEySFVwBD5X6zWVkwgkxceR3T8RRa7u9TFSP7t4SYRLdNwknPfJLdWXS3gHEwqj35NUL7LQFjMk5HRzV`, last `2e4j1gxe...` above |
| 21:08:17 | `Commit`: `AddLiquidity` of the remaining 999,999,999.999 CSTARTER and 0 SOL, single-sided | `4mjSBFxCEixFCL2UvJqfSahSoH4DoLsQhu2uU4nm2V48pd8hhwpMTMajk5jz4WjWh1rJDrVUNNvz77fRmr1Jh78F` |
| 21:13:15 | `FillDammV2` cranked by the deployer: the vault's 50 SOL buys 497,735,070.6 CSTARTER (49.8% of supply) | `unR74eASfcNtvJ7sbQ3nm2hEV2Qmf5umWguFrrE7rRv5CXZUqPhnwdNzJz5jjGHA3uoY5r33W1BmJTffhQTu2bH` |
| 22:13:14 | Pool activation (`activationPoint` 1791324794), first public buy in that second | `4VACvvcr9o9ApKtMzHbcqTKd5Dgu2EEnn5AiXGBkFR3pvwQEy5owqQufeSzBiyU2Sw9n2LKt1Wo46JXNhnFh35xr` |
| 22:13:15 | Vault unlock (`startVestingPoint` = `endVestingPoint` = 1791324795) | - |
| 22:14:30 | `PullLiquidity` by the deployer: `ClaimPositionFee` and `RemoveAllLiquidity`; the deployer receives 115,521,863,714 lamports and 309,754,848.56 CSTARTER | `4rKyiR564P9WsbG5aetiWPeW9gaLpuvAppJ7TC6Afw4qhBqcsrwd449XNQjQkwu7cZgPu33gPuNXjRgnrxqonEEN` |
| 22:17:15 | A second campaign, Crypt Cat (CCAT), created by an unrelated pump.fun trader `D5YReTDbCEsLzrdX2iz69WJNjM73AV9GqfRyw3AVVj7m`, who paid the 0.02 SOL fee; it never took a deposit, and its 999,999,999.999 CCAT stayed in the PDA's token account `7BsHUms69iXs8oiFBCGkEr7vMUacZpocXfveML3Bu5DF` when the program was closed | `4kGQmzvyfkxNDRfMpJABb41z1Co47MHW7J3d9PhyxMgjyrBEyZreYRj7PYQ7bu32TPbNEdt3YjnWm3CAFpWWENwa` |

Harmonized (HMD, mint `G7KpnwnSCnxLUYymcyFF38LzC5pKB46BZqvczPfAw3fk`, pool `6GiMQxa5vAJPKwmUWAxAz62w6eDhbMpyCpomL85WSQVw`, vault `E5rmTS7x...`):

| Time 2026-10-08 | Step | Transaction |
| - | - | - |
| 00:09:33 | `Propose` and `OpenAccord`, the same flow as `CreateLaunch` and `OpenQueue` | `4m7g9MbDaejErszDqZAsPAYLuPRgjtNXxndhuR9FSAjTg3b3oA4oXH2JfXgFikhjpFAdZp55qoyGmM1yUryf9df3` |
| 00:09:46 to 00:14:42 | 55 `AddVoice` joins | first `5LKJunipjhZ8YSrM4X2MP965B6nDz8yxJKjeumq4niC3FdhwESTjrBw8yCw1MZ79eqb2KfXKJJDa44DtCRBkyrXZ`, last `3igdbQ3D...` above |
| 00:29:43 to 00:29:51 | three `CountVoices` calls, then `Harmonize`: `AddLiquidity` of 999,999,999.999 HMD single-sided | `35bC2xw9REdMV1LGH6xkntmZaUsv57bzGUBPh3GEw3RXZJCR8u2jQPK8fc9vpqKbu3ZjeFLtF3GwPUnem9YGnhqv` |
| 00:34:35 | `FillDammV2` cranked by the deployer: 40 SOL buys 327,889,163.2 HMD (32.8%) | `3SmKmG96PfcdzBRPGXxFaxCRXkLVoZTbv7eMLJZURXVoiUzcUV7TdLJW7sn5WdqNqGAmKS7c8SffJLE9C4LFRNiA` |
| 01:34:33 | Pool activation; vault unlock at 01:34:34; first public buy at 01:34:37 | `5JbXvcVvjSW5xtLoXegxru7NXqh8tscnzamgzvoUxjiWAt5B3bXXWg7KS7vTrBdBVq3R3kBgqZkwnyHP3pErcrfY` |
| 01:49:26 | `RetrieveLiquidity` by the deployer: 67,027,552,503 lamports and 550,303,346.77 HMD | `3DoMrhqUPPFMPpx8sdumuqMoZZTFPL8Z1Te6D24brGhqdocyHZnYUsjrHt8HdQBjF8s4ey3oYMu5mKph6iSaoqQ` |

- Launch arguments, decoded from the instruction data after the name, symbol and URI strings:
  - CSTARTER: 25 SOL and 50 SOL, 3,600 s;
  - CCAT: 5 SOL and 20 SOL, 21,600 s;
  - HMD: 20 SOL and 40 SOL, then a u32 of 50 and 1,200 s.
  The 3,600 s and 1,200 s match the gaps from creation to `Commit` and to `CountVoices`; the u32 of 50 matches the quorum in Harmonized's pitch.
  The cryptstarter.com capture showed CSTARTER as "Goal 50 · Cap 50" ([capture][cs-home]), so what the 25 SOL value means is **Unverified**.
- Both pools, decoded with `@meteora-ag/cp-amm-sdk`:
  - a flat 1% base fee, with no fee scheduler periods and the dynamic fee off;
  - fees collected in SOL only (`collectFeeMode` 1);
  - `whitelistedVault` set to the vault, and `creator` the PDA;
  - a price range from the initial price to 10^6 times it;
  - one position, `permanentLockLiquidity` 0, and `liquidity` now 0.
  The CSTARTER pool's lifetime fees were 4.353 SOL to the position and 0.921 SOL of protocol fee, claimed through `ClaimProtocolFee2` at 23:00:46 (`5rJkJyr5VYerF4pKksLxSNZmgd3M9c9BbHwnpSsDqyPDWdvKHrk781mCGF7Gee3NNMA7RQBib9Xmh6PicZm5YbAW`).
- Vaults: Pro Rata, authority mode (`whitelistMode` 2), timestamp activation, `depositingPoint` at creation, no vesting:
  - CSTARTER: `maxBuyingCap` 50 SOL, `totalDeposit` 50.140 SOL, `totalRefund` 0.128 SOL;
  - HMD: `maxBuyingCap` 40 SOL, `totalDeposit` 41.708 SOL, `totalRefund` 1.708 SOL.

### E4. Trading after the open

| | CSTARTER | HMD |
| - | - | - |
| Open to liquidity pull | 76 s | 14 min 53 s |
| Successful swaps, distinct fee payers | 414, 137 | 54, 37 |
| First public fill against the vault's average price | 2.09 times | 1.50 times |
| Highest swap average price against the vault's | 9.34 times, at 22:13:30 | 2.21 times, at 01:45:44 |
| Last swap before the pull | 5.17 times | 2.21 times |
| Traders without an escrow: SOL in, SOL out, net | 279.21, 174.65, -104.56 (132 payers) | 33.75, 6.77, -26.99 (28 payers) |
| Escrow owners: SOL from sells | 38.12 | 4.48 (after 4.68 in buys) |
| Failed transactions on the pool before the open, then until the pull | 164, 139 (25 payers) | 55, 166 (3 payers) |

- Prices are each swap's SOL over its token amount, from the pool vaults' balance changes.
- The first CSTARTER buy came from `vampJFQn7cfVgXfuPmecVdjVrt33DWGxe4WvWmXk84t` through a program whose id starts `vampPz`, at 5 SOL in the activation second; it sold 16 s later for 16.40 SOL (`3PzHjcVhbEiyoLJfkGhPiZXD3GvHpC3EFH5fyPxTmYzVQ4gweP93Uzn4FyYVULrytFdxPchzpVZbP9d3mXSydXVq`).
- Of the 414 CSTARTER swaps, 335 went through `FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9`, 45 straight to DAMM v2, 15 through `term9YPb9mzAsABaqN71A4xdbxHmpBNZavpBiQKZzN3` and 9 through Jupiter; what the `FLASHX` program is (a bot router, by its traffic) is **Unverified**.
- The deployer's CSTARTER result: 115.52 SOL pulled, less its 27 wallets' 26.66 SOL of deposits, is about 88.9 SOL.
  That matches the losses of the traders without an escrow (104.56 SOL) and of the nine other escrow owners (10.68 SOL), less the bot cluster's gain (25.32 SOL) and Meteora's 0.92 SOL fee.

### E5. Who joined

Funding traced over each escrow owner's SOL transfers (up to 150 transactions each).

CSTARTER, 46 escrows:

| Group | Escrows | Deposited (SOL) | Evidence |
| - | - | - | - |
| Deployer's wallets | 27 | 26.66 | All 27 sent SOL to the deployer between 13:22:22 and 13:23:20 on 2026-10-07, 20.27 SOL in all (first `64ZmWssv3WUXcPyaffxzLKMLA2qCHeJJkcLiBNr5MoNqNVSHGxQKcGS2D8KQ9wYc1fFghwp4gkm3WUVDTw7o1qPo`, last `4QF52dwdGQrsppmU4d4w4i1BCNZr1XCPSXrqTBo8n1yr62RQmfuh2JRVwBrAqNDvURAcN7bnfVECYRxyuVQn9fAx`); they never sold, and claimed their coins after the pull, from 22:54 |
| Bot trader's cluster | 10 | 12.80 | Funded with 1.3 SOL each from `pumpSuAxFePbNXz2CbmfJfrWNCgb4LbxafWRGYFhAfQ` (26,357 signatures since 2026-08-09, trades through `FLASHX...`) or its relay `Ag8yiH55mNgtZEM7fFZv2VQabYbpPNDpnAhm8TjPfp7J`, between 20:12 and 20:18; five of them sold 38.12 SOL into the opening bots at 22:13:30 and 22:13:50 (`26tz6rJN366Xz1SsVXvCrRsiXCn2nvozZ8UnRG9DEPFdGnLSobgWdLLZmtx9dsvFA8rWVdMdsyoRyxR3oydHnCm2`, `7vSevt1rDyrJNphyirnTBi7v4gpuaGffmtTcpsrABNce9MtUUU3JfcijqsXZf31Bd9X5AaR4XKkGNhRzmiVca5b`) and sent the proceeds to `Ag8yiH55...` |
| Others | 9 | 10.68 | Older wallets, six of them funding each other (`D3bcLqWJ...`, `MYGpCXKC...`, `3LEKLGFi...`, `YxrAZWHA...`, `854QJ8K2...`, `Cw7zcDmB...`); none sold before the pull |

- The deployer's 27 wallets share one funding pattern.
  Most had 14 to 19 transactions (seven had 29 to 67), and each was first funded 0.4 to 1.9 days before the launch, with about 0.1 SOL from an exchange hot wallet: Binance 2 `5tzFkiKs...`, KuCoin `BmFdpraQ...`, Bybit Wallet 10 `iGdFcQoyR2MwbXMHQskhmNsqddZ6rinsipHc4TNSdwu` or Gate `u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w` (Solscan labels).
  Each then received a pair of equal transfers from two fresh wallets in the same minute, for example 0.191 SOL twice into `5L8a1rbM...` at 15:32 on 2026-10-06.
  All 27 were funded before the program existed (19:58), and they joined from 35 s after the launch.
- HMD, 55 escrows: 44 owners had their first transaction less than two days before the launch, with the same exchange-then-twin-hop funding.
  Two older trading wallets that fund each other, `BX4a9PRTA2QLw73f1cDQK7LyNt5uRm9BMvLJ7yJegnbL` and `EMPRzHkrPQBj9EWe6KE88e3sWSkPkFYwtwn9iyGrk2xW`, withdrew at 00:16 and 00:17 (`25ESzMCJ5hqwCaQaxT6hiRMKGnnWTH9dd2cFiCoJ9zLqPQH6sJ4Sh7zKJHef1vWhJhRJ89S8kh6SNR1qi2Hem29i`), leaving two escrows at zero.
- 20 of the 46 Cryptstarter join transactions carry Lighthouse (`L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`) assertion instructions, which a browser wallet adds, so some joins went through a web wallet.

### E6. Money in and out of the deployers

- `C4mpYCuY...`:
  - funded only by 2.752751 SOL from Binance 2 at 10:24:07 on 2026-10-06 (`5u15thWMYs9f5o4ZdbqjQGdxGyE5UHicMCmZ8ZZ1QQTc142NQvxmmCsSdSrm7bVmJ2HYGbENiVsT6cFvCDV14hc1`);
  - after the pull, sent 100 SOL to `9Lp3eqPQxxZJmRm9DoZwF9TZsWxrVW46EoxLoNNPefzQ` at 22:18:40 (`2XC4Bwqr3NGJH6KqD7njPqWu6LYtw1qhRqs5QnXLFXsuCDGjKBdDL9pYMK9iMY3Rmna5UKjvELXXtmHVQoLVPV5Y`) and 15.387 SOL to `6hrxva81E648pKAbxrtuvykid3BzGXdrdgdUxuZFgdvc` at 22:24:50 (`3e28EM4KCCeKLioh9uVwy8yDujyyy7pXh7WLNxVKupHQPpeABXsdokT1kfdkUxagSmMx79eLusmfcUXx3PnYQ4Li`);
  - the next day, sent 22.62 SOL to `HRBKkLAAN88sqCRPyAam7toLVvUh4Rvo9UvcfZ3RZBrd` (`n1VVGASEVsMntZEyYcuJ28XfekRAffQ6Rzf8b5BkW9dhZc7PGriaKrgrP4HK3SUrEtiNuqWKg9o19iWBcrQa2ub`) and 7.485 SOL to `4iUyULVWSohZogcjpQKVmC4aqpXaQLZaDicV1fUzEQG4` (`3BMdXjpjBgy9LynPrmnY32PiALuNrnjHUUeALCunFLEDu1zgbQgJSrenyjab8UsLWL467FXMUohQqABH9GuLiJHk`), a wallet first funded from KuCoin in August 2026.
  - `6hrxva81...` and `HRBKkLAA...` each forwarded the whole amount within seconds and were never used again.
- `5cmQHjA9...`:
  - funded only by 3.32676 SOL from KuCoin at 11:01:12 on 2026-10-06 (`2PumzAHVxJybeCmG4kBG4zva1tW9suvvvz8NQXvfqpgAYsDD1jjcCb4ebJzGxuGLPL9PwW9qQcfRms6pmrwHgveU`);
  - sent 70.312882 SOL to `5FKCweuqzKikTuiug42dszKeZCr7HV8jpkHGToVcKCvX` one minute after closing the program (`2RqHQUB8NQ2561pH7Cf6EngDB26pe3rRoswH2VTgp2kS3tDD6JgMfDYqpvQEPcj9g5dqdb6Rkda2GrrFLz4aKJcr`), a wallet active since November 2025 that first received USDC from KuCoin.
- The exchange labels come from Solscan account pages: "Binance 2", "KuCoin Hot Wallet (BmFdp)", "Bybit Wallet 10", "Gate Hot Wallet (u6PJ8)".
  Helius's wallet identity API returned 403 on this plan.

### E7. One operator, at least five programs

- The two mainnet programs run the same code under new names:
  - `InitGlobal` has the same 50-byte layout and values: the deployer as admin, 20,000,000 lamports, and a u16 of 25;
  - `AddLaunchConfig` matches byte for byte except one u16 (5000 against 3300), and Harmonized appends a u32 of 25 and a u64 of 250,000,000;
  - the launch transaction repeats every lamport: a 100,000,000-lamport prefund to the PDA, refunds of 83,500,160 and 96,952,000 lamports, a pool seeded with 1,000 raw base units and 1 lamport, and a 20,000,000-lamport fee to the deployer;
  - the same raise/39 cap rule;
  - the instruction set maps one to one (`CreateLaunch`/`Propose`, `OpenQueue`/`OpenAccord`, `Join`/`AddVoice`, `Commit`/`CountVoices` and `Harmonize`, `PullLiquidity`/`RetrieveLiquidity`).
- Both programs' joining wallets swept SOL into one wallet, `FJeSoLmGzNvCNC55X92T9tye34gg8t35REpVXZkVyigy`, at the same time.
  Six CSTARTER operator wallets did so from 21:44:33 to 21:46:59 on 2026-10-17 (for example `4yrGNAbGmoQeaS4w26tK9m95kYgaXtsRqbrjTkgEoa5xqd7hTcvLFbKfZFfQZ4XpinZQSbMSgntbJkuHipuzWU7F`), and 36 HMD escrow owners from 21:44:29 to 21:48:56 (for example `5GvFVxgBrwz7csngDpHoJhJcPFM6cP5FBLRyE4nEEhVqaMCJQ7XDj53njY8wHLegvSeFWAY9d7M7PpkjNeJ9hp2K`).
- The same wallet fleet then bought into three more single-use launch programs, each deployed by a new key and closed within one to three days:

| Program | Deployed, closed | Coin | Fleet wallets among its signers | Exit |
| - | - | - | - | - |
| `DBZ4kpf3auFcPspomkWsPWHr8BeSshQFU1ePcQPKgj6e` | 2026-10-08 11:44:19 (`61cxNzsLK6tDFcK2oyj6P5LttpKThJXzgQqAhSsVk1MddsH61xNf5yvKA9AN7qaHgCs2kkAk1nEP2So61aLSsDDe`), 2026-10-09 10:21:56 | CAKEDOG, created 12:13:14 | 28 HMD escrow owners | `PullLiquidity` at 12:37:16, deployer `28x4ZvKy5E3iNhXahrVsPSqhwci4n2oVtXEwRHhyk4jK` +97.52 SOL (`jNc6cpBkVYmY9cf64yJZrnh483kYCmrxpxeeL4UA3mVyVM9HowuGyAwdGknpLa7kfc3qQiJYgdQxPfBvJqe2AjF`) |
| `ivy2VQCjyYEKAGT3oFx3pcyiYeAPKHeP6H6NQjG5oHb` | 2026-10-16 00:38:15 (`x6QtvX8P1zqXnTfdGvUuNjMpjq8c68uKL3Ch5AkFArrcqMekGqgRnJo5sAMvUjbKefYLeehn5ER65qjdi7fvco3`), 2026-10-19 13:42:18 | IVY, created 00:39:34 | 23 HMD and 2 CSTARTER escrow owners | `WithdrawPool` at 00:58:00, deployer `43ioxZ6EXamU8VkZ7wELVtMQkGPaVYF6w1FfvpHeVmWC` +219.59 SOL (`4z8S68RxMWnhHreJhyRR6Jp8isH92qKiwWe9eEuJsduE19UXqi44wx9cHbcAKZfTYX8DLbTJ8MDTy26gic84oN1K`) |
| `8xgfMLpC1Kukf8QMdXH5z1W7VNyHYL1R4JmZ18LyufMb` | 2026-10-16 23:52:19 (`2t2DDNfsVAdrMvTzo8tPa51sfQ1D92zvgWpctdCBxugcf1aV6GhkJt8yDF1V5SgS3CFAUEbJwq1YjxzdxPXc3BLJ`), 2026-10-17 21:42:37 | lo0m (`https://lo0m.org/token/lo0m.json`), `Initialize` 00:12:25 | 9 HMD and 3 CSTARTER escrow owners | not traced; `ReclaimAuthoritySol` at 21:42:23, two minutes before the fleet swept to `FJeSoLmG...` |

- These three are bonding-curve programs with no Alpha Vault (instructions `CreateToken`, `Buy`, `Migrate`, `PullLiquidity`; `Create`, `BuyExactSolIn`, `Migrate`, `WithdrawPool`; `Initialize`, `Buy`, `Bond`, `Migrate`, `ReclaimAuthoritySol`).

### E8. The sites and accounts

- cryptstarter.com, as captured by the Internet Archive at 20:35:16 on 2026-10-06 ([home][cs-home], [CSTARTER page][cs-coin]):
  - "Every coin on Cryptstarter launches through a crowdfunding campaign. If it hits its goal, all backers buy in together at one price. If it doesn't, everyone gets their SOL back."
  - "100% back if it misses", "One price for everyone. A single pooled buy. No snipers, no early cheap seats", "Over the cap? Refunded. Everyone fills pro-rata."
  - "Featured campaign ... Cryptstarter $CSTARTER by @CryptstarterSol ... Goal 50 · Cap 50."
  - "Powered by Meteora. Launch liquidity is held by the Cryptstarter program and can be withdrawn by the platform's liquidity controller."
- cryptstarter.com today: the domain was created in 2014 and last updated on 2026-10-06 (GoDaddy whois), it has no A record, and a request gets no answer.
  The Archive also holds 2025 pages of an EVM-era site at the same domain, such as `/token/0xb688459a7bB548D5506d98adB9221aD7cD530cfe` ([capture list][cs-cdx]).
- Crypt Cat's image URL is on `6ac56f2dca645b7d7ba91d67--cryptstarter.netlify.app`, so the front end was a Netlify site (Helius DAS `getAsset`).
- [@CryptstarterSol][x-cs] posts:
  - 13:45 on 2026-10-06, a bare link;
  - 20:10, "Introducing Cryptstarter ... No snipers. No whales ... The first and official campaign is live" ([post][x-cs-intro]);
  - 21:14, "Funded. The first Cryptstarter campaign closed with an overflow of 50.14 SOL from 46 backers ... $CSTARTER will open for trading after the Meteora bonding process which takes one hour" ([post][x-cs-funded]).
  These posts had 80 to 359 views.
- [@HarmonizedPad][x-hp] posts:
  - 23:57 on 2026-10-07, "No coin launches alone. Harmonized is a consensus launchpad on Solana. A coin only goes live when enough real wallets agree" ([post][x-hp-intro]);
  - 01:35:47 on 2026-10-08, "$HMD is live on @MeteoraAG. Voices: claim your coins and any refund in one click at ... CA: G7Kpnwn..." ([post][x-hp-live]), with 60 likes on 647 views from an account of 55 followers.
- The HMD metadata JSON (`https://harmonized.org/api/meta/QmaBt6ZHr8xQrE68QYieF2akxxfPQAkTtcFSZbpDtEXTUj`) was served when Helius DAS indexed it, with the description "The first coin launched on Harmonized. No coin launches alone." and the image on `harmonized.org/api/ipfs/`; today that URL returns 404.
- harmonized.org today: "Harmonized launches tokens on Uniswap and up. at the same price, in the same block, and lets Uniswap's new Aggregator Hooks route between them ... Built on Robinhood Chain", linking to x.com/harmonizedhooks, which no longer exists.
  It lists Launcher `0x91993bd0a2538D2eA013571949a520b84F6dD54B`, Migration `0x5816A5975352046FCe7fea627D2fF5bb1e2e6767` and Aggregator Hook `0xA1f9CDa5fB5c662eA7712302e3aB7BDAAcd92888`.
  On Robinhood Chain's Blockscout, the Launcher is a verified contract named `HarmonizedLauncher`, created through the CREATE2 factory `0x4e59b44847b379578588920cA78FbF26c0B4956C`, with its first transaction on 2026-10-23.
- Web search found no news, review or rug report about Cryptstarter, CSTARTER, Harmonized or HMD on Solana.

### E9. Vaultz on devnet

- Joins tabulated over every successful `BuyIntoVault`:
  - `8rpD...`: 36 joins into 7 vaults by 6 distinct wallets, each vault taking one fixed amount (for example 526,315,789 lamports, which is 0.5 SOL plus 5%); `6u165geHf487ppnYKLUw1hJTxVnAJW1ZzYMYjP5dBViH` and `91kaGFUULL52exNQZiWBmX6knQXdnDY52L8rEkNAk5Ug` joined single vaults three times each;
  - `EqFH...`: 84 joins into 52 vaults by 12 distinct wallets, 48 of them by the deployer `CJUniU73...`.
- One `8rpD...` join, user `CEtuR4hv8hsULQGtyN9CFieDG7EcCj8tDxWKt1TVEnN9` only signer (`4R1JMXTVi6THY9Ex2EjiU6TggHdgQQj5KiCMAMnHpAByUJ4NLNrJBEAX4vHcKq5Kd5sz14eKqBasaafzEDWcGfM1`, 2026-06-21 01:54:57):
  - the argument is 526,315,789 lamports;
  - the user pays 13,157,894 lamports to `DZM5SUFNThmzarZzKiJouwxh1XZtSstwbnN2F4vNCz3k` and 13,157,895 to a wrapped-SOL account of `Hxth8M8F2MsEq6oHSH3sREg1Vmzsu5Zn7PhAyy959Zuu`, and wraps 0.5 SOL in a token account owned by the custody PDA `J4Ai5eXPRkatYa7L4h9vmcih1vcY8HddNxzTu4eSMXpi`;
  - the program creates two accounts of its own (92 and 134 bytes), the vault authority PDA `7RzUsnkfSYNqoM9RawbnCh4JzFhqTRfsHzW6C6pv4dPr` creates the escrow, and the deposit is made by CPI.
  What the two 2.5% payments are for is inferred from the instruction names (`InitBackerYieldPool`, `BindProjectTreasuryMeteoraVault`, `UpdatePlatformFee`) and is **Unverified**.
- Backer NFT metadata on IPFS: "HOOD NINJA #1 ... Trade on Magic Eden, OpenSea, or hold for token claim", `external_url` `https://vltz.io/vault/G5q1VwK9i1qEvZX59xpWZVrbRRP7RdpfBpGVM8ANphXp`, collection family "Vaultz" ([NINJA #1][vz-nft]); the other collections are SPACEBOT, ZUCK, MDEV, ALIENS, LAMBO and SAC.
- The Alpha Vault survey of 2026-10-26 ([alpha-vault-authority E3][avauth]) found off-curve authorities as follows:
  - mainnet: three vaults, owned by the PDAs `J7Hj3ebE...` (Cryptstarter, two vaults) and `2j7Dx9iw...` (Harmonized, one);
  - devnet: 77 vaults, owned by `3yDt46K2T4hkpNQSPHUrzzFK4RBDkD6Zf1zM4CHLPsb6` (68 vaults, `EqFH...`), `7RzUsnk...` (8 vaults, `8rpD...`) and `EV8xRhANrC6q3S9nWZmkqCHooWKWRJUUpQ5v6bceeFBf` (1 vault, created by the Vaultz test wallet `F3qjAbnjzxcV4RPSxV3JasfZWViqHEEdLBP8gPbRkp3D`, which then called `RegisterVaultLaunch` on `Gyfuaf...`).
- vltz.io: registered on 2026-06-02 (Namecheap whois); its live title is "Vaultz - Anti-snipe launch vaults on Robinhood Chain", described as "a permissionless presale vault protocol on Robinhood Chain. Raise ETH, auto-migrate to a locked Uniswap v3 position, launch without handing bots the first block."
- X posts:
  - [@PhronisInc][x-ph], 2026-06-02: "By honest Devz built for honest Devz!!Vaultz Launchpad coming soon @MeteoraAG @solana";
  - @PhronisInc, 2026-06-04: "Launch on Vaultz no snipers no bots Bond using @MeteoraAG Alpha Vaults!!!";
  - [@phronisceo][x-phceo-mint], 2026-06-22: "$SPACEMOUSE vault is live on Vaultz 0.3 SOL in vault · Mint open · 6d 23h left · 1 holder Mint with us - fixed price, one NFT per wallet. #Vaultz #Solana".
  @PhronisInc describes itself as "Digital asset infrastructure", located in the United States.

### E10. Method

- Scripts, in `scratchpad/prior-art/scripts/` of the session:
  - `program_history.cjs`: every signature and transaction of an address, with program data metadata only, never program bytes;
  - `tx_detail.py`: instruction trees from logs, instruction data, balance changes;
  - `pool_flows.py` and `group_outcomes.py`: pool vault deltas per transaction and per wallet;
  - `escrows.cjs`: escrows decoded with `@meteora-ag/alpha-vault` 1.1.16;
  - `accounts.cjs`: vaults and pools decoded with `@meteora-ag/alpha-vault` and `@meteora-ag/cp-amm-sdk` 1.5.1;
  - `owner_trace.cjs` and `owner_clusters.py`: escrow owners' SOL transfers;
  - `funders.cjs`: oldest and newest transactions of an address;
  - `vaultz_joins.py`: Vaultz joins;
  - `xapi.cjs`: X lookups.
- Transaction pages: `https://solscan.io/tx/<signature>`, with `?cluster=devnet` for devnet; account pages: `https://solscan.io/account/<address>`.
- Some mainnet transactions are now version 1, so `getTransaction` needs `maxSupportedTransactionVersion: 1`.

[avauth]: https://github.com/imDev2023/top-pad/blob/research/alpha-vault-authority/research/alpha-vault-authority.md
[cs-home]: https://web.archive.org/web/20261006203516/https://cryptstarter.com/
[cs-coin]: https://web.archive.org/web/20261006203423/https://cryptstarter.com/c/A3ET5bFFxvxj6nDaScvvUYGchaPAn8p8Yg2rHdUYsiQ4
[cs-cdx]: https://web.archive.org/web/*/cryptstarter.com*
[x-cs]: https://x.com/CryptstarterSol
[x-cs-intro]: https://x.com/CryptstarterSol/status/2107564124427391081
[x-cs-funded]: https://x.com/CryptstarterSol/status/2107580270077734966
[x-csbnb]: https://x.com/CryptstarterBNB/status/1983182341846503434
[x-hp]: https://x.com/HarmonizedPad
[x-hp-intro]: https://x.com/HarmonizedPad/status/2107983621172646075
[x-hp-live]: https://x.com/HarmonizedPad/status/2108008423841247692
[x-vz]: https://x.com/LaunchOnVaultz
[x-ph]: https://x.com/PhronisInc/status/2062565986683748720
[x-phceo]: https://x.com/phronisceo
[x-phceo-mint]: https://x.com/phronisceo/status/2068859891578466556
[x-hood]: https://x.com/hooddailynfts/status/2109299142698676693
[vz-nft]: https://gateway.pinata.cloud/ipfs/bafkreif4l6dbzyx2bhjdulxmo3d34kfw6qo4momlmxyodc76ylytcklf44
[hashex-hmz]: https://hashex.org/auto-audits/solana/GNRZPsLwW9wxdqzDwYa3Qm9XVpQSX9rmEx49w5AHpump
