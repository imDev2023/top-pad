# What makes traders and creators pick a launchpad, and what they fear

Research for ticket #2 on the Top-pad wayfinder map, captured 2026-10-26.
It builds on [research/reference-launchpads.md](https://github.com/imDev2023/top-pad/blob/research/reference-launchpads/research/reference-launchpads.md) (what StonkFun, uselaunch.fun, pump.fun and PonsVault do, and Bitquery's bundle and sniper numbers) and does not repeat it.
Terms follow [GLOSSARY.md](https://github.com/imDev2023/top-pad/blob/main/GLOSSARY.md).
"Self-reported" marks a figure from one person's or one company's own post that was not checked on-chain here.
**Unverified** marks a claim that could not be confirmed from a second source or from data.
Posts on X were found by engagement-ranked search, so they show what resonates with this audience, not how common a view is.

## Answer

- Liquidity and attention decide where people trade, not fairness: pump.fun had 86.7% of the day's launchpad volume on Jupiter's board on 2026-10-26, three days into a #BOYCOTTPUMPFUN wave, and its daily fees fell only about 7% during the boycott week.
- Every challenger since 2025 rose on a novelty plus a token or reward incentive (Believe, letsbonk, Heaven, Bags, StonkFun) and kept 0% to 28% of its peak-week fees afterwards; pump.fun copied what worked (creator fees, stock pairs, holder rewards) within days or weeks.
- Traders' strongest fear is being exit liquidity for the creator's own bundle and for copycats, more than for snipers, which matches Bitquery's $579M made by creator bundles against $31.5M by sniper bots.
- Vamps are the loudest complaint of 2026 ("anything with volume gets copied within minutes", [X](https://x.com/mcdonaldsboy_/status/2114416458172449132)), and the KIMCHI affair that started the boycott was a creator-bundled vamp.
- The motive is a lottery ticket with status attached: volatility and FOMO top the reasons people buy memecoins, 23% name entertainment, and the culture rewards being first and posting the P&L.
- Traders already check bundles, snipers, dev holdings and a dev's past coins before buying, mostly inside trading terminals (GMGN, Axiom and fomo earned about $42M in 30 days against pump.fun's $46M), so showing these numbers is table stakes and the value is in enforcing them and publishing them where people trade.
- Creators want income from creator fees, protection from vamps and snipers, and credit for a good record; they bundle partly to defend against snipers, and honest serial creators say traders cannot tell them from scammers.
- A deposit window is welcome only in one form: short (a countdown of minutes, not hours), held on-chain and refundable, one price for everyone, and hard to farm; this audience was taught that "every pre sale is a scam" (pump.fun's founding pitch), and a long window loses the moment and gives vamps a head start on other launchpads.
- Launchpads that relied on fairness alone stayed small (Jupiter Studio, Flaunch, Moonshot Create) or were gamed (the WET sale on Jupiter DTF sold out within seconds, and at least 1,100 of its 1,530 wallets traced to one sybil farm), and Virtuals dropped its Genesis fair launch because "fairness alone is not enough".
- Verdicts on the core features: Creator lock and Vamp Shield strongly supported; Fair Open supported only in the short, refundable, sybil-resistant form; Bundle Radar, Fairness card and Creator record supported but worth building only if they are acted on and visible in terminals; Launch calendar weakly supported and risky unless the coin's name, ticker and image stay sealed until the Open.
- The fairness features answer real and loud fears, but no evidence shows them pulling traders away from pump.fun on their own; the map needs a separate answer for liquidity and attention.

## Verdicts on the core features

### Creator lock: strongly supported

Evidence:
- Bitquery's study of 8.2M pump.fun launches (summarised in the reference digest) found creator bundles made more than $579M against $31.5M for snipers, 21% of launches had creator-linked buys in the creation block holding a median 10% of supply, and on 65% of coins the creator first sold within a minute.
- In the KIMCHI copy of 20 October 2026, the deployer's launch transaction bought 793,086,976 tokens (about 79% of supply) for 85 SOL and then sent 75% of supply to one wallet; the first outside buyer paid 3.8 times the deployer's price ([Bitquery](https://bitquery.io/investigations/kimchi-pumpfun-launch-snipers)).
- Traders ask for exactly this: "why can't pumpfun just lock a % of dev coins after launch?" (r/solana, February 2025, 29 upvotes, 61 comments, [Reddit](https://www.reddit.com/r/solana/comments/1ir9vpu/why_cant_pumpfun_just_lock_a_of_dev_coins_after/)).
- "Block 0 bundling" heads the list of complaints in the most-viewed anti-pump.fun post of the boycott, 368K views ([uselaunch.fun on X](https://x.com/_LaunchX/status/2114318562424766849)).

What it asks of the design:
- A cap on the declared creator wallet is easy to dodge, because bundling tools spread a launch over 10 to 40 or more wallets funded through exchanges or privacy protocols (self-reported tool walkthrough, [X](https://x.com/TheMaran/status/2111462996690243672)); the cap only bites together with Fair Open's per-wallet caps and Bundle Radar.
- Creators defend bundling as protection from snipers ([LaunchR, 2024](https://x.com/LaunchR_/status/1816516137514938607)); Fair Open removes that reason, which is the case to make to creators.
- The lock must leave creators an income: a creator says that without creator fees "a dev take the profit and has no reason to bagwork it anymore" ([X](https://x.com/CryptoRilsio/status/2054512964019867901)).

### Vamp Shield: strongly supported, and more urgent than its place in the list suggests

Evidence:
- High-reach posts through 2026 call vamps the worst problem in the trenches: "by FAR the worst month it has ever been for vamps and pvp's" ([X, 23 October 2026](https://x.com/V1nnyfx/status/2113666913179935154)), "Every coin that actually runs instantly gets vamped" ([X, March 2026](https://x.com/Jeremybtc/status/2035261547333747025)), "the vamps and pvps are at catastrophic levels" ([X, October 2026](https://x.com/_Shadow36/status/2106813836649218248)).
- The boycott's trigger was a vamp: the KIMCHI copy drew $23.9M of trading from 13,635 wallets in its first hour while the original fell from about $5.35M to $875K fully diluted in 15 minutes ([Bitquery](https://bitquery.io/investigations/kimchi-pumpfun-launch-snipers)).
- Vamping is a product: a terminal launched "Insta-Vamp: Instantly vamp any coin with a single click" in September 2025 ([uxento on X](https://x.com/uxento/status/1966474909955059790)).
- A launchpad pitch of "one coin per narrative, no vamps. no multi-wallet abuse. no pre-migration sniping" drew 10,218 likes and 504K views in July 2026 ([X](https://x.com/pvewin/status/2077804355668099281)); how that launchpad fared is **unverified**.
- Rivals now ship ticker locks: uselaunch.fun blocks duplicate tickers for 60 minutes and reuse of the same tweet ([X](https://x.com/_LaunchX/status/2114318562424766849)), and Pump Eco blocks ticker reuse for 24 hours (self-announced, [X](https://x.com/pump_eco/status/2114435905435959703)).
- Creators fear it too: "if you deploy with creator fees, you get vamped by a random serial deployer that says 'cashbacks on'" ([X](https://x.com/CryptoRilsio/status/2054512964019867901)).

What it asks of the design:
- A shield inside Top-pad cannot stop copies on pump.fun or on other chains (a "4way chain pvp", [X](https://x.com/polarster/status/2106587239685775474)), so it should also tell buyers which coin is the original across venues, tied to the creator's verified identity.
- A Fair Open window shows a coin before it trades, which gives vamps elsewhere a head start; see the deposit-window section.

### Fair Open: supported only in a short, refundable, sybil-resistant form

See [Is a deposit window welcome or a turn-off?](#is-a-deposit-window-welcome-or-a-turn-off) below.

### Bundle Radar: supported, but already table stakes

Evidence:
- pump.fun shows creator, sniper, bundler and top-10 percentages and tags Bundler and Sniper wallets on every coin page (reference digest).
- GMGN's own agent tooling exposes sniper count, bundler-volume share, rat-trader (insider) share, suspected-insider hold rate and a 0 to 1 rug score, and filters new coins by dev holdings ([gmgn-cli README](https://cdn.jsdelivr.net/npm/gmgn-cli@1.3.7/Readme.md)).
- Traders are told to check Bubblemaps clusters, first-block buyers and wallet funding before buying ([X](https://x.com/TheMaran/status/2111462996690243672)), and free scanners advertise to that habit ([CrawlScan on X](https://x.com/CrawlScan_/status/2114418024870740099)).
- A reply in an r/solana thread on spotting rugs starts with "the bundle checkers/ top holders" (search-result snippet of [Reddit](https://www.reddit.com/r/solana/comments/1hmz7bu/how_to_spot_obvious_rugs_on_pump_fun/)).

What it asks of the design:
- Displaying bundle data adds little; acting on it (Fair Open eligibility and caps, the Fairness card, ranking) is the difference.
- It must explain its flags: an honest creator says every launch "instantly gets 20 comments calling me a scammer, bundler, rugger" ([X](https://x.com/cooldevisback/status/2063810088305836190)), and another had to plead "I have 0 supply, anything you see as cluster/bundle/sniped is not me" ([X](https://x.com/tontheneko/status/2021709381264650285)); a false flag harms creators.

### Fairness card: supported, if it is verifiable and travels

Evidence:
- It packages what traders now assemble from three to five tools (see Bundle Radar).
- Trust in a platform's own claims is low: on the day uselaunch.fun announced itself on X, a critic's on-chain check said its "100% buyback and burn" had burned 1.01% of supply and that snipers took about 19% of its own coin (**unverified**, one critic, [X](https://x.com/SomeHad2Do/status/2114460007471239635)).
  The fee wallet that critic names (`5CEbue...SPAG`) is StonkFun's own platform fee wallet in the owner's Stoker research (`stonk-fun-solana/research/README.md`), so part of the critique may misread StonkFun's balance as uselaunch's.
- Most trading happens in terminals: over the last 30 days GMGN earned $12.5M, Axiom $14.6M and fomo $15.1M, against $46.4M for pump.fun (DefiLlama revenue, pulled 2026-10-26).

What it asks of the design:
- Every number on the card should be recomputable from the chain.
- It should be published where trades happen (an API, and an image for X posts), not only on Top-pad's coin page.

### Creator record: supported, with an identity problem to solve

Evidence:
- Serial deployers dominate creation: from mid-November 2025 to early July 2026, about 1 in 200 creator wallets made more than 100 coins and accounted for 48% of pump.fun launches, while 3 in 4 creator wallets made a single coin ([Bitquery](https://bitquery.io/investigations/solana-launchpad-year)).
- Scams use fresh wallets: 86% of the 451,402 curve-skip PumpSwap pools, 99% of which were later emptied (almost always by the dev), were opened by a wallet that opened no other (same source).
- Honest serial creators want their record to count: one cites 98 graduations from about 3,000 real coins (3.27%) against a market rate he puts at 0.31% and asks traders to "support devs who bring content and have a decent migration ratio" (self-reported, [X](https://x.com/cooldevisback/status/2063810088305836190)).
- Terminals already list a dev wallet's past coins (`created-tokens` in the [gmgn-cli README](https://cdn.jsdelivr.net/npm/gmgn-cli@1.3.7/Readme.md)).

What it asks of the design:
- A record per wallet resets for free, so it must bind to an identity that is costly to abandon, such as an X account (uselaunch.fun allows one coin per X account; Bags pays fees to verified X handles).
- It must reward a good record, or honest creators will keep launching from alt accounts as the creator above says good devs do now.

### Launch calendar: weakly supported, and only with Fair Open and a sealed identity

Evidence:
- The trench norm is the stealth or random-time launch, because an announced time gets sniped: "To reduce bots, will be launching at random time" ([X](https://x.com/fluffycrypt/status/2073049577263894619)).
- Insiders get the contract and the time first: "before launch, memecoin creators tell their friends, favorite influencers the coin they are about to deploy" (r/solana, 107 upvotes, [Reddit](https://www.reddit.com/r/solana/comments/1cmj0fv/the_dirty_lie_about_memecoins_what_everyone/)).
- pump.fun's co-founder sold stealth launches as a feature: "the early buyers are those who turned notifs on your posts I.e. your biggest fans get rich" ([X, March 2024](https://x.com/a1lon9/status/1774152655436226727)).
- Scheduled deposit raises do draw crowds when anticipated (MetaDAO, Virtuals Genesis and the PUMP sale, below), and Jupiter's AlphaScan already has a "Soon" feed next to New and Bonded (Jupiter + Meteora knowledge base, `ecosystem-and-apps.md` section 1.3).
- A new product commits a hash in public and reveals the name only at the countdown, so "snipers have nothing to read until the reveal" ([X](https://x.com/veillaunch/status/2112848154890740125)); its traction is **unverified**.

What it asks of the design:
- A calendar only makes sense because Fair Open removes the first-block race.
- It should publish the time, the creator and the terms but keep the name, ticker and image sealed until the Open, or it becomes a schedule for vamps.

## Is a deposit window welcome or a turn-off?

### Evidence that it can be welcome

- Fairness is what traders say they want: "No pre sale, No big wallet buy, No pump & dump, No snipers" is a stock pitch repeated across many 2026 posts ([X](https://x.com/saracrypto_eth/status/2075782744118837325)).
- Refundable deposit windows draw huge commitments for anticipated launches: Umbra's MetaDAO raise drew commitments of about 200 times its $750,000 minimum and more than 50 times its hard cap, and then traded 5 times above its sale price ([The Defiant](https://thedefiant.io/news/tokens/umbra-trades-5x-above-ico-price-after-oversubscribed-raise)).
- pump.fun's own PUMP sale raised about $500M in about 12 minutes at $0.004 on 12 July 2025 ([Cointelegraph](https://cointelegraph.com/news/pump-fun-ico-raises-500m-sells-out-minutes)); PUMP traded near $0.0042 in late October 2026 ([KuCoin](https://www.kucoin.com/news/insight/PUMP/6ade5b4db1e8a7000773437e)).
- Some traders ask for a short wait: one asked pump.fun to restore 30-second to 1.5-minute migration timers, because a pause lets buyers see if "the dev has 30% supply", makes graduation an event again, and cuts fakes that rely on "everything happens so quickly" ([X, October 2025](https://x.com/iconXBT/status/1983950605585457381)).
- A Reddit guide to a truly fair launch lists publishing the contract "well in advance of trading" so buyers can review the supply and the dev wallet ([Reddit](https://www.reddit.com/r/CryptoCurrency/comments/1hc7egm/is_a_truly_fair_launch_actually_possible/)).

### Evidence that it can be a turn-off

- This audience's founding belief is anti-presale: in March 2024 pump.fun's co-founder wrote "every pre sale is a scam", "every pump dot fun launch is a green flag", and that with pump.fun the "market decides valuation" for a "better looking chart" ([X](https://x.com/a1lon9/status/1774152655436226727)).
- That followed the March 2024 presale wave, in which 33 presales tracked by ZachXBT raised about 796,000 SOL (about $139M) and at least four ended as rugs or scams ([Fortune](https://dc.fortune.com/crypto/2024/03/20/solana-memecoins-ethereum-presale-dex-crypto/), [Cointelegraph](https://cointelegraph.com/magazine/5-risks-apeing-new-solana-memecoins/)).
- Speed is the culture: half of pump.fun coins have their last trade within about 3 minutes of their first and 35% within a minute ([Bitquery](https://bitquery.io/investigations/solana-launchpad-year)).
- Windows get farmed: the WET public sale on Jupiter DTF in December 2025 sold out within seconds, and at least 1,100 of 1,530 participating wallets were new, funded from a few wallets in a tight time window, and had each received 1,000 USDC before the sale ([Cointelegraph](https://cointelegraph.com/news/solana-wet-presale-bot-sybil-attack-humidifi)).
  Secondary coverage gives the sale as fixed-price with a $1,000 cap per wallet (**unverified**; the relay page is gone).
- Pro-rata windows invite over-commitment: with commitments more than 50 times Umbra's cap, most deposits were refunded, and pro-rata allocation rewards depositing more than you want; coverage claims about 98% was refunded and that commits were inflated to game the allocation (**unverified** here).
- Meteora's Alpha Vault ignores the per-wallet cap in permissionless pro-rata mode and needs at least 1,200 seconds of deposit time in FCFS mode (Jupiter + Meteora knowledge base, `meteora/01-products-and-protocol.md` sections 6.2 to 6.4).
- Fairness alone did not keep users: Virtuals replaced its Genesis pledge window with Unicorn, saying Genesis "succeeded to a certain extent, but fairness alone is not enough" ([MEXC relay of the announcement](https://www.mexc.com/news/125247)).
- Flaunch's 30-minute fixed-price fair launch on Base, during which buyers cannot sell ([Bankless](https://www.bankless.com/read/how-to-launch-better-memecoins-on-flaunch.md), [Flaunch SDK](https://unpkg.com/@flaunch/sdk@0.8.1/README.md)), has earned about $3.1M of revenue all time and about $10K in the last 30 days (DefiLlama).
- A window shows a coin before it trades, which is when vamps strike; the KIMCHI copy took $23.9M of volume in its first hour.
- One price for everyone removes the first-block winner whose screenshot sells the coin ("PnL screenshots are the best form of marketing", [X](https://x.com/a1lon9/status/1774152655436226727)).

### What this means for Fair Open

- The evidence supports a Fair Open that feels like a countdown, not a presale:
  - short enough to keep the moment, in minutes rather than hours (the nearest evidence is a trader's ask for 30 to 90 second timers and Alpha Vault's 20-minute FCFS floor);
  - deposits held on-chain, refundable, and never reachable by the creator, so it cannot be read as a presale;
  - one opening price for everyone, with the chart visibly starting at that price so it can still go up;
  - per-wallet caps enforced by our own program and depositors scored by Bundle Radar, because a first-come window was farmed (WET) and pro-rata allocation rewards over-depositing;
  - the coin's name, ticker and image reserved or sealed during the window, so a vamp cannot open first elsewhere.
- No evidence shows memecoin traders choosing a launchpad because it has a deposit window; this is a design bet that the devnet proof or a small test cohort should check before the spec commits to it.

## Evidence

### 1. Market share: what moved it and what held

Method: DefiLlama's daily fee and revenue series for each Solana launchpad (`https://api.llama.fi/summary/fees/<slug>?dataType=dailyFees`, pulled 2026-10-26).
Fees depend on each platform's fee rate and on DefiLlama's method for it; pump.fun's series covers its bonding curve, graduation and app fees, not PumpSwap trading.
So the series compare a platform with itself over time better than platforms with each other.

| Launchpad | Peak fee day | Daily fees, week around the peak | Daily fees, last 30 days | Share of peak kept |
|---|---|---|---|---|
| Believe (Launch Coin) | 2025-05-13 | $2.56M | $0 | 0% |
| boop.fun | 2025-05-06 | $282K | $0 | 0% |
| letsbonk.fun (BONK.fun) | 2025-07-22 | $1.66M | $128K | 7.7% |
| Jupiter Studio | 2025-07-11 | $133K | $300 | 0.2% |
| Heaven | 2025-08-20 | $426K | $0 | 0% |
| Moonshot Create | 2025-06-28 | $244K | $800 | 0.3% |
| Bags | 2026-01-16 | $1.43M | $10K | 0.7% |
| rise.rich | 2026-04-22 | $226K | $1.3K | 0.6% |
| StonkFun | 2026-09-11 | $1.39M | $388K | 28% |
| pump.fun | 2025-01-24 | $6.14M | $2.13M | 35% |

pump.fun's share of the fees of the 12 Solana launchpads tracked here, by month:
- 100% through March 2025, before any rival was tracked.
- 59.6% in May 2025, when Believe took 30.3%.
- 30.7% in July 2025, when letsbonk took 56.3%.
- 50.9% in August 2025, when Bags took 30.3% (the cause of Bags's August 2025 spike was not established here).
- 82.6% in September 2025 and 91.9% in November 2025.
- 60.3% in January 2026, when Bags took 28.9%.
- 95.5% in July 2026.
- 50.8% in September 2026, when StonkFun took 35.5%.
- 82.5% in October 2026 to date.

The events behind the shifts:
- **Moonshot, January 2025:** it was the featured way to buy the TRUMP coin, claimed nearly $400M of volume and 200K new users (self-reported), and became the top US finance app ([The Block](https://www.theblock.co/post/335580/trump-memecoin-launch-propels-moonshot-into-top-10-on-us-apple-app-store)); its app fees went from $2.2M in December 2024 to $34.5M in January 2025, then $8.0M in February and under $1M a month from October 2025 (DefiLlama `moonshot.money`).
- **Believe, May 2025:** anyone launched a coin by tagging an X account, without a wallet, on a bonding curve that graduated to Meteora ([QuickNode](https://www.quicknode.com/builders-guide/tools/believe-app-by-believe)), with a 50/50 fee split for creators ([NiftyNoon](https://niftynoon.substack.com/p/niftynoon-believe-in-something-does)).
  Its revenue fell 94% from the May peak ([The Defiant](https://thedefiant.io/news/defi/launchcoin-tumbles-as-believe-app-s-revenue-falls-94-from-may-peak)), it later moved some creator payouts to PayPal ([The Defiant](https://thedefiant.io/news/defi/believe-launchpad-pauses-some-on-chain-payouts-asks-creators-to-switch-to-paypal)), and it faces a class action alleging a pattern of "generate excitement, bring consumers in, collect fees, and let the token collapse" ([The Block](https://www.theblock.co/post/398532/believe-founder-arrested-strangulation)).
- **letsbonk, July 2025:** on 5 and 6 July it passed pump.fun on 24-hour launches (about 15,600 against 11,500) and graduations (135 against 103), while pump.fun still had more than twice as many active traders ([The Block](https://theblock.co/post/361189/letsbonk-dethrones-pump-fun-with-higher-daily-memecoin-volume-token-launches)).
  Its draw was half of fee revenue buying and burning BONK, the BONK community and a $264M runner, Useless Coin (same source); The Block also names airdrop speculation as "a large driver of volume" ([The Block](https://www.theblock.co/post/366395/pump-fun-fends-off-letsbonk-in-battle-for-top-solana-memecoin-launchpad)).
- **pump.fun's recovery, August and September 2025:** pump.fun's revenue recovered to $35M in August (68.2% share) after letsbonk's $37.4M against pump.fun's $15.4M in July ([Blockworks](https://blockworks.com/news/pumpdotfun-fee-model)), helped by PUMP buybacks ([CoinGecko](https://www.coingecko.com/learn/memecoin-launchpad-wars-pumpfun-stonkfun-ponsfamily)).
  Project Ascend on 2 September 2025 raised creator fees for small coins (0.95% falling to 0.05% as market cap grows) and paid creators $2M in its first 24 hours ([Decrypt](https://decrypt.co/337872/pump-funs-new-fee-model-hands-out-2m-to-creators-in-first-24-hours)).
- **Heaven, August 2025:** about $350M of volume in its first week, with all revenue buying back its LIGHT token ([The Block](https://theblock.co/post/368036/newcomer-launchpad-heaven-nears-350-million-in-volume-as-team-pledges-one-year-token-lockup)); its tracked fees are now zero (DefiLlama).
- **Bags, January 2026:** an anonymous user launched GAS on Bags naming Steve Yegge's X account as the fee earner; "The person behind that Twitter account doesn't have to agree, or even know" ([Sean Goedecke, 17 January 2026](https://seangoedecke.com/gas-and-ralph/)).
  Yegge's fees reached about $238K (same source), Bags's daily fees went from about $640 in December to more than $2M on 16 January ([Forklog](https://forklog.com/en/bags-platform-challenges-pump-fun-amid-ai-token-hype/)), and GAS fell 98% after Yegge distanced himself ([Whale Alert](https://whale-alert.io/stories/d27c01673ae5/Gas-Town-GAS-tumbles-98-to-11M-after-creator-Steve-Yegge-distances-himself-other-Bags-launchpad-tokens-also-plunge)).
- **StonkFun, September 2026:** pairing coins with any asset, mostly stock tokens, it out-earned pump.fun for a day on 6 September with $1.5M ([CoinGecko](https://www.coingecko.com/learn/memecoin-launchpad-wars-pumpfun-stonkfun-ponsfamily)).
  pump.fun added custom pairs including stock tokens on 9 September and holder rewards on 12 September (reference digest), and StonkFun's daily fees fell from about $1.4M in mid-September to between $65K and $273K in the last days of October (DefiLlama).
- **#BOYCOTTPUMPFUN, October 2026:** pump.fun signed the trader Kimchi as a partner on 20 October; a "Project Kimchi" coin promoted by a QR code that co-founder Alon reposted ran to about $14M and then fell more than 95%, and the hashtag grew from 9 posts on 20 October to 1,067 on 24 October ([KuCoin](https://www.kucoin.com/news/insight/PUMP/6ade5b4db1e8a7000773437e)).
  The boycott followed a new 0.45% fee on app and web trades from 17 October ([pump.fun fees](https://pump.fun/docs/fees)) and was fed by a $2.5M squad P&L competition announced on 23 October ([pump.fun on X](https://x.com/Pumpfun/status/2113647400057237848)).
  pump.fun's daily fees averaged $1.85M from 20 to 25 October against $1.99M the week before, and $1.49M over the weekend of 24 and 25 October against $1.82M the weekend before (DefiLlama).
  A boycott post itself asks "what's the point if everyone goes straight back to the same platform tomorrow?" ([X](https://x.com/En_Solana/status/2113944403467239766)).

Jupiter's launchpad board, 1 day, captured 2026-10-26 ([jup.ag/spot/launchpads](https://jup.ag/spot/launchpads)):

| # | Launchpad | Share | 1d volume | 1d traders | 1d mints | 1d bonded |
|---|---|---|---|---|---|---|
| 1 | Pump | 86.7% | $422M | 733K | 34,017 | 964 (2.83%) |
| 2 | StonkFun | 8.56% | $41.7M | 69.2K | 1,742 | 20 (1.15%) |
| 3 | Meteora (DBC) | 2.08% | $10.1M | 21K | 534 | 19 (3.56%) |
| 4 | LetsbonkFun | 0.861% | $4.19M | 9.36K | 52 | 2 (3.85%) |
| 5 | MetaDAO | 0.124% | $604K | 534 | 0 | 0 |
| 6 | BAGS | 0.0581% | $282K | 1.25K | 38 | 0 |
| 9 | Jup Studio | 0.0363% | $176K | 1.71K | 6 | 0 |
| 13 | Believe | 0.00557% | $27.1K | 155 | 0 | 0 |
| 15 | Moonshot | 0.00290% | $14.1K | 288 | 15 | 0 |

### 2. Retention and survival

- No public cohort retention data for launchpad users was found; monthly active wallets and token survival are the nearest measures.
- CoinGecko's Dune-based series of pump.fun and PumpSwap traders ([CoinGecko](https://www.coingecko.com/research/publications/pump-fun-traders-are-making-a-comeback), realized P&L only, no bot filter):
  - monthly active wallets: 3.87M in January 2025, 5.26M in May 2025, 1.68M in November 2025, 3.35M in March 2026, 3.14M in April 2026;
  - share of wallets in profit: 30.1% in June 2025, 44.8% in November 2025, 73.3% in April 2026.
- CoinGecko reads this as losing traders leaving and a smaller, more selective base returning; that is its interpretation, not a cohort measurement.
- Bitquery's survival table for coins whose first trade fell between 1 November 2025 and 7 October 2026 ([Bitquery](https://bitquery.io/investigations/solana-launchpad-year)):

| Where the coin started | Coins | Traded on launch day only | Any trade in week 1 | Any trade in week 5 |
|---|---|---|---|---|
| pump.fun | 8,984,141 | 79% | 16.4% | 1.5% |
| Meteora DBC | 1,120,239 | 51% | 47.7% | 1.9% |
| Raydium LaunchLab | 425,887 | 84% | 18.9% | 1.3% |

- 1 in 58 pump.fun coins graduated, and 43% of graduates still traded in week 5 against 1% of the rest (same source).
- About 75% of Meteora DBC coins graduated, 35% on a single trade, and DBC's early survival edge was gone by week 5 (same source).
- pump.fun made 78% of all new Solana tokens in the period, and Meteora's launchpad share of new tokens fell from 23% in November 2025 to 5% in March 2026 (same source).

### 3. What traders want and fear

**FOMO and the lottery ticket:**
- In Kraken's January 2025 survey of 798 US crypto holders, dramatic volatility (linked to FOMO) was the top reason for first interest in memecoins, then recommendations from friends or family, then their fun nature; 29% invest for short-term returns and 23% for entertainment ([Kraken](https://www.kraken.com/en-gb/learn/memecoin-survey)).
- Kraken sells memecoins, so the survey has a commercial interest.
- Speed tools are where the money goes: GMGN, Axiom and fomo together earned about $42M in the last 30 days (DefiLlama).
- Caller accounts sell the dream in these terms: "$250 turned into $10,000,000" ([X](https://x.com/KytroCrypto/status/2114428025953456410)).

**Fear of being exit liquidity:**
- Solidus Labs' 2025 rug-pull report flagged about 98.6% of pump.fun tokens as pump-and-dumps or rug pulls (as reported by [BeInCrypto](https://beincrypto.com/pump-fun-tokens-scams-solidus-labs-report/); the report itself was not read here).
- A Dune analysis reported in early 2025 found about 55,000 of 13.5M pump.fun wallets (0.4%) had realized more than $10,000 of profit ([Decrypt](https://decrypt.co/300403/pump-fun-traders-millionaires)).
- The boycott's vocabulary is "insider advantages, questionable promotions, manufactured hype, and ordinary traders constantly ending up as exit liquidity" ([X](https://x.com/En_Solana/status/2113944403467239766)).
- The fear changes behaviour: "Everyone is so conditioned to sell the first pump because they've watched every promising chart being bundled, vamped or dumped into oblivion the second they bought" ([X](https://x.com/0xBNZ/status/2113766993744597123)).
- Some see the game as rigged for tool users: "a wealth transfer from new participants to those who have the right tools" ([X](https://x.com/0xkioto/status/2107536759647015416)).
- A class action reportedly cites about 5,000 internal pump.fun messages as showing slot-machine-style design (**unverified**, relayed by [crypto_banter via X](https://x.com/neildevvv/status/2114676153503907923)).

**Vamps and PvP:** see Vamp Shield above.

**Status and sharing gains:**
- pump.fun's co-founder: "PnL screenshots are the best form of marketing" ([X](https://x.com/a1lon9/status/1774152655436226727)).
- pump.fun's biggest competition so far pays $2.5M to the three squads with the highest P&L over two weeks ([X](https://x.com/Pumpfun/status/2113647400057237848)); it ranks realized plus unrealized P&L, which critics say bundlers can mark up on thin positions ([KuCoin](https://www.kucoin.com/news/insight/PUMP/6ade5b4db1e8a7000773437e)).
- Paid callers and KOLs are part of the status economy, and boycott posts accuse them of being paid to stay quiet ([X](https://x.com/mcdonaldsboy_/status/2114074136423346393)).

**Trust signals:**
- What traders check is listed under Bundle Radar and Creator record.
- "No presale" and "no snipers" are themselves trust badges in coin marketing (see the deposit-window section).
- Identity matters: Bags pays fees to verified X handles, and an honest creator tells buyers to check whether the top holders are labelled wallets ([X](https://x.com/cooldevisback/status/2063810088305836190)).

### 4. What creators want and fear

- **Income:** pump.fun has paid a creator fee on every coin since 13 May 2025 and charges no platform fee to create a coin ([pump.fun fees](https://pump.fun/docs/fees)); Project Ascend paid creators $2M in its first day ([Decrypt](https://decrypt.co/337872/pump-funs-new-fee-model-hands-out-2m-to-creators-in-first-24-hours)); one creator says he made "over 6 figs just on fees" ([X](https://x.com/CryptoRilsio/status/2054512964019867901)).
- **Cashback backfired:** pump.fun's cashback mode, which sent the creator fee back to buyers, is "no longer available for new launches" ([pump.fun fees](https://pump.fun/docs/fees)), after creators complained it removed the reason to keep promoting a coin ([X](https://x.com/CryptoRilsio/status/2054512964019867901)).
- **Fear of vamps and snipers:** "A lot of people copy my launches. A lot of people snipe my launches." ([X](https://x.com/cooldevisback/status/2063810088305836190)).
- **Bundling as defense:** bundle tools sell same-block self-buys as a way "to eliminate snipers" ([LaunchR](https://x.com/LaunchR_/status/1816516137514938607)); even a self-described honest creator says he runs "3 block 0 snipers on each launch holding around 7%" (same post as above).
- **Fear of false accusation:** see Bundle Radar.
- **Consent:** on Bags a third party can name anyone's X account as fee earner without consent, which one developer calls "largely predatory" ([Sean Goedecke](https://seangoedecke.com/gas-and-ralph/)).
- **Easy launch:** Believe let creators launch by tagging an X account with no wallet ([QuickNode](https://www.quicknode.com/builders-guide/tools/believe-app-by-believe)).

### 5. Fair-launch and anti-bot launchpads: what worked and what failed

- **pump.fun, 2024 (worked):** it beat presales by letting the market set the price from a low start at no cost to the creator ([X](https://x.com/a1lon9/status/1774152655436226727)); its fees grew from $2.4M in March 2024 to $93.9M in November 2024 (DefiLlama).
- **Meteora Alpha Vault (worked for anticipated launches):** depositors share one buy price before the pool opens; the JUP launch pool is Meteora's showcase at $164M TVL and $300M volume (Jupiter + Meteora knowledge base, `ecosystem-and-apps.md` section 2.7); no memecoin outcome data was found.
- **Virtuals Genesis (worked, then replaced):** a points-weighted 24-hour pledge window selling 37.5% of each agent token's supply, capped at 0.5% of supply per user ([Alea Research, June 2025](https://alearesearch.substack.com/p/virtual-genesis-virtuals-agent-launchpad)), replaced by Unicorn because "fairness alone is not enough" ([MEXC relay](https://www.mexc.com/news/125247)).
- **MetaDAO (works for funded projects):** raises are many times oversubscribed, such as Umbra above and Rip Cars at 127 times ([Solana Compass](https://solanacompass.com/news/metadaos-rip-cars-ico-closes-127x-oversubscribed-with-319m-in-commitments)); these are funded projects, not trench coins.
- **Jupiter DTF and WET (gamed):** the public window lost to a sybil farm, and HumidiFi cancelled the allocations and reissued the token ([Cointelegraph](https://cointelegraph.com/news/solana-wet-presale-bot-sybil-attack-humidifi)).
- **Jupiter Studio (small):** anti-sniping on by default in Meme mode, a 99% fee on buys decaying to 0% over a random 15 to 60 seconds, and Jupiter's distribution (Jupiter + Meteora knowledge base, `jupiter/01-products-user-docs.md` section 14.1); 0.036% of launchpad volume today.
- **Flaunch (small):** 30-minute fixed-price fair launch; see the deposit-window section.
- **Heaven and boop.fun (faded):** buyback or staking flywheels on a platform token, now at zero tracked fees (DefiLlama).
- **uselaunch.fun's LAUNCH (too new to judge):** no creator wallet, a 60-minute duplicate-ticker lock and creator fees recycled into burns, announced on X on 25 October 2026 in the middle of the boycott ([X](https://x.com/_LaunchX/status/2114318562424766849)); the early critique above is **unverified**.
- **Announced, outcomes unverified:** a "one coin per narrative" launchpad ([X](https://x.com/pvewin/status/2077804355668099281)), Pump Eco's 24-hour ticker lock ([X](https://x.com/pump_eco/status/2114435905435959703)), MET Pad on Meteora with a 50% buy tax for the first 10 seconds ([X](https://x.com/MetPadSol/status/2114692770673610927)), and a sealed-hash countdown launch ([X](https://x.com/veillaunch/status/2112848154890740125)).
- **The pattern:** what grew combined a fair-looking mechanism with liquidity, attention or a token incentive; mechanisms that offered fairness alone stayed small, and windows without strong anti-sybil rules were farmed.

## Gaps

- Telegram was not read: the active groups are private and need a user-account login, the same gap the Stoker research hit.
- Reddit posts were pulled through Bright Data, which returns post bodies but not comments; one quoted reply comes from a search snippet.
- X posts are engagement-ranked, so they show which views resonate, not how widespread they are.
- No cohort retention data for launchpad users was found.
- The cause of Bags's August 2025 fee spike was not established.
- A July 2026 arXiv paper on coordinated sniper cohorts ([arXiv:2607.02795](https://arxiv.org/abs/2607.02795)) would answer whether early coordinated buying pulls in later buyers, but its author has withdrawn all numerical results pending a corrected analysis, so none are used here.
- DefiLlama's methods differ per platform and change over time, so cross-platform shares are approximate.

## Sources

Data pulled on 2026-10-26:
- DefiLlama fees overview and per-protocol series: https://api.llama.fi/overview/fees?dataType=dailyRevenue and https://api.llama.fi/summary/fees/{slug}?dataType=dailyFees for pump.fun, bonk.fun-launchpad, graphite-protocol, launch-coin-on-believe, bags, moonshot-create, moonshot.money, jupiter-studio, stonkfun, boop.fun, heaven, rise.rich, trends-legacy, launchlab and meteora-dynamic-bonding-curve.
- Jupiter launchpad board: https://jup.ag/spot/launchpads
- pump.fun fee docs: https://pump.fun/docs/fees
- GMGN agent tooling: https://cdn.jsdelivr.net/npm/gmgn-cli@1.3.7/Readme.md
- X posts via twitterapi.io advanced search, and Reddit posts via the Bright Data `reddit_posts` pipeline; every post used is linked inline.

Studies and analyses:
- Bitquery, Solana launchpad year: https://bitquery.io/investigations/solana-launchpad-year
- Bitquery, KIMCHI: https://bitquery.io/investigations/kimchi-pumpfun-launch-snipers
- CoinGecko, pump.fun traders: https://www.coingecko.com/research/publications/pump-fun-traders-are-making-a-comeback
- CoinGecko, launchpad wars: https://www.coingecko.com/learn/memecoin-launchpad-wars-pumpfun-stonkfun-ponsfamily
- Kraken memecoin survey: https://www.kraken.com/en-gb/learn/memecoin-survey

The owner's knowledge bases and project research (read-only):
- Jupiter + Meteora knowledge base: `ecosystem-and-apps.md` (sections 1.3, 2.7), `jupiter/01-products-user-docs.md` (section 14.1), `meteora/01-products-and-protocol.md` (section 6).
- Stoker research: `stonk-fun-solana/research/README.md` and `research/competitors/README.md`.
- Top-pad reference digest: https://github.com/imDev2023/top-pad/blob/research/reference-launchpads/research/reference-launchpads.md

News coverage is linked inline where each claim is made.
