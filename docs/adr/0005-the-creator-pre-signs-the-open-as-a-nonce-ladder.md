# The creator pre-signs a Fair Open's creation as a durable-nonce ladder

When a creator schedules a Fair Open, they sign a ladder of creation transactions in advance, one for each possible size of the pot's buy, all on one durable nonce; at the open our keeper sends the largest rung the pot covers, and the nonce advancing invalidates every other rung (owner, 2026-10-27).
A reader would expect the creator to sign once at the open, or our server to create the coin; we chose the ladder because the creator's own wallet must sign the pool creation so terminals show the creator as dev, the pot's buy amount is part of the signed message but only known when the window closes, and the open is scheduled for a time when the creator may be offline.
The devnet proof is in [Fair Open creation transaction on devnet](https://github.com/imDev2023/top-pad/issues/31).

## Considered Options

- **A durable-nonce ladder signed at scheduling (chosen).**
  On devnet a rung was sent 47 s after signing with the creator offline, and resending a second rung failed.
  The cost: the creator signs several transactions in one go, the pot's buy is rounded down to the nearest rung (the rest is refunded), and a creator can spoil the open by advancing the nonce, which our program's 15-minute on-chain withdrawal covers.
- **The creator signs at the open.**
  One signature and the exact amount, but the creator must be online at that moment; kept as the fallback for wallets that cannot sign the ladder.
- **Our keeper creates the coin and hands the creator role over in the same transaction** (`transfer_pool_creator`).
  The pool's creator ends up correct, but the init's signer and DBC's creation event name our keeper, so terminals would likely show Top-pad as every coin's dev, and the Creator record would be invisible where traders look.
- **The pot buys a fixed amount the creator signs for in advance.**
  The open would fail whenever the pot fell short of that amount, and withdrawable deposits make the final pot unknowable at scheduling.

## Consequences

- Our program's `open` instruction checks the time, so no rung can open early, and checks the exact shape of the transaction by introspection, so a rung can do nothing but the open it was signed for.
- Every Fair Open needs its own durable nonce account, and every open uses one shared address lookup table: the transaction is 979 bytes with it and 1,193 without, against a 1,232-byte limit.
- The rung spacing sets how much of a pot can go unspent; the spec fixes it.
