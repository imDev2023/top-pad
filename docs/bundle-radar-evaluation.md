# The Bundle Radar evaluation

Written by `pnpm --filter @top-pad/tests-radar-eval evaluate` (spec 11.5, [#61](https://github.com/imDev2023/top-pad/issues/61)); rerun it rather than editing this file.
It measures how precisely each Bundle Radar signal finds a creator's bundle on mainnet pump.fun launches.
It runs Bundle Radar's own rules over every launch, `labelBuy`, `fundingLinks` and `walletLabels` in `@top-pad/indexer`, the functions `radarOf` runs on Heat's coins, and scores them against Jito's public record of which buyers sat in the creation's own bundle.
A signal may count toward confirming a bundle only once the low end of its 95% Wilson interval reaches 99% (spec 6.5): at least 400 flagged wallets with none wrong, or 1,000 with at most 3.

## Answer

Scored over every wallet other than the Creator wallet that bought a launch in its creation slot, where Jito bundled the creation; a flag is right when one of the wallet's buys sat in the creation's bundle.

| Signal | Wallets flagged | Wrong | Precision | Wilson low (95%) | Reaches 99% | Bundle wallets it finds |
| - | - | - | - | - | - | - |
| Same slot (`same_slot`, a label only) | 900 | 250 | 72.22% | 69.21% | no | 100.0% |
| Positions 1 to 4 after the creation (`after_creation`) | 652 | 2 | 99.69% | 98.89% | no | 100.0% |
| Creator wallet signed or paid (`creator_signed`) | 29 | 0 | 100.00% | 88.30% | no | 4.5% |
| Direct transfer with the Creator wallet (`creator_funded`) | 263 | 3 | 98.86% | 96.70% | no | 40.0% |
| Any direct link short of Jito's record (spec 6.5) | 655 | 5 | 99.24% | 98.23% | no | 100.0% |
| Same Jito bundle as the creation (`jito_bundle`) | 650 | 0 | 100.00% | 99.41% | ground truth | 100.0% |

- Positions 1 to 4 after the creation (`after_creation`) does not pass (652 flagged, 2 wrong: precision 99.69%, Wilson low 98.89%; it needs 99%).
- Creator wallet signed or paid (`creator_signed`) does not pass (29 flagged, 0 wrong: precision 100.00%, Wilson low 88.30%; it needs 99%).
- Direct transfer with the Creator wallet (`creator_funded`) does not pass (263 flagged, 3 wrong: precision 98.86%, Wilson low 96.70%; it needs 99%).
- Any direct link short of Jito's record (spec 6.5) does not pass (655 flagged, 5 wrong: precision 99.24%, Wilson low 98.23%; it needs 99%).
- Same Jito bundle as the creation (`jito_bundle`) is the ground truth itself, so it is right by definition on the 650 wallets it flags.
- Same slot (`same_slot`, a label only) is right on 72.2% of the wallets it marks, which is why it only labels.
- Where Jito did not bundle the creation, the four positions after it held 258 wallets; another direct link backs 123 of 258 (47.7%), a floor under the rule's precision there, not a measure of it (below).
- The Cryptstarter and Harmonized fleet: the direct links found 27 of 234 (11.5%) of the fleet wallets that joined or bought its five launches, all of them CSTARTER's, through the transfer that defines the fleet (below).

## The launches

- The list is an even sample, about every 20th in chain order, of the 40,384 successful pump.fun creations of 2026-10-25 (UTC), so every hour is in it: 2,000 launches, in `tests/radar-eval/data/launches.json`.
- Launches read: 1,988.
  Not launches after all: 12 (no coin signed its creation).
- Jito bundled the creation of 411 of 1,988 (20.7%); in 200 of 1,988 (10.1%) the bundle also held a buy by another wallet, a creator bundle in Bitquery's sense (it found the creator's wallets in block 0 of 21%).
- A wallet other than the Creator wallet bought in the creation slot of 421 of 1,988 (21.2%).
- Scored wallets: 900 bought a bundled launch in its creation slot, of which 650 sat in its bundle.

## Spec 6.5's direct links, one by one

- **Positions 1 to 4** does not pass (652 flagged, 2 wrong: precision 99.69%, Wilson low 98.89%; it needs 99%).
  By position after a bundled creation:

  | Position | Wallets | In the creation's bundle |
  | - | - | - |
  | 1 | 296 | 296 of 296 (100.0%) |
  | 2 | 229 | 229 of 229 (100.0%) |
  | 3 | 103 | 103 of 103 (100.0%) |
  | 4 | 24 | 22 of 24 (91.7%) |

- **Same Jito bundle** is the ground truth itself, so it is right by definition on the 650 wallets it flags; production reads it from the same API (`jitoApi`).
- **Signed or paid by the Creator wallet** does not pass (29 flagged, 0 wrong: precision 100.00%, Wilson low 88.30%; it needs 99%).
- **Direct transfers with the Creator wallet** in the 7 days either side of the open does not pass (263 flagged, 3 wrong: precision 98.86%, Wilson low 96.70%; it needs 99%).
  The link was settled, a transfer found or every candidate read, for 642 of the 900 scored wallets (71.3%); the rest count as unflagged (Method, below), which lowers what it finds, not its precision.
  Some links are trades: one transaction in which the Creator wallet sent the buyer coins and the buyer paid it SOL, or the reverse, which spec 6.5 counts as coins passed directly.
  Leaving out wallets linked only by trades, a variant and not production's rule, does not pass (249 flagged, 0 wrong: precision 100.00%, Wilson low 98.48%; it needs 99%).
  The reading stops at the first linking transaction, so a wallet whose first was a trade may hold a one-way transfer too, and the variant may flag more than this counts.
- **Any of them** does not pass (655 flagged, 5 wrong: precision 99.24%, Wilson low 98.23%; it needs 99%): this is what puts a wallet in a case today, short of Jito's record, which settles it on mainnet.

## Two variants the wrong flags suggest

Every wrong flag was either a trade or position 4, so two narrower rules would have made no mistake here:
- Positions 1 to 3 only passes (628 flagged, 0 wrong: precision 100.00%, Wilson low 99.39%).
- Direct transfers leaving out trades does not pass (249 flagged, 0 wrong: precision 100.00%, Wilson low 98.48%; it needs 99%).
- Spec 6.5's direct links with both passes (631 flagged, 0 wrong: precision 100.00%, Wilson low 99.39%).

They were chosen after seeing these wrong flags, so this sample cannot measure them fairly: a rule change would need them confirmed on a fresh sample, another day's launches, which the same command reads once `DAY` in `tests/radar-eval/src/main.ts` names that day and the kept data is moved aside.

## The position rule where the creation was not bundled

Heat's launch key sends every creation, so a creator's bundle can never hold it, and the position rule then flags whoever lands next; on devnet a sniper with no tie to the creator was flagged that way (spec 6.4).
On the 1,577 launches whose creation Jito did not bundle, 258 wallets bought in the four positions after it.
No record says whose they were; another direct link (the Creator wallet signing for them, or a direct transfer) backs 123 of 258 (47.7%), so that is the floor under the rule's precision there.
None of the rest is known to be wrong either: the funding link was left unsettled for 78 of them, read at most 8 transactions each, and 0 of 258 (0.0%) landed in a Jito bundle of their own.

## The Cryptstarter and Harmonized fleet

The second case is one operator's wallet fleet, which joined or bought its own five single-use launches on mainnet in October 2026, funded through exchanges and hop wallets (#29, `research/alpha-vault-prior-art`); Jito saw none of it.
The fleet is read from the chain by the two sweeps that gave it away, 27 wallets sending SOL back to Cryptstarter's deployer ([C4mpYC...](https://solscan.io/account/C4mpYCuYaV1YtSRnJacMxRB2kqYSu3WUoexyS9QzCrA7)) and 219 wallets sending SOL into the fleet's shared wallet ([FJeSoL...](https://solscan.io/account/FJeSoLmGzNvCNC55X92T9tye34gg8t35REpVXZkVyigy)): 242 wallets in all.
The first sweep is itself a direct transfer with Cryptstarter's Creator wallet, as proceeds sent back, so `creator_funded` finding CSTARTER's fleet is partly how that fleet was found.
CAKEDOG's, IVY's and lo0m's launchpads pay the creator's fee straight to the Creator wallet in every trade, which production's `transfersIn` reads as a direct transfer from the buyer, so every buyer looked funded; Heat's programs never pay the creator from a trade, so transactions that called the launchpad's own program are left out of the funding links here (`launchpadTransactions` in the kept fleet).
Each cell counts the fleet wallets a signal flags, and any other wallet it flags:

| Launch | Wallets that joined or bought | Fleet wallets among them | same slot | positions 1 to 4 | Jito bundle | signed or paid | direct transfer | any direct link |
| - | - | - | - | - | - | - | - | - |
| CSTARTER | 46 | 29 | 0 of 29 | 0 of 29 | 0 of 29 | 0 of 29 | 27 of 29 | 27 of 29 |
| HMD | 55 | 36 | 0 of 36 | 0 of 36 | 0 of 36 | 0 of 36 | 0 of 36 | 0 of 36 |
| CAKEDOG | 47 | 28 | 0 of 28 | 0 of 28 | 0 of 28 | 0 of 28 | 0 of 28 | 0 of 28 |
| IVY | 131 | 74 | 0 of 74 | 0 of 74 | 0 of 74 | 0 of 74 | 0 of 74 | 0 of 74 |
| lo0m | 89 | 67 | 0 of 67 | 0 of 67 | 0 of 67 | 0 of 67 | 0 of 67 | 0 of 67 |
| All five | 368 | 234 | 0 of 234 | 0 of 234 | 0 of 234 | 0 of 234 | 27 of 234 | 27 of 234 |

## Every wrong flag of a direct link

5 wallets were flagged by a direct link but sat outside the creation's bundle; each is listed so it can be checked by hand.

| Launch | Wallet | Flagged by | Position | Its buy | Transfers with the Creator wallet |
| - | - | - | - | - | - |
| [41kRtjKp...](https://solscan.io/tx/41kRtjKpFDXGBofnLXWYXAg8EwgWppWL5uRHd5SEBdUq96eV7i8u9WDvWV92rsQVGtMwHYRBnfL4tsaoGiLw7kmN) | [2pv6sE...](https://solscan.io/account/2pv6sE6sgEedXjZu6CpHjkANPHkAR8gJjFKki9bEajAb) | direct transfer (a trade) | 147 | [Y7Jk99kJ...](https://solscan.io/tx/Y7Jk99kJJFNMBWmWjMsuESRTp5RHvJcbJUQtWU8JyDy5gxBcrHC3ggXwApKEMnzC6WRaBRXUFjjycdZkPVbgKDQ) | [4n2z9dv3...](https://solscan.io/tx/4n2z9dv3SpopbmWaq4Rsmj2xzHnUDMNMNRFzQxPHrKPz3hzA4XewyPiiuFjmpiXJkY8jmXzHyFuPhDsi4oqcoZYi) from the creator, 703,927,057,095 of [GXC5nr...](https://solscan.io/account/GXC5nrtFWvEdXScrqKLQ5u3KTuqQC6R2u37UgnaPpump); [4n2z9dv3...](https://solscan.io/tx/4n2z9dv3SpopbmWaq4Rsmj2xzHnUDMNMNRFzQxPHrKPz3hzA4XewyPiiuFjmpiXJkY8jmXzHyFuPhDsi4oqcoZYi) to the creator, 0.077820047 wrapped SOL |
| [4AM67hMC...](https://solscan.io/tx/4AM67hMCDwFZKBPWd1qmp8xsFHxbwBoyxVNXdYjyLAATsDoipKyFu4WT4ofvCpT9YTWexygSVA2EADxHFJ4ieFjR) | [B8JoKJ...](https://solscan.io/account/B8JoKJGL4ug97iRVoL2664nPSrG1Y6cWiYrvM3DcNs4D) | direct transfer (a trade) | 119 | [5FhArZPV...](https://solscan.io/tx/5FhArZPVEGFok59ZThs23KndUMW5fTKgCeY1HvKX5xbPn5m6ARexGis1uudLQyWuwgaQ9jDhi2hRkEFXEw6KoAFg) | [biEURroH...](https://solscan.io/tx/biEURroHpQgjc1uiAaMFdWMrwRTnjqj7ZPsuS1swzepBMbZrpFSnHD4R3iRfaBpAuH8xFHdSsxygfWCYmyg545a) from the creator, 702,927,057,095 of [2U917z...](https://solscan.io/account/2U917zKEN4GDT5m8UhkL9uHdDE12cFCESWGsZWgdpump); [biEURroH...](https://solscan.io/tx/biEURroHpQgjc1uiAaMFdWMrwRTnjqj7ZPsuS1swzepBMbZrpFSnHD4R3iRfaBpAuH8xFHdSsxygfWCYmyg545a) to the creator, 0.038010955 wrapped SOL |
| [3JGCdxzd...](https://solscan.io/tx/3JGCdxzdEkGWNkqfWzuhB1ad6HyQurmyAMZFSKk9pwAgPQRYVCLYg2iEaHu9uU6SywvMD5FCtHMfGH8PXAGJvHbc) | [9Jhbsj...](https://solscan.io/account/9JhbsjpSQJVGst9aWhuR7MEJLwYaTSWHYNHWLTGwm51j) | positions 1 to 4 | 4 | [591VyUup...](https://solscan.io/tx/591VyUups68nJhLDdJeBeEoLyZvC5KfXcy8dKjtkzaYyEZtC43uMXd6ZR1oWy2jUrtp7TCeFdKbKc6ZHbVvthQn7) | - |
| [5xaruZ8B...](https://solscan.io/tx/5xaruZ8BA4hXuebkKGHEqxhmQ2Xi8M4Zkt4k8UHHZMp1NasJStnwwYa48c9Vf9T7AXBE6X5VgxzCPvGM1mYU4Zqg) | [2MdUKd...](https://solscan.io/account/2MdUKdqjr79D9azVbRsvuvRjnfqaiFbmR83z4BfLSppf) | direct transfer (a trade) | 28 | [ifBBqBiB...](https://solscan.io/tx/ifBBqBiBZugWehrX7BxP41MUZ7Tnkgp6M1ZxKL5ktXR87FCXYCBoD2Mp9Y9pZ6UhJwS3cnyHVzTb11XCeUAjWrQ) | [4c9V4jHB...](https://solscan.io/tx/4c9V4jHBCZqCEgz6vfrxtiUWHHyu8uuczjAiWBZ8317iiEj1xaPQq5Jg557KhR11NkiigqdZpCWY5WTsBbbEtX2L) from the creator, 3,520,371,073,923 of [GYgkjH...](https://solscan.io/account/GYgkjHFnJGtA45X5Xiw5bFRD47ENZsSh8WsM9UbDpump); [4c9V4jHB...](https://solscan.io/tx/4c9V4jHBCZqCEgz6vfrxtiUWHHyu8uuczjAiWBZ8317iiEj1xaPQq5Jg557KhR11NkiigqdZpCWY5WTsBbbEtX2L) to the creator, 0.084853971 wrapped SOL |
| [2hG3pmYB...](https://solscan.io/tx/2hG3pmYB47yetBNkcQVFp5757stde3SCi5Cr4un4zQHETEfcoDiL8hjbuMywTETqhEiASCfjgk1KY5CGujqbJiNw) | [9qrN4i...](https://solscan.io/account/9qrN4ihmqkRdV6Zk12XzicC7p7RNKUGHJ8z1XZFjoTWo) | positions 1 to 4 | 4 | [24DtbhN3...](https://solscan.io/tx/24DtbhN3hxso1MWrtQ5Pg8fQJ6WDjJd2W1yspxCEiRCSXmD1zwFMn9RW48Y2oeg6ZsXqx8kUkM78a8TdM79Hsyyf) | - |

## For the known-bot list

The known-bot list keys on wallets that bought in the first 2 seconds of 3 or more launches (spec 8); this set holds the creation slot only.
120 wallets bought in the creation slot of 3 or more of the 1,988 launches (590 launches between them), and 52 of them ever sat in a creation's bundle, which a threshold would mark as bots.
The kept set, `tests/radar-eval/data/set.jsonl`, holds every creation-slot buy with its signers, block position and Jito bundle, to tune the thresholds against.

## Method and limits

- Reads only Solana's public mainnet endpoint (`api.mainnet-beta.solana.com`, about 10 calls of a method each 10 seconds) and Jito's public bundle API, with no key, no paid archive and no transaction.
- The launch list comes from the history of pump.fun's mint authority, an account of every `create` and `create_v2`; each launch's block is read once with account details, which gives the creation's place, every later transaction in the slot, its signers and its token balances.
- A buy is a later transaction in the creation slot in which the bonding curve's balance of the coin fell and a wallet's rose; that wallet is the buyer, as the indexer's trade event names the trader on Heat.
- The Creator wallet is the creation's fee payer, the wallet that made and paid for the launch (Bitquery's "dev"); its own buys are left out, as production leaves them out of a case.
- The ground truth is Jito's bundle record (`/api/v1/bundles/bundle/<id>`): a wallet is in the bundle when one of its creation-slot buys is among the bundle's transactions.
  A wallet outside the bundle is counted wrong for any signal that flags it, even where it may be the creator's by another route, so every such flag is listed above.
- The funding window is 7 days either side of the open, as production's, read 8 or more days after the launches so the days after are complete.
  Production reads the Creator wallet's whole history; here, to stay within the free tier, each account's history over the day and the 7 days either side is listed once (up to 16,000 signatures), and the transactions read are those both the Creator wallet's and the buyer's histories hold, where one side is too busy to list, the other side's whole window is the candidates when it holds 200 transactions or fewer, and otherwise the wallet is unread.
  Candidates are read with production's `transfersIn`, nearest the open first, where a bundle's funding and its proceeds sit, and stop at the first direct transfer, since one settles the flag; at most 25 a wallet on a bundled launch and 8 on another, as the free tier serves about one transaction a second.
  A wallet left unsettled counts as unflagged.
  A direct SOL transfer names both wallets; a token transfer names the buyer only when the buyer is its authority or its account is made in it, so the Creator wallet sending tokens into a buyer's existing account is the one kind of link this can miss.
- Mainnet now carries version 1 transactions, which a read must allow (`maxSupportedTransactionVersion: 1`); production's devnet reads ask for version 0.

## Rerun

`pnpm --filter @top-pad/tests-radar-eval evaluate` reads whatever the kept set lacks, then scores and rewrites this report; `--refetch` reads every launch and the fleet again, the launch list kept, so the same launches are measured.
A whole run from nothing takes about four hours on the free tier, the fleet about two of them, and a stopped run goes on where it stopped.
