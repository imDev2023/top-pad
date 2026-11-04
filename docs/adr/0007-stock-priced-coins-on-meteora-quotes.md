# Stock-priced coins: SOL and every xStock DBC accepts as a quote

Status: accepted by the owner on 2026-11-04, proposed on 2026-11-02, replacing "SOL only" in spec section 1; the three questions it left open are settled at the end.

Heat offers Stock-priced coins: a creator may price a coin in SOL or in any xStock that Meteora's DBC accepts as a quote, in both launch modes (owner, 2026-11-02).
A reader would expect a SOL-only devnet build to stay SOL-only until mainnet; the owner chose otherwise because pricing coins in stocks is what Stoker is known for, and Heat is planned to become Stoker's launch engine, so the cohort should prove it.
The code was built quote-agnostic for this ([Stock-priced coins](https://github.com/imDev2023/top-pad/issues/14)): every amount on `Launch` is in the quote's raw units, the fee program checks only a config's fee claimer, and `create_launch` refuses non-SOL quotes with one check (`QuoteNotSupported`).

## Which quotes

- A quote is offered only if DBC accepts it: SPL mints, Token-2022 mints DBC treats as permissionless, and Token-2022 mints with a live DBC TokenBadge (PDA `["token_badge", quote_mint]` under DBC).
  The list is read from the chain, never kept by hand.
- Spec 3.2's rule stands: no quote with a non-zero Token-2022 transfer fee or a live fee authority, now or later.
- A quote whose transfer hook names a program, whose default account state is Frozen, or which is paused is refused at scheduling, and a paused quote fails the open.
- What Stoker's research found (its `research/competitors/README.md`, snapshot 2026-09-26, and its quote fixture of 2026-10-10): all 49 xStocks used as a DBC quote carry a TokenBadge; the 23 decoded carry Permanent Delegate, Pausable, Scaled UI Amount, Default Account State (Initialized), Confidential Transfer and a Transfer Hook naming no program, 8 decimals and no transfer fee.
  So the xStocks pass every rule above today; whether they still do is checked from the chain when the ticket starts.

## Considered Options

- **SOL plus DBC-accepted xStocks in both launch modes (chosen).**
  The cohort proves the product Stoker needs, and the deposits, pushes, Tax Share and Creator Earnings get tested in a quote with issuer powers before mainnet.
  The cost is a token vault in the Fair Open program, per-quote configs, and the issuer powers below.
- **Keep SOL only until the cohort, add stocks in the mainnet effort (the current spec).**
  The smallest build, but the cohort would then measure a product Stoker cannot use, and the token-vault work would land after the proof meant to cover it.
- **Depositors pay in SOL and the pot swaps into the xStock at the open (rejected):** the creation transaction already measures 1,093 bytes of 1,232, a Jupiter route does not fit, and the pot's price would depend on a swap nobody can check in advance.
- **Instant launches only on stocks, Fair Opens SOL only (rejected):** splits the brand's default mode from the product's reason to exist.

## Decisions

1. **A token vault for non-SOL quotes.**
   For SOL the vault keeps holding plain SOL as built; for any other quote the vault is a token account of the quote owned by the program, and deposits, withdrawals, refunds, the pot's buy, pushes, claims and the Tax Share move by `transfer_checked` with the quote's own token program.
   Seat and coin-account rent stays in SOL in every quote.
2. **Deposit steps and tier caps in a SOL equivalent.**
   Tier caps stay in steps (Unverified 10, Scored 50, Verified 200); a launch's step is 0.01 SOL's worth of its quote in raw units at the price when it is scheduled, stored on `Launch.step` as it already is, so caps, counts and the allocation do not change.
3. **Per-quote configs at a SOL-equivalent Graduation Target.**
   A DBC config fixes its quote and its Graduation Target and can never be changed, so each quote gets its own Fair Open and Instant config pair at 85 SOL's worth (8.5 on devnet), made by the same generator, and a new pair is made when the quote's price has moved far enough (the band below); old configs keep serving the coins made on them.
4. **A `QuoteSettings` account per quote** in the Fair Open program, PDA `["quote", quote_mint]`, naming the quote's current Fair Open config, Instant config and step; `create_launch` takes the config and step it names instead of `ProgramConfig`'s one config.
   A quote manager key, named once by the upgrade authority, writes these accounts, so configs can follow prices without the offline key, as Stoker's curve rule manager does (Stoker ADR 0005).
   `create_launch` checks every fixed field of the config it is given (fee claimer the fee program's PDA, collect fee mode, the sniper tax integers, creator fee 0, migration option and LP buckets), so a leaked manager key can only point a quote at a correctly shaped config with a wrong target or step, never take fees.
5. **Prices and labels.**
   Prices, balances and market caps use the quote's Scaled UI Amount multiplier, so a split or dividend does not break charts; the coin page, launch form and deposit page show the quote's issuer powers as Quote Risk Labels in Stoker's words and placement (Stoker CONTEXT.md).

## Consequences

- The issuer of an xStock can pause it, which stops the coin's curve, its graduated pool and every refund, push and Tax Share out of a Fair Open vault until it unpauses, and can move tokens out of any account, the pool's quote vault and the Fair Open vault included; Heat cannot prevent either, so it labels them and says so on "How this is enforced".
- The vault invariant (spec 5.3) holds in the quote's raw units, and its random-instruction LiteSVM test runs in a Token-2022 quote too.
- A coin's Graduation Target is fixed in its quote when it launches, so in SOL terms it drifts with the stock's price; the band keeps new launches within it, as Stoker's does.
- The fee program needs no change: it pays both halves in the quote, out of DBC's quote vault, as built.
- Devnet has no xStocks, so the tests run on a stand-in Token-2022 mint with the same extensions, which DBC accepts only with a devnet TokenBadge (open question 2).
- Rent: one `QuoteSettings` account per quote and two configs per quote per band move, paid by the operations wallet.

## Settled questions

1. **The band (owner, 2026-11-04): Stoker's 10% band.**
   A quote's config pair stands while its Graduation Target, valued in SOL at the quote's latest price, stays within 10% of 85 SOL's worth (8.5 on devnet); the job that watches prices makes a new pair at the live price and rewrites `QuoteSettings` once it drifts past that.
   So a coin's target in SOL terms is within 10% of the SOL target when it launches, and two configs are made per quote per move, not two per launch.
   EmberCurve's pattern, a config per launch (about four per coin at about 0.01 SOL each), was the alternative that never drifts.
2. **Meteora on TokenBadges (2026-11-02, [#26](https://github.com/imDev2023/top-pad/issues/26#issuecomment-6585115722)):** only Meteora creates a TokenBadge; most xStocks hold the mainnet badge, and a launchpad can request one for a stock that lacks it; Meteora can badge our devnet stand-in mint on request.
   The stand-in exists since 2026-11-03, `Wm7nXsHnoHJm3NemWaLbnxd7QkmeHLALucsFC4qTUNK` ([#84](https://github.com/imDev2023/top-pad/issues/84#issuecomment-6616824303)).
3. **Which xStocks first (owner, 2026-11-04): the 22 liquid ones** for the cohort, those with more than $100K of liquidity by EmberCurve's figures on 2026-11-02: SPYx, CRCLx, NVDAx, QQQx, TSLAx, MSTRx, SPCXx, AAPLx, HOODx, MSFTx, COINx, MCDx, GLDx, GMEx, STRCx, METAx, KOx, GOOGLx, AMZNx, BRK.Bx, DFDVx, PLTRx.
   All 1,476 xStocks DBC had badged on 2026-11-03 passed the quote rules, so the list is a product choice; the rules take any mint, and a quote is offered once it has a `QuoteSettings` account.
