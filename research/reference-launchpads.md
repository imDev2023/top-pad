# Reference launchpads and Meteora quote-asset approvals

Charting digest for the Top-pad wayfinder map, captured 2026-10-26.
It covers the four launchpads in the owner's brief (StonkFun, uselaunch.fun, pump.fun, PonsVault), the Raydium versus Meteora comparison, and which quote assets Meteora accepts.
EmberCurve, a launchpad on Meteora's own programs that the owner named on 2026-11-02, was added that day, with what it answers for Heat.
Facts are paraphrased with their sources; no third-party page text is copied here.

## Corrections to the brief

- StonkFun is a Solana launchpad on Raydium LaunchLab, not a Robinhood Chain one; the Robinhood Chain knowledge base has no entry for it.
- uselaunch.fun is a front end on top of StonkFun's LaunchLab setup, not its own venue.
- None of the four is built on Meteora; EmberCurve, added later, is (DBC graduating into DAMM v2, the same programs as Heat).
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

## EmberCurve

Sources: embercurve.fun `/`, `/markets`, `/how`, `/pairs`, `/launch`, `/meteora`, `/developers`, `/vault`, `/ghost`, `/council`, `/fomo`, `/cooking` and the $EMBER coin page, and its public keyless API (`/api/solana/partners`, `/api/solana/quotes`, `/api/solana/configs`), all read 2026-11-02 (site release `v1.39.0-ui.332`).

- What it is: a Solana launchpad on Meteora DBC graduating into DAMM v2, branded Ember.
  Its team also runs Rektrade, a 1000x perps venue on HyperEVM, linked from the home page.
- Scale, by its own figures on 2026-11-02:
  - 792 coins, 115 graduated, 514 still on their curves;
  - $421.1M lifetime volume on any venue by Jupiter's launchpad statistics, $142.5M of it on its own curves and DAMM v2 pools, ranked 9th of 88 launchpads by 30-day volume;
  - $1.78M of trading fees, $1.15M of it paid out to holders and other recipients, $352.5K to Meteora's protocol;
  - but only $47.8K to $66.1K of volume in the last 24 hours, and every lifetime figure trending down (26% to 46%).
- Launch: 1B supply with mint, freeze and update authority all revoked (`tokenAuthorityOption Immutable`).
  Every coin opens at a $4,000 market cap and graduates at a cap the creator picks ($15K, $25K, $35K by default, $40K, $69K or $100K), converted to the pair token at the launch price and written into the config as `migrationMarketCap`.
  A curve studio offers four curve shapes built from 16-segment liquidity weights, with the same start, cap and supply.
  The creator signs and pays one create-pool transaction (pool rent, a few hundredths of a SOL; no platform fee).
  A platform launch signer co-signs every launch with an `ember-launchpad:` memo, which is how indexers attribute Ember coins.
  The platform pays about 0.01 SOL for a new DBC config the first time a parameter set is used (pair, tax, cap, shield, shape and other add-ons) and every later launch with that set reuses it: 3,298 configs so far.
- Pairs: 1,349 pair tokens, all on DBC: 739 xStocks, 442 Ondo, 50 Backpack, 8 PreStocks, 3 Tessera, 33 other crypto, 25 memes, SOL, USDC and its own $EMBER.
  - Its API marks every stock token as holding a DBC badge or being on Meteora's allowlist.
  - The fee-bearing pre-IPO tokens (PreStocks at 1% to 5%, Tessera at 0.2%, all with a live fee authority) open through `create_config2`.
  - A badge watch re-reads Meteora's badges every ten minutes and opens a pair the moment its badge exists.
  - Most paired: $EMBER (251 coins), MET (188), SOL (129), USDC (42), JUP (20), then NVDAx (18), the first stock.
  - Buys route SOL or USDC into the pair token through Jupiter (exact-out) and into the curve in one versioned transaction.
