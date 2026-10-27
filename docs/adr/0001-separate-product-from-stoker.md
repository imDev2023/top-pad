# Top-pad is a separate product from Stoker

The owner already has Stoker (`/Volumes/Farhan/Work Folder/Dev/AI/stonk-fun-solana`, https://github.com/imDev2023/Stoker-Markets), a working launchpad on Raydium LaunchLab whose promise is "launch a coin paired with any asset, with no gatekeeper, and the creator's earnings forwarded off-chain on a public ledger".
Top-pad's promise is the opposite emphasis: a fair launch on Meteora whose rules the chain enforces rather than the server promises.
We decided (owner, 2026-10-26) to build Top-pad as a separate product, with Stoker as reference material (its research, decisions and lessons), so that neither promise dilutes the other.
Whether to reuse Stoker's code (indexer, public ledger, Arweave metadata, Cloudflare hosting) is a stack question, not a product one, and is decided on the map.

## Considered Options

- **A. Separate product (chosen).**
- **B. Stoker's next version:** Stoker moves from LaunchLab to Meteora and takes on the fairness design, and Top-pad's map lives in Stoker's repo.
  Rejected because it would replace Stoker's working any-asset model rather than add to it.
- **C. A launch mode inside Stoker:** Fair Open launches on Meteora offered next to Stoker's any-asset LaunchLab launches, sharing one site, one backend and one brand.
  Not chosen now, but kept on purpose as a future option (owner, 2026-10-26).
  Revisit it if Top-pad's prototype proves Fair Open works and running two launchpads costs more than it gains, for example in audience, liquidity or operations.
  It would be charted as a fresh effort on Stoker's tracker, starting from Top-pad's finished spec.

## Consequences

- Top-pad keeps its own repo, tracker, glossary and decision records.
- Where Top-pad and Stoker name the same concept (Quote Asset, Creator, Graduation), Top-pad uses Stoker's word, so that option C stays cheap if it is ever taken.
- Stoker is read-only from Top-pad sessions; another session works in it.
- Revisited 2026-10-27, with the spec finished: kept separate (owner).
  Option C is next weighed after the devnet cohort ([docs/spec.md](../spec.md) section 11.3): if Fair Open proves itself there, either Fair Open becomes a launch mode inside Stoker or Greenflag takes over Stoker's any-asset launches; attention and liquidity split across two launchpads is the cost to weigh.
