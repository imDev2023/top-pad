# Top-pad

A fair-launch token launchpad on Solana, built on Meteora's pools.
Its reason to exist is that the people who launch and buy a coin are not beaten to it by bots, insiders or copycats.

## Language

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