- Fees: a flat 1%, 2% (default), 2.5% or 3% trading tax, collected in the pair token (`collectFeeMode QuoteToken`).
  Meteora takes 20% on chain; Ember, partner and fee claimer on every config, takes the other 80%, and its keeper splits that between the coin's fee module (62.5% of the claim, so 50% of the tax; 95% for Stock Basket) and the platform (about 30% of the tax).
  At graduation 5% of the quote raised goes to Ember (Customizable migration fee).
  The DAMM v2 pool keeps the coin's tax, with 100% of its LP permanently locked in the platform's own position (the creator's share is 0%), whose fees the keeper keeps claiming and routing.
- Fee modules: 35 in the catalogue, one chosen at launch and switchable later by holder vote.
  - Paying the creator: Keep it, or Split to up to five wallets.
  - Paying holders every 30 minutes, pro rata to the top 2,000 holders above 0.005% of supply, in the pair token, SOL or $EMBER; variants weight by holding time (Diamond Hands), escrow until market-cap milestones, pay a sister coin's holders, or the pool's LPs, or deepen the pool (Deep Pool, LP Farm).
  - Burning: Buyback & burn, Dip Defender (buys only after a set fall from the 24-hour high), EMBER Booster (buys and burns $EMBER).
  - Games: SuperLotto (10 winners every 30 minutes, weighted by the square root of balance, seeded from a finalized blockhash, plus a daily jackpot), Top Buyer Bounty, graded-card packs on Jupiter Gacha, and votes on Jupiter prediction markets.
  - Trading the fees: Conviction on Jupiter Perps, YOLO on Jupiter's 500x to 1000x venue, Paper Mill on a HyperEVM perps venue.
  - Others: a basket of up to 30 stocks and tokens bought hourly for holders of 100,000+ coins; X Money, paid to any X handle through MoonPay's PayBox; fomode, paying 80% of the claim to a trader picked from fomo.family's leaderboard; Ghost and Veil, paying holders at one-time stealth addresses; and pre-IPO modules paid at the New York close, several scored on posts in Ember's forum, Campfire.
  - The toll family (Tollgate, Reflection, Turnstile) puts a 1% to 10% Token-2022 transfer fee on the coin itself through `create_config2` (DBC 0.2.2), withheld on every venue forever and harvested by the platform every 15 minutes.
- Anti-sniper: none by default; the tax is flat from the first trade.
  An optional Sniper Shield writes DBC's exponential fee scheduler into the config, from 50%, 75% or 90% down to the tax over 10, 20 or 30 minutes, its fees following the coin's module.
- Founder's Buy: with the shield on, the creator's first buy rides in the launch transaction, where DBC charges the first swap the scheduler's floor fee (the config's `firstSwapWithMinFee`) when it sits in the pool's creation transaction with no referral and no CPI.
  The creator pays the tax while a sniper in the next slot pays the shield, and the amount is the creator's to set.
- After graduation, optional: a Gravity Fee (DAMM v2's market-cap fee scheduler from 5%, 7.5% or 10% down to the tax as the cap reaches 2, 5 or 10 times graduation, rising again on a fall, expiring after 7, 30 or 90 days) and a self-deepening pool (DAMM v2 compounding, 25% to 75% of LP fees folded back as locked liquidity).
- Other add-ons: DBC's dynamic fee (up to 20% on top of the tax); a Finisher prize (1%, 2% or 5% of supply to whoever's buy completes the curve); a Gift (50% to 90% of supply held back as curve leftover and sent at graduation to one named wallet); a Graduation Airdrop (5% to 15% of supply plus 80% of the quote surplus to holders at graduation).
- Rebates: every curve trade carries a referral account in the Meteora swap.
  A shared link's referrer gets DBC's referral share, 4% of the tax carved from Meteora's protocol share, instantly; a trade with no referrer names the trader's own account, so the trader gets that 4% back as cashback.
- Governance (Council): signed, gasless votes weighted by the smaller of a voter's balance when voting and when the vote closes.
  Any holder of 0.5% may propose a module switch, a new creator (community takeover), pausing the creator side, or new links; a proposal passes when 10% of circulating supply votes and yes wins; one change per coin every 3 days.
- Transparency: every claim, payout, burn and draw is in a public ledger with its signature.
  The keyless public API serves markets, pair tokens with their badge and fee state, curve previews, trades, candles (from GeckoTerminal), holders, the ledger, every launch and config, and a live feed of server-sent events, and builds trade and launch transactions for the user's wallet to sign.
  The platform wallet's holdings are on a public Vault page ($412.59 on 2026-11-02).
