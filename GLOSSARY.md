# Heat

A fair-launch token launchpad on Solana, built on Meteora's pools.
Its repo and folder keep the working name Top-pad.
Its reason to exist is that the people who launch and buy a coin are not beaten to it by bots, insiders or copycats.

## Language

### Launches

**Launch mode**:
How a coin first reaches public trading on Heat: a Fair Open, the default, or an Instant launch.
_Avoid_: launch type, launch style

**Fair Open**:
The launch mode that begins with a deposit window in which every depositor gets the coin at the same price, before public trading starts.
_Avoid_: presale, IDO, whitelist sale

**Pot**:
Everything deposited in a Fair Open, which buys the coin for all its depositors at one price at the open.
_Avoid_: vault (that is Meteora's Alpha Vault), presale pool, treasury

**Open**:
The moment a Fair Open's deposit window ends and its coin is created and starts trading, with the pot's buy first.
_Avoid_: launch (that is the whole process), TGE, go-live

**Depositor tier**:
How much one person may put into a Fair Open, set by how strongly they have shown they are one person: Verified, Scored or Unverified.
_Avoid_: whitelist level, allocation tier

**Seat**:
One person's place in a Fair Open, held by the one wallet that took it: their deposit and the rent they put up, all of which comes back to them if the Fair Open fails.
_Avoid_: slot, ticket, position (that is a liquidity provider's)

**Admission**:
Heat's signed word that a wallet may deposit in a Fair Open, as which person and up to what cap; the Fair Open program takes no deposit without one, and the chain sees the person only as a pseudonym.
_Avoid_: whitelist, allowlist, permit

**Level**:
When a Fair Open's deposits ask for more than its pot can spend, the most each person's deposit buys with: everyone gets the level, or all they asked if that is less, and the rest is refunded.
_Avoid_: allocation (that is the whole result), cap (that is the Depositor tier's)

**Instant launch**:
The launch mode in which a coin is open to public trading from the moment it is created, with no deposit window.
_Avoid_: pump launch, standard launch, curve launch

**Graduation**:
The moment a coin's bonding curve reaches its Graduation Target and its liquidity moves into a regular Meteora pool (DAMM v2), after which it trades like any other coin.
Both launch modes graduate the same way.
_Avoid_: migration (that is Meteora's mechanism), bonding, completion

**Graduation Target**:
The amount of quote asset a coin's curve must raise to graduate, fixed once at launch.
_Avoid_: bonding target, market cap target

**Quote asset**:
The token a coin is priced in and bought with, such as SOL, USDC or a stock token.
_Avoid_: pair token, base token (the base token is the coin itself)

**Stock-priced coin**:
A coin whose quote asset is a stock token such as TSLAx; the coin itself is not a stock.
_Avoid_: stock coin, xStock launch (Heat never issues stock tokens)

**Token badge**:
Meteora's per-token approval that lets a token with special Token-2022 features be used in one of its pool programs.
_Avoid_: whitelist, listing

### Creators

**Creator**:
The person behind a launch, known by their Creator record.
_Avoid_: dev, deployer (terminals' words for the Creator wallet); Stoker's "Creator" means the wallet, which here is the Creator wallet

**Creator wallet**:
The one wallet that signs a Creator's launches and that terminals show as the coin's dev; it changes only by a recorded handover.
_Avoid_: dev wallet, deployer

**Creator record**:
The public history of a Creator's launches on Heat, tied to their X account and built only from facts anyone can check.
_Avoid_: reputation score, trust score (it has no score), creator profile

**Creator lock**:
The lock on the Creator's share of their coin's Fair Open pot: nothing is released for a week after the open, then it releases steadily until all of it is free 30 days after the open.
Only a Fair Open has one, because an Instant launch has no creator buy.
_Avoid_: dev lock, team vesting

### Launch abuse

**Vamp**:
A copycat token launched with a trending coin's name, ticker or image to pull buyers away from the original.
_Avoid_: clone, fake, vampire attack (that is a different thing: luring away a protocol's liquidity)

**Protected coin**:
A coin that a vamp may not imitate on Heat, because it has earned real traction; its protection lapses when the traction does.
_Avoid_: reserved ticker, registered name (nobody reserves a name by launching first)

**Sniper**:
A bot that buys in the first seconds or slots after trading opens, to sell into the buyers who arrive after it.
_Avoid_: early buyer (an early human buyer is not a sniper)

**Zero-block buy**:
A buy that lands in the same slot the pool is created, usually by the creator or a bot bundled into the launch transaction.
_Avoid_: block-0 snipe, same-block buy

**Bundler**:
A creator who secretly buys a large share of a coin's supply across many wallets at launch, in order to dump it later.
_Avoid_: insider, dev wallet (a single disclosed creator wallet is not a bundler)

**Bar**:
A permanent stop on a Creator launching on Heat, imposed after a confirmed finding that they bundled their own launch; it can be lifted only on appeal and touches nothing already launched.
_Avoid_: ban (too broad: a barred Creator may still trade and deposit), blacklist, suspension

### Fees

**Sniper tax**:
The very high trading fee that every buy and sell pays when a coin starts trading, falling steadily to the normal fee over its Tax window, so that sniping or bundling at launch loses most of the stake.
None of it goes to the coin's creator.
_Avoid_: anti-sniper fee, snipe tax, launch tax

**Tax window**:
The first minute of a coin's trading, during which the sniper tax applies and the fees traders pay go to the Fair Open's depositors as their Tax Share, or to Heat in an Instant launch.
_Avoid_: deposit window (that is the Fair Open's window before trading starts), launch window

**Window claim**:
The first claim of a coin's fees once its Tax window has ended, which pays everything its pool has collected to the Tax Share, or to Heat in an Instant launch; one sent late also pays out the normal fees of the seconds it was late by.
Anyone may send it, and Heat's keeper sends it the moment the window ends.
_Avoid_: tax claim, first claim

**Tax Share**:
A Fair Open depositor's share of the sniper tax their coin collected, in proportion to how much of their deposit bought coins.
_Avoid_: rebate (it is not their own money coming back), cashback, airdrop, holder rewards

**Platform Fee**:
Heat's share of the fees on trades of its coins, on the curve and after Graduation.
_Avoid_: partner fee (Meteora's name for the role), protocol fee (that is Meteora's own cut)

**Creator Earnings**:
What a coin's creator earns from trades of their coin, on the curve and after Graduation.
_Avoid_: creator fee (Meteora's on-chain term), creator rewards, royalties
