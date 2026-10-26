# Top-pad

A fair-launch token launchpad on Solana, built on Meteora's pools.
Its reason to exist is that the people who launch and buy a coin are not beaten to it by bots, insiders or copycats.

## Language

### Launches

**Fair Open**:
A launch that begins with a deposit window in which every buyer gets the same opening price, before public trading starts.
_Avoid_: presale, IDO, whitelist sale

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
