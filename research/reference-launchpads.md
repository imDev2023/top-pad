# Reference launchpads and Meteora quote-asset approvals

Charting digest for the Top-pad wayfinder map, captured 2026-10-26.
It covers the four launchpads in the owner's brief (StonkFun, uselaunch.fun, pump.fun, PonsVault), the Raydium versus Meteora comparison, and which quote assets Meteora accepts.
Facts are paraphrased with their sources; no third-party page text is copied here.

## Corrections to the brief

- StonkFun is a Solana launchpad on Raydium LaunchLab, not a Robinhood Chain one; the Robinhood Chain knowledge base has no entry for it.
- uselaunch.fun is a front end on top of StonkFun's LaunchLab setup, not its own venue.
- None of the four is built on Meteora.
- PonsVault's footer says it is independent of pons and Robinhood, while the Robinhood Chain knowledge base (`LAUNCHPADS-II.md`, `launchpads/pons/README.md`) says the Pons team built it.

## StonkFun

Sources: stonkfun.xyz `/launch`, `/rewards`, `/flywheel`, `/revenue`, `/developers` and a token page (2026-10-26); the owner's Stoker research (`stonk-fun-solana/research/README.md`, 2026-09-26).

- Launch: Raydium LaunchLab constant-product curve, 1B supply, graduates at 85 SOL raised (rescaled for other quote assets) into a Raydium CPMM pool whose LP is permanently locked through Raydium's Burn & Earn.
- Quote assets: about 580, including SOL, xStocks, PreStocks, currencies, leverage tokens and 419 custom tokens.
- Cost: about 0.012 SOL of rent and no platform launch fee.
- Protections: almost none.
  The creator may buy up to 75% of supply atomically with the launch, which shuts out snipers but allows a huge bundled creator bag.
  No copycat check, wallet caps or sniper tax were found.
- Economics: 1.25% trading fee with about 0.5% forwarded off-chain to the creator; optional 1% or 3% transfer tax paid to holders; about 60% of platform revenue buys and burns $STONK; a flywheel buys and burns the top 10 platform coins.
- UX: TradingView Lightweight Charts fed by Jupiter data, a swap widget, top-holder table, public revenue and rewards dashboards, a keyless public API; no chat or livestreams.
- Weaknesses: rewards depend only on volume; pump.fun copied stock pairs (2026-09-09) and holder rewards (2026-09-12); a misbuilt taxed coin taxes holders and pays no one; the US, Canada and UK are blocked.

## uselaunch.fun

Sources: uselaunch.fun `/how`, `/launch`, `/calls` (2026-10-26).

- Launch: one platform "master wallet" creates every coin on StonkFun's LaunchLab setup, free, paired with any of about 600 assets.
- No creator wallet and no creator buy at all, so there is no creator bag to dump.
- Zero-block protection: coins are created in a private bundle with a tip and the address is never published early, so no third party can land in the creation block.
  The site does not promise protection from snipers after that block.
- Copycat filter, the strongest of the four:
  - tickers are compared after folding case, spaces, lookalike letters and leetspeak (P3PE, PЕPE with a Cyrillic letter, and "P E P E" all equal PEPE);
  - names that copy another coin plus "official" or "2" are refused;
  - resized or recoloured copies of another coin's image are refused;
  - one coin per X account;
  - a ticker already trading elsewhere with real money is refused;
  - a database constraint stops two simultaneous launches from both taking the same ticker.
