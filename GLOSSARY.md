# Top-pad

A fair-launch token launchpad on Solana, built on Meteora's pools.
Its reason to exist is that the people who launch and buy a coin are not beaten to it by bots, insiders or copycats.

## Language

### Launches

**Launch mode**:
How a coin first reaches public trading on Top-pad: a Fair Open, the default, or an Instant launch.
_Avoid_: launch type, launch style

**Fair Open**:
The launch mode that begins with a deposit window in which every depositor gets the coin at the same price, before public trading starts.
_Avoid_: presale, IDO, whitelist sale

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

**Creator lock**:
The cap on the creator's own buy of their coin, together with its gradual release over time.
_Avoid_: dev lock, team vesting

**Quote asset**:
The token a coin is priced in and bought with, such as SOL, USDC or a stock token.
_Avoid_: pair token, base token (the base token is the coin itself)

**Stock-priced coin**:
A coin whose quote asset is a stock token such as TSLAx; the coin itself is not a stock.
_Avoid_: stock coin, xStock launch (Top-pad never issues stock tokens)

**Token badge**:
Meteora's per-token approval that lets a token with special Token-2022 features be used in one of its pool programs.
_Avoid_: whitelist, listing

### Launch abuse

**Vamp**:
A copycat token launched with a trending coin's name, ticker or image to pull buyers away from the original.
_Avoid_: clone, fake, vampire attack (that is a different thing: luring away a protocol's liquidity)

**Sniper**:
A bot that buys in the first seconds or slots after trading opens, to sell into the buyers who arrive after it.
_Avoid_: early buyer (an early human buyer is not a sniper)

**Zero-block buy**:
A buy that lands in the same slot the pool is created, usually by the creator or a bot bundled into the launch transaction.
_Avoid_: block-0 snipe, same-block buy

**Bundler**:
A creator who secretly buys a large share of a coin's supply across many wallets at launch, in order to dump it later.
_Avoid_: insider, dev wallet (a single disclosed creator wallet is not a bundler)

### Fees

**Sniper tax**:
The very high trading fee that every buy and sell pays when a coin starts trading, falling steadily to the normal fee over its Tax window, so that sniping or bundling at launch loses most of the stake.
None of it goes to the coin's creator.
_Avoid_: anti-sniper fee, snipe tax, launch tax

**Tax window**:
The first minute of a coin's trading, during which the sniper tax applies and the fees traders pay go to the Fair Open's depositors as their Tax Share, or to Top-pad in an Instant launch.
_Avoid_: deposit window (that is the Fair Open's window before trading starts), launch window

**Tax Share**:
A Fair Open depositor's share of the sniper tax their coin collected, in proportion to how much of their deposit bought coins.
_Avoid_: rebate (it is not their own money coming back), cashback, airdrop, holder rewards

**Platform Fee**:
Top-pad's share of the fees on trades of its coins, on the curve and after Graduation.
_Avoid_: partner fee (Meteora's name for the role), protocol fee (that is Meteora's own cut)

**Creator Earnings**:
What a coin's creator earns from trades of their coin, on the curve and after Graduation.
_Avoid_: creator fee (Meteora's on-chain term), creator rewards, royalties
