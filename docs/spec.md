# Greenflag devnet prototype: build spec

Assembled on 2026-10-27 from the wayfinder map, [Top-pad: the spec for the fair-launch launchpad prototype](https://github.com/imDev2023/top-pad/issues/1), in [Assemble the spec](https://github.com/imDev2023/top-pad/issues/38).
The product is named **Greenflag**; the repo and folder keep the working name Top-pad.
Every decision below was made by the owner in a ticket on the map; each section links its tickets and ADRs so a reader can zoom in, but the decision itself is stated here.
Terms are used exactly as defined in [GLOSSARY.md](../GLOSSARY.md).

One marker appears throughout:
- **Unproven**: designed from Meteora's source or our own arithmetic, not yet shown on devnet; the build's devnet tests (section 11) prove it.

The small parameters the map left for this spec to fix are marked **(owner, 2026-10-27)**; the owner confirmed each in [Assemble the spec](https://github.com/imDev2023/top-pad/issues/38).

## Contents

1. [What Greenflag is](#1-what-greenflag-is)
2. [Launch modes, end to end](#2-launch-modes-end-to-end)
3. [The coin and the two DBC configs](#3-the-coin-and-the-two-dbc-configs)
4. [Fees](#4-fees)
5. [On-chain programs](#5-on-chain-programs)
6. [Anti-abuse](#6-anti-abuse)
7. [Creators](#7-creators)
8. [Discovery and ranking](#8-discovery-and-ranking)
9. [Screens](#9-screens)
10. [Backend and stack](#10-backend-and-stack)
11. [Devnet proof plan and acceptance](#11-devnet-proof-plan-and-acceptance)
12. [Parameters](#12-parameters)
13. [Prerequisites and owner tasks](#13-prerequisites-and-owner-tasks)
14. [Build order](#14-build-order)
15. [Out of scope](#15-out-of-scope)
16. [Risks and what is unproven](#16-risks-and-what-is-unproven)
17. [Sources](#17-sources)

## 1. What Greenflag is

Greenflag is a fair-launch token launchpad on Solana, built on Meteora's Dynamic Bonding Curve (DBC) and DAMM v2 pools.
Its reason to exist is that the people who launch and buy a coin are not beaten to it by bots, insiders or copycats.
The first audience is memecoin creators and traders.

The owner's standing preferences (2026-10-26), which every later choice follows:
- **Lead with stopping creator bundling, snipers second**: on pump.fun, creator bundles made more than $579M against $31.5M for sniper bots.
- **Prefer rules the chain enforces over promises the server makes**; a small on-chain program of our own is allowed wherever Meteora's programs cannot enforce a rule.
- **Weigh quality, robustness and long-term maintainability over development cost.**
- Where Greenflag and Stoker name the same concept, use Stoker's word; the one deliberate exception is that Stoker's "Creator" (a wallet) is Greenflag's Creator wallet, and Greenflag's Creator is the person.
- Plain ASCII hyphens only, never em or en dashes.

What this build is:
- A **devnet prototype shaped like the eventual mainnet product**: real launches and trades on devnet, against Meteora's programs deployed there.
- **SOL only** as the Quote asset, with every program, config and table taking the quote mint as a parameter ([Stock-priced coins](https://github.com/imDev2023/top-pad/issues/14)).
- A product separate from Stoker, the owner's LaunchLab launchpad, which is read-only reference material ([ADR 0001](adr/0001-separate-product-from-stoker.md)).
- Done when the acceptance criteria in section 11 pass; mainnet is a separate, later effort (section 15).

The retention bet, recorded as **unproven** ([Retention](https://github.com/imDev2023/top-pad/issues/18)): no platform token and no paid incentives.
Creators come back because their Creator record and Creator Earnings build up only on Greenflag.
Traders come back because Greenflag coins are measurably less bundled and Fair Open depositors earn a Tax Share.

## 2. Launch modes, end to end

There are two launch modes: **Fair Open**, the default and the brand, and **Instant launch** ([Launch mechanism](https://github.com/imDev2023/top-pad/issues/10), [ADR 0002](adr/0002-fair-open-on-dbc-with-our-own-deposit-program.md)).
Both are DBC curves on Greenflag's own configs, both use the same curve, Graduation Target and sniper tax, and both graduate into DAMM v2.
There is no transfer hook on Greenflag coins.

### 2.1 A Fair Open's life

**1. Link X.**
Every launch needs an X account linked through OAuth; the Creator record belongs to that account, and the handle goes into the coin's metadata ([Creator record](https://github.com/imDev2023/top-pad/issues/21)).
The record's one Creator wallet signs the launch.

**2. Choose the launch mode.**
Fair Open is preselected.

**3. Enter the coin.**
- Ticker: `A-Z0-9`, 2 to 10 characters, uppercased.
- Name: any script, refused if it holds zero-width or bidi characters or mixes Latin with Cyrillic or Greek.
- Image.
- Vamp Shield checks all three before anything is scheduled (section 6.2): an exact match to a Protected coin is refused, a near match launches with a "looks like X" label.
- The ticker's strict key is reserved in the database for the life of the deposit window.

**4. Schedule.**
- The window's start, up to 7 days ahead; the window is a fixed 10 minutes ([Fair Open rules](https://github.com/imDev2023/top-pad/issues/19)).
- An optional minimum raise.
- A one-line teaser for the calendar: free text, at most 80 characters, plain text with no links or cashtags, refused if it names a Protected coin or holds the characters refused in names **(owner, 2026-10-27)**.

**5. Seal the identity.**
- Our server prepares the coin's metadata JSON and image as Arweave data items and signs them at scheduling; a data item's id is fixed once signed and binds its content, so the metadata URI also commits to the image.
- The creator commits a SHA-256 hash of the name, ticker and metadata URI, stored in the launch account.
- Name, ticker and image stay private until the open; our server sees them privately so Vamp Shield can run.
- Our keeper uploads both data items through Turbo 15 s before the open ([Our Fair Open program](https://github.com/imDev2023/top-pad/issues/28), [Backend design](https://github.com/imDev2023/top-pad/issues/36)).

**6. Sign the open in advance: the nonce ladder** ([ADR 0005](adr/0005-the-creator-pre-signs-the-open-as-a-nonce-ladder.md)).
- The open's creation transaction contains the pot's buy amount, which is only known when the window closes, so the creator signs a ladder of complete creation transactions, one per possible buy amount, all on one durable nonce.
- Rungs fall in 5% steps from the pot's cap (17 SOL on mainnet), at most 64 of them, spanning a 26x range.
- The creator signs all rungs in one wallet approval; the screen shows one plain "Sign your open in advance: one approval" step, with the rungs behind a details link ([What should Top-pad look like?](https://github.com/imDev2023/top-pad/issues/15)).
- Every signature is collected at scheduling: the creator (as the DBC pool's `creator`), our keeper (as fee payer, as the pot's delegate and as the nonce authority), and the coin's mint key, which our server generates and destroys straight after signing.
- Our keeper holds the nonce and our server generated the mint, so the creator cannot spoil a signed ladder: they can neither advance the nonce nor create that mint first.
- Fallback for a wallet that cannot sign a batch: the creator signs once, online, at the open.
- Signing 64 transactions in one prompt is **unproven** in Phantom, Solflare and Backpack.

**7. Prepay the launch's rent.**
About 0.03 SOL, all of it rent: the DBC pool accounts (about 0.02 SOL), the launch account (about 1,100 bytes, 0.0062 SOL) and the nonce account (0.00106 SOL).
The launch and nonce rent come back when the launch closes, and all of it comes back if the Fair Open fails.
It is not a Greenflag fee; it puts a small, refundable price on filling the launch calendar.

**8. The calendar entry.**
A sealed entry: a "?" tile, the time, the creator and their record summary, the terms (pot up to 17 SOL, minimum raise, 10 minutes) and the teaser.

**9. The 10-minute window: deposits.**
- A depositor verifies once on Greenflag, not per launch, and gets a Depositor tier (section 6.3).

  | Depositor tier | Proof | Cap per Fair Open |
  | - | - | - |
  | Verified | World ID Orb or Civic Uniqueness (no KYC; owner, 2026-10-27) | 2 SOL |
  | Scored | a wallet-history attestation (such as Trusta) or a linked X account | 0.5 SOL |
  | Unverified | none | 0.1 SOL, and all Unverified deposits together buy at most 25% of what the pot spends |

- Deposits are in steps of 0.01 SOL, and each deposit carries our admission server's co-signature (section 5.3).
- One person holds one seat per Fair Open, through one wallet.
- A depositor can withdraw everything until the window closes.
- Each depositor puts up about 0.0027 SOL of refundable rent beyond the deposit: 0.00123 SOL for the seat and 0.00149 SOL for the coin account the push creates (returned if they already have one).
- The creator may deposit like anyone else, under their own tier and cap (at least Scored, since they linked X); their share of the coins is locked (step 13).

**10. The open.**
At the scheduled time our keeper broadcasts the largest rung at or below what the pot should spend; the nonce advancing makes every other rung invalid.
The creation transaction, in order, with one shared address lookup table:
1. Fair Open program `open`: checks the time, the rung, and the transaction's exact shape by instruction introspection; approves our keeper as SPL delegate for exactly the buy; wraps exactly the buy into the pot's wrapped-SOL account.
2. DBC `initialize_virtual_pool_with_spl_token` on the Fair Open config, the creator signing as `creator`, so terminals show the creator as the coin's dev.
3. DBC `swap2`, top-level, paid from the pot with our keeper signing as its delegate: the pool's first swap ever, so it pays the scheduler's ending fee of 1.25% (DBC's first-swap discount).
4. Fair Open program `settle`: revokes the delegate, records the coins bought and the SOL spent, checks the coin matches the committed identity hash, reads the pool's accrued partner fee (at that instant exactly the pot's own fee) and records it with the fee program, and creates the coin's record in the fee program (section 5.2).

On devnet the prototype's version came to 979 bytes with a lookup table (1,193 without, against a 1,232-byte limit) and 160k to 204k compute units for its DBC part; with the fee-program record it is about 1,014 bytes, **unproven** ([Fair Open creation transaction on devnet](https://github.com/imDev2023/top-pad/issues/31)).
Every buy in the creation slot other than the pot's pays the 99% cliff of the sniper tax; public trading starts in that same instant.
The keeper holds the broadcast up to 10 s if the metadata URI is not yet served.

**11. Allocation: one price, equal shares.**
- Every depositor buys at the pot's single average price.
- If deposits exceed what the pot can spend, everyone gets the same amount (the level), anyone who asked for less gets all of theirs, and the rest is refunded.
- The 25% Unverified limit is measured against what the pot actually spends; if Unverified asks exceed it, Unverified depositors get their own lower level and everyone else shares the rest.
- The program computes the level on chain at the open, in one pass, from per-step deposit counts kept in the launch account; no server input.
- The pot spends the rung, which is at most 5% below what the depositors' fills add up to; each depositor's fill is scaled to the rung pro rata, and the unspent part is refunded.
- Worked example: a 15 SOL pot with 30 people asking 0.1 SOL and 50 asking 0.5 to 2 SOL gives a level of 0.24 SOL; the 30 get 0.1 each, the 50 get 0.24 each.
- Rounding **(owner, 2026-10-27)**: the level is floored to the lamport; each depositor's SOL spent rounds up and their coins round down; lamport dust is added to the launch's Tax Share, so it stays with depositors; coin dust is burnt.

**12. Pushes.**
Right after the open anyone can run the push, and our keeper does it at once, in parallel batches of 10 transactions.
One push transaction pays about 8 depositors their coins and refund; a 500-depositor Fair Open needs about 100 push transactions, paid by Greenflag (about 0.0005 SOL in base fees plus priority fees).
Every seat gets its coins and refund within 2 minutes of the open; anything a push cannot deliver stays in the seat for the depositor to claim.
There is no vesting for depositors: the 60 s sniper tax also taxes sells, so a first-minute dump pays up to 99%.

**13. The Creator lock.**
Right after the open, anyone can run the lock instruction, which moves the creator's share of the pot's coins into a Jupiter Lock vesting escrow ([Creator lock](https://github.com/imDev2023/top-pad/issues/11), [ADR 0004](adr/0004-the-creator-buys-only-through-the-fair-open-pot.md)):
- nothing released for 7 days after the open, then a straight-line release, all free 30 days after the open;
- nobody can cancel it, Greenflag included;
- only the recipient, the Creator wallet, can change who receives it.

Its rent (about 0.0036 SOL) comes out of the creator's deposit.
The creator may later buy on the curve from their own wallet, unlocked; those holdings are labelled on the Fairness card, never refused.

**14. The tax window and the Tax Share.**
- The Tax window is the first 60 s of trading.
- At 60 s our keeper claims the pool's partner fees; the first claim after the window counts as window fees, whoever sends it.
- Window fees, minus the pot's own fee, become the launch's Tax Share, paid to depositors in proportion to the SOL their deposit spent.
- The creator's seat gets no Tax Share, so a creator bundling their own creation slot is not refunded any of the tax **(owner, 2026-10-27)**.
- The keeper pushes the Tax Share, about 14 depositors per transaction, and closes their seats, returning the seat rent.

**15. Failure paths.**
- The program refuses `open` once the scheduled time is 15 minutes past, so a late open can never race the withdrawals.
- From then on, or once a pot misses its minimum raise or falls below the lowest rung, anyone can mark the launch failed: no coin is created.
- Each depositor then withdraws their deposit and both rents on chain alone, with no server running.
- There is no wallet or person quorum.

### 2.2 An Instant launch's life

1. Link X, choose Instant launch, enter the coin; Vamp Shield runs as in a Fair Open.
2. One transaction creates the coin and its DBC pool on the Instant config, which has the first-swap discount off.
   The creator signs as `creator` and pays the pool's rent; our launch key co-signs, and the same transaction registers the coin's record in the fee program.
   Our launch key co-signs only launches signed by the record's current Creator wallet that pass Vamp Shield.
3. There is no creator buy: every buy in the creation slot, the creator's included, pays the 99% cliff, so a creation-slot bundle loses about 99%.
4. The tax window's fees go to Greenflag's treasury, and the coin's Fairness card says so openly.
5. There is no Creator lock in an Instant launch; a creator who wants to hold supply honestly uses Fair Open.

### 2.3 Graduation

When a coin's curve holds the Graduation Target (85 SOL on mainnet, 8.5 SOL on devnet), our keeper's graduation Workflow migrates it to DAMM v2 ([Curve and Graduation Target](https://github.com/imDev2023/top-pad/issues/33)).
Meteora's mainnet keepers only migrate at a 10 SOL threshold, so our keeper does it; anyone may call the migration.
The graduated pool starts with about 85 SOL and 200 million coins, at a 425 SOL market cap.
Both halves of its LP are permanently locked: the creator's half as their own position NFT, Greenflag's half held by the fee program ([Launch liquidity](https://github.com/imDev2023/top-pad/issues/30)).

### 2.4 Coins made around our flow

Anyone can create a pool directly on Greenflag's DBC configs.
The Creator lock, Vamp Shield and every Greenflag guarantee cover only coins our launch key co-signed ([Creator lock](https://github.com/imDev2023/top-pad/issues/11)).
Such pools never appear on Greenflag's board or search; opened by address, their page shows a red "Not launched through Greenflag" banner and no Fairness card ([Discovery and ranking](https://github.com/imDev2023/top-pad/issues/37)).
The fee split, the sniper tax and the LP locks still bind them, because those live in the config.

## 3. The coin and the two DBC configs

Sources: [Curve and Graduation Target](https://github.com/imDev2023/top-pad/issues/33), [Sniper tax curve](https://github.com/imDev2023/top-pad/issues/23), [Fee model](https://github.com/imDev2023/top-pad/issues/13), [Launch liquidity](https://github.com/imDev2023/top-pad/issues/30).
Meteora program ids: DBC `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`, DAMM v2 `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`.

### 3.1 The coin

| Parameter | Value |
| - | - |
| Token type | classic SPL Token (no Token-2022) |
| Supply | exactly 1,000,000,000, fixed (DBC revokes the mint authority) |
| Decimals | 6 |
| Metadata | DBC `Immutable` token authority: `is_mutable` false, no update authority |
| On the curve | 800,000,000 (80%) |
| To the graduated pool | 200,000,000 (20%), nothing left over beyond rounding |

### 3.2 The two configs

Fair Open and Instant launch sit on separate configs that differ only in the first-swap discount.

| Setting | Fair Open config | Instant config |
| - | - | - |
| `enable_first_swap_with_min_fee` | on (the pot's buy pays the ending fee) | off |
| Quote mint | wrapped SOL (a parameter; devnet tests also run Circle's devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) | same |
| Activation type | timestamp (`activation_type` 1) | same |
| Collect fee mode | quote token | same |
| Base fee | fee scheduler, linear, timestamp mode: 99% cliff falling to 1.25% over 60 one-second periods | same |
| Dynamic (volatility) fee | off | same |
| Migration quote threshold (Graduation Target) | 85 SOL mainnet, 8.5 SOL devnet | same |
| Curve | curve A (section 3.3) | same |
| Creator trading fee percentage | 0 (the fee program splits instead, [ADR 0003](adr/0003-our-program-splits-every-curve-fee.md)) | same |
| Partner and `fee_claimer` | a PDA of the fee program | same |
| Leftover receiver | the fee program, which burns any leftover it withdraws **(owner, 2026-10-27)** | same |
| Pool creation fee | none (0) | same |
| Migration option | DAMM v2 | same |
| Migration fee | 0% (Meteora's fixed 0.2% protocol liquidity fee still applies) | same |
| Migration fee option | `Customizable`, with the market-cap fee scheduler (section 3.4) | same |
| Graduated LP buckets | partner 50% permanently locked, creator 50% permanently locked, nothing unlocked or vesting | same |
| Locked vesting | none | same |

Quotes with a non-zero Token-2022 transfer fee or a live fee authority are never accepted, now or later.

The sniper tax's integers **(owner, 2026-10-27)**: DBC's fee denominator is 1,000,000,000 and a 99% cliff with a whole-number linear step cannot end at exactly 1.25% after 60 steps.
Use cliff 989,999,960 (98.999996%) and reduction 16,291,666 per one-second period, so the ending fee is exactly 12,500,000 (1.25%), the curve fee every trader is told; the alternative (cliff 990,000,000) ends at 1.250004%.

| After the open | Fee | A 1 SOL buy pays | A 10 SOL buy pays |
| - | - | - | - |
| creation slot | 99% | 0.99 SOL | 9.90 SOL |
| 5 s | 90.85% | 0.91 SOL | 9.09 SOL |
| 30 s | 50.12% | 0.50 SOL | 5.01 SOL |
| 60 s and after | 1.25% | 0.0125 SOL | 0.125 SOL |

Timestamp mode, because slots are now about 212 ms and keep shrinking; linear, because an exponential fall over the same minute is at 48% after 10 s; sells pay it too.

### 3.3 Curve A

Two segments: a deep first segment sized for the largest pot, then a rise like pump.fun's.
A 17 SOL pot moves the price exactly 1.5625x, so the public opens exactly 1.25x above the pot's average price (a 5 SOL pot: 1.07x).
The same curve serves Instant launches.

| At 85 SOL | Curve A |
| - | - |
| Market cap at the start | 37.09 SOL |
| A full 17 SOL pot buys | 366,698,905 coins (36.67% of supply), at 4.636e-8 SOL each |
| Market cap at the open after a full pot | 57.95 SOL |
| Graduation price | 4.25e-7 SOL per coin (425 SOL market cap, 7.3x above the open) |
| A Verified depositor at the 2 SOL cap in a full pot holds | about 4.3% of supply |

Exact config values **(owner, 2026-10-27)**, computed from the decided shape with DBC's conventions (sqrt prices in Q64.64 of lamports per raw coin unit, liquidity such that quote = liquidity x delta sqrt price >> 128); total quote comes to exactly the target and total base to 800,000,000 coins less one raw unit:

| Value | Mainnet (85 SOL) | Devnet (8.5 SOL) |
| - | - | - |
| `sqrt_start_price` | 112339987264937698 | 35525023207151271 |
| `curve[0].sqrt_price` | 140424984081172123 | 44406279008939089 |
| `curve[0].liquidity` | 205974751412899298487096901153009 | 65134935495174677848696046692349 |
| `curve[1].sqrt_price` (graduation) | 380289371323205464 | 120258058333485015 |
| `curve[1].liquidity` | 96467846755739443120361515208159 | 30505811672022150935646294787906 |

The build regenerates these with the DBC SDK's `buildCurveWithCustomSqrtPrices` and checks that `create_config` accepts them: the last curve point must sit exactly at the migration price, which caps DBC's 25% swap buffer at the curve, and total supply must cover swap plus migration amounts after rounding.

### 3.4 The graduated pool

| Setting | Value |
| - | - |
| Fee | Meteora's market-cap fee scheduler, linear, from 1.25% at Graduation to 0.25% in 100 steps of 0.01% |
| Step spacing | the last step lands at exactly 100x the graduation market cap (each step adds 9% of the graduation sqrt price) |
| Expiry | 10 years after Graduation (315,360,000 s; the field is a u32 and neither program caps it) |
| Fees collected in | the quote asset |
| Dynamic fee | off |

The fee follows the current price, not the peak, so a coin falling back toward its graduation price climbs back toward 1.25% (2x: 1.21%, 10x: 1.01%, 50x: 0.58%).
Until the schedule expires, Meteora's operators cannot change the pool's base fee, only its dynamic fee.
The exact encoding of the step parameter is checked against DAMM v2's `fee_market_cap_scheduler.rs` in the build.

## 4. Fees

Sources: [Fee model](https://github.com/imDev2023/top-pad/issues/13), [ADR 0003](adr/0003-our-program-splits-every-curve-fee.md), [Our Fair Open program](https://github.com/imDev2023/top-pad/issues/28).
The model is the same in both launch modes, so creators pick a mode for its fairness and the cohort is not skewed by price.

| When | Trader pays | Meteora | Creator | Greenflag |
| - | - | - | - | - |
| Curve, after the tax window | 1.25% | 0.25% (20%) | 0.50% | 0.50%, plus about 0.05% referral share on swaps our site builds (out of Meteora's cut) |
| Curve, during the tax window | the sniper tax | 20% | nothing | Instant launch: the rest. Fair Open: the rest is the depositors' Tax Share, except the pot's own fee, split 50/50 |
| Surplus when the curve completes | | 20% | half of the rest | half of the rest |
| After Graduation | 1.25% falling to 0.25% by 100x | 20% | half the LP fees, through their own position NFT | half the LP fees |

- **The creator gets none of the sniper tax**, so a creator's creation-slot bundle pays the full tax with nothing refunded.
- **The pot's own fee is not part of the Tax Share**: it is split 50/50 like a normal trade, recorded in the creation transaction.
- **No one-off fees**: no pool creation fee, no graduation fee (Meteora's fixed 0.2% at migration applies), no surcharge on our own site, and a platform fee of 0 on trades routed through Jupiter.
- **No holder share** beyond the Tax Share; holder rewards are a mainnet-effort option, for which every coin's record keeps an empty earnings-recipient override.
- **One treasury address** receives Greenflag's Platform Fee: a plain key on devnet, a Squads multisig on mainnet.

How fees move:
- The configs give the creator 0% and name the fee program as partner, so the split binds every pool on the configs, including pools created by calling DBC directly.
- **Creator Earnings never sit in our programs**: they wait in Meteora's pool until claimed.
  A claim, which anyone can send, pulls a pool's partner fees from DBC and pays both halves in the same instruction: the creator's half to whoever holds the pool's DBC creator role at that moment, Greenflag's half to the treasury.
- The window claim at 60 s routes the window's fees to the launch's Tax Share (a Fair Open record exists) or to the treasury (every Instant launch, and pools made around our flow).
- A late window claim moves normal fees into the window; our keeper claims at 60 s, so at most a few seconds of 1.25% fees move.
- After Graduation the creator claims their LP fees from Meteora directly; the creator page claims curve earnings and LP fees in one transaction.

## 5. On-chain programs

Sources: [Our Fair Open program](https://github.com/imDev2023/top-pad/issues/28), [ADR 0006](adr/0006-a-fee-program-and-a-fair-open-program.md), [Fair Open creation transaction on devnet](https://github.com/imDev2023/top-pad/issues/31), [Launch liquidity](https://github.com/imDev2023/top-pad/issues/30), [Stack](https://github.com/imDev2023/top-pad/issues/17).

### 5.1 Common rules

- Two programs: a small **fee program** and the **Fair Open program**.
- Anchor 1.2.1; every deploy ships `security.txt` and an OtterSec verified build.
- Built for SBPF v2, the newest version devnet and mainnet run: Anchor 1.2.1 defaults to v3, which neither has activated (checked 2026-10-27).
- Every amount is in the quote's raw units and the quote mint is a parameter; nothing hard-codes SOL.
- Kit clients are generated with Codama from the programs' IDLs.
- Unit tests run in LiteSVM or Mollusk with our programs only; integration tests run against Meteora's programs deployed on devnet; no Meteora program binary is ever downloaded, dumped, committed or loaded in tests (Surfpool is out until Meteora answers in writing).
- Upgrades: a plain upgrade key, kept offline, on devnet; on mainnet, upgrades and treasury changes go through Squads with a 7-day timelock, the authority published and every build verified.
- The starting shape is the prototype's program on branch [`prototype/fair-open-creation-tx`](https://github.com/imDev2023/top-pad/tree/prototype/fair-open-creation-tx) (`prototypes/fair-open-creation-tx/program/src/lib.rs`: `create_launch`, `deposit`, `open`, `settle`, `claim`, with 10 unit tests of the transaction-shape check); it is throwaway, not a base to extend blindly.

### 5.2 The fee program

The partner on every Greenflag config, forever; it should rarely change.

Accounts:
- `FeeConfig`: the treasury address, the launch key, the Fair Open program id.
- `fee_claimer` PDA: the configs' partner and fee claimer; receives Greenflag's graduated LP position NFTs and holds them permanently locked.
- `CoinRecord` PDA, one per mint (the on-chain list of Greenflag coins): mint, pool, launch mode, the Fair Open launch it came from if any, the pot's own fee, whether the window claim has run, and an empty earnings-recipient override.

Instructions:
- `register_coin`: creates a `CoinRecord`; requires the launch key's signature (Instant launch, in the creation transaction) or a CPI from the Fair Open program's `settle` (Fair Open); about 0.001 SOL of rent per coin.
- `record_pot_fee`: CPI from `settle`; records the pot's own fee for the 50/50 split.
- `claim_window_fees`: the first partner-fee claim after the pool's 60 s window; anyone may send it; pays the window's fees, minus the pot's own fee split 50/50, to the launch's Tax Share account or to the treasury.
- `claim_fees`: anyone may send it; claims the pool's partner fees by CPI and pays half to the current DBC creator role holder (read from the pool account) and half to the treasury.
- `claim_surplus`: after the curve completes, splits the partner surplus the same way.
- `claim_lp_fees`: claims Greenflag's graduated LP fees to the treasury.
- `burn_leftover`: withdraws any DBC fixed-supply leftover after migration and burns it **(owner, 2026-10-27)**.

Invariants:
- It never holds a creator balance after an instruction ends.
- Window fees reach only the launch's Tax Share or the treasury.
- A `CoinRecord` exists only for a coin our launch key or the Fair Open program registered.
- **Unproven**: a PDA as `fee_claimer` claiming partner fees by CPI (Bags runs a program-owned fee claimer on mainnet, so the risk is low).

### 5.3 The Fair Open program

Holds deposits for the minutes of a window and carries everything that will keep changing.

Accounts:
- `ProgramConfig`: the admission signer's public key and the keeper's public key (both changed by the upgrade authority), the fee program id.
- `Launch` (about 1,100 bytes): the creator and Creator wallet, the scheduled open, the window's end, the minimum raise, the identity hash, the pot's cap, the nonce account, the rung parameters, deposit counts per 0.01 SOL step (200 steps to 2 SOL plus 10 for Unverified, 840 bytes), totals per tier, status, and after the open the coins bought and the SOL spent.
- `Vault`: a program-owned account holding deposits as plain SOL.
- The pot's wrapped-SOL and coin accounts.
- `Seat` (115 bytes), one per launch and person pseudonym: the wallet, tier, cap, deposit, fill, coins and refund owed, Tax Share owed, status.
  The pseudonym is a keyed hash of our cluster id salted per launch, so the chain never links one person's wallets across launches.

Instructions:
- `create_launch`: the creator signs; stores the schedule, minimum raise, identity hash and nonce reference; the creator prepays the launch's rent.
- `deposit`: checks our admission server's ed25519 signature over the launch, the wallet, the person pseudonym, the tier, the cap and an expiry, through the instructions sysvar; the first wallet of a person takes the seat and a second wallet of the same person is refused; enforces the tier cap in 0.01 SOL steps; updates the step counts; the depositor pays the seat and coin-account rent.
  There is no revoke instruction: nothing is reversed inside a window.
  A deposit's network fee is 10,000 lamports (the precompile signature is charged like a transaction signature).
- `withdraw`: until the window closes.
- `open`: refuses before the scheduled time and from 15 minutes after it; computes what the pot should spend from the step counts and checks the rung is the largest at or below it; checks the exact transaction shape by introspection, so a rung can do nothing but its one open; approves our keeper as SPL delegate for exactly the buy and wraps exactly the buy.
- `settle`: the last instruction of the creation transaction; revokes the delegate; records coins bought and SOL spent; checks the coin's name, ticker and URI from the DBC init against the identity hash; reads the pool's accrued partner fee and calls the fee program's `record_pot_fee` and `register_coin`.
- `push`: anyone; pays a batch of seats their coins and refund, creating their coin accounts from the rent they prepaid.
- `lock_creator`: anyone, right after the open; moves the creator's coins into a Jupiter Lock escrow by CPI to `create_vesting_escrow_v2` (`cancel_mode` 0, `update_recipient_mode` 2, recipient the Creator wallet, cliff at 7 days, linear to day 30); Jupiter Lock program `LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn`.
- `push_tax_share`: anyone, after the window claim; pays a batch of seats their Tax Share and closes them, returning the seat rent.
- `claim`: a depositor collects anything a push could not deliver.
- `mark_failed`: anyone, once the open is 15 minutes late, the minimum raise is missed, or the pot is below the lowest rung.
- `withdraw_failed`: a depositor alone takes back their deposit and both rents.

Invariants:
- The vault always holds at least the deposits, refunds and rent it owes.
- At most one open per launch, never before its scheduled time, never from 15 minutes after it.
- No seat's fill exceeds its tier's cap; Unverified fills add up to at most 25% of the SOL spent.
- The creator's coins leave the pot only into the Jupiter Lock escrow.
- **Unproven**: the program on chain at all (the prototype's never ran: the wallet had 0.027 SOL), its compute, `settle`, `claim`, the partial fill past the target, and the Jupiter Lock CPI.

## 6. Anti-abuse

### 6.1 The sniper tax

Every buy and sell pays the config's fee scheduler: 99% in the creation slot, falling linearly each second to 1.25% at 60 s, in both launch modes (section 3.2, [Sniper tax curve](https://github.com/imDev2023/top-pad/issues/23)).
It lives in the config, so it taxes trades routed through Jupiter and Titan exactly like ours.
A DBC config has one fee scheduler, so there is no separate humans-first window; Fair Open admission is Greenflag's humans-first window ([Block or label](https://github.com/imDev2023/top-pad/issues/12)).
On devnet the prototype measured the pot at 1.250%, a second buy in the same transaction at 99.000%, and a buy about 1 s later at 97.371%.

### 6.2 Vamp Shield

Sources: [Block or label](https://github.com/imDev2023/top-pad/issues/12), [How can we catch a copycat coin (vamp) before it launches?](https://github.com/imDev2023/top-pad/issues/6).
Every refusal is our launch key declining to co-sign; nothing on chain refuses a launch.

- **Refused** if the launch matches a Protected coin by any of:
  - the same folded ticker or name key (Unicode confusables per UTS #39, leetspeak, suffixes);
  - an image within PDQ distance 31 or less across all 8 orientations;
  - an SSCD similarity of 0.75 or more.
- **Labelled "looks like X"** on a near match: a derivative affix (BABY, INU), an edit distance of 1 on keys of 5 or more letters, or SSCD 0.60 to 0.75.
- All thresholds are starting values, re-measured against the refusal logs.
- **Protected coins** are earned by traction, never first-come: Jupiter-verified coins; Solana coins with real organic activity; coins trending now (protected for 72 hours); CoinGecko's top 1,000; Greenflag coins that completed a Fair Open or reached 100 holders.
  A Greenflag coin's protection lapses when it falls below the activity bar (organic score under 30 and under 300 holders over 7 days).
  108 strict keys are shared among verified tokens, so a dictionary word alone is never protected.
- **Ticker uniqueness** lives in the database, not on chain: a partial unique index on the strict key covers coins in an open deposit window and protected Greenflag coins, and a failed launch releases its key; our launch key refuses to co-sign a duplicate.
- **Appeals** go to the operator queue before launch; relaunches and community takeovers pass by linking the original mint and proving control.

### 6.3 Fair Open admission

- Verification is once per person on Greenflag, giving the Depositor tier in section 2.1.
- The linkage pipeline (off chain) ties wallets to one person: that person's wallets become one admission with one cap, enforced on chain by the one-seat rule.
- Wallets tied to the creator's cluster, other than the creator's own wallet, are refused.
- No other linkage signal refuses anyone, because no Solana linkage method has published accuracy.
- A wallet refused or merged at admission sees the reason at once and can still buy after the open.
- An upheld appeal clears the wallet for future Fair Opens only.
- World ID cannot be verified on chain on Solana, so it is checked by our server.

### 6.4 Bundle Radar labels

After the open, Bundle Radar only labels, each label with its evidence linked:
- same-slot buys;
- buys in the four positions right after the creation transaction;
- Jito bundle membership (mainnet only; Jito runs no devnet block engine);
- direct funding links to the Creator wallet.

Labels never move a coin's ranking (section 8).

### 6.5 Confirmed bundling and bars

Source: [Confirmed bundling](https://github.com/imDev2023/top-pad/issues/34).

- **Only a direct link to the Creator wallet confirms a finding**:
  - the buy's signer or fee payer is the Creator wallet;
  - the buy sits in the same Jito bundle as the coin's creation transaction, or in positions 1 to 4 right after it (185 of 186 such buys were in the launch bundle);
  - SOL or coins passed directly between the buying wallet and the Creator wallet in the 7 days before the open, or as proceeds sent back in the 7 days after it.
- Probabilistic signals (multi-hop funding, exchange time windows, matching amounts or timing) only ever label.
- **A floor of 1% of supply**: the linked wallets must have bought 1% or more between them, counted across the pot and the first hour of trading.
- **A job opens the case, a person confirms it, a different person hears the appeal**: no bar is applied automatically; the case holds the evidence pack (the transactions, the Jito bundle ids and the transfers behind each link); on mainnet the appeal goes to a second operator; on devnet the owner fills both roles.
- **Bars start on day one**; any other signal may count toward confirmation only once the Bundle Radar evaluation measures its precision at 99% or more (section 11.5).
- **The bar applies at once; the finding stays private for 72 hours**: our launch key stops co-signing the creator's launches; any scheduled Fair Open not yet in its window is cancelled; the creator gets the evidence pack on their record page and by X direct message, and may reply.
  After 72 hours the record shows "Barred: confirmed creator bundle in <coin>, <date>" with the evidence and appeal status, and the coin's page and Fairness card show "confirmed creator bundle".
- **One appeal within 30 days, decided in 48 hours**; a second only with new evidence.
  Grounds: a link is wrong (a shared exchange or custodian, or a launch service bundling for its customers).
  An upheld appeal lifts the Bar and removes the finding from the public record; the audit log keeps it.
- **A Bar never expires and only stops new launches**: it bars the X account, the Creator wallet and any World ID nullifier from launching; Creator Earnings keep flowing, the Creator lock keeps vesting, existing coins keep trading with the finding shown; a barred Creator may still trade and deposit in other creators' Fair Opens.
- The "How this is enforced" page publishes the counts of bars, appeals and overturned findings.

### 6.6 The operator queue

One queue handles refused launches, refused or merged admissions, bundling cases and appeals, aiming to answer within 48 hours.
On devnet the owner is the only operator; mainnet staffing is part of the mainnet effort.

## 7. Creators

Sources: [Creator record](https://github.com/imDev2023/top-pad/issues/21), [Confirmed bundling](https://github.com/imDev2023/top-pad/issues/34), [Discovery and ranking](https://github.com/imDev2023/top-pad/issues/37).

- **The Creator record belongs to an X account**, required for every launch; a wallet resets for free (3 in 4 creator wallets launch once), an audience does not.
- **One Creator wallet at a time**: the only wallet that signs the record's launches, and the wallet terminals show as dev.
  It changes by a handover the old wallet signs, shown on the record.
  A lost wallet rotates through the X account after a public cooldown of 7 days, which the current Creator wallet can cancel **(owner, 2026-10-27)**.
- **An optional World ID Orb "verified human" mark**, checked on our server, with one action shared across Greenflag so each human has one nullifier, bound to their record; a Bar then follows the person.
- **History stays with the launcher; earnings follow the creator role**: our indexer follows every `transfer_pool_creator`, made on our site or not; Creator Earnings go to whoever holds the role; the coin stays on the original Creator's record, marked "handed over to ..." on both records.
- **The record shows only facts anyone can recompute**, with no composite score: launches by mode; graduations and the graduation rate; Creator lock status; sells from the Creator wallet; coins handed over; coins that never graduated and went quiet; Bundle Radar findings with their evidence; any Bar.
- **A good record earns visibility, never exceptions**: the record on the coin page and the Fairness card, a verified-creator mark, and priority for the calendar's featured slots.
  A good record means at least one graduated Greenflag coin, no Bar and no open bundling case.
  Locks, caps, the sniper tax and the fee split are the same for everyone.

## 8. Discovery and ranking

Source: [Discovery and ranking](https://github.com/imDev2023/top-pad/issues/37).

- **Only coins our launch key co-signed are Greenflag coins**: the board, search and calendar list nothing else; the list is the fee program's `CoinRecord` accounts on chain, mirrored by a public API and a signed daily snapshot.
- **The board's order**: Live now (Fair Open windows in progress, with countdowns); Up next (the sealed calendar for the next 7 days); Trending; New (Instant launches at creation, Fair Opens at their open, newest first); Graduated.
- **Trending counts people, not volume**: unique net buyers in the last hour, decayed by age, with per-wallet-capped buy volume as the tie-break.
  Never counted: wallets Bundle Radar ties to the coin's creator, wallets on Greenflag's known-bot list, and a buy and sell inside one transaction.
  The known-bot list holds wallets that bought in the first 2 seconds of 3 or more launches and wallets that made a buy and sell inside one transaction; an operator can remove a wallet; thresholds are tuned against the Bundle Radar evaluation set.
  Trending is recomputed every 15 s.
- **Labels only mark; a confirmed bundle demotes**: "looks like X" and unconfirmed Bundle Radar labels show on a coin's row but never move it; a coin with a confirmed creator bundle leaves Trending and every featured slot, and stays in New and search with its banner.
- **Three featured calendar slots a day, earned, never sold**: only good records qualify; among them, the highest graduation rate first, then the most recent graduation; first-time creators still get the full calendar entry and Live now.
- No profit leaderboard in this build (section 15).

## 9. Screens

Sources: [What should Top-pad look like?](https://github.com/imDev2023/top-pad/issues/15), [Greenflag screens mockup](https://claude.ai/artifact/TCCQ6amBP6ic2tDuvfB4ZH) (a private page; the owner can share it), branch [`prototype/screens-mockup`](https://github.com/imDev2023/top-pad/tree/prototype/screens-mockup).
The mockup is throwaway; the build implements these choices, not its code.

Design decisions:
- **The name is Greenflag** (`greenflag.fun`); a legal check against the UK roadside-recovery brand Green Flag belongs to the mainnet effort.
- **Race-marshal flags are the visual language**: green proven on chain, yellow labelled, red a Bundle Radar finding, a checkered flag at Graduation.
- **Dark-first** on asphalt grey, with a mirrored light theme.
- **Fair Opens lead the board** (section 8's order).
- **Coin page layout B**: a flags strip above the chart, each flag expanding on tap, the full Fairness card one tap away.
- **The Fairness card opens with its green, yellow and red counts**, any red count first and the card's border turning red.
- **The sealed calendar entry** shows a "?" tile, the teaser, the creator's record summary and the terms.
- **On phones, the deposit panel comes first**, the explainer of the open below it.
- **The sniper tax is a yellow band** with the live percentage, a countdown and "never to the creator", turning green when the minute ends.
- **One plain signing step** for the nonce ladder, the rungs behind a details link.
- **An Instant launch's card says openly** that the first minute's tax went to Greenflag.

The screens:
1. **Discover**: the board in section 8's order, each coin row with its flags.
2. **Fair Open page**: the countdown, the pot filling (with the 25% Unverified line), the minimum raise, the depositor's tier and cap with "Verify once", deposit and withdraw, the refundable rent, "if the window closed now" (each person's share, your fill, your refund), and what happens at the open.
3. **Coin page**: name, ticker, mint, price, market cap, holders; the flags strip and Fairness card; the tax band during the first minute; the chart (TradingView Lightweight Charts v5, 1 s, 15 s and coarser candles); the graduation bar to 85 SOL; quick buy showing the fee before signing; trades with the fee each paid, the labelled keeper's pot buy pinned; banners for a confirmed bundle, a Meteora-paused pool, or "Not launched through Greenflag".
4. **Launch flow**: link X; Fair Open (preselected) or Instant launch; the coin with live Vamp Shield verdicts (clear, "looks like X", refused with an appeal link); schedule (time up to 7 days ahead, minimum raise, teaser, about 0.03 SOL refundable rent); sign; done.
5. **Creator record**: the facts in section 7, Creator wallet history, the verified-human and verified-creator marks, Creator Earnings from both sources with one claim, and for a barred Creator the banner, evidence pack and appeal history; the accused creator's private 72-hour view with a reply box.
6. **How this is enforced**: each promise, what keeps it, and who could still change it (below).
7. **Operator app** (separate, section 10): cases, appeals, refused launches and admissions.

The Fairness card's rows:
- Launch: Fair Open with the number of people and one price, and "identity matched the sealed hash", or Instant launch with no creator buy.
- Creator lock: the creator's deposit and "locked until <date>", linking the Jupiter Lock escrow (never called "open source").
- The creator's unlocked holdings from later buys.
- Liquidity: before Graduation "Liquidity sits in Meteora's bonding curve; nobody can withdraw it"; after Graduation "100% of liquidity locked forever", linking both positions.
- Bundle Radar findings with evidence, and any "confirmed creator bundle".
- The creator and their record summary.
- The labelled Greenflag keeper that sent the pot's buy.
- The Tax Share paid to depositors, or for an Instant launch the tax that went to Greenflag.
- A link to "How this is enforced".

"How this is enforced" says, at least:
- the sniper tax and fee split live in Meteora's config and nobody can edit them after launch;
- Fair Open rules and the 15-minute withdrawal live in the Fair Open program, upgradeable only through the 7-day timelock on mainnet (a plain key on devnet);
- nobody can cancel the Creator lock, Greenflag included;
- nobody can withdraw liquidity before Graduation or unlock it after;
- Meteora's operators can pause a graduated pool (withdrawals still work) and change its dynamic fee, but not its base fee until the schedule expires; Meteora can upgrade its own programs;
- copycat and bundling labels are Greenflag's judgement, with the evidence linked; the counts of bars, appeals and overturned findings;
- the guarantees cover only coins our launch key co-signed, and only those are listed.

Also in the build: a P&L share card for a trader's own position (one of the core trading basics in the brief; owner, 2026-10-27), and the Fairness card as an image for X link cards (2:1, under 5 MB), the one channel to traders fully ours ([How can Top-pad's fairness data reach the trading terminals](https://github.com/imDev2023/top-pad/issues/20)).

## 10. Backend and stack

Sources: [Stack](https://github.com/imDev2023/top-pad/issues/17), [Backend design](https://github.com/imDev2023/top-pad/issues/36), [Which charts, market data and swap routing should the trading screens use?](https://github.com/imDev2023/top-pad/issues/8), [What should the prototype be built on?](https://github.com/imDev2023/top-pad/issues/9).

### 10.1 Stack

| Layer | Choice |
| - | - |
| Repo | a new pnpm monorepo shaped like Stoker's |
| Web | Next.js 16 on Cloudflare Workers through OpenNext, a pure client of our API |
| API | Hono with a zod contract |
| Data | Drizzle on Postgres through Hyperdrive, on Neon for the devnet build **(owner, 2026-10-27)**; pgvector for image signatures |
| Jobs | Cloudflare Workflows; Durable Objects for live rooms and alarms |
| Containers | Cloudflare Containers for the vision service, and for the LaserStream consumer once the paid Helius plan is in place |
| Chain clients | Kit everywhere we own, generated with Codama; `@solana/web3.js` v1 only inside `packages/meteora` for the DBC and DAMM v2 SDKs' curve and quote maths, behind a narrow interface, with parity tests against real devnet swaps |
| Meteora adapter | DBC and DAMM v2 only; no DLMM, no Alpha Vault |
| Programs | Anchor 1.2.1 |
| Metadata | Arweave through Turbo |
| Charts | TradingView Lightweight Charts v5 |
| Trading | direct swaps on our pools built by our server, earning Meteora's referral share; Jupiter Swap v2 for routing beyond them; Titan later as a second quote |
| Copied from Stoker | `packages/arweave` (308 lines), the job runner (87), the indexer (337) and the test wallet (126), each copied file headed with Stoker commit `43e196b` |

### 10.2 Components and data flow

- **Indexer**: one ingestion entry point behind a narrow source interface, decoding Meteora's and our programs' events itself, with two sources **(owner, 2026-10-27)**:
  - **during the devnet build, free-tier RPC**: standard WebSocket `logsSubscribe` on the DBC, DAMM v2 and our programs' ids, `getBlock` for each transaction's position in its block, and reconciliation from `getSignaturesForAddress` plus `getTransaction`;
  - **when getting ready to launch, a Helius LaserStream (Yellowstone gRPC) stream** in a small Cloudflare Container, which checkpoints its last slot and replays after a restart, with reconciliation through `getTransactionsForAddress` (which also returns each transaction's position in its block).

  Switching sources changes only the entry point, never the decoding or the tables.
  The browser's fast path reports a confirmed trade so it shows at once.
  No webhooks: they carry no in-block position, can lose an event after 3 failed retries, and take minutes to watch a new address.
- **Live rooms**: one Durable Object per coin and one for the board, holding hibernatable WebSockets; the indexer publishes each decoded trade to its room; rooms batch every 100 ms; a reconnecting browser resyncs from its last slot through the API.
- **Trades and candles**: the `trades` table is kept forever; the indexer writes 1 s candles on every trade, and 15 s, 1 m, 5 m, 15 m, 1 h, 4 h and 1 d roll up from them; 1 s candles are kept 7 days, 15 s candles 30 days, coarser ones forever; any candle can be rebuilt from trades.
- **Trending**: the board's Durable Object runs one Postgres query on a 15 s alarm and pushes the result to every viewer.
- **Keeper**: one Cloudflare Workflow per launch, keyed by the launch id:
  1. 15 s before the open, upload the metadata and image through Turbo;
  2. at the open, broadcast the rung once the metadata URI is served, holding up to 10 s;
  3. run `lock_creator`;
  4. push coins and refunds in parallel batches of 10 transactions;
  5. at 60 s, send the window claim;
  6. push the Tax Share;
  7. if the open has not landed 15 minutes after its time, mark the launch failed.

  Graduation is its own Workflow, started when the indexer sees a curve complete.
  Every step is safe to repeat on chain.
  If the build measures the open landing more than 2 s late, the open alone moves to a Durable Object alarm.
- **Admission server**: verifies personhood once (World ID server-side, Civic Uniqueness, Trusta-style attestations, X; no KYC), runs the linkage pipeline, and signs each deposit's admission.
- **Launch service**: X OAuth, Vamp Shield checks, the ticker reservation, Arweave data items, the nonce account, collecting the ladder's signatures, and co-signing Instant launches.
- **Vision service**: PDQ (all 8 orientations) and SSCD on CPU in one Python Container behind a Durable Object, asleep when idle; signatures in Postgres (PDQ `bit(256)` with a Hamming HNSW index, SSCD `vector(512)` with a cosine HNSW index).
  The protected set refreshes from Jupiter's trending endpoints every minute, its verified and organic lists hourly, CoinGecko's top 1,000 daily, and our own coins as they cross the protection bar.
- **Bundle Radar**: labels from the indexer within seconds; one hour after each open a job builds the evidence pack (positions, Jito bundle membership on mainnet from Jito's public API, each linked buyer's direct transfers over the previous 7 days) and opens a case if it meets section 6.5's rules.
- **Operator app**: its own Worker behind Cloudflare Access (free for up to 50 users), never a route of the public site; every operator action writes an audit row through a database role that can only insert; the audit log is exported to R2 daily; evidence packs are stored with their case.
- **Cohort tap**: gives each cohort member 1 devnet SOL once.

### 10.3 Keys

- At scheduling every rung collects all its signatures; at the open the keeper only broadcasts, and no mint key is ever stored.
- Two runtime hot keys, each in Cloudflare Secrets Store and bound only to the Worker that uses it:
  - the **keeper key**: fee payer for the lock, pushes, claims and graduation, the pot's delegate and the nonce authority, and the launch key that co-signs creation transactions and registers coins, holding a capped SOL float with a low-balance alert **(owner, 2026-10-27)**;
  - the **admission signer**, holding no funds.
- The upgrade and treasury keys never touch Cloudflare: kept offline on devnet, held by Squads on mainnet.

### 10.4 Data

- Postgres is the only system of record: launches, seats, coins, pools, trades, candles, transfers (the funding graph), the co-signed list mirror, creators (X account, Creator wallet history, World ID nullifier), admissions, protected coins and their signatures, the known-bot list, cases, appeals, bars, the audit log, job runs and indexer cursors.
- R2 holds blobs: an Arweave image cache, Fairness card images, evidence pack and audit exports.
- KV holds only public caches (up to 60 s stale).
- Durable Object storage holds only live-room state; D1 is not used.
- One Neon project for devnet **(owner, 2026-10-27)**: Supabase's free plan allows two active projects and both are Stoker's; Convex was weighed and set aside, because the board's trending query, the funding graph, the candle rebuilds and the insert-only audit role are SQL.
- CI runs lint, typecheck, unit tests and `anchor build`.

### 10.5 Providers

- **During the devnet build, free tiers only (owner, 2026-10-27)**: a devnet endpoint from the owner's Chainstack or QuickNode accounts for RPC, WebSockets and sending, with the shared Helius free key as a second (it sends 1 transaction per second and is rate-limited when agents run in parallel); devnet Fair Opens have tens of depositors, not hundreds, so pushes stay within these limits.
- **When getting ready to launch**: a dedicated Helius project on the Developer plan ($49 a month) or higher, its key in the project's own `.env`, not the owner's shared key file: LaserStream, `getTransactionsForAddress`, 10M credits, 50 requests and 5 sends per second.
- A second provider for sending and fallback reads: the owner's existing Chainstack or QuickNode endpoint.
- Mainnet LaserStream needs Helius Business or Professional; that choice belongs to the mainnet effort.

## 11. Devnet proof plan and acceptance

Source: [Proof plan](https://github.com/imDev2023/top-pad/issues/35).
**Done means every mandatory integration test (11.2) and all four attack simulations (11.1) pass on devnet.**
The cohort (11.3) informs the default-mode decision but does not gate the build; what devnet cannot show, chiefly how terminals display a coin, goes to the mainnet effort.

### 11.1 Attack simulations

| Simulation | Setup | Passes when |
| - | - | - |
| Sniper | a bot buys in the creation slot and at 1, 5, 30 and 60 s, on a Fair Open and an Instant launch, until at least 5 separate transactions land in the creation slot | every creation-slot buy paid 99%; every later buy paid the linear schedule to within one 1-second step; the pot paid 1.25%; every first-minute fee reached the Tax Share or the treasury |
| Bundler | the Creator wallet and 4 wallets it funded directly buy an Instant launch in the creation slot and sell 2 minutes later | the bundle loses at least 97% of what its creation-slot buys spent; Bundle Radar labels the coin; a case opens with its evidence pack and the owner confirms it; our launch key refuses the creator's next launch; the 72-hour private window and the appeal form work |
| Farm | 100 wallets funded from one source and 20 honest wallets against one Fair Open | the linked wallets get one seat; wallets tied to the creator's cluster are refused; a second wallet of a seated person is refused on chain; Unverified fills stay at or under 25%; the on-chain level matches our server's reference calculation to the lamport; every seat gets its coins and refund within 2 minutes |
| Failure | attempts to spoil, rush or hijack the open | each fails: the creator advancing the nonce, the keeper sending a rung early or a smaller rung than the pot covers, a coin that differs from the committed hash, `open` 15 minutes late; then, with the keeper switched off, every depositor withdraws on chain alone |

### 11.2 Mandatory integration tests

All on devnet, against Meteora's deployed programs, with no Meteora binaries anywhere:
- both programs deployed from verified builds, each instruction's compute measured;
- a full Fair Open (scheduling, deposits, the open, the lock escrow with the right cliff and recipient, the pushes, the Tax Share, closed seats), plus a partial fill;
- the 64-rung ladder signed in one prompt in Phantom, Solflare and Backpack, plus the sign-at-the-open fallback;
- the coin's metadata served through Turbo within 10 s of upload, before the rung lands;
- the fee program's PDA claiming partner fees by CPI, the 60 s window claim, and the 50/50 split paying whoever holds the creator role;
- graduation at 8.5 SOL by our keeper, both LP halves permanently locked, the graduated pool's fee stepping down on schedule;
- an Instant launch run through to graduation;
- one Fair Open and one Instant launch priced in Circle's devnet USDC, checking deposits, refunds, the Tax Share and Creator Earnings in a non-SOL quote (tests only, never offered on the site).

### 11.3 The cohort

- About 30 creators and 100 traders for 2 weeks, recruited from the owner's X following and memecoin Telegram groups; members link X as the launch flow requires and get 1 devnet SOL once from our tap.
- It measures the share of creators who keep Fair Open (preselected) rather than switch to Instant launch; how many sealed Fair Opens reach their minimum raise, and depositors per Fair Open; creators who launch a second coin and depositors who join a second Fair Open, as weak evidence.
- **Fair Open stays the default unless fewer than a third of cohort creators keep it, or fewer than half of sealed Fair Opens reach their minimum raise.**

### 11.4 Devnet SOL

About 60 SOL for the proof (about 6 to deploy two programs, about 26 for three graduations at 8.5 SOL, about 15 for simulation wallets, the rest margin) and about 130 for the cohort; most comes back by selling test coins.
Every CLI airdrop was refused during the prototype, so the owner collects it (section 13).
faucet.solana.com gives at most 10 SOL every 8 hours when signed in with GitHub (at most 30 SOL a day), so collection runs alongside the build: the first slices need only the deploys (about 6 SOL), the proof's 60 SOL is 2 to 3 days of requests, and the cohort's 130 accrues during the build, before slice 11 needs it.

### 11.5 The Bundle Radar evaluation

- Runs during the build, not before it: bars already run on direct links, so it only gates promoting a new signal.
- 2,000 recent pump.fun launches; ground truth is Jito's public bundle API, which shows which block-0 buyers sat in the launch's own bundle (it answered without a key on 2026-10-27).
- Creator wallets are in block 0 of about 1 in 5 launches, so about 400 bundled launches.
- A signal passes when the low end of its 95% Wilson interval reaches 99%: at least 400 flagged wallets with none wrong, or 1,000 with at most 3.
- The Cryptstarter and Harmonized fleet (about 70 wallets across five launches, funded through exchanges and hop wallets) is the second case, covering what Jito cannot see.
- Built with standard RPC reads on free tiers and Jito's public API; no paid Bitquery archive.

## 12. Parameters

| Parameter | Value | Source |
| - | - | - |
| Coin supply, decimals | 1,000,000,000 fixed, 6 | [#33](https://github.com/imDev2023/top-pad/issues/33) |
| Curve / graduated pool supply | 80% / 20% | [#33](https://github.com/imDev2023/top-pad/issues/33) |
| Graduation Target | 85 SOL mainnet, 8.5 SOL devnet | [#33](https://github.com/imDev2023/top-pad/issues/33) |
| Market cap at the start / at Graduation | 37.09 SOL / 425 SOL | [#33](https://github.com/imDev2023/top-pad/issues/33) |
| Curve fee after the tax window | 1.25% (Meteora 0.25%, creator 0.50%, Greenflag 0.50%) | [#13](https://github.com/imDev2023/top-pad/issues/13) |
| Sniper tax | 99% cliff, linear, 60 one-second periods, ending at 1.25% | [#23](https://github.com/imDev2023/top-pad/issues/23) |
| Sniper tax integers | cliff 989,999,960, reduction 16,291,666 per period (owner, 2026-10-27) | this spec |
| Tax window | 60 s | [#23](https://github.com/imDev2023/top-pad/issues/23) |
| Graduated pool fee | 1.25% to 0.25%, 100 linear steps of 0.01% by 100x market cap, 10-year expiry | [#13](https://github.com/imDev2023/top-pad/issues/13), [#33](https://github.com/imDev2023/top-pad/issues/33) |
| Graduated LP | 50% partner, 50% creator, both permanently locked | [#30](https://github.com/imDev2023/top-pad/issues/30) |
| Deposit window | 10 minutes, fixed, scheduled up to 7 days ahead | [#19](https://github.com/imDev2023/top-pad/issues/19) |
| Pot cap | 20% of the Graduation Target (17 SOL; 1.7 SOL on devnet) | [#19](https://github.com/imDev2023/top-pad/issues/19) |
| Public opening vs the pot's price | at most 1.25x | [#19](https://github.com/imDev2023/top-pad/issues/19) |
| Tier caps | Verified 2 SOL, Scored 0.5 SOL, Unverified 0.1 SOL; unscaled on devnet; fixed in SOL on mainnet (owner, 2026-10-27) | [#19](https://github.com/imDev2023/top-pad/issues/19), [#33](https://github.com/imDev2023/top-pad/issues/33) |
| Unverified share of the pot | at most 25% of what it spends | [#19](https://github.com/imDev2023/top-pad/issues/19) |
| Deposit step | 0.01 SOL | [#28](https://github.com/imDev2023/top-pad/issues/28) |
| Ladder rungs | 5% steps from the pot's cap, at most 64 | [#28](https://github.com/imDev2023/top-pad/issues/28) |
| Late-open withdrawal | 15 minutes after the scheduled time | [#19](https://github.com/imDev2023/top-pad/issues/19) |
| Creator lock | nothing for 7 days after the open, linear to day 30 | [#11](https://github.com/imDev2023/top-pad/issues/11) |
| Depositor rent | seat 0.00123 SOL + coin account 0.00149 SOL, about 0.0027 SOL, refundable | [#28](https://github.com/imDev2023/top-pad/issues/28) |
| Creator rent at scheduling | about 0.03 SOL, refundable | [#28](https://github.com/imDev2023/top-pad/issues/28) |
| Lock escrow rent | about 0.0036 SOL, from the creator's deposit | [#28](https://github.com/imDev2023/top-pad/issues/28) |
| Coin record rent | about 0.001 SOL per coin | [#36](https://github.com/imDev2023/top-pad/issues/36) |
| Push batch | about 8 depositors per transaction (coins and refunds), about 14 (Tax Share); parallel batches of 10 transactions; all within 2 minutes | [#28](https://github.com/imDev2023/top-pad/issues/28), [#35](https://github.com/imDev2023/top-pad/issues/35), [#36](https://github.com/imDev2023/top-pad/issues/36) |
| Teaser | free text, at most 80 characters, no links or cashtags, Vamp Shield's text checks (owner, 2026-10-27) | this spec |
| Creator wallet rotation cooldown | 7 days, cancellable by the current Creator wallet (owner, 2026-10-27) | this spec |
| Rounding and dust | level floored to the lamport; SOL spent rounds up, coins round down; lamport dust to the Tax Share; coin dust and DBC leftover burnt (owner, 2026-10-27) | this spec |
| Creator's seat and the Tax Share | no Tax Share for the creator's seat (owner, 2026-10-27) | this spec |
| PDQ refuse threshold | distance 31 or less, all 8 orientations | [#12](https://github.com/imDev2023/top-pad/issues/12) |
| SSCD thresholds | refuse at 0.75 or more, label 0.60 to 0.75 | [#12](https://github.com/imDev2023/top-pad/issues/12) |
| Trending protection | 72 hours | [#12](https://github.com/imDev2023/top-pad/issues/12) |
| Protection lapse | organic score under 30 and under 300 holders over 7 days | [#12](https://github.com/imDev2023/top-pad/issues/12) |
| Bundling confirmation | direct link, 1% of supply across the pot and the first hour, 7-day transfer window | [#34](https://github.com/imDev2023/top-pad/issues/34) |
| Private window before publication | 72 hours | [#34](https://github.com/imDev2023/top-pad/issues/34) |
| Appeals | one within 30 days, decided in 48 hours; a second only with new evidence | [#34](https://github.com/imDev2023/top-pad/issues/34) |
| Featured calendar slots | 3 a day | [#37](https://github.com/imDev2023/top-pad/issues/37) |
| Trending window and refresh | last hour, recomputed every 15 s | [#37](https://github.com/imDev2023/top-pad/issues/37), [#36](https://github.com/imDev2023/top-pad/issues/36) |
| Known-bot rule | first 2 s of 3 or more launches, or an in-transaction buy and sell | [#36](https://github.com/imDev2023/top-pad/issues/36) |
| Candle retention | 1 s for 7 days, 15 s for 30 days, coarser forever | [#36](https://github.com/imDev2023/top-pad/issues/36) |
| Bundle Radar evaluation | 2,000 launches, 99% at the 95% Wilson lower bound | [#35](https://github.com/imDev2023/top-pad/issues/35) |
| Cohort | about 30 creators and 100 traders, 2 weeks, 1 devnet SOL each | [#35](https://github.com/imDev2023/top-pad/issues/35) |
| Upgrade timelock (mainnet) | 7 days, Squads | [#30](https://github.com/imDev2023/top-pad/issues/30) |

## 13. Prerequisites and owner tasks

1. **Devnet SOL**: about 190 (about 60 for the proof, about 130 for the cohort), collected by the owner through the Solana Foundation faucet signed in with GitHub (at most 10 SOL every 8 hours) and QuickNode's faucet (one drip per 12 hours), into `3hTTgfj2YqqYJeEgSF49U8ZyZwyHnwPhF9LRsXy4fMY8`; started now and continued through the build, since at the faucet's limit 190 SOL takes at least a week (section 11.4).
2. **A Helius Developer plan** ($49 a month or higher) in a Greenflag project, its key in the project's `.env`: not needed for the devnet build, which runs on free tiers; bought when getting ready to launch (section 10.5).
3. **Meteora's follow-up** ([Ask Meteora in writing](https://github.com/imDev2023/top-pad/issues/26), Discord ticket `devlaunch-6428`).
   Meteora's support answered on 2026-10-27: building on Meteora is permissionless and needs no approval, partner agreement or fee arrangement, as long as the product keeps to the Terms of Service and Privacy Policy, and a launchpad built on Meteora is not counted as competitive; licence files for the DLMM and Alpha Vault SDKs are being added.
   Not yet answered, in a follow-up drafted on that ticket for the owner to send: whether our program may act for depositors (6.2(d)), whether Meteora's binaries may run in our tests, and whether the SDKs' IDLs may back CPI bindings.
   None of it blocks this devnet build; a no on 6.2(d) would reopen [ADR 0002](adr/0002-fair-open-on-dbc-with-our-own-deposit-program.md).
4. **The Jupiter message** ([Ask Jupiter how it labels a launchpad's Fair Open pot buy](https://github.com/imDev2023/top-pad/issues/32)), drafted in that ticket, for the owner to send: how Jupiter labels the keeper's pot buy, the pushes out of the pot, and a Verified depositor holding about 4.3% of supply.
5. **The cohort**: recruiting about 30 creators and 100 traders from the owner's X following and memecoin Telegram groups.

## 14. Build order

Thin end-to-end slices, in dependency order, each ending in something demonstrable on devnet:

1. **Skeleton and configs**: the monorepo, CI, Codama clients for DBC, DAMM v2 and Jupiter Lock, the copied Stoker modules; both DBC configs created on devnet with the section 3 values, `create_config` accepting the curve integers.
   Demo: two config accounts on devnet with the right parameters.
2. **Instant launch and trading**: the fee program's `register_coin`; the launch service (X OAuth, Vamp Shield's text rules, the launch key co-signing); the indexer on free-tier WebSockets, trades and candles; the coin page with the tax band, chart, trades and quick buy through server-built direct swaps.
   Demo: launch a coin, watch the 99% to 1.25% tax on real devnet trades.
3. **Fee claims**: `claim_window_fees` at 60 s, `claim_fees` 50/50 to the creator role holder; the creator page's one-transaction claim.
   Demo: the window's fees reach the treasury, later fees split 50/50.
4. **Fair Open core**: the Fair Open program (`create_launch`, `deposit` with the admission co-signature and seats, `withdraw`, `open` with the rung check, `settle`, `push`, `mark_failed`, `withdraw_failed`); the nonce ladder; the keeper Workflow; the Fair Open page; the ticker reservation; the admission server's one-time verification and the linkage pipeline (section 6.3).
   Demo: a full Fair Open from scheduling to coins in depositors' wallets, and a failed one refunded on chain.
5. **Creator lock and Tax Share**: `lock_creator` into Jupiter Lock, `push_tax_share`, closed seats; sealing with Arweave data items and the identity hash.
   Demo: the creator's escrow on chain with the right cliff; depositors receive their Tax Share.
6. **Graduation**: the graduation Workflow at 8.5 SOL, both LP halves locked, the graduated pool's fee schedule, `claim_surplus`, `claim_lp_fees`, `burn_leftover`, the creator's LP fee claim.
   Demo: a coin graduates and trades on DAMM v2.
7. **Anti-abuse**: the vision Container and the protected-set refresh; Vamp Shield's image rules; Bundle Radar labels; the case job; the operator app; Bars, the 72-hour private window and appeals.
   Demo: the bundler simulation end to end.
8. **Creators and discovery**: the Creator record, Creator wallet handover and rotation, the World ID mark, role-transfer tracking; the board, trending with the known-bot list, featured slots, the calendar.
   Demo: the board ranks a test cohort's coins.
9. **Fairness and enforcement pages**: the Fairness card and its X image, "How this is enforced", the P&L share card, a review of every screen on phones and desktops in both themes.
   Demo: the screens in section 9 on real devnet data.
10. **Proof**: the four simulations and the integration test suite; the Bundle Radar evaluation on mainnet data; the cohort tap.
    Demo: the acceptance run in section 11.
11. **Cohort**: two weeks, then the default-mode decision by section 11.3's rule.

Every screen ships its phone layout and both themes in the slice that builds it **(owner, 2026-10-27)**.

The build tickets (2026-10-27): [#39](https://github.com/imDev2023/top-pad/issues/39) to [#64](https://github.com/imDev2023/top-pad/issues/64), sub-issues of the map labelled `build`, wired with native blocking edges in this order; each names the spec sections it implements and its devnet demo.
The open `build` tickets with no open blocker are the build's frontier.

When getting ready to launch, outside these slices: buy the Helius plan and switch the indexer's source to LaserStream in a Container (section 10.2).

## 15. Out of scope

Not in this build; each returns only as its own effort, mostly the mainnet effort:
- Mainnet itself: legal work and country blocking, a security audit, the entity's jurisdiction, a signed partner agreement with Meteora, the legal check of the Greenflag name.
- Giving up the programs' upgrade keys, the members of the Squads multisig, a faster emergency rotation of the admission key than the timelock allows, an external signer or KMS for hot keys, and the mainnet LaserStream plan.
- Integration requests to trading terminals (a Jupiter launchpad listing and custom tag, GMGN, Codex, Photon, Axiom, DexScreener), including asking GMGN to stop reading vault claims as phishing, to credit Jupiter Lock escrows as locked, and asking terminals to use the co-signed coin list; publishing the Creator record as a Solana Attestation Service attestation.
- A platform token with buybacks; holder rewards, holder calls, user referrals, and a realized-profit leaderboard; cashback is dropped for good.
- Stock-priced coins and any non-SOL quote on the site (the code stays quote-agnostic).
- DLMM launch pools and DLMM markets; a Greenflag transfer hook; the DAMM v2 launch pool with an Alpha Vault as Fair Open's fallback (not needed, since the DBC creation transaction works on devnet).
- Building Greenflag as a launch mode inside Stoker ([ADR 0001](adr/0001-separate-product-from-stoker.md), option C).
- Livestreams, native mobile apps, and chains other than Solana.

## 16. Risks and what is unproven

Unproven, and proved by section 11's tests:
- Our programs on chain at all: compute, `settle`, `claim`, the `fee_claimer` PDA claim, the Jupiter Lock CPI, a partial fill past the target, and the creation transaction at about 1,014 bytes with the coin record.
- Wallets signing a 64-rung ladder in one prompt.
- A sniper's separate transaction landing in the creation slot.
- Turbo serving an upload within 10 s.
- How precisely a Workflow wakes (if the open lands more than 2 s late, it moves to a Durable Object alarm).
- The exact curve and fee-scheduler integers being accepted by `create_config`, and the graduated pool's market-cap step encoding.
- Codama's output for Meteora's IDLs, settled in [#39](https://github.com/imDev2023/top-pad/issues/39) (2026-10-27): clean for DAMM v2 and Jupiter Lock; for DBC, two generic fixes applied to the IDL before generation (two fields with the same camelCase name, and a type embedding an account's struct), so no client falls back to the SDK.
- Whether Neon's free plan (100 compute-hours a project a month) lasts a month of the always-on indexer and the 15 s trending query; if not, the devnet database moves to a paid plan.
- The LaserStream Container source, untested until the paid Helius plan is bought; the devnet build tests the WebSocket source instead.

Risks that devnet cannot settle:
- **Meteora's terms**: Meteora's support confirmed on 2026-10-27 that building on Meteora is permissionless and a launchpad is not competitive, but not yet that our program may act for depositors (6.2(d): users act only for their own account, and the pot buys for its depositors); a no would reopen [ADR 0002](adr/0002-fair-open-on-dbc-with-our-own-deposit-program.md).
- **Terminals**: what terminals show as dev, whether Jupiter counts the pot's buy or the pushes as insiders, and how a 4.3% depositor holding reads; terminals do not index devnet.
- **Demand**: no evidence yet shows anyone picking a launchpad for a deposit window, or depositing blind into a sealed coin; the cohort measures it weakly.
- **Upgradeable dependencies**: Meteora can upgrade DBC and DAMM v2 (one shared upgrade authority, `JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd`), and Jupiter can upgrade the Lock program (`CvQZZ23qYDWF2RUpxYJ8y9K4skmuvYEEjH7fK58jtipQ`); Jupiter Lock's source repository now returns 404.
- **The guarantee's edge**: anyone can create pools on our configs; they are not listed, but aggregators may still name them after us.
- **Admission key**: a stolen admission key could admit fake persons up to the tier caps until it is rotated (on mainnet, through the timelock).
- **Prior art**: "fair launch on Meteora" has already been used as a scam wrapper (Cryptstarter and Harmonized), so every promise must be checkable on chain, not just claimed.

## 17. Sources

Decisions, in map order (each ticket holds its resolution and any later corrections):
- [What should the prototype be built on?](https://github.com/imDev2023/top-pad/issues/9)
- [Which charts, market data and swap routing should the trading screens use?](https://github.com/imDev2023/top-pad/issues/8)
- [Launch mechanism](https://github.com/imDev2023/top-pad/issues/10)
- [Fee model](https://github.com/imDev2023/top-pad/issues/13)
- [Sniper tax curve](https://github.com/imDev2023/top-pad/issues/23)
- [Stock-priced coins](https://github.com/imDev2023/top-pad/issues/14)
- [Stack](https://github.com/imDev2023/top-pad/issues/17)
- [Retention](https://github.com/imDev2023/top-pad/issues/18)
- [Creator lock](https://github.com/imDev2023/top-pad/issues/11)
- [Fair Open rules](https://github.com/imDev2023/top-pad/issues/19)
- [Block or label](https://github.com/imDev2023/top-pad/issues/12)
- [Creator record](https://github.com/imDev2023/top-pad/issues/21)
- [Launch liquidity](https://github.com/imDev2023/top-pad/issues/30)
- [Fair Open creation transaction on devnet](https://github.com/imDev2023/top-pad/issues/31)
- [Confirmed bundling](https://github.com/imDev2023/top-pad/issues/34)
- [Curve and Graduation Target](https://github.com/imDev2023/top-pad/issues/33)
- [Our Fair Open program](https://github.com/imDev2023/top-pad/issues/28)
- [Proof plan](https://github.com/imDev2023/top-pad/issues/35)
- [Discovery and ranking](https://github.com/imDev2023/top-pad/issues/37)
- [What should Top-pad look like?](https://github.com/imDev2023/top-pad/issues/15)
- [Backend design](https://github.com/imDev2023/top-pad/issues/36)

Research behind them: tickets [#2](https://github.com/imDev2023/top-pad/issues/2) to [#7](https://github.com/imDev2023/top-pad/issues/7), [#16](https://github.com/imDev2023/top-pad/issues/16), [#20](https://github.com/imDev2023/top-pad/issues/20), [#22](https://github.com/imDev2023/top-pad/issues/22), [#24](https://github.com/imDev2023/top-pad/issues/24), [#25](https://github.com/imDev2023/top-pad/issues/25), [#27](https://github.com/imDev2023/top-pad/issues/27) and [#29](https://github.com/imDev2023/top-pad/issues/29), with their `research/<name>` branches (read one with `git show origin/research/<name>:research/<name>.md`).

ADRs: [0001](adr/0001-separate-product-from-stoker.md) separate product from Stoker; [0002](adr/0002-fair-open-on-dbc-with-our-own-deposit-program.md) Fair Open on DBC with our own deposit program; [0003](adr/0003-our-program-splits-every-curve-fee.md) our program splits every curve fee; [0004](adr/0004-the-creator-buys-only-through-the-fair-open-pot.md) the creator buys only through the Fair Open pot; [0005](adr/0005-the-creator-pre-signs-the-open-as-a-nonce-ladder.md) the creator pre-signs the open as a nonce ladder; [0006](adr/0006-a-fee-program-and-a-fair-open-program.md) a fee program and a Fair Open program.