- UX: Markets filtered by pair and fee module, Cooking (coins on their curves ranked by progress), Curated, Portfolio, a payout lookup per wallet, the Campfire forum, an AI assistant that answers questions and drafts launches for the wallet to sign, English and Chinese, Privy wallets, sign-in with X.
- Absent: bundle detection, any limit on the creator's bag, a copycat check, a creator lock.
- Trust: one platform wallet, `GZjYfGyUNQfDChcQ66Gc3ZMcQqPEisyRYe1nPyQhP9bp`, is partner, fee claimer and leftover receiver on every config, holds every graduated pool's locked LP, is the withdraw authority of every toll coin's transfer fee, and holds module funds between rounds.
  So everything past Meteora's 20% rests on one off-chain keeper and one key, and many modules send holders' fees into leveraged perps, prediction markets, lotteries and card packs.
- Naming: Ember labels its live trade ticker "Heat" and scores Campfire posts by "heat", an overlap with our product's name.

## What EmberCurve answers for Heat

1. Stock pairing works on DBC in production.
   Ember offers 739 xStocks, 442 Ondo and 50 Backpack stocks as DBC pair tokens, matching the bulk badge runs found in [quote-asset-badges](https://github.com/imDev2023/top-pad/blob/research/quote-asset-badges/research/quote-asset-badges.md) (all 740 xStocks and 443 Ondo tokens badged on 2026-09-09) and Meteora's answer of 2026-11-02 that most xStocks already hold a mainnet badge and a missing one can be requested.
   Demand is thin, though: NVDAx, the most paired stock, has 18 of 792 coins, against 439 paired with $EMBER or MET.
2. Fee-bearing quote tokens pair through `create_config2` in production (8 PreStocks at 1% to 5%, 3 Tessera at 0.2%), so its restrictions (fixed supply, no locked vesting, Customizable migration fee, Compounding fee mode) are workable for a launchpad.
3. A coin priced in a stock collects its fees in that stock.
   If Heat paired with stocks, the treasury's share, Creator Earnings and the Tax Share would all be paid in the stock, with its issuer's pause and permanent delegate behind them.
4. DBC's minimum fee for the first swap in the creation transaction is what Heat's Fair Open uses for the pot's buy (#46); Ember spends it on the creator's own buy, of any size, before anyone else can trade.
   Combined with no bundle detection, that leaves Ember fully open to the creator bundling Bitquery measured on pump.fun, which Heat leads against.
5. Cashback through DBC's referral account costs the trader nothing extra: Ember names the trader's own account when there is no referrer.
   Heat names its treasury's wSOL account on every swap (#43), so the same mechanism would move that share from Heat to traders; cashback was dropped in [Retention](https://github.com/imDev2023/top-pad/issues/18).
6. One DBC config per parameter set, created by the platform on first use, keeps a launch's cost to the pool rent while offering many caps, taxes and curve shapes; Heat has two fixed configs.
7. Where Heat is ahead: the Fair Open pot, Bundle Radar, Vamp Shield, the Creator lock and the Tax Share have no counterpart on Ember, and Heat's fee split is enforced by its own program rather than one keeper key.
   Where Ember is ahead: the breadth of pairs, a menu of fee modules with holder rewards, holder governance, fee shaping after graduation (Gravity, compounding), and a public API and ledger.

## Mechanisms found on only one launchpad

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
11. A menu of 35 fee modules, switchable after launch by a holder vote that can also replace the creator (EmberCurve).
12. Cashback: the trader's own account named as the DBC referral account when nobody referred them (EmberCurve).
13. Holder payouts at one-time stealth addresses (EmberCurve Ghost and Veil).
14. A market-cap fee scheduler on the graduated DAMM v2 pool that rises again on a fall (EmberCurve Gravity Fee).
15. A Token-2022 transfer fee on the coin itself, charged on every venue forever and burnt or paid to holders (EmberCurve toll family).
16. A share of supply for whoever's buy completes the curve (EmberCurve Finisher).

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
