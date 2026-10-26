# Our program, not DBC's creator share, splits every curve fee

Top-pad's DBC configs give the creator 0% of trading fees and name our own program as the partner, so our program receives the whole 80% that Meteora leaves on every curve trade and pays it out by fixed rules (owner, 2026-10-26).
A reader would expect DBC's own creator share, which pays creators straight from Meteora's program; we chose against it because that share is one percentage for a pool's whole life, so it would give the creator their cut of the sniper tax and refund part of their own creation-slot bundle (at a 50/50 split, 3.96 SOL of the 9.9 SOL a 10 SOL bundle pays).
The decision and its numbers are in [Fee model](https://github.com/imDev2023/top-pad/issues/13).

## The rules

- During the tax window (from pool creation until the sniper tax has decayed), every fee goes to the Fair Open's depositors as their Tax Share, or to Top-pad in an Instant launch; the Fair Open pot's own fee is split like a normal trade.
- After the window, half goes to whoever holds the pool's DBC creator role, as Creator Earnings they claim from our program, and half is Top-pad's Platform Fee, sent to one treasury address.
- The surplus left when the curve completes is split the same way.
- After Graduation our program is out of the creator's path: the creator holds their half of the graduated pool's LP as their own position NFT and claims from Meteora directly.

## Considered Options

- **Our program does the split (chosen).**
  The config enforces it for every pool on it, including pools created by calling DBC directly instead of through our site.
  The cost is that every creator's curve earnings pass through our program, so whoever controls its upgrade key could redirect them.
- **Our program holds each pool's creator role during the tax window, then hands it to the creator** (DBC's creator share left at 50%).
  Creator earnings would sit in Meteora's program after the first minute, out of our reach.
  Rejected because it only binds pools created through our flow (a creator calling DBC directly on our config keeps the role and their share of the tax), needs two role hand-offs and a crank per launch, and terminals would see our program as each coin's creator at launch.
- **Off-chain forwarding, as in Stoker** ([its ADR 0009](https://github.com/imDev2023/Stoker-Markets/blob/main/docs/adr/0009-creator-earnings-off-chain.md)).
  Rejected because Top-pad prefers rules the chain enforces, and StonkFun's forwarding job once stopped paying creators for about three weeks.

## Consequences

- Our program's upgrade policy (immutable or behind a timelock) is now also a question of who can touch creators' earnings and change the treasury address.
- Our keeper claims each pool's partner fees the moment its tax window ends; whatever that claim collects counts as window fees, so a late claim moves normal fees into the Tax Share or to Top-pad.
- DBC configs cannot be edited, so changing the split later only applies to coins launched on a new config.
