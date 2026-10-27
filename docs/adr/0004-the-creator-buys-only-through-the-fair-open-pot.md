# The creator buys only through the Fair Open pot, and their share is locked in Jupiter Lock

A Top-pad creator can hold their coin from launch only by depositing in its Fair Open like any other depositor, under their tier's cap and at the same price; their share of the pot's coins goes into a Jupiter Lock vesting escrow that releases nothing for 7 days after the open and everything by day 30 (owner, 2026-10-26 and 2026-10-27).
An Instant launch has no creator buy at all: its DBC config turns the first-swap discount off, so a creator buying in the creation slot pays the full 99% sniper tax like anyone else.
A reader would expect the creator to get a capped first buy in every launch, as on most launchpads; we chose against it because DBC cannot cap or lock that buy, and keeping the discount on for it would give anyone who calls DBC directly on our config a cheap, uncapped first buy.
The decision and its numbers are in [Creator lock](https://github.com/imDev2023/top-pad/issues/11).

## Considered Options

- **The creator buys only through the Fair Open pot, locked in Jupiter Lock (chosen).**
  The pitch is "the creator gets exactly your deal, and theirs is locked", and stopping creator bundling, the owner's first priority, comes free in Instant launches, where a creation-slot bundle loses about 99%.
  The cost: a creator who wants a stake at launch must run a Fair Open, and the lock binds only coins our launch key co-signs, since anyone can call DBC directly on our Fair Open config.
- **A DBC `locked_vesting` allocation in every launch.**
  DBC enforces it on every pool on the config, but it is a free share of supply, which reads as team tokens.
- **A capped, discounted creator buy in Instant launches, co-signed by our launch key.**
  It needs the first-swap discount on, which any direct caller of DBC could use uncapped.
- **Where the locked coins sit.**
  A Jupiter Lock escrow (chosen) is labelled on Jupiter and is the program DBC itself uses for locked vesting, but GMGN tags it `rat_trader` and counts it 0% locked.
  Streamflow is the mirror image: credited on GMGN and RugCheck, an unlabelled whale on Jupiter.
  Coins kept in our own program would show as locked on no terminal.
- **When the release starts.**
  From the open (chosen), not from Graduation, which would leave the coins unlabelled in our program until then, and stuck forever if the coin never graduated.

## Consequences

- Fair Open and Instant launch sit on separate DBC configs, with the first-swap discount on and off, and the same sniper tax schedule.
- Our program creates each creator's Jupiter Lock escrow right after the open, with the Creator wallet as recipient; nobody, Top-pad included, can cancel it.
- Creator buys after the open are labelled on the Fairness card, not refused, since routed trades never touch our site.
- Asking GMGN to credit Jupiter Lock escrows is part of the mainnet effort's terminal work.
