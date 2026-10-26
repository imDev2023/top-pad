# How terminals show a Fair Open launch: vault buyers, locked creator supply and launch-pool coins

Research for ticket [#27](https://github.com/imDev2023/top-pad/issues/27) on the Top-pad wayfinder map, captured 2026-10-26.
It follows [research/terminal-distribution.md](https://github.com/imDev2023/top-pad/blob/research/terminal-distribution/research/terminal-distribution.md) (terminals compute their own dev, sniper, insider and bundler figures) and [research/dlmm-fair-open.md](https://github.com/imDev2023/top-pad/blob/research/dlmm-fair-open/research/dlmm-fair-open.md) (Fair Open runs on a DLMM launch pool with an Alpha Vault).
Terms follow [GLOSSARY.md](https://github.com/imDev2023/top-pad/blob/main/GLOSSARY.md).
Every figure below is what a terminal's own API, page or shipped client code returned for a real mainnet coin on 2026-10-26, unless marked otherwise.
**Unverified** marks a claim no primary source confirmed, usually because the app is behind a login.

## Answer

- Nobody flags Alpha Vault depositors as insiders or snipers today, but for different reasons per terminal, and the reasons matter more than the result.
- Jupiter computes snipers and insiders only for coins it recognises as launchpad coins, and 657 of 661 filled mainnet Alpha Vault coins have no launchpad on Jupiter, so its token page simply hides Dev, Snipers, Insiders and Bundlers for them.
- What Jupiter does show is the vault's buy as one trade by whoever cranked it: on ROUTER, BILLZ and CWU the cranker was Jupiter's "dev" wallet, so the coin's first trade reads as the dev buying 33%, 48% and 88% of supply an hour before open.
- GMGN tags vault claimers `transfer_in` (126 of the 127 depositors found among the top 100 holders of six coins), its "suspected phishing wallet" signal ("many phishing-tagged wallets from one token source spread tokens"), and tags the vault account itself `rat_trader` (insider) while it still holds unclaimed tokens.
- RugCheck never puts the vault or the claims in an insider network, but does link depositors who move tokens between their own wallets after claiming, which is a sybil signal Top-pad can use.
- Locked creator supply reads differently on every terminal and no lock reads clean everywhere: Jupiter labels a Jupiter Lock escrow "Jupiter Lock" but counts it in Top 10; GMGN tags the same escrow `rat_trader` and counts it as 0% locked; RugCheck knows it on one coin of four and warns "Single holder ownership" on two of the other three.
- Streamflow locks are the mirror image: GMGN counts them in `locked_ratio` and RugCheck names them "Streamflow Vault", while Jupiter shows an unlabelled whale.
- A locked DLMM seed position is invisible as a lock: RugCheck flags BILLZ "Large Amount of LP Unlocked 100%" (danger) although its seed positions are locked to 2036, and GMGN reports it unlocked; a locked DAMM v2 position is read (RugCheck 100% locked on CWU).
- Launch-pool coins carry no launchpad identity anywhere checked: Jupiter `launchpad` null, GMGN `launchpad` empty, DexScreener "Meteora - DLMM" or "Meteora - DYN2" with no "via", RugCheck `deployPlatform` "unknown"; DBC coins get `met-dbc`, `meteora_virtual_curve` and "via DBC".
- They also miss the new-launch columns at the moment that matters: Jupiter's New column lists a coin when its first pool is created, which was 75 to 120 minutes before trading opened on the four memecoin-scale launches, and the column held only 28 seconds of launches; GMGN's Trenches leaves plain Meteora pools out by default.
- For Fair Open's design this means: never crank the vault from the creator's or any dev wallet; keep vesting zero or minutes long so the vault does not sit as an anonymous whale; expect DLMM or DAMM v2 Fair Opens to be clean but unbranded; and expect a DBC-based Fair Open (recognised as a launchpad coin) to risk the opposite, since Jupiter's definition makes a first-block vault buy an insider and passes that status to every claimer (unverified, untested).

### The coins

Alpha Vault launches (vault data decoded from the Alpha Vault program `vaU6kP7iNEGkbmPkLmZfGwiGxd4Mob24QQCie5R9kd2`; depositor wallets from its Escrow accounts):

| Coin | Mint | Pool | Vault | Depositors | Trading opened | Notes |
| - | - | - | - | - | - | - |
| ROUTER (Solrouter) | `6SjVTj1VGwFSXn7wEjwFm77LvACeTqB7sQUebYKX8Ds5` | DLMM customizable `DJ8qzBm3...` | FCFS, Merkle, `F3Yygo5N...` | 117 | 2026-04-30 16:42 UTC | OpenServ launch; vesting 15 minutes |
| BILLZ | `6V1rcRMaw4bZ32DK9WrbG1k9FA2h9Yw64dv9v9ph1Y3x` | DLMM customizable `57DYHtHi...` | FCFS, Merkle, `HqbRkCTK...` | 115 | 2026-05-21 17:26 UTC | OpenServ launch; 20% of supply in a Streamflow lock; seed positions locked to 2036 |
| CWU | `CmVUoJUt7hMGc9ze7s8zYdnA7enMfCAFdQCggxcbACWU` | DAMM v2 `DKQiZKjk...` | FCFS, Merkle, `3jTh2sgF...` | 217 | 2026-04-09 02:08 UTC | |
| XST | `XSTuo1fV7HHMhs4BYiwtrWSLsMCJNrooH2AssWTYZqP` | DAMM v2 `4tSYkRZo...` | Pro Rata, authority, `3BusaY32...` | 100 | 2026-07-23 23:19 UTC | 69,037 holders |
| HUMA | `HUMA1821qVDKta3u2ovmfDQeW2fSQouSKE8fkF44wvGw` | DLMM permission pairs | Pro Rata, Merkle, `8gCqHrCc...`, `DrqECfsv...` | 3,567 + 26,568 | 2025-05-25 13:05 UTC | partner launch |
| DOOD (Doodles) | `DvjbEsdca43oQcw2h3HW1CT7N3x5vRcr3QrvTUHnXvgV` | DLMM customizable `HYXkzMD7...` | FCFS, Merkle, `GCfw6GTR...` | 1,204 | 2025-05-09 13:05 UTC | |
| CLOUD (now SANC) | `CLoUDKc4Ane7HeQcPpE3YHnznRxhMimJ4MyaUqyHFzAu` | DLMM permission pair `3v94LDob...` | Pro Rata, open, `6PpD39Xu...` | 5,011 | 2024-07-18 | Sanctum's launch with Meteora |

OpenServ describes its mechanism as a Fair Open in all but name: trading locked at launch, a 21-minute deposit window, "Cap: 1 SOL per wallet", one atomic vault buy "at the same entry", and "Vault tokens fully unlock after 15 minutes" ([OpenServ on X, 2026-04-29](https://x.com/openservai/status/2049510348584345969)).

DBC comparison coins with `locked_vesting` (Jupiter Lock escrows created by DBC's `create_locker`, recipient the pool creator):

| Coin | Mint | Jupiter launchpad | Locked share of supply now | Lock escrow | Vesting ends |
| - | - | - | - | - | - |
| SUAREZ | `ASTLouBaXXQbbmE2gf7C1sbhm6MUopFCrZ46W8qytrnd` | `met-dbc` | 33.33% | `4iMYu7DT...` | 2027-11-19 |
| MODRIC | `F5qFr17LeunQk5ikRM9hseSi2bbZYXYRum8zaTegtrnd` | `met-dbc` | 12.50% | `FSbNP76H...` | 2027-10-17 |
| STEALF | `G5W6LwkLeoj6rZqBP1y3KT8k6Cz6rXGJmMNU3TArXtXw` | `met-dbc` | 20.62% | `9bMpgMNP...` | 2028-09-14 |
| CANDLE | `A8bcY1eSenMiMy75vgSnp6ShMfWHRHjeM6JxfM1CNDL` | `candle` | 21.68% | `GiJDRj4e...` | 2028-04-25 |

### 1. Are vault depositors flagged as insiders, snipers or bundlers?

| Terminal | ROUTER | BILLZ | CWU | HUMA | DBC comparison (SUAREZ, STEALF) |
| - | - | - | - | - | - |
| Jupiter Spot token page (jup.ag, formerly Pro) | No launchpad, so Token Info shows only Top 10 H., Freeze Auth and Mint Auth; no Dev, Snipers, Insiders or Bundlers cell; Sniper, Insider and Bundler filters hidden | Same | Same | Same | Full panel: Top 10 H., Dev H., Snipers H., Insiders H., Bundlers H., Pro Traders, Dex Paid, DA |
| Jupiter trades (how the vault buy appears) | First trade: "buy" of 32.97% of supply ($9,665) by `7Da5dpUb...`, Jupiter's dev, 1 hour before open; it is the vault's `fill_dlmm` signed by that wallet | First trade: 48.46% of supply ($28,110) by the same dev wallet `7Da5dpUb...`, 1 hour before open | First trade: 87.99% of supply ($72,011) by the dev `7DVrHpPm...`, 1 hour before open | First trade: 1.0% of supply ($749,822) by `Gk8VSoDb...`, Meteora's whitelisted cranker | n/a |
| Jupiter holder tags (`sniper` / `insider` / `bundler` holders, and depositors among them) | 0 / 0 / 14, depositors 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 58, depositors 0 | SUAREZ 0 / 0 / 0; STEALF 2 / 1 / 1, lock escrow not among them |
| Jupiter Tokens API `audit` | No sniper or insider fields; top 10 55.09%; dev balance 0; `devMints` 55 | Top 10 50.59%; dev balance 0 | Top 10 16.86% | Top 10 76.48% | SUAREZ: top 10 62.53%, dev balance 16.67%, `devMigrations` 1; no sniper or insider value (shown as 0%) |
| GMGN | 5 of 5 depositors in the top 100 tagged `transfer_in`, all received from the vault; 0 depositors tagged sniper or `rat_trader`; 1 tagged bundler; the vault account itself tagged `rat_trader` + `transfer_in` | 15 of 16 depositors in the top 100 tagged `transfer_in`; 0 sniper, 0 `rat_trader`; 8 of 66 bundler-tagged holders are depositors | 71 of 71 depositors in the top 100 tagged `transfer_in`; 0 sniper, 0 `rat_trader`; 8 of 100 bundler-tagged are depositors; "entrapment" share 95.7% | 2 of 2 depositors in the top 100 tagged `transfer_in`; 0 sniper, 0 `rat_trader`; 2 of 100 bundler-tagged | SUAREZ: no depositors; the Jupiter Lock escrow tagged `rat_trader` + `transfer_in` |
| RugCheck | 0 of 20 top holders flagged insider; two transfer networks: 5 wallets, all depositors, linked by transfers between them, and 20 wallets with no depositor; the vault is never a node | 0 of 20 flagged; three networks of 7, 4 and 4 wallets, 9 of them depositors, linked depositor to depositor | 0 flagged; no insider network | 0 flagged; one 110-wallet transfer network with 0 depositors | SUAREZ: 0 flagged; a 4-wallet network not involving the lock |
| DexScreener | Audit "No issues"; holder classification not captured (unverified) | No pair returned by the API or the page | Audit "No issues" | not checked | STEALF: Audit "No issues" |
| Birdeye | Unverified (holder tags need an API key) | Unverified | Unverified | Unverified | Unverified |
| Axiom, Photon | Unverified (both require a wallet login) | Unverified | Unverified | Unverified | Unverified |

Sources: the jup.ag client bundles `_tokenId-M0Y9Y_Pv.js` and `vendor-tanstack-runtime-wmJ-i0Rt.js` served with `https://jup.ag/tokens/<mint>`; `https://datapi.jup.ag/v1/assets/search?query=<mint>`, `https://datapi.jup.ag/v1/holders/<mint>?includePnl=true&tags=<tag>` and `https://datapi.jup.ag/v1/txs/<mint>?dir=asc&limit=10`; `https://api.jup.ag/tokens/v2/search`; GMGN `GET https://openapi.gmgn.ai/v1/token/info`, `/v1/token/security` and `/v1/market/token_top_holders?tag=<tag>`; RugCheck `GET https://api.rugcheck.xyz/v1/tokens/<mint>/report` and `/insiders/graph`; DexScreener pair pages; first-trade signers from `getTransaction`; all 2026-10-26.

### 2. How is locked creator supply shown?

| Terminal | DLMM seed position, locked (BILLZ pool `57DYHtHi...`, 37.3% of supply, lock to 2036) | DAMM v2 position, locked (CWU pool `DKQiZKjk...`) | Streamflow lock (BILLZ `GMrrHWbG...`, 20.0%) | Alpha Vault holding unvested or unclaimed tokens (CLOUD, HUMA, ROUTER; GCR and VTA vaults at 89.8% and 99.98%) | DBC `locked_vesting` in Jupiter Lock (SUAREZ 33.33%, MODRIC 12.5%, CANDLE 21.68%, STEALF 20.62%) |
| - | - | - | - | - | - |
| Jupiter | The pool reserve, labelled "Meteora DLMM Liquidity Pool", left out of Top 10 and of dev holding; the lock itself is not shown | Pool reserve labelled "Meteora DAMM V2 Liquidity Pool", left out of Top 10 | Unlabelled holder, counted in Top 10 (50.59% includes it) | Unlabelled holder, counted in Top 10 (VTA's Top 10 is 99.98%, all vault); CLOUD's vault is holder #79 with 0.07% | Labelled "Jupiter Lock" (tag id `Lock`), counted in Top 10 (SUAREZ 62.53% includes 33.33%), not in Dev H. (16.67% is the wallet only), never sniper, insider or bundler-tagged |
| GMGN | Pool holder (`addr_type` 2, `meteora_dlmm`); `lock_summary.is_locked` false | `lock_summary.is_locked` false | `locked_ratio` 0.2000; left out of `top_10_holder_rate` (32.15%); holder tagged `top_holder` + `transfer_in` | Holder tagged `rat_trader` + `transfer_in` (ROUTER, GCR; CLOUD and HUMA vaults `transfer_in` only); left out of `top_10_holder_rate` | Escrow tagged `top_holder` + `rat_trader` + `transfer_in`; `locked_ratio` 0; left out of `top_10_holder_rate`; the DBC pool's LP shown as 95% locked "blackhole" |
| RugCheck | "Large Amount of LP Unlocked 100.00%" (danger); `lpLockedPct` 0 on every DLMM market of every sample coin | `lpLockedPct` 100 ($167,485) | Known account "Streamflow Vault" (LOCKER); no single-holder warning | Not a known account; GCR: "Single holder ownership 89.77%" (danger), VTA: 99.98% (danger) | Known as "Jupiter Locker" on CANDLE only; on SUAREZ "Single holder ownership 33.33%" (warn), on STEALF 20.62% (warn); MODRIC's migrated DAMM v2 pool `lpLockedPct` 100 |
| DexScreener | Audit "No issues" on the pair page; locked-supply wallets only through paid Enhanced Token Info (unverified per coin) | Audit "No issues" | Unverified | Unverified | Unverified |
| Birdeye, Axiom, Photon | Unverified | Unverified | Unverified | Unverified | Unverified |

GMGN's `top_10_holder_rate` leaves out every program-owned holder seen here (pools, Streamflow, Jupiter Lock, Alpha Vault): BILLZ's 32.15% is exactly its top 10 once the pool and the 20% Streamflow lock are removed, SUAREZ's 29.29% is about Jupiter's 62.53% less the 33.33% lock, and GCR, whose vault holds 89.77%, gets a rate of 0; that the rule is "program-owned" is an inference from these four coins.

### 3. Do launch-pool coins appear in new-launch columns, and under what name?

| Terminal | Alpha Vault coins (ROUTER, BILLZ, CWU, XST, HUMA, DOOD) | DBC coins (SUAREZ, MODRIC, STEALF, CANDLE) |
| - | - | - |
| Jupiter Tokens API and datapi `launchpad` | `null` for all six; for 657 of the 661 filled mainnet Alpha Vault coins (the other four, all tiny, carry `pump.fun`, `letsbonk.fun` or `met-dbc`) | `met-dbc` with the partner config, or the launchpad's name (`candle`) |
| Jupiter AlphaScan New column | Plain new pools are listed, unlabelled: the 2026-10-26 snapshot held 2 coins without a launchpad among 30 (TMNT on a new DAMM v2 pool); the column is sorted by first-pool creation, which was 88.6, 86.1, 119.8 and 75.0 minutes before trading opened on ROUTER, BILLZ, CWU and XST, and the 30 coins spanned 28 seconds of launches | Listed by launchpad in New, Soon and Bonded (1 `met-dbc` in New, 5 in Graduating, 12 in Graduated in the snapshot) |
| Jupiter launchpad filter | The client's 92-entry launchpad list has no Alpha Vault, DLMM launch pool or OpenServ entry | `met-dbc`, `jup-studio`, `bags.fun`, `candle` and others are entries |
| GMGN token info | `launchpad` "", `launchpad_platform` "", `exchange` `meteora_dlmm` or `meteora_damm_v2` | `launchpad` and `launchpad_platform` `meteora_virtual_curve` |
| GMGN Trenches | Not in the default view: 0 plain pools among 60 new coins; only if the user adds the `pool_meteora` platform (then 59 DAMM v2 and 1 DLMM new pools) | In the default view: 8 of 60 new and 37 of 60 completed coins were `meteora_virtual_curve` |
| DexScreener pair header | "Meteora - DLMM" (ROUTER) and "Meteora - DYN2" (CWU, XST), no launchpad | "Meteora - DYN2 via DBC" (STEALF), linking to `dexscreener.com/solana/meteoradbc` |
| RugCheck | `launchpad` null, `deployPlatform` "unknown" | Same: `launchpad` null, `deployPlatform` "unknown" |
| Birdeye meme lists | Not a documented source: sources are pump_dot_fun, moonshot, raydium_launchlab, meteora_dynamic_bonding_curve and EVM launchpads | `meteora_dynamic_bonding_curve`, covered since 2025-09-20 |
| Codex | Lists "Meteora Alpha Vault" as a launchpad name; whether it tags these coins, and whether Axiom, fomo or Phantom display it, is unverified (needs an API key) | Lists `MeteoraDBC` as a protocol and many DBC launchpads by name |
| Axiom, Photon | Unverified; Axiom's Pulse is documented for pump.fun and other launchpad tokens; Photon announced Meteora DBC support in September 2026 | Photon: "Meteora DBC assets are all now supported" |

## What this means for Fair Open's design

- **Never crank the vault fill from the creator's wallet or any wallet a terminal treats as the dev.**
  Jupiter attributes the fill to its signer and labels trades by the dev wallet "Dev" with "DB"/"DS" chart markers that are on by default and not gated on launchpad, so ROUTER, BILLZ and CWU each open with a "dev bought 33 to 88% of supply" event; crank from a dedicated, publicly named Top-pad keeper wallet (as Meteora's `Gk8VSoDb...` did for HUMA and DOOD), and ask Solscan and Jupiter to label it.
- **Keep vault vesting at zero or a few minutes.**
  An Alpha Vault holding unclaimed tokens is an anonymous whale on every terminal (Jupiter Top 10, GMGN `rat_trader`, RugCheck "Single holder ownership" danger), claims need each depositor's signature (`claim_token` signer is the owner), and dead launches show the result: the vault of CTZN (`CTZNu628...`, 356 escrows) records the whole supply bought and none of it claimed.
- **Vault claims cannot come from a path GMGN reads as a buy.**
  Any non-swap delivery is `transfer_in`, GMGN's phishing signal, so every Fair Open will look airdrop-distributed on GMGN; the remedies are a GMGN-side label for the vault program or Top-pad's vault, and saying so on the Fairness card.
- **On DLMM or DAMM v2 the Fair Open reads clean but unbranded.**
  No insider or sniper figure is computed or shown, the creator lock and the seed lock are not credited, and the coin has no launchpad identity, which Top-pad must then win by asking Jupiter, GMGN, DexScreener and Codex to map its pools or vault authority, starting with Codex, which already has a "Meteora Alpha Vault" name.
- **On DBC the trade-off flips (unverified, the key risk).**
  A DBC coin is a launchpad coin on Jupiter, so insiders are computed; ticket #4's design makes our program's vault buy the pool's first swap in the creation transaction, which Jupiter's definition ("bought within the first block after launch, or received the token from another insider") would make an insider, and every claimer would inherit it; Insiders H. could then show roughly the depositors' whole share in red.
  Top-pad must get Jupiter to treat its vault PDA as a launch vault, the way it already exempts pools and labels Jupiter Lock, before choosing DBC for Fair Open.
- **Pick the creator-lock venue with the terminals in mind.**
  Jupiter Lock is labelled on Jupiter but tagged `rat_trader` and counted as unlocked on GMGN; Streamflow is credited by GMGN and RugCheck but unlabelled on Jupiter; DBC's own `locked_vesting` uses Jupiter Lock.
  Whichever is chosen, Top-pad should ask the others to recognise it, and the Fairness card should name the escrow address.
- **Prefer a lock terminals can read for the seeded liquidity.**
  RugCheck reads DAMM v2 position locks but reports a DLMM seed locked to 2036 as "LP Unlocked 100%" (danger), and GMGN credits neither, so on DLMM the seed lock protects buyers without being visible.
- **The New column moment is pool creation, not open.**
  On Jupiter a DLMM or DAMM v2 Fair Open appears 75 to 120 minutes before it can trade and scrolls out in under a minute; Top-pad's own Launch calendar and countdown, not the terminals, will carry the open.
- **Bundle Radar can borrow RugCheck's signal.**
  RugCheck's transfer networks on ROUTER and BILLZ are depositors moving tokens between each other after claiming, the pattern a capped Fair Open's sybil wallets leave behind.

## Findings per terminal

### Jupiter (Spot token page, AlphaScan, Tokens API, datapi)

- The Token Info section reads `VI=e=>!!e.launchpad`: with a launchpad it renders Top 10 H., Dev H., Snipers H., Freeze Auth, Mint Auth, Dex Paid, Pro Traders, Insiders H., Bundlers H. and the CA and DA rows; without one it renders only Top 10 H., Freeze Auth and Mint Auth (`https://jup.ag/assets/_tokenId-M0Y9Y_Pv.js`, fetched 2026-10-26).
- The Holders and Transactions tabs offer Sniper, Insider and Bundler filters only when `Osn=e=>!!e.launchpad` is true (`vendor-tanstack-runtime-wmJ-i0Rt.js`), matching the docs' "available for launchpad tokens only" ([Jupiter token page docs](https://docs.jup.ag/user-docs/trade/spot/token-page)).
- The cells read `audit.sniperPct`, `audit.insiderPct` and `audit.bundlerStats.holdingPct` from `https://datapi.jup.ag/v1/assets/search?query=<mint>`, and show 0% when a field is absent (same bundle).
- The tooltips define snipers as "wallets that bought within 3 blocks after launch" and insiders as "wallets that bought within the first block after launch or received the token from another insider", with a green check below 5% (same bundle).
- Across all 661 filled mainnet Alpha Vault coins (200 on DLMM, 461 on DAMM v2), none had `sniperPct` or `insiderPct`, and 657 had no `launchpad` (datapi search, 2026-10-26); among top-traded launchpad coins the same fields are present when non-zero, for example insiders 58.39% on the pump.fun coin `C5xph2yL...pump`.
- The holders endpoint takes `tags=sniper|insider|bundler` (the client sends it only for launchpad coins); called directly, it returned 0 snipers and 0 insiders for every sample coin, and bundler lists with 0 depositors except 1 on XST.
- Jupiter labels holders by type: "Meteora DLMM Liquidity Pool", "Meteora DAMM V2 Liquidity Pool", "Meteora Vault", "Jupiter Lock" and exchange names appeared; Alpha Vault and Streamflow accounts had no label.
- `audit.topHoldersPercentage` excludes labelled pools and Meteora vaults but includes the Jupiter Lock escrow and unlabelled vaults: CANDLE's 25.93% equals its top 10 without the 71.66% "Meteora Vault" holder, and SUAREZ's 62.53% includes the 33.33% lock.
- `GET https://datapi.jup.ag/v1/txs/<mint>?dir=asc` returns the vault fill as `type: buy` with `traderAddress` the transaction's fee payer: BILLZ's first entry is tx `37PQBtEL...`, an Alpha Vault program transaction whose only signer is `7Da5dpUb...`, also the coin's `dev`; the same holds for ROUTER (`exmyuQQm...`) and CWU (`4By9RSei...`), while XST's (`3Nm7UBvQ...`) and HUMA's (`23bLmWtd...`) signers were not the dev.
- The chart's trade markers include a Dev marker labelled "DB" or "DS", `defaultVisible: true`, resolved from the token's `dev` address with no launchpad check (`vendor-tanstack-runtime-wmJ-i0Rt.js`); that it draws on these coins was read from code, not seen on screen.
- Jupiter's `dev` is the deployer: OpenServ's launcher `7Da5dpUb...` is the dev of both ROUTER (`devMints` 55) and BILLZ, so the launchpad-as-dev risk from ticket #20 is live on an Alpha Vault launchpad.
- AlphaScan's columns come from `POST https://datapi.jup.ag/v1/assets/gems` with `recent`, `aboutToGraduate` and `graduated`; on 2026-10-26 `recent` held 30 coins created between 17:09:45 and 17:10:13 UTC, sorted by first-pool creation, 28 with a launchpad (24 pump.fun, 2 stonkfun, 1 raydium-launchlab, 1 met-dbc) and 2 without (TMNT on DAMM v2 pool `76J7sTWL...`, one on a pump.fun AMM pool).
- AlphaScan's docs describe New as "Tokens just launched (typically seconds to minutes old)" ([AlphaScan docs](https://docs.jup.ag/user-docs/trade/spot/alphascan)).
- The client's launchpad enum (`LB` in `vendor-tanstack-runtime-wmJ-i0Rt.js`) has 92 entries from `pump.fun` to `grainpad`; none is an Alpha Vault or launch-pool venue.
- The Tokens API (`https://api.jup.ag/tokens/v2/search`, with key) returns the same `launchpad`, `dev` and a smaller `audit` (mint and freeze flags, `topHoldersPercentage`, `devBalancePercentage`, `devMints`, `devMigrations` for launchpad coins only).

### GMGN

- Calls follow gmgn-cli 1.6.9 (`dist/client/OpenApiClient.js`: host `https://openapi.gmgn.ai`, `X-APIKEY` with `timestamp` and `client_id`), using the public read-only test key printed in its [README](https://cdn.jsdelivr.net/npm/gmgn-cli@1.6.9/Readme.md).
- Holder tags are documented as `sniper` ("launched at token open"), `bundler`, `rat_trader` ("insider/sneak trading") and `transfer_in` ("Wallets with a transfer-in record for this token") ([gmgn-cli token skill](https://cdn.jsdelivr.net/npm/gmgn-cli@1.6.9/skills/gmgn-token/SKILL.md)).
- The UI shows "Suspected phishing wallet: Token transfer detected", explained as "Many phishing-tagged wallets from one token source spread tokens. This fakes a wide range of holders", next to "Suspected Insider: Multiple position holders share the same creation time, funding source and transfer time" ([GMGN icon definitions](https://docs.gmgn.ai/index/featured-icon-definition)).
- Vault claimers' `token_transfer_in.address` is the vault: 14 BILLZ holders' last inbound transfer came from `HqbRkCTK...`, and all 71 CWU depositors in the top 100 came from their vault.
- `stat.top_entrapment_trader_percentage` was 95.7% on CWU, 59.7% on DOOD, 57.4% on XST and 41.4% on CLOUD; that "entrapment" is the API name for the phishing signal is an inference (the field is undocumented beyond "Ratio of volume from entrapment traders").
- The Alpha Vault account is tagged `rat_trader` while it holds tokens (ROUTER's `F3Yygo5N...` at 0.26%, GCR's vault at 89.77%), and so is every Jupiter Lock escrow sampled.
- `locked_ratio` (documented as "Ratio of supply locked") credits Streamflow (BILLZ 0.2000; ROUTER 0.2907, where RugCheck also lists a "Streamflow Vault") and gives 0 for Jupiter Lock escrows.
- `lock_summary` credits DBC's migrated LP (95%, "is_blackhole") and reports DLMM and the CWU DAMM v2 pool as not locked.
- Trenches (`POST /v1/trenches`, body as `buildTrenchesBody` builds it) on 2026-10-26: default view `new_creation` 60 coins (Pump.fun 36, pump_mayhem 12, meteora_virtual_curve 8, ray_launchpad 4), `completed` 60 (meteora_virtual_curve 37, Pump.fun 22, pump_mayhem 1); with `launchpad_platform: ["pool_meteora"]` the new column filled with plain pools (59 DAMM v2, 1 DLMM).
- The documented Trenches platform list for Solana has no `pool_*` entries, while the trending list does ([gmgn-cli market skill](https://cdn.jsdelivr.net/npm/gmgn-cli@1.6.9/skills/gmgn-market/SKILL.md)); GMGN's separate New Pair leaderboard has filtered by DEX, including Meteora, since February 2025 ([GMGN on X](https://x.com/gmgnai/status/1894783433500770613)).

### RugCheck

- Reports from `GET https://api.rugcheck.xyz/v1/tokens/<mint>/report`; insider networks from `GET /v1/tokens/<mint>/insiders/graph` ([RugCheck API spec](https://api.rugcheck.xyz/swagger/doc.json)).
- No depositor was flagged `insider` in the top 20 of any sample coin, and no Alpha Vault was ever a node of an insider network.
- ROUTER's 5-wallet "transfer" network and BILLZ's three networks (7, 4, 4 wallets) are depositors sending tokens to each other; CLOUD's 339-wallet network has 1 depositor and HUMA's 110-wallet network none.
- BILLZ: risks "Creator history of rugged tokens" (danger, the OpenServ launcher), "Large Amount of LP Unlocked 100.00%" (danger) and "Low amount of LP Providers"; known accounts "Meteora DLMM Pool" and "Streamflow Vault" (LOCKER).
- All 181 DLMM markets listed across the eleven reports had `lpLockedPct` 0, while DAMM v2 markets carrying a permanent lock had 100 (CWU `DKQiZKjk...`, MODRIC `4jwzNcz5...`).
- The Jupiter Lock escrow was a known "Jupiter Locker" (LOCKER) on CANDLE but unknown on SUAREZ, MODRIC and STEALF; on SUAREZ (33.33%) and STEALF (20.62%) it triggered "Single holder ownership", and on MODRIC (12.5%) nothing.
- `launchpad` was null and `deployPlatform` "unknown" on all eleven coins, DBC included.

### DexScreener

- Pair pages captured with firecrawl on 2026-10-26: ROUTER "Meteora - DLMM", CWU and XST "Meteora - DYN2", each with Audit "No issues" and no "via"; STEALF "Meteora - DYN2 via DBC" ([ROUTER](https://dexscreener.com/solana/DJ8qzBm3ZoRi4YiVmpiLBBuc67cq737vqaTNbMRJGcvZ), [CWU](https://dexscreener.com/solana/DKQiZKjkbYEzjCJajV6rbA1GkmFbsQMn9kvE6qU33K9h), [XST](https://dexscreener.com/solana/4tSYkRZovRM3bW6iLFRANwrUQ9A2xT85KnDuUdksj5B4), [STEALF](https://dexscreener.com/solana/GqbkAy1ajZivdjk8jhDdMqapzN6ogEfD12LtJYyXQC4C)).
- The public API (`https://api.dexscreener.com/tokens/v1/solana/<mints>`) returned no pair for BILLZ, MODRIC, SUAREZ or CANDLE on the day, and carries only `dexId` and `labels` (`DLMM`, `DYN2`), no launchpad.
- The Holders tab did not render in the capture, so how DexScreener classifies vault claimers or locks is unverified.

### Birdeye

- Holder tags are documented as `dev` ("the mint creator from the initialize-mint transaction"), `sniper` ("bought within the first n blocks of the token, counted from the token's first swap. On Solana, n = 5"), `bundler` (4 buys in one slot, or 3 wallets across adjacent slots) and `insider` ("received the token directly from the Chef wallet via token transfer, not via a swap") ([Birdeye holder profile docs](https://data.birdeye.so/docs/data-api/holder/get-token-v1-holder-profile)).
- On an Alpha Vault coin the first swap is the vault fill, an hour before anyone else can trade, so by this definition only the vault's cranker could be a sniper; whether claimers count as insiders depends on what Birdeye calls the "Chef wallet", which the page does not define (unverified).
- Meme lists cover pump_dot_fun, moonshot, raydium_launchlab and meteora_dynamic_bonding_curve on Solana, the last since 2025-09-20 ([Birdeye meme list docs](https://data.birdeye.so/docs/data-api/meme/get-defi-v3-token-meme-list)).
- The public token page renders Trades, Security(1), Holders, Top Traders, Dev Tokens and Markets tabs, but the holder data needs a click or an API key (firecrawl capture of `birdeye.so/solana/token/6SjVTj1V...`).

### Axiom and Photon

- Both token pages need a wallet login (firecrawl captures of `axiom.trade/meme/DJ8qzBm3...` and `photon-sol.tinyastro.io/en/lp/DJ8qzBm3...` showed only the shell or the Connect Phantom screen).
- Axiom documents Pulse as monitoring "pump.fun and [REDACTED] tokens", with filters Dev Holding %, Snipers % ("early buyers"), Insiders % ("private sales, team members"), Bundle % and Top 10 Holders % ([Axiom Pulse docs](https://docs.axiom.trade/axiom/finding-tokens/pulse.md)); "private sales" could include vault depositors (unverified).
- Photon announced "Stonk, Pump and Meteora DBC assets are all now supported" in September 2026 ([Photon on X](https://x.com/tradewithPhoton/status/2099246067909079253)); no Photon post about DLMM or DAMM v2 launch pools was found.

### Codex

- Codex's generated launchpad list for Solana includes both "MeteoraDBC" and "Meteora Alpha Vault" ([Codex supported launchpads](https://docs.codex.io/launchpads)), the only upstream source found that names Alpha Vault launches as a launchpad.
- Whether Codex tags the sample coins with it, and whether its customers show it, is unverified (no Codex key; defined.fi's page did not render the field).

## How DBC's locked vesting reaches terminals

- DBC's `create_locker` calls Jupiter Lock's `create_vesting_escrow_v2` with `sender` the DBC pool authority, `sender_token` the pool's base vault and `recipient` the pool creator ([`create_locker.rs`](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/main/programs/dynamic-bonding-curve/src/instructions/migration/create_locker.rs), read from a local copy of the public repo).
- `getProgramAccounts` on Jupiter Lock (`LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn`, VestingEscrow layout from the locker 0.4.0 IDL) filtered on creator `FhVo3mqL...` (DBC's pool authority) returned 1,487 escrows; 167 were still vesting on 2026-10-26, one per mint, and Jupiter files those mints under `met-dbc` (106), `cyreneai` (45), `jup-studio` (9) and four others.
- So the lock escrow, not the creator's wallet, holds the creator's unvested supply, which is why Jupiter's Dev H. leaves it out and GMGN treats it as a separate insider whale.

## Method

- Vault and pool data: the 411 DLMM-type vaults decoded for ticket #3, plus all 684 mainnet DAMM v2-type vaults (addresses from a parallel session's DAMM v2 scan, re-read from chain) decoded with the same `Vault` layout (base mint at byte 136, pool type at byte 305); depositors from Escrow accounts (`dataSize` 136, vault at byte 8, owner at byte 40) via Helius `getProgramAccounts`.
- Each terminal was queried for the same coins on the same day; depositor wallets were matched against each terminal's tagged holders by address.
- Jupiter's client logic was read from the minified bundles served to `https://jup.ag/tokens/<mint>`; bundle names carry content hashes and will change.
- Read-only calls only: no transaction was signed or sent, no login was used, and no local browser was driven; JS-rendered pages were captured with firecrawl's scrape, without clicks.
- Scripts and raw responses are in the session scratchpad under `term-fo/`.

## Open questions and unverified points

- Whether Jupiter would mark a DBC-based Fair Open's vault buy and its claimers as insiders, and whether it would exempt a launchpad's vault PDA; this needs a question to Jupiter or a small mainnet launch, since Jupiter does not index devnet.
- What Birdeye calls the "Chef wallet", and how Birdeye, Axiom and Photon tag vault claimers and lock escrows.
- Whether Codex tags Alpha Vault coins "Meteora Alpha Vault" and whether Axiom, fomo or Phantom show it.
- How DexScreener's Holders tab and paid locked-supply setting treat vault and lock accounts.
- Why GMGN tagged 8 BILLZ and 8 CWU depositors as bundlers (their later trading, or the claims).
- Whether GMGN would label a vault or lock program as non-insider for a partner launchpad.
