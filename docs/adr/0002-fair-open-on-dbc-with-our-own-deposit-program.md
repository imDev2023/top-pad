# Fair Open runs on DBC with our own deposit program, not on a Meteora launch pool

Top-pad offers two launch modes, Fair Open (the default) and Instant launch, and both are DBC curves that graduate into DAMM v2 (owner, 2026-10-26).
For a Fair Open, deposits sit in our own program while nothing exists on chain; at the open, one transaction creates the coin and its DBC pool and makes the pot's buy the pool's first swap at the scheduler's ending fee, so public trading starts in the same instant under the sniper tax.
A reader would expect Meteora's Alpha Vault, which is built for exactly this; we chose against it because a launch pool must be created at least 70 minutes before the open with the coin public all that time (Jupiter lists it 75 to 120 minutes early, so a vamp can open first elsewhere), deposits close an hour before trading, and launch-pool coins get no launchpad name, so Jupiter hides their sniper, insider and bundler figures.
The research behind this is in [Launch mechanism](https://github.com/imDev2023/top-pad/issues/10) and the tickets it links.

## Considered Options

- **DBC with our own deposit program (chosen).**
  The window can be minutes long and the coin can stay sealed until it trades; DBC gives Top-pad's launches a launchpad name on Jupiter; a multi-segment curve can keep the public's opening price near the depositors'; Instant launches share the same program.
  The cost is more of our own code holding users' deposits, a creation transaction that is designed from Meteora's source but not yet built, an unverified risk that Jupiter counts the pot's first buy and its claimers as insiders, and more exposure to Meteora's term that users act only for their own account.
- **A DAMM v2 launch pool with a Pro Rata Alpha Vault (the fallback).**
  Every step is proven on mainnet and devnet, and Meteora's vault holds deposits.
  The spec falls back to it if the devnet prototype shows the DBC creation transaction cannot be built; a Fair Open coin's launch pool is then its final market and never graduates.
- **A DLMM launch pool with an Alpha Vault (rejected),** although the owner's brief preferred DLMM: no fee scheduler and a 10% fee cap leave the opening unprotected, RugCheck shows a permanently locked DLMM seed as 100% unlocked, seeding costs 0.24 to 5 SOL against 0.0165 SOL on DAMM v2, and Meteora's admin can still move the open.

## Consequences

- The pot's buy is capped well below the Graduation Target, with the rest refunded pro rata, so no coin graduates in its own creation transaction.
- Top-pad coins carry no transfer hook: a hook caps only the creator's disclosed wallet, adds little to a 99% creation-slot sniper tax, costs about 1 to 10% of curve volume (Jupiter's Metis router and Titan cannot route hook pools), and a bug in it would freeze every transfer of a coin until Graduation.
- Anyone can create pools on our DBC config, and terminals may name those coins as ours, so which coins Top-pad lists and how it labels the rest is settled under discovery and ranking.