- Economics: contradictory between pages (100% of the creator share to the coin's buyback and burn on `/how`; a 3% fee split three ways on `/launch`).
- UX: holder-only calls stamped with the market cap at call time and ranked, a burns page, an AI name and ticker helper, a built-in wallet.
- Weakness: everything depends on trusting the master wallet and StonkFun's off-chain fee forwarding, which the site itself calls "not a guarantee".

## pump.fun

Sources: pump.fun `/docs/fees` (updated 2026-10-17), `/docs/mayhem-mode`, `/create`, `/go`, the home page; Bitquery, https://bitquery.io/investigations/pump-fun-snipers-bundles.

- Launch: its own constant-product curve, 1B supply, graduating automatically to a protocol-owned PumpSwap pool (about 85 SOL per third parties; the docs give no number).
- Quote assets: SOL, USDC, an admin-controlled list of custom assets (181 mints including xStocks, per the owner's Stoker research), or another pump coin.
- Protections: detection only.
  Each coin page shows creator, sniper, bundler and top-10 percentages and tags wallets as Bundler or Sniper.
  Copycats are handled only by trademark takedown requests; metadata is immutable; there is a community takeover process.
- Economics: 1.25% curve fee (0.30% creator, 0.95% protocol); PumpSwap creator fee tiered by market cap from 0.95% down to 0.05%; holder rewards since 2026-09-12; an extra 0.45% platform fee on web and app trades since 2026-10-17.
- UX: livestreams with chat, leaderboards, callouts with profit tracking, P&L cards, perps, a trading terminal, a mobile app, TradingView Advanced Charts.
- Weaknesses: Mayhem Mode coins can strand holders on the curve; the GO bounty feature drew public backlash.

### The Bitquery numbers that set Top-pad's priorities

Bitquery examined 8.2M pump.fun launches:

- on 38%, someone other than the creator bought in the creation block;
- on 21%, the creator's own bundled wallets bought in that block, taking a median 10% of supply;
- creator bundles made more than $579M, against $31.5M for sniper bots;
- on 65% of coins, the creator first sold within a minute.

Creators did about 18 times more damage than bots, which is why the map leads with stopping bundlers.

## PonsVault (Robinhood Chain)

Sources: Robinhood Chain knowledge base `launchpads/pons/README.md` and `launchpads/pons/pages/33-ponsvault-docs-live.md`; ponsvault.com home and `/tip` (2026-10-26).

- Launch: pons v2 factory curve priced in ETH, USDG or one of 23 stock tokens; 71.4% of supply sold on the curve; graduates at 4.2 ETH into a full-range Uniswap v4 position locked forever; 0.0005 ETH launch fee.
- Protections: a snipe tax of 99% on buys falling to zero over 3 seconds, with the launcher, fee recipient and up to 32 named wallets exempt; per-transaction and per-wallet caps for a window after launch; vault settings immutable after creation.
  No copycat check.
- Economics: 1% fee (30% protocol, 70% to the creator's vault) plus an optional 0 to 10% creator tax; vault types for staking, stake and burn, stock dividends, fee share to an X handle; NFT "seats" with tiered payouts.
- Weaknesses: unverified and upgradeable vault contracts, no audit, buybacks without a price check, and the Pons owner can reassign a token's fee recipient.

## Mechanisms found on only one of the four

1. Copycat filter with lookalike folding, image matching and one coin per X account (uselaunch).
2. No creator wallet or creator buy at all (uselaunch).
3. Private-bundle creation with an unpublished address (uselaunch).
4. A 99% sniper tax decaying to zero over 3 seconds with a fixed exemption list (PonsVault).
5. Creator fees routed to an immutable vault: staking, stock dividend or burn (PonsVault).
6. Creator fee tiered by market cap (pump.fun).
7. Sniper and bundler percentages and wallet tags on every coin page (pump.fun).
8. An AI agent trading the coin for its first 24 hours (pump.fun Mayhem Mode).
9. A platform-wide flywheel burning the top 10 coins (StonkFun).
10. A creator buy of up to 75% of supply, atomic with the launch (StonkFun; the opposite of fair).

## Raydium versus Meteora for this launchpad

- Meteora's programs already contain anti-sniper building blocks: base-fee schedulers that start as high as 99% and decay (DBC, DAMM v2), an activation point before which normal swaps are disabled, and the Alpha Vault pre-activation buy (DLMM, DAMM v1, DAMM v2; not DBC).
  Source: the Jupiter + Meteora knowledge base, `meteora/01-products-and-protocol.md` sections 4 and 6.
- Raydium LaunchLab's docs cover curves, platform fees (capped at 100 bps by `GlobalConfig.max_share_fee_rate`) and creator fees; no anti-sniper mechanism was found in them (https://docs.raydium.io/products/launchlab, https://docs.raydium.io/products/launchlab/platform-config).
- Since a 2026-08-17 upgrade, LaunchLab migrations combine the platform's and creator's LP shares into one platform-owned locked-LP position (https://docs.raydium.io/products/launchlab/creator-fees).
- 2026 volume data from different providers disagree by orders of magnitude; most put Meteora ahead of Raydium and both far behind PumpSwap for memecoins (https://docs.bitquery.io/docs/mcp/trading/examples/solana-dex-market-share/).
- Unsettled: whether a brand-new quote asset on LaunchLab needs Raydium's admin to create a config.
  The owner's Stoker research says so in `research/README.md` but lists LaunchLab as "anyone, any mint" in `research/competitors/README.md`.

## Which quote assets Meteora accepts

Sources: https://docs.meteora.ag/core-products/dbc/token-2022-support, https://docs.meteora.ag/core-products/damm-v2/token-2022-support, https://docs.meteora.ag/core-products/dlmm/token-2022-support; the owner's Stoker scan of every DBC pool, `stonk-fun-solana/research/competitors/meteora_dbc_quote_mix.json` (snapshot 2026-09-26).

- A DBC quote asset needs no approval if it is an SPL Token mint, or a Token-2022 mint with only metadata extensions and a zero transfer fee.
- Any other Token-2022 quote mint, such as a stock token with Permanent Delegate, Pausable or Scaled UI Amount, needs a token badge that a Meteora operator creates after review (a Google Form and a Discord ticket).
  The DBC docs name stock tokens as the case this path exists for.
- A badge is per mint and per program: a DBC badge does not satisfy DAMM v2 or DLMM.
  DBC graduation uses DAMM v2 configs with the `CreatePoolWithoutMintValidation` permission, so a DBC-badged quote asset still graduates.
- DLMM additionally refuses mints with a freeze authority unless Meteora reviews them.
- Superseded on 2026-10-26: the docs mirror said a badge never allows a non-zero transfer fee on a quote mint, but DBC 0.2.2 (live on mainnet since 2026-10-16) accepts a badged fee-bearing quote through `create_config2`, which forces fixed supply, no locked vesting, the Customizable migration fee and the Compounding fee mode; a zero-fee TransferFeeConfig with its authority revoked is now accepted without a badge.
  Source: [research/quote-asset-badges.md](https://github.com/imDev2023/top-pad/blob/research/quote-asset-badges/research/quote-asset-badges.md), which also has the full per-mint count for StonkFun's 607 quote assets.
- xStocks carry Scaled UI Amount, Pausable and Permanent Delegate (https://solana.com/news/case-study-xstocks).
  Consequences for any coin priced in one: the issuer can pause it, can move tokens out of any account including pool vaults, and the displayed balance changes with splits and dividends.
- The Stoker scan of DBC on 2026-09-26 found:
  - 2,368 token badges in the program and 731 distinct quote mints in use, 227 of them Token-2022;
  - 607 quote mints in use without a badge (SOL, 16 stablecoins, 590 other tokens);
  - 124 stock-token quote mints with a badge: 49 xStocks (among them NVDAx, SPYx, AAPLx, TSLAx, AMZNx, METAx, QQQx, GLDx) and 75 from Backpack, Ondo and other issuers;
  - asset-paired pools are only 0.61% of DBC's 1.7M pools; the largest asset-pairing platform is EmberCurve.
