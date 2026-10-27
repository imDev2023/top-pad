# Two programs: a small fee program and the Fair Open program

Top-pad's on-chain code is two programs (owner, 2026-10-27).
The fee program is the partner named on every DBC config, holds Top-pad's graduated LP position NFTs, and claims, splits and pays curve fees by the rules in [ADR 0003](0003-our-program-splits-every-curve-fee.md); it never holds creators' balances, because a claim pulls fees from Meteora and pays both halves in the same instruction.
The Fair Open program holds deposits for the minutes of a window and carries everything that will keep changing: admission by our server's co-signature, the equal-share allocation, the nonce-ladder rung check at the open, the pushes, the failure path and the creator's Jupiter Lock escrow.
A reader would expect one program, which is simpler to deploy; we split them because every config names the fee program as partner forever, so it should change as rarely as possible, while Fair Open will keep changing.
The decision and its numbers are in [Our Fair Open program](https://github.com/imDev2023/top-pad/issues/28).

## Considered Options

- **Two programs (chosen).**
  A bug in the Fair Open code cannot touch accounts the fee program owns, and the fee program can later be frozen on its own while Fair Open keeps evolving.
  The cost is two deployments, two verified builds and a CPI boundary between them (the open records the pot's own fee for the fee program to split).
- **One program.**
  Every Fair Open change would be an upgrade of the program that every config names as partner and that holds Top-pad's LP positions.

## Consequences

- Both programs sit under the same Squads multisig with a 7-day timelock on mainnet, and a plain key on devnet ([Launch liquidity](https://github.com/imDev2023/top-pad/issues/30)).
- Creators' curve earnings wait in Meteora's pools until claimed, so neither program holds a creator balance an upgrade could redirect; what an upgrade could still change is where future claims pay.
- Whether the fee program is made immutable is a mainnet-effort decision.
