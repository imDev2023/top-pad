# Catching a copycat coin (vamp) before it launches

Research for ticket #6 on the Top-pad wayfinder map, captured 2026-10-26.
It answers how Top-pad can refuse or flag a vamp at creation time: ticker and name folding, image matching, the "already trading elsewhere" check, known evasions and false positives, and originals-registry designs.
Every claim carries its source.
Claims marked **measured** come from small experiments run for this note on 2026-10-26; their method is described where the result appears.
Claims marked **unverified** could not be confirmed against a primary source.

## Answer

### The pipeline in one paragraph

Lock the inputs first, because a check at creation means nothing if the creator can change the name, ticker or picture afterwards.
Then fold the ticker and name into comparison keys built on the Unicode skeleton (UTS #39) plus a small leetspeak and affix layer, and hash the picture with PDQ (with its eight flip and rotation variants) and an SSCD copy-detection embedding.
Compare those keys against a **protected set**: coins that already trade with real money (Jupiter-verified tokens, unverified Solana coins that pass a sustained organic-activity bar, the top coins on other chains), coins that are trending right now, and Top-pad's own coins that have earned protection.
An exact key or picture match against the protected set is refused with the reason and a link to the original; a near match is allowed with a visible "looks like X" label; everything else passes.
Uniqueness among Top-pad's own launches is enforced by a database unique index, or by an on-chain registry account, so that two simultaneous launches cannot both take a ticker.

### 1. Lock the inputs (prerequisite)

- Make metadata immutable: Meteora DBC lets the token's update authority go to the creator, the partner or no one ([owner's KB, `meteora/01-products-and-protocol.md` section 4.6](https://github.com/imDev2023/jupiter-meteora-resources)), so Top-pad should pick "no one" (or the platform), otherwise a creator passes the check and then renames the coin or swaps the picture.
- Host the picture and the metadata JSON ourselves at content-addressed storage (IPFS through the owner's Pinata key, or Arweave), so the image behind the URI cannot change after the check.
- Restrict the ticker to ASCII `A-Z0-9` after NFKC and uppercasing, 2 to 10 characters, and write that canonical form on-chain.
  Metaplex already caps the symbol at 10 bytes and the name at 32 bytes ([`mpl-token-metadata` `MAX_SYMBOL_LENGTH`, `MAX_NAME_LENGTH`](https://github.com/metaplex-foundation/mpl-token-metadata/blob/main/clients/rust/src/lib.rs)), and the check is on UTF-8 bytes ([`assertions/metadata.rs`](https://github.com/metaplex-foundation/mpl-token-metadata/blob/main/programs/token-metadata/program/src/assertions/metadata.rs)), so non-Latin tickers are already squeezed.
  An ASCII-only ticker removes homoglyph, zero-width, emoji and bidi tricks from Top-pad's own tickers outright, and makes the ticker key simple enough to compute inside an on-chain program.
  This shuts out CJK and emoji tickers; that is a product decision for the map (see the open questions).
- For names, allow Unicode but refuse Default_Ignorable code points (zero-width characters, bidi controls, Hangul fillers) and anything below UTS #39 "Moderately Restrictive", that is, any mix of Latin with Cyrillic or Greek ([UTS #39 section 5.2](https://www.unicode.org/reports/tr39/tr39-34.html)).

### 2. Ticker and name keys

Compute three keys for every ticker and name, ours and every external token's:

| Key | Steps | Catches |
| --- | --- | --- |
| strict | NFKC; map regional-indicator, negative-squared and negative-circled letters to A-Z; uppercase; UTS #39 internalSkeleton (NFD, drop Default_Ignorable, map confusables, NFD); drop combining marks and every non-letter, non-digit | case, spaces and dots, fullwidth and math-bold letters, Cyrillic or Greek lookalikes, zero-width and bidi characters, accents, `0`/`O`, `1`/`I`/`l`/`\|` |
| loose | strip a leading `$`; map leetspeak digits and symbols (`3`E `4`A `5`S `7`T `8`B `6`/`9`G `2`Z `$`S `@`A `!`I); then strict | `P3PE`, `5OL`, `B0NK` |
| core | loose, then strip authenticity and version affixes repeatedly: OFFICIAL, REAL, OG, ORIGINAL, THE, NEW, CLASSIC, V2, 2, 20, II, CTO, COMMUNITY, FAN, PARODY, ONSOL, SOL, SOLANA, COIN, TOKEN | "Official X", "X 2.0", "X CTO", "X on SOL" |

Derivative affixes (BABY, MINI, LIL, INU, KING, CAT, DOG) are different: they mark a derivative coin rather than a fake, and some are part of real names (SHIBA INU, PEPECAT, both verified on Jupiter, **measured**), so never strip them into the core key; a protected key plus a derivative affix goes to the flag rule below.
Order matters: uppercase before the skeleton, never casefold before it, because casefolding turns Greek capitals into small letters whose skeleton is not Latin (**measured**: `ΡΕΡΕ` casefolded gives skeleton `pꞓpꞓ`, uppercased gives `PEPE`).
Store keys with the Unicode version that produced them and recompute them on every Unicode upgrade, because UTS #39 says skeletons "are not stable across versions of Unicode" and "must be recomputed when updating" ([UTS #39 section 4](https://www.unicode.org/reports/tr39/tr39-34.html)).

Decisions per comparison against the protected set:

| Match | Outcome |
| --- | --- |
| strict key equal | refuse (the two render alike) |
| loose or core key equal | refuse (copy plus leetspeak or affix, the pattern uselaunch.fun refuses) |
| name's core key equals a protected ticker or name | refuse |
| Damerau edit distance 1 on the loose key, key length 5 or more | flag with a label, do not refuse |
| ticker contains a protected ticker plus a derivative affix (BABYPEPE, PEPEINU), or name contains a protected key as a word plus other words ("Baby X", "X Dollar Bill") | flag with a label, do not refuse (derivative and parody coins are a normal genre) |

Never use edit distance on keys shorter than 5: **measured** against the 3,946 distinct keys of Jupiter-verified tokens, a random 3-letter ticker is within edit distance 1 of a verified one 78% of the time, a 4-letter one 22%, a 5-letter one 2%, and a 6-letter one 0%.
At scale the keys are short strings: a B-tree index on each key handles exact matches over millions of rows, and edit distance 1 against a protected set of tens of thousands needs only a deletion-variant index or a plain scan.

### 3. Picture matching

On upload, decode and re-encode the image, then compute a SHA-256 (exact duplicates), a PDQ hash with its quality score and its eight dihedral variants, and a 512-dimension SSCD embedding.

| Signal | Refuse | Flag | Source of the number |
| --- | --- | --- | --- |
| PDQ, minimum over the eight dihedral hashes, both images quality 50 or more | distance 31 or less | 32 to 45 | Meta recommends starting at "<=31" and discarding quality "<=49" ([PDQ README](https://github.com/facebook/ThreatExchange/blob/main/pdq/README.md)) |
| SSCD `sscd_disc_mixup` cosine | 0.75 or more | 0.60 to 0.75 | "cosine similarity greater than 0.75 are copies with 90% precision" on DISC21 ([SSCD README](https://github.com/facebookresearch/sscd-copy-detection)) |
| CLIP-style embedding | never | optional "same character" hint only | **measured** below: it scores different Pepe frogs at 0.91 to 0.94 |

Run both PDQ and SSCD, because they fail differently (**measured**): PDQ breaks on a 5% crop, a 15% border and a 10 degree rotation, where SSCD still ranks the true original first every time (its score often drops below 0.75, so those land in the flag band); SSCD in turn missed a real copied PEPE logo (SSCD 0.61) that PDQ caught at distance 28, because one copy was a 64-pixel thumbnail.
Fetch protected logos at full resolution from the token's own metadata URI, not from aggregator thumbnails.
Neither survives colour inversion; inversion is rare enough to leave to the flag tier and human review.
Exempt issuer families (tokenized stocks and wrapped assets share branding templates), as Jupiter does ([token page docs](https://docs.jup.ag/user-docs/trade/spot/token-page)).

Indexing: 256-bit PDQ hashes take 32 bytes each, so 10 million fit in 320 MB; FAISS `IndexBinaryFlat` is "carefully optimized especially for 256-bit vectors" and `IndexBinaryMultiHash` gives sub-linear search ([FAISS binary indexes](https://github.com/facebookresearch/faiss/wiki/Binary-indexes)), and Meta ships a multi-index-hashing design for PDQ ([README-MIH](https://github.com/facebook/ThreatExchange/blob/main/pdq/README-MIH.md)).
In Postgres, pgvector stores `bit` vectors up to 64,000 dimensions with an HNSW `bit_hamming_ops` index and `vector` up to 2,000 dimensions with cosine HNSW ([pgvector README](https://github.com/pgvector/pgvector)), which covers both PDQ and SSCD in one database.
Cloudflare Vectorize takes up to 1,536 dimensions and 20 million vectors per index ([Vectorize limits, via the owner's Cloudflare KB `build/02-ai.md`](https://developers.cloudflare.com/vectorize/platform/limits/)), enough for SSCD; it has no Hamming metric.

### 4. "Already trading elsewhere": the protected set and its data sources

Raw volume and reported liquidity are useless as a real-money signal (**measured** on 80 Jupiter search results for PEPE, WIF, BONK and TRUMP): "WIFBTC" showed $2.98M of 24-hour volume but $1.2k of organic volume and organic score 0, and every fresh pump.fun curve reports about $3k of "liquidity" with 1 or 2 holders.
Organic score, holder count and verification separate real coins from noise.

Recommended protected set (starting values, to be tuned against real refusal logs):

| Tier | Members | Data source | Outcome on a key or picture match |
| --- | --- | --- | --- |
| A1 | Jupiter-verified Solana tokens (4,067 on 2026-10-26, **measured**) | Jupiter `GET /tokens/v2/tag?query=verified`, daily | refuse |
| A2 | Unverified Solana coins with organic score 50 or more, 1,000 or more holders, market cap $250k or more and a graduated pool, in two snapshots 12 hours apart | Jupiter `toporganicscore` and `toptraded` lists plus `search` by mint | refuse |
| A3 | Trending now: in Jupiter's `toporganicscore/5m` or `toptrending/1h` top 100 with organic score 50 or more; protected for 72 hours | Jupiter category endpoints, every minute | refuse |
| A4 | Top coins on other chains: CoinGecko top 1,000 by market cap | CoinGecko `/coins/markets`, daily | refuse |
| A5 | Top-pad coins that completed their Fair Open, or reached 100 holders, while they keep trading | Top-pad's own database or chain state | refuse |
| B | Any Solana coin with organic score 30 or more or 300 or more holders in the last 7 days; any DexScreener pair on any chain with $50k or more liquidity | Jupiter, DexScreener search | flag |
| C | Everything else (the long tail of dead coins) | none | allow |

The tier A2 bar would protect "cat wif sword" (organic score 75, 11,825 holders, $1.7M market cap, not verified) and leave out vamps such as "Dog Wif Hat" with ticker WIF (organic score 45, 193 holders, $282 liquidity) (**measured**, same 80 results).
The 72-hour trending lock copies four.meme's Token Name Protection, which locks a name and ticker for 72 hours once a coin reaches 100 holders on its curve ([four.meme product update 25-10-18](https://four-meme.gitbook.io/four.meme/product-update/5-product-update-25-10-18)).

Data sources, best first:

| Source | Fit | Freshness for new tokens | Limits and cost |
| --- | --- | --- | --- |
| Jupiter Tokens API v2 | best: search by symbol, name or mint; verification, organic score, holders, launchpad | **measured**: `/recent` listed mints 3 to 62 s after their first pool; tokens 9 to 11 s old were found by mint 4 of 4 times and by ticker 3 of 4 | search 10 credits, category 5, tag 50, recent 1; Free 1 RPS, Developer $25 a month 10 RPS, limits per organisation ([owner's KB `jupiter/02-developer-platform-and-apis.md` sections 1.5, 1.6, 3](https://github.com/imDev2023/jupiter-meteora-resources)) |
| DexScreener API | cross-chain search by name or symbol, free, no key | **measured**: 21 of 30 mints from Jupiter's `/recent` had a pair about 30 to 90 s after their first pool; 0 of 4 tokens 10 to 20 s old were found by ticker search | search and pairs 300 requests a minute, profiles 60 ([API reference](https://docs.dexscreener.com/api/reference)); a search returned at most 30 pairs (**measured**) |
| GeckoTerminal public API | new pools per network, search | endpoints cached 1 minute ([GeckoTerminal API](https://www.geckoterminal.com/dex-api)); **measured** newest `new_pools` entry 77 s old | "approximately 10 calls/minute", beta ([same page](https://www.geckoterminal.com/dex-api)) |
| CoinGecko | other-chain majors by market cap; search sorted by market cap | not for new tokens | Demo key 100 calls a minute ([errors and rate limits](https://docs.coingecko.com/docs/errors-and-rate-limits)) |
| Birdeye | search with exact or fuzzy mode by symbol, name or both, `verify_token` filter, new-listing feed | not tested (no key in the owner's inventory) | search 25 CU; free Standard plan 30,000 CU a month and 1 rps, Lite $39 for 2.5M CU ([search](https://data.birdeye.so/docs/data-api/search-utils/get-defi-v3-search), [pricing](https://data.birdeye.so/docs/guides/payment/pricing)) |
| Helius DAS | metadata and image of a known mint only: `searchAssets` has no name or symbol parameter ([searchAssets](https://www.helius.dev/docs/api-reference/das/searchassets)) | real time through streams | DAS 10 credits a call; Free 1M credits and 2 DAS req/s, Developer $49 10M and 10 req/s ([billing](https://www.helius.dev/docs/billing)) |

Search APIs cannot be the matcher: Jupiter's search does not fold lookalikes (**measured**: `PEPE` with a Cyrillic `Е` returned only 1 token, one whose name contains that same Cyrillic string, instead of the 20 PEPE results), and it returns 20 results ranked by text similarity, volume and liquidity ([Jupiter VRFD docs](https://docs.jup.ag/user-docs/launch/vrfd/token-verification)), so fresh tokens under common tickers drop out (**measured**: a second "XD" created in the same seconds was not in the top 20).
So Top-pad needs its own index: pull the tier lists above on a schedule, compute keys and picture signatures locally, and keep it fresh from Jupiter `/recent` (1 credit a call) or a Helius stream of new mints.
The live check at launch then runs entirely against local indexes and takes milliseconds.

### 5. Registry rules and races

- A first-come lock on every ticker invites squatting; four.meme protects only coins with traction and deliberately lets two near-simultaneous creates both succeed, which "prevents bots from mass-locking names" ([four.meme](https://four-meme.gitbook.io/four.meme/product-update/5-product-update-25-10-18)).
- Top-pad's Fair Open window is the moment a vamp hurts most, so among Top-pad's own launches use a partial unique index on the strict key over coins in an open deposit window or in tier A5, so the race is decided by the database, as uselaunch.fun says it does ([uselaunch.fun/how](https://uselaunch.fun/how)).
- Release the key when a Fair Open fails or a coin stops trading, so dead launches do not squat.
- Because Top-pad tickers are ASCII-only, the strict key is a tiny table (uppercase, `0` to `O`, `1`/`I` to `l`) that an on-chain program could compute and enforce with a registry account seeded by the key; external real-money checks stay off-chain and would need a server attestation (design suggestion, not sourced).
- "One coin per X account", as uselaunch.fun does ([uselaunch.fun/launch](https://uselaunch.fun/launch)), raises the cost of mass vamping, but X API prices for checking accounts are **unverified** (only secondary reporting of a pay-per-use model from February 2026 was found).
- Appeals: a refused creator can ask for review; legitimate relaunches, migrations and community takeovers pass by linking the original mint or by proof of control, the same proof Jupiter asks for metadata updates ([VRFD FAQ](https://docs.jup.ag/user-docs/launch/vrfd/faq)).

### What uselaunch.fun does, from its public pages

- Before its master wallet signs, "the ticker must be new (case, spaces, lookalike letters and leetspeak fold into one)", the name cannot be a copy with "official" or a "2" added, the picture cannot be "a resized or recoloured copy", and "an X account owns one coin" ([uselaunch.fun/how](https://uselaunch.fun/how), 2026-10-26).
- "A ticker already trading elsewhere with real money is refused too" ([same page](https://uselaunch.fun/how)).
- "The database enforces it, so two launches racing for one ticker can't both win" ([same page](https://uselaunch.fun/how)).
- Its create page lists the "anti-vamp check" as ticker, name, X account and picture, and says a refusal comes "with the reason" ([uselaunch.fun/launch](https://uselaunch.fun/launch)).
- It publishes no thresholds, no definition of "real money" and no data source; how the filter behaves in practice is **unverified**, because testing it would mean creating real coins.

## Evidence

### 1. Ticker and name folding

#### What the Unicode skeleton is

- UTS #39 version 18.0.0 (2026-08-27, revision 34) defines `internalSkeleton(X)`: convert to NFD, remove Default_Ignorable_Code_Point characters, replace each character by its prototype from the confusables data, and reapply NFD ([UTS #39 section 4](https://www.unicode.org/reports/tr39/tr39-34.html)).
- Two strings are confusable when their skeletons are equal; the mechanism "imposes transitivity on the data" and "in some cases the test may be overly inclusive" ([same section](https://www.unicode.org/reports/tr39/tr39-34.html)).
- Skeletons "are not intended for display", are not stable across Unicode versions, and stored skeletons must be recomputed when the Unicode version changes ([same section](https://www.unicode.org/reports/tr39/tr39-34.html)).
- The data file used here is `confusables.txt` version 18.0.0 dated 2026-08-06, with 6,712 mappings ([confusables.txt](https://www.unicode.org/Public/security/latest/confusables.txt); count **measured**).
- UTS #39 defines restriction levels; "Moderately Restrictive" allows Latin plus one other recommended script "except Cyrillic, Greek", and Highly Restrictive allows Latin with Han and Japanese or Korean scripts ([UTS #39 section 5.2](https://www.unicode.org/reports/tr39/tr39-34.html)).
- The whole-script check flags many legitimate Latin and Cyrillic strings, because the data has "a large number of mappings between Latin and Cyrillic" ([UTS #39 section 4.1](https://www.unicode.org/reports/tr39/tr39-34.html)).

#### What the skeleton catches and misses (**measured**)

Method: `internalSkeleton` implemented in Python 3.12 from `confusables.txt` 18.0.0 and `DerivedCoreProperties.txt`, applied to variants of PEPE, WIF, BONK and SOL.

| Input | Bare skeleton | Strict key (NFKC, upper, skeleton, letters and digits only) |
| --- | --- | --- |
| `P` + Cyrillic `Е` (U+0415) + `PE` | PEPE | PEPE |
| Greek `ΡΕΡΕ` | PEPE | PEPE |
| fullwidth, math bold `𝐏𝐄𝐏𝐄`, superscript `ᴾᴱᴾᴱ` | PEPE | PEPE |
| circled `ⓅⒺⓅⒺ` | `℗Ⓔ℗Ⓔ` (wrong without NFKC first) | PEPE |
| zero-width space, ZWJ, soft hyphen, variation selector, U+202E, Hangul filler U+3164 | PEPE (all are Default_Ignorable) | PEPE |
| `P E P E`, `P.E.P.E`, `$PEPE` | kept spaces and dots | PEPE |
| `PÉPE` with a combining accent | kept the accent | PEPE |
| braille blank U+2800 (not Default_Ignorable) | `PEPE ` | PEPE |
| regional indicators `🇵🇪🇵🇪`, negative squared `🅿🅴🅿🅴` | unchanged | PEPE (extra mapping table) |
| small capitals `ᴘᴇᴘᴇ` | unchanged | unchanged (no confusables entry: a gap) |
| `B0NK`, `W1F`, `WIF` | BONK, WlF, WlF | BONK, WlF, WlF |
| `P3PE`, `5OL` | unchanged (only `0`, `1` and `\|` have digit mappings) | loose key: PEPE, SOL |
| lowercase `pepe` | pepe (case-sensitive) | PEPE |

- In `confusables.txt`, digit `0` maps to capital `O`, digit `1`, capital `I` and `|` map to small `l`, and digits 2 to 9 have no mapping (**measured** from the file), so leetspeak needs its own table.
- Emoji tickers fold to an empty strict key; ENS's normalization handles emoji as separate tokens and strips U+FE0F ([ENSIP-15](https://docs.ens.domains/ensip/15)), which is the model to copy if emoji tickers are ever allowed.

#### Precedents for name registries

- PyPI refuses a new project whose "ultranormalized" name equals an existing one: it removes `.`, `_` and `-`, maps `l`, `L`, `i`, `I` to `1` and `o`, `O` to `0`, lowercases, and indexes the result in Postgres ([warehouse migration `d18d443f89f0`](https://github.com/pypi/warehouse/blob/main/warehouse/migrations/versions/d18d443f89f0_ultranormalize_name_function.py); refusal in [`packaging/services.py`](https://github.com/pypi/warehouse/blob/main/warehouse/packaging/services.py) as `ProjectNameUnavailableSimilarError`).
- PyPI's separate typo check ("TypoSnyper", added 2025-03-05) compares new names only against a corpus of top projects (a static fallback list of 200), skips its omission check for names shorter than 4 "to reduce false positives", and on a match only records an observation and notifies admins, without blocking ([`typosnyper.py`](https://github.com/pypi/warehouse/blob/main/warehouse/packaging/typosnyper.py), [`packaging/tasks.py`](https://github.com/pypi/warehouse/blob/main/warehouse/packaging/tasks.py)).
- npm has refused new package names that equal an existing name once punctuation is removed since 2017, because "many typosquat names either accidentally or on purpose use punctuation differences to sneak through" ([npm blog, 2017-12-26](https://blog.npmjs.org/post/168978377570/new-package-moniker-rules)).
- ENS normalization (ENSIP-15, final) pins Unicode 17.0.0, groups characters by script, rejects labels with a whole-script confusable, and says it handles only single-character confusables ([ENSIP-15](https://docs.ens.domains/ensip/15)).

#### Affixes and combo-squatting

- Of 2,117 counterfeit ERC-20 tokens aimed at 94 of the top 100 tokens, 79.1% reused the official name or symbol and 76.4% were combo-squats that add text, spaces, underscores or abbreviations ("HT Coin", "HT_huobi", "USDT-2", "USDT New") ([Gao et al. 2020, "Tracking Counterfeit Cryptocurrency End-to-end", arXiv:2011.02673](https://arxiv.org/abs/2011.02673)).
- That study matched by keyword containment and then removed false positives by hand (migrated tokens, test tokens, unrelated legitimate projects) ([same paper](https://arxiv.org/abs/2011.02673)).
- On Solana today (**measured**, Jupiter search 2026-10-26): ticker PEPE is reused by "Pretty Enormous Pair Eh?" and "Peak Erection Peak Energy", ticker BONK by four different "Big Ol' ... Knockers" names, and TRUMP derivatives include "Official Barron Trump", "baby trump", "Trump $100 Bill" and "TRUMPDOLLAR".
  Backronym names keep the ticker check as the decisive one: these coins differ in name, not in ticker.

#### Edit distance on short tickers (**measured**)

Method: strict keys of the 4,067 Jupiter-verified tokens (3,946 distinct keys; 108 keys are shared by 2 or more verified tokens), Levenshtein distance 1.

| Key length | Keys | Share with a verified neighbour at distance 1 |
| --- | --- | --- |
| 2 | 65 | 98% |
| 3 | 444 | 95% |
| 4 | 1,212 | 86% |
| 5 | 1,140 | 59% |
| 6 | 716 | 25% |
| 7 | 170 | 9% |

A random ticker lands within distance 1 of a verified ticker 78% of the time at 3 letters, 22% at 4, 2% at 5 and 0% at 6, so distance 1 is a flag at length 5 or more and never a refusal.

### 2. Picture matching

#### Primary facts on perceptual hashes

- PDQ is a 256-bit DCT hash with a 0 to 100 quality score; random pairs of hashes average a distance of 128, roughly within 90 to 160 ([PDQ paper, `hashing.pdf`](https://github.com/facebook/ThreatExchange/blob/main/hashing/hashing.pdf)).
- Meta's starting thresholds: match at distance 31 or less, discard hashes with quality 49 or less ([PDQ README](https://github.com/facebook/ThreatExchange/blob/main/pdq/README.md)); its own matcher uses `PDQ_CONFIDENT_MATCH_THRESHOLD = 31` and quality 50 ([`pdq_utils.py`, `signal.py`](https://github.com/facebook/ThreatExchange/tree/main/python-threatexchange/threatexchange/signal_type/pdq)).
- PDQ "is designed for lightly (non-adversarially) modified images", tolerates light watermarks, "does not do well at pairing photos one of which is a crop of another", and can compute the hashes of all eight rotations and flips cheaply ([`hashing.pdf`](https://github.com/facebook/ThreatExchange/blob/main/hashing/hashing.pdf)).
- The README warns that the eight dihedral hashes are not exactly rotation-invariant, so picking a "minimal" hash per image is unreliable; compare against all eight instead ([PDQ README](https://github.com/facebook/ThreatExchange/blob/main/pdq/README.md)).
- PDQ uses 256 bits because "64 bits is uncomfortably small for web-scale image-matching", a dig at pHash's 64 bits ([`hashing.pdf`](https://github.com/facebook/ThreatExchange/blob/main/hashing/hashing.pdf)).
- An adversary defeats all of them: a black-box attack evaded pHash, dHash, aHash and PDQ on 99.9% of 10,000 attacked images while preserving their content, even at loose thresholds (PDQ 70 to 90) ([Jain, Cretu, de Montjoye, USENIX Security 2022, arXiv:2106.09820](https://arxiv.org/abs/2106.09820)).
- SSCD is a self-supervised descriptor trained for copy detection; for `sscd_disc_mixup`, cosine above 0.75 means a copy at 90% precision on DISC21 ([SSCD README](https://github.com/facebookresearch/sscd-copy-detection), [Pizzi et al. CVPR 2022, arXiv:2202.10261](https://arxiv.org/abs/2202.10261)).
- DISC21 has a 1 million image reference set and queries edited with text and emoji overlays, colour changes, blur, crops, rotations, flips and pasting onto other backgrounds ([Douze et al. 2021, arXiv:2106.09672](https://arxiv.org/abs/2106.09672)).

#### Experiment on real token logos (**measured**)

Method: 334 logos decoded from Jupiter (a seeded random sample of 400 verified-token icons plus every icon from the PEPE, WIF, BONK and TRUMP searches); pHash and dHash from `imagehash` 4.3.2, PDQ from `pdqhash` 0.2.8, SSCD `sscd_disc_mixup` TorchScript, CLIP ViT-B-32 (OpenAI weights through `open_clip` 3.3.0).
Twelve edits were applied to 60 verified logos (the hash run and the embedding run drew slightly different samples of 60); "dihedral" means the best match over the eight flips and rotations.

Share of edited copies still matched:

| Edit | PDQ <= 31 | PDQ dihedral <= 31 | pHash <= 10 | SSCD >= 0.75 | SSCD nearest neighbour is the original | CLIP >= 0.90 |
| --- | --- | --- | --- | --- | --- | --- |
| resize to 96 px | 65% | 65% | 93% | 100% | 100% | 95% |
| JPEG quality 30 | 100% | 100% | 93% | 80% | 100% | 92% |
| crop 5% each side | 0% | 0% | 78% | 100% | 98% | 100% |
| crop 15% each side | 0% | 0% | 2% | 32% | 98% | 83% |
| 15% white border | 0% | 0% | 12% | 68% | 100% | 93% |
| hue shift 120 degrees | 90% | 90% | 90% | 100% | 100% | 100% |
| invert colours | 0% | 0% | 0% | 0% | 22% | 73% |
| mirror | 10% | 82% | 0% (100% dihedral) | 100% | 100% | 55% |
| rotate 90 degrees | 2% | 82% | 0% (100% dihedral) | 72% | 100% | 43% |
| rotate 10 degrees | 0% | 0% | 20% | 25% | 100% | 93% |
| text banner over 20% | 65% | 65% | 60% | 93% | 100% | 80% |
| corner sticker over 9% | 13% | 13% | 10% | 98% | 100% | 100% |

False positives among different logos (55,278 pairs for the hashes, 55,611 for the embeddings):

| Signal | Median | Pairs at the refuse threshold | Pairs in the flag band |
| --- | --- | --- | --- |
| PDQ | 126 | 15 at <= 31 | 17 at 32 to 60 |
| pHash | 32 | 48 at <= 10 | n/a |
| dHash | 29 | 909 at <= 10 | n/a |
| SSCD | 0.085 | 143 at >= 0.75 | 924 at 0.60 to 0.75 |
| CLIP | 0.593 | 41 at >= 0.90 | 5,393 at 0.75 to 0.90 |

- Every pair at PDQ 31 or less was the same picture: issuer families sharing one logo (Global X and Franklin funds, GE xStocks, Fire USD and Fire SPY) or a real vamp or relaunch ("Trump $100 Bill" and "Trump Dollar Bill", "dawgwifhat" and "Dog Wif Hat", two "MIGHTY ZION ORANGE RANGER" coins, "TRUMPDOLLAR" and "Trump $1 Coin", and a copy of the verified PEPE logo at distance 28).
- With issuer-family tokens removed (138 logos left), SSCD put all 5 pairs above 0.75 on copies or one issuer family, with an empty gap between 0.67 and 0.85; 7.2% of logos had a neighbour above 0.75 and 13.8% above 0.60, though the sample is enriched with search results that contain copies, so a random new logo will flag less often.
- Ondo and xStocks logos share one frame or one issuer logo, so they cluster at SSCD 0.83 to 1.0 and PDQ 0 to 66, which is why issuer families need an exemption.
- dHash is too loose for refusal (909 false pairs at distance 10 or less), and CLIP scores different Pepe-style frogs ("Peepo", "Pepe Nerd", the verified Pepe) at 0.91 to 0.94, so it measures "same character", not "same picture".
- The copied PEPE logo scored PDQ 28 but SSCD only 0.61, because the verified token's icon is 64 by 64 pixels.

### 3. Data sources for "already trading elsewhere"

#### Jupiter Tokens API and verification

- Endpoints: `/search` by symbol, name or up to 100 comma-separated mints (20 results by default); `/tag?query=verified`; `/{toporganicscore|toptraded|toptrending}/{5m|1h|6h|24h}` with up to 100 results; `/recent` for mints whose first pool was just created ([owner's KB, `jupiter/02-developer-platform-and-apis.md` section 3.2](https://github.com/imDev2023/jupiter-meteora-resources), from [developers.jup.ag/docs/tokens](https://developers.jup.ag/docs/tokens)).
- Each result carries `isVerified`, `organicScore` (0 to 100), `organicScoreLabel`, `holderCount`, `mcap`, `liquidity`, `launchpad`, `graduatedPool`, `firstPool`, `audit` and 5-minute to 24-hour stats including organic buy and sell volume ([same KB section 3.3](https://github.com/imDev2023/jupiter-meteora-resources)).
- Organic score "excludes wallets trading via known bot/automation channels" and is relative to the ecosystem ([same KB section 3.4](https://github.com/imDev2023/jupiter-meteora-resources)).
- Jupiter verification marks the "canonical version" of a ticker; its criteria include market cap (a warning under $100k or when "the ticker is already verified for a different contract address"), organic score, holders, "Ticker Uniqueness", social support (the most important) and on-chain liquidity; Express rejections name reasons such as "Ticker Conflict" ([VRFD token verification](https://docs.jup.ag/user-docs/launch/vrfd/token-verification)).
- A verified label can be removed when the token loses its liquidity, stops trading, migrates to a new address or "has a ticker conflict with another verified token" ([VRFD FAQ](https://docs.jup.ag/user-docs/launch/vrfd/faq)).
- Verification is still not unique per ticker in practice (**measured**): verified tokens use both `PEPE` (created 2026-09-17) and `Pepe` (created 2024), META is both MetaDAO and a Meta stock token, and 94 uppercased tickers are shared by two or more verified tokens.
- Jupiter shows a persistent impersonation banner linking the legitimate asset, and a weaker "reused icon" badge that "does not indicate which token used the icon first" and is never shown on verified or issuer-backed tokens ([token page](https://docs.jup.ag/user-docs/trade/spot/token-page), [AlphaScan](https://docs.jup.ag/user-docs/trade/spot/alphascan)).

#### Freshness and coverage (**measured** on 2026-10-26 around 15:46 UTC)

- Jupiter `/recent`: 30 mints, first pools 3 to 62 seconds old (median 34); 29 from pump.fun, 1 from Meteora DBC.
- DexScreener `/tokens/v1/solana/...` for those 30 mints: 21 had a pair; DexScreener lists a token once it is "added to a liquidity pool and [has] at least one transaction" ([token listing](https://docs.dexscreener.com/token-listing)).
- GeckoTerminal `/networks/solana/new_pools`: newest pool 77 seconds old, median 102, consistent with its 1-minute cache.
- Ticker search for four tokens 9 to 11 seconds old: Jupiter found 4 of 4 by mint and 3 of 4 by ticker; DexScreener found 0 of 4.
- The first keyed Jupiter call returned HTTP 429 "[API Gateway] Too many requests" and a keyless retry worked; Jupiter limits apply per organisation, so other sessions on the owner's key share the bucket ([owner's KB section 1.6](https://github.com/imDev2023/jupiter-meteora-resources)).

#### Other providers

- DexScreener's API terms allow commercial use but forbid building a product whose "primary purpose is to compete directly with DEX Screener" ([API terms](https://docs.dexscreener.com/api/api-terms-and-conditions)).
- DexScreener exposes `/community-takeovers/latest/v1` with a `claimDate` per token, so community takeovers can be recognised ([API reference](https://docs.dexscreener.com/api/reference)).
- CoinGecko's `/onchain/networks/{network}/new_pools` covers pools from the past 48 hours, 20 per page, refreshed every 30 s on paid plans and 60 s on Demo or keyless ([CoinGecko docs](https://docs.coingecko.com/reference/latest-pools-network)).
- Birdeye's search filters by markets including Pump.fun and Meteora DLMM and by `verify_token` ([search docs](https://data.birdeye.so/docs/data-api/search-utils/get-defi-v3-search)); its new-listing endpoint costs 25 CU, returns at most 20 and only within the last 3 days ([new listing](https://data.birdeye.so/docs/data-api/tokenmarket-list/get-defi-v2-tokens-new-listing)); both are in the free Standard package ([data accessibility](https://data.birdeye.so/docs/guides/data-accessibility-by-packages)).
- Helius Parsed Streams deliver decoded transactions at 1 credit per event on all plans, and LaserStream gRPC on mainnet needs a Business or Professional plan ([credits](https://www.helius.dev/docs/billing/credits)); either can feed the own index with new mints in real time.

### 4. Evasion tricks and false positives

| Trick | Caught by |
| --- | --- |
| Lookalike letters across scripts, fullwidth, math alphanumerics, circled and squared letters | NFKC plus skeleton (strict key); ASCII-only ticker for our own coins |
| Zero-width characters, bidi overrides, variation selectors, Hangul fillers | Default_Ignorable removal; refuse them outright in names |
| Visible blanks that are not ignorable (braille blank U+2800) | dropping non-letter, non-digit characters |
| Small capitals | not caught by UTS #39 data; add a mapping table |
| Leetspeak, `$` prefix | loose key |
| "Official", "2", "CTO", "on SOL" | core key |
| Backronym names over a famous ticker | the ticker key, not the name |
| Typos and transpositions (`PEEP`, `BONKK`) | edit distance flag, length 5 or more only |
| Translations, phonetic respellings, word reordering | not caught by any key; flag tier, community reports |
| Resized, recompressed, recoloured or watermarked pictures | PDQ and SSCD |
| Mirrored or rotated pictures | PDQ dihedral, SSCD |
| Cropped, padded or tilted pictures, stickers | SSCD (PDQ fails) |
| Inverted colours, redrawn or AI-restyled pictures, adversarial noise | neither reliably; flag tier, human review ([Jain et al. 2022](https://arxiv.org/abs/2106.09820)) |
| Changing metadata after launch | immutable metadata, self-hosted content-addressed image |
| Launching the copy on another launchpad | out of Top-pad's reach; only labelling on Top-pad's own pages |

False-positive sources and how to handle them:

- Common words and generic tickers: 108 strict keys are shared by verified tokens (BABY 4 times; DOG, SHIB, META, LOL, REAL 3 times each) (**measured**), so protect a key only through a coin with traction, never a dictionary word by itself.
- Issuer families: tokenized stocks and wrapped assets legitimately share names and branding (META the stock and META the DAO; xStocks templates); Jupiter exempts "recognised issuer-backed assets" from its reused-icon badge ([token page](https://docs.jup.ag/user-docs/trade/spot/token-page)).
- Bridged or other-chain originals: the same coin exists on several chains (two verified "SHIBA INU" SHIB tokens on Solana, **measured**), so tier A4 refuses the copy, while the issuer's own bridged token is exempt by mint.
- Legitimate relaunches, migrations and community takeovers: allow them through an appeal that links the original mint; Jupiter treats migration as a reason to move the verified label ([VRFD token verification](https://docs.jup.ag/user-docs/launch/vrfd/token-verification)).
- Parody and fan coins: pump.fun allows them if the title carries a caveat such as "[trademark] fan" or "[trademark] parody" ([pump.fun trademark guidelines](https://pump.fun/docs/trademark-guidelines)), which is why derivatives are flagged, not refused, and why FAN and PARODY are core-key affixes (a bare "PEPE FAN" still folds to PEPE).

### 5. How other platforms handle copycats

- **uselaunch.fun**: refuses before creation on ticker, name, picture, X account and "real money elsewhere", with a database constraint against races (see the Answer).
- **pump.fun**: no check at creation; name, symbol and image are immutable "SPL token metadata" ([create-coin docs](https://pump.fun/docs/create-coin)); trademark owners email `legal@pump.fun`, pump.fun "does not adjudicate" disputes, may remove content from its own website only, and may terminate repeat violators ([trademark guidelines, 2025-05-14](https://pump.fun/docs/trademark-guidelines)).
- **Jupiter**: one canonical verified token per ticker, ticker conflicts as a rejection and removal reason, an impersonation banner and a reused-icon badge (see section 3).
- **four.meme (BNB Chain)**: once a coin has 100 holders on its curve, its name and ticker are locked for 72 hours against "the same or similar name/ticker"; the check spans both launch modes, protection continues after the coin launches, and simultaneous creates may both succeed on purpose ([product update 25-10-18](https://four-meme.gitbook.io/four.meme/product-update/5-product-update-25-10-18)).
- **Moonshot, Bags, Believe, LetsBonk**: no public copycat rule was found (**unverified**; searches returned only launch coverage such as [The Block on Moonshot](https://www.theblock.co/post/301748/dexscreener-released-a-pump-fun-competitor-moonshot)).
- **DexScreener**: lists everything automatically and tracks community takeovers ([token listing](https://docs.dexscreener.com/token-listing), [API reference](https://docs.dexscreener.com/api/reference)).

### 6. Originals-registry designs and their abuse cases

| Design | Who uses it | Abuse | Mitigation |
| --- | --- | --- | --- |
| First come per normalised ticker | uselaunch.fun (its own coins), PyPI and npm (package names) | ticker squatting: mass-creating hyped tickers before the real launch | protect only with traction; release on failure or inactivity; launch cost and rate limits |
| Protection earned by traction (holders) | four.meme (100 holders, 72 hours) | a vamp launched before the original reaches the bar; buying 100 holders | short trending lock (tier A3) fed by organic score rather than raw holders |
| Canonical list curated by review | Jupiter VRFD | slow (Express costs 1,000 JUP and promises 24 to 48 hours), and only covers coins that apply ([VRFD](https://docs.jup.ag/user-docs/launch/vrfd/token-verification)) | use as tier A1, not as the only tier |
| One coin per X account | uselaunch.fun | bought or farmed accounts; X API cost **unverified** | combine with key and picture checks; do not rely on it alone |
| Per picture hash | uselaunch.fun, Jupiter reused-icon badge | shared templates and generic meme art cause false refusals; adversarial edits evade | refuse only against protected logos; flag the rest; issuer exemptions |

## Open questions this raises

- Should Top-pad tickers be ASCII-only (simplest, chain-enforceable, but no CJK or emoji tickers), and if not, which scripts are allowed?
- Should the strict-key registry live in Top-pad's own on-chain program (a registry account per key) or stay a server-side database constraint?
- Where does SSCD inference run (it needs a PyTorch runtime; Workers AI does not host it, **unverified** beyond the Vectorize limits above), and is the protected-logo index in Postgres with pgvector or in Vectorize plus a separate PDQ store?
- Who reviews appeals and flags, and how fast, during a Fair Open window that may be short?
- What exactly earns a Top-pad coin protection: a completed Fair Open, a holder count, or organic activity after trading starts?

## Unverified or not tested

- uselaunch.fun's real behaviour, thresholds and data sources (only its public statements were read).
- Birdeye freshness and accuracy (documentation only; no key).
- X API pricing for verifying account ownership (secondary sources only).
- Copycat rules at Moonshot, Bags, Believe and LetsBonk (none found).
- The tier thresholds in section 4 are starting values derived from 80 search results and the measured distributions, not validated against a labelled set of vamps.
- The experiments used 334 logos and 60 edited originals; the false-positive rates should be re-measured on the full protected set before thresholds are fixed.
