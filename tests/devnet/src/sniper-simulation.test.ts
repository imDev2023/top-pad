// The sniper simulation (spec 11.1, #60), repeatable: a bot buys a coin in its creation slot and again 1, 5, 30 and 60 s
// after the creation goes out, on a Fair Open and on an Instant launch, launching again until at least 5 of its
// transactions have landed in the creation slot in each mode. The bot is the strongest a sniper can be: it knows the
// coin's mint before the coin exists (this run sends the creation itself, Heat's bank the creator and our keeper the
// launch key and the Fair Open's fee payer, as the launch service and the keeper's Workflow build them), signs its buys
// in advance and sends them again and again, a lamport apart, from the moment the creation goes out (bundle.ts's spray).
//
// It passes when every creation-slot buy paid the sniper tax's 99% cliff; every later buy paid the linear schedule, at
// the second the chain's clock says it ran, to within one 1-second step; the Fair Open's pot paid the 1.25% ending fee;
// and every fee the coin's first minute took reached the Fair Open's Tax Share or, for the Instant launch, Heat's
// treasury: the window claim (the Fair Open program's `collect_tax_share`, or the fee program's `claim_window_fees`,
// whoever sends it first, this run or the deployed keeper) paid out exactly the partner's part of every swap before it,
// the pot's own fee aside, which stays in the pool for the 50/50 split, and the creator's part of every fee is nothing.
//
// Real devnet SOL: about 0.1 a run (the pools' and records' rent, the 99% the bot's creation-slot buys pay, 1.25% each
// way on the pot's coins, which its depositors sell back after the Tax window), staggered to stay inside the public
// endpoint's limits; about 3 minutes for the Instant launch and 4 for the Fair Open. The spray spends the public
// endpoint's budget, so the bot's later buys go through the shared Helius devnet key (run it with `direnv exec`): sent to
// the public endpoint in the seconds after the spray, they were refused (429) or silently dropped. Its bot derives from
// the bank's key and the run's name, which it logs. It signs with the keeper and admission keys, which only this Mac
// holds (~/.config/top-pad/devnet); without them it is skipped.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Base64EncodedWireTransaction,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import {
  allocate,
  claimablePool,
  dbcPoolAddress,
  FEE_DENOMINATOR,
  instantLaunchAccounts,
  instantLaunchInstructions,
  quoteAccount,
  rungAtOrBelow,
  SOL_QUOTE,
  sniperTaxNumerator,
  swapInstructions,
  Tier,
  TOKEN_PROGRAM_ADDRESS,
  windowClaimInstructions,
} from "@top-pad/chain";
import { fetchLaunch, fetchMaybeLaunch, LaunchStatus } from "@top-pad/clients/fair-open";
import { fetchVirtualPool } from "@top-pad/clients/dbc";
import { fetchCoinRecord, findCoinRecordPda } from "@top-pad/clients/fee";
import { decodeTransaction, type TaxShareCollection, type WindowClaimed } from "@top-pad/indexer";
import { describe, expect, it } from "vitest";
import { landings, sellAndClose, signedBundle, spray, wrapSol, type BundleCopy } from "./bundle";
import { bank, chainTime, devnet, fund, landed, rpc, send, sweep } from "./devnet";
import { admitted, closeNonce, deposit, depositorsOf, keeper, newPerson, pushAll, recoverDeposits, scheduleFairOpen, seatsOf, sellAll, settleOpened, signedLadder, type ScheduledFairOpen } from "./fairOpen";
import { HEAT_CONFIGS, json, newRun, partnerShare, percent, poolSwaps, simulationWallet, sniperTaxVerdict, splitAt, untilChainTime, type PoolSwap } from "./simulation";

const keys = ["keeper.json", "admission.json", "bank.json"].every((name) => existsSync(join(homedir(), ".config/top-pad/devnet", name)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SOL = 1_000_000_000n;
const STEP = 10_000_000n;
const [INSTANT, FAIR_OPEN] = [devnet.configs!.instant, devnet.configs!.fairOpen];
/** The fee program's `WindowAlreadyClaimed`: the deployed keeper's claim landed first. */
const WINDOW_ALREADY_CLAIMED = 6010;
/** The sniper tax's end, 1.25%: what the pool's first swap pays on a config with the first-swap discount (spec 2.1 step 10). */
const ENDING = sniperTaxNumerator(60);

/** Transactions the bot wants in the creation slot, per launch mode, and the launches it may take to get them. */
const IN_SLOT_WANTED = 5;
const MAX_LAUNCHES = 3;
/** The bot's creation-slot buy, each copy a lamport more, and how its copies go out: rounds of 5, 60 ms apart. */
const SLOT_BUY = 200_000n;
const COPIES = 30;
const PER_ROUND = 5;
const ROUND_MS = 60;
/** The bot's later buys: how long after the creation goes out, by this Mac's clock, and what each spends. */
const LATER_SECONDS = [1, 5, 30, 60];
const LATER_BUY = 1_000_000n;
/** What the bot is given for a launch: its wrapped copies, its later buys, accounts' rent and fees. */
const BOT_FUNDS = SLOT_BUY * BigInt(COPIES) + LATER_BUY * BigInt(LATER_SECONDS.length) + SOL / 50n;
/** How far ahead of now a Fair Open's window closes: time to deposit and sign the ladder. */
const OPENS_IN = 120n;
/** The Fair Open's depositors: two Scored seats, so the pot can open without an Unverified one. */
const ASKS: [Tier, bigint][] = [
  [Tier.Scored, 30n],
  [Tier.Scored, 20n],
];

/** One launch the bot sniped, read back from the chain. */
type Sniped = {
  mode: "fair_open" | "instant";
  mint: Address;
  pool: Address;
  activation: bigint;
  creationSlot: bigint;
  /** The bot's buys that landed: in the creation slot, and after it. */
  inSlot: PoolSwap[];
  later: PoolSwap[];
  /** Every swap the pool ran before its window claim, anyone's, the pot's included. */
  beforeClaim: PoolSwap[];
  /** The Fair Open's pot buy, and the rung it spent. */
  pot: { swap: PoolSwap; rung: bigint; potFee: bigint } | null;
  /** The window claim: the Instant launch's claim, or the Fair Open's Tax Share collection. */
  claim: { signature: string; instant: WindowClaimed | null; taxShare: TaxShareCollection | null };
  /** What the pool held for the partner and the creator right after the claim. */
  after: { partnerQuoteFee: bigint; creatorQuoteFee: bigint };
};

const signatureOfWire = (wire: string) => getBase58Decoder().decode(getBase64Encoder().encode(wire).slice(1, 65)) as Signature;

/** The bot's copies in rounds, as `spray` sends them. */
function rounds(copies: BundleCopy[]) {
  const out: BundleCopy[][] = [];
  for (let i = 0; i < copies.length; i += PER_ROUND) out.push(copies.slice(i, i + PER_ROUND));
  return out;
}

/**
 * Sends a signed transaction after the endpoint's preflight at `processed`, so whatever is sent next goes out after it:
 * a creation that fails its preflight is never sent, and neither is a rung, whose failure would void its ladder.
 */
async function sendFirst(wire: string): Promise<Signature> {
  await rpc.sendTransaction(wire as Base64EncodedWireTransaction, { encoding: "base64", preflightCommitment: "processed" }).send();
  return signatureOfWire(wire);
}

/**
 * The endpoint the bot's later buys go through: the shared Helius devnet key's (free tier) when there is one, since the
 * spray spends the public endpoint's per-address budget and a buy sent there in the next seconds is refused (429) or
 * dropped; otherwise the public endpoint.
 */
const laterRpc = process.env.HELIUS_API_KEY ? createSolanaRpc(`https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`) : rpc;

/** A buy of the bot's, built, signed and sent at once through `laterRpc` after its preflight; its signature once confirmed. */
async function laterBuy(bot: KeyPairSigner, mint: Address, config: Address, amountIn: bigint): Promise<Signature> {
  const pool = await dbcPoolAddress(config, mint, devnet.quote.mint);
  const buy = await swapInstructions({ config, pool, mint, quoteMint: SOL_QUOTE.mint, quoteTokenProgram: SOL_QUOTE.tokenProgram, trader: bot, side: "buy", amountIn, minimumOut: 1n });
  const { value: lifetime } = await laterRpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const transaction = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(bot, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => appendTransactionMessageInstructions(buy, m),
    ),
  );
  const signature = getSignatureFromTransaction(transaction);
  await laterRpc.sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: "base64", preflightCommitment: "processed" }).send();
  for (let poll = 0; poll < 60; poll++) {
    await sleep(1_000);
    const { value: [status] } = await laterRpc.getSignatureStatuses([signature]).send();
    if (status?.err) throw new Error(`the bot's buy ${signature} failed: ${json(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;
  }
  throw new Error(`the bot's buy ${signature} did not confirm`);
}

/** The creation goes out, then the bot's copies, then its later buys, each `LATER_SECONDS` after the creation went out. */
async function snipe(bot: KeyPairSigner, mint: Address, config: Address, creationWire: string, copies: BundleCopy[]) {
  const t0 = Date.now();
  const creation = await sendFirst(creationWire);
  await spray(rounds(copies), ROUND_MS);
  const later: Promise<Signature>[] = [];
  for (const [i, seconds] of LATER_SECONDS.entries()) {
    await sleep(Math.max(t0 + seconds * 1_000 - Date.now(), 0));
    later.push(laterBuy(bot, mint, config, LATER_BUY + BigInt(i)));
  }
  const landed = await landings([creation]);
  const created = landed.get(creation);
  if (!created || created.err) throw new Error(`the creation ${creation} did not land: ${json(created?.err)}`);
  await Promise.all(later);
  return { creation, creationSlot: created.slot };
}

/** The bot's buys that landed, the creation slot's and later ones, from the pool's own history. */
function botBuys(swaps: PoolSwap[], bot: Address, creationSlot: bigint) {
  const mine = swaps.filter((s) => s.trader === bot && s.side === "buy");
  return { inSlot: mine.filter((s) => s.slot === creationSlot), later: mine.filter((s) => s.slot > creationSlot) };
}

/** The window claim among a coin record's transactions, newest first. */
async function windowClaimOf(coinRecord: Address, mint: Address): Promise<{ signature: string; slot: bigint; claim: WindowClaimed }> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const history = await rpc.getSignaturesForAddress(coinRecord, { limit: 20, commitment: "confirmed" }).send();
    for (const { signature, slot, err } of history) {
      if (err) continue;
      const claim = decodeTransaction(await landed(signature), HEAT_CONFIGS).windowClaims.find((w) => w.mint === mint);
      if (claim) return { signature, slot, claim };
    }
    await sleep(3_000);
  }
  throw new Error(`no window claim of ${mint} among ${coinRecord}'s transactions`);
}

/** An Instant launch the bot snipes, Heat's bank its creator and our keeper its launch key, as the launch service builds it. */
async function snipeInstant(bot: KeyPairSigner): Promise<Sniped> {
  const creator = await bank();
  const launchKey = await keeper();
  const mint = await generateKeyPairSigner();
  const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
  const launch = {
    config: INSTANT,
    quoteMint: devnet.quote.mint,
    creator,
    mint,
    launchKey,
    coin: { name: `Sniper sim ${tag}`, ticker: `SNP${tag}`, uri: `https://turbo-gateway.com/heat-sniper-simulation-${tag.toLowerCase()}` },
    computeUnitPrice: 0n,
  };
  const { pool, coinRecord } = await instantLaunchAccounts(launch);
  await wrapSol(bot, SLOT_BUY * BigInt(COPIES) + BigInt(COPIES * COPIES));
  const copies = await signedBundle([[bot]], mint.address, INSTANT, SLOT_BUY, COPIES);
  const instructions = await instantLaunchInstructions(launch);
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const creation = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(creator, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  );
  console.log(`Instant launch ${mint.address} (${launch.coin.ticker}), pool ${pool}`);
  const { creationSlot } = await snipe(bot, mint.address, INSTANT, getBase64EncodedWireTransaction(creation), copies);
  const state = (await fetchVirtualPool(rpc, pool, { commitment: "confirmed" })).data.poolState;

  // The window claim, whoever sends it first: this run, as the window ends, or the deployed keeper, which keeps every
  // Heat coin on devnet. It runs once; the other is refused.
  await untilChainTime(claimablePool(pool, state, SOL_QUOTE).windowEndsAt);
  const current = claimablePool(pool, (await fetchVirtualPool(rpc, pool, { commitment: "confirmed" })).data.poolState, SOL_QUOTE);
  await send(launchKey, await windowClaimInstructions({ pool: current, heat: true, treasury: devnet.keys!.treasury, payer: launchKey, computeUnitPrice: 0n })).catch(
    (e: { cause?: { context?: { code?: number } } }) => {
      if (e.cause?.context?.code !== WINDOW_ALREADY_CLAIMED) throw e;
    },
  );
  const claim = await windowClaimOf(coinRecord, mint.address);
  const after = (await fetchVirtualPool(rpc, pool, { commitment: "confirmed" })).data.poolState;
  const swaps = await poolSwaps(pool);
  const { before, after: since } = await splitAt(swaps, claim.signature, claim.slot);
  return {
    mode: "instant",
    mint: mint.address,
    pool,
    activation: state.activationPoint,
    creationSlot,
    ...botBuys(swaps, bot.address, creationSlot),
    beforeClaim: before,
    pot: null,
    claim: { signature: claim.signature, instant: claim.claim, taxShare: null },
    // What trades since the claim added is not the window's: the pool right after the claim held the rest.
    after: { partnerQuoteFee: after.partnerQuoteFee - since.reduce((n, s) => n + partnerShare(s.fee), 0n), creatorQuoteFee: after.creatorQuoteFee },
  };
}

/**
 * A Fair Open the bot snipes: scheduled by script (Heat's bank its creator), two Scored depositors admitted with the
 * devnet admission key, the creator's ladder signed at scheduling, and at its time the rung the pot covers sent as our
 * keeper sends it, the bot's copies right behind; then the seats pushed and the Tax Share collected, as the keeper's
 * Workflow does.
 */
async function snipeFairOpen(bot: KeyPairSigner, held: { launch: ScheduledFairOpen | null; depositors: KeyPairSigner[] }): Promise<Sniped> {
  const creator = await bank();
  const s = (held.launch = await scheduleFairOpen(creator, (await chainTime()) + OPENS_IN - 600n));
  const wallets = (held.depositors = await depositorsOf(s.launch, ASKS.length));
  await fund(wallets, ASKS.map(([, steps]) => steps * STEP + SOL / 50n));
  for (const [i, [tier, steps]] of ASKS.entries()) await deposit(s.launch, wallets[i]!, steps * STEP, await admitted(s.launch, wallets[i]!.address, newPerson(), tier));
  const { ladder, mint } = await signedLadder(s);
  const before = (await fetchLaunch(rpc, s.launch)).data;
  const rung = rungAtOrBelow(before.potCap, allocate(before.counts, before.unverifiedCounts, before.step, before.potCap).spend)!;
  const signed = ladder.find((r) => r.rung === rung)!;
  const poolAddress = await dbcPoolAddress(FAIR_OPEN, mint.address, devnet.quote.mint);
  console.log(`Fair Open ${s.launch}, coin ${mint.address}, pool ${poolAddress}, rung ${rung}`);

  // The bot's copies are signed close to the open, so their blockhash still lives when they go out.
  await untilChainTime(before.opensAt - 25n);
  await wrapSol(bot, SLOT_BUY * BigInt(COPIES) + BigInt(COPIES * COPIES));
  const copies = await signedBundle([[bot]], mint.address, FAIR_OPEN, SLOT_BUY, COPIES);
  await untilChainTime(before.opensAt);
  const { creation, creationSlot } = await snipe(bot, mint.address, FAIR_OPEN, signed.transaction, copies);
  const opened = (await fetchLaunch(rpc, s.launch)).data;
  expect(opened.status).toBe(LaunchStatus.Opened);
  const state = (await fetchVirtualPool(rpc, poolAddress, { commitment: "confirmed" })).data.poolState;

  // The keeper's work after the open: every seat pushed, then at 60 s the Tax Share collected and paid, the launch closed.
  await pushAll(s.launch, mint.address, (await seatsOf(s.launch)).map((x) => ({ seat: x.address, wallet: x.seat.wallet })));
  const settled = await settleOpened(s.launch);
  if (!settled.collect) throw new Error(`${s.launch}'s Tax Share was not collected`);
  const taxShare = decodeTransaction(await landed(settled.collect), HEAT_CONFIGS).taxShares[0]!;
  const collectSlot = (await rpc.getSignatureStatuses([settled.collect as Signature], { searchTransactionHistory: true }).send()).value[0]!.slot;
  const after = (await fetchVirtualPool(rpc, poolAddress, { commitment: "confirmed" })).data.poolState;
  const swaps = await poolSwaps(poolAddress);
  const split = await splitAt(swaps, settled.collect, collectSlot);
  const potSwap = swaps.find((s) => s.signature === creation)!;
  const record = (await fetchCoinRecord(rpc, (await findCoinRecordPda({ mint: mint.address }))[0], { commitment: "confirmed" })).data;
  return {
    mode: "fair_open",
    mint: mint.address,
    pool: poolAddress,
    activation: state.activationPoint,
    creationSlot,
    ...botBuys(swaps, bot.address, creationSlot),
    beforeClaim: split.before,
    pot: { swap: potSwap, rung, potFee: record.potFee },
    claim: { signature: settled.collect, instant: null, taxShare },
    after: { partnerQuoteFee: after.partnerQuoteFee - split.after.reduce((n, x) => n + partnerShare(x.fee), 0n), creatorQuoteFee: after.creatorQuoteFee },
  };
}

/** Every pass condition of spec 11.1's sniper row, for one launch. */
async function expectPassed(r: Sniped) {
  const label = `${r.mode} ${r.mint}`;
  for (const buy of r.inSlot) {
    const v = sniperTaxVerdict(buy, r.activation, true);
    console.log(`${label}: a creation-slot buy ${buy.signature} paid ${percent(v.paid)} (${buy.fee} of ${buy.quoteAmount})`);
    expect(v.ok, `${buy.signature} paid ${percent(v.paid)} in the creation slot`).toBe(true);
  }
  for (const buy of r.later) {
    const v = sniperTaxVerdict(buy, r.activation, false);
    console.log(`${label}: a buy ${v.seconds} s after the open, slot ${buy.slot}, paid ${percent(v.paid)} against the schedule's ${percent(v.expected)}`);
    expect(v.ok, `${buy.signature} paid ${percent(v.paid)} at ${v.seconds} s, the schedule ${percent(v.expected)}`).toBe(true);
  }
  // The bot's later buys reached every second it aimed for: 1, 5, 30 and 60 s after the creation went out.
  expect(r.later.filter((b) => b.quoteAmount >= LATER_BUY).length).toBeGreaterThanOrEqual(LATER_SECONDS.length);

  const windowFees = r.beforeClaim.filter((s) => s.signature !== r.pot?.swap.signature).reduce((n, s) => n + partnerShare(s.fee), 0n);
  if (r.pot) {
    // The pot's buy was the pool's first swap, at the 1.25% ending fee, and its own fee is recorded for the 50/50 split.
    expect(r.beforeClaim[0]!.signature).toBe(r.pot.swap.signature);
    // DBC rounds a fee up.
    expect(r.pot.swap).toMatchObject({ side: "buy", quoteAmount: r.pot.rung, fee: (r.pot.rung * ENDING + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR });
    expect(r.pot.potFee).toBe(partnerShare(r.pot.swap.fee));
    console.log(`${label}: the pot spent ${r.pot.rung} and paid ${r.pot.swap.fee}, ${percent((r.pot.swap.fee * FEE_DENOMINATOR) / r.pot.rung)}`);
    // Every first-minute fee reached the Tax Share: the collection took the partner's part of every other swap before it.
    expect(r.claim.taxShare).toMatchObject({ fees: windowFees, toTreasury: false });
    // The pot's own fee stays in the pool, for the next Creator Earnings claim to split.
    expect(r.after.partnerQuoteFee).toBe(r.pot.potFee);
    console.log(`${label}: the Tax Share took ${r.claim.taxShare!.fees} of window fees from ${r.beforeClaim.length - 1} swaps (${r.claim.signature})`);
  } else {
    // Every first-minute fee reached the treasury: the window claim paid it the partner's part of every swap before it.
    const treasuryAccount = await quoteAccount(devnet.keys!.treasury, devnet.quote.mint, TOKEN_PROGRAM_ADDRESS);
    expect(r.claim.instant).toMatchObject({ pool: r.pool, heat: true, destination: treasuryAccount, amount: windowFees });
    expect(r.after.partnerQuoteFee).toBe(0n);
    console.log(`${label}: the window claim paid the treasury ${windowFees} from ${r.beforeClaim.length} swaps, ${r.claim.instant!.claimedAt - r.claim.instant!.windowEndedAt} s after the window (${r.claim.signature})`);
  }
  // The creator gets none of the sniper tax.
  expect(r.after.creatorQuoteFee).toBe(0n);
}

/** Sells back what the bot holds of every coin it sniped, once their Tax windows are over, and sweeps it. */
async function settleBot(bot: KeyPairSigner, sniped: { mint: Address; config: Address }[]) {
  for (const { mint, config } of sniped) await sellAndClose(bot, mint, config).catch((e) => console.warn(`selling ${mint} from the bot failed`, e));
  await sweep(bot);
}

describe.skipIf(!keys)("the sniper simulation on devnet", () => {
  for (const mode of ["instant", "fair_open"] as const) {
    it(
      `${mode === "instant" ? "an Instant launch" : "a Fair Open"}: every creation-slot buy pays 99%, every later one the schedule, and every first-minute fee reaches ${mode === "instant" ? "the treasury" : "the Tax Share"}`,
      async () => {
        const run = newRun(`sniper-${mode}`);
        const bot = await simulationWallet("sniper", run, "bot");
        console.log(`run ${run}: bot ${bot.address}`);
        const sniped: Sniped[] = [];
        const coins: { mint: Address; config: Address }[] = [];
        const held: { launch: ScheduledFairOpen | null; depositors: KeyPairSigner[] } = { launch: null, depositors: [] };
        try {
          for (let launch = 0; launch < MAX_LAUNCHES && sniped.reduce((n, r) => n + r.inSlot.length, 0) < IN_SLOT_WANTED; launch++) {
            await fund([bot], [BOT_FUNDS]);
            const r = mode === "instant" ? await snipeInstant(bot) : await snipeFairOpen(bot, held);
            coins.push({ mint: r.mint, config: mode === "instant" ? INSTANT : FAIR_OPEN });
            console.log(`${r.mode} ${r.mint}: ${r.inSlot.length} of the bot's ${COPIES} copies landed in the creation slot ${r.creationSlot}, ${r.later.length} buys after it`);
            sniped.push(r);
            if (held.launch) {
              for (const w of held.depositors) await sellAll(w, r.mint);
              await closeNonce(held.launch.nonce, held.launch.creator.address);
              await sweep(...held.depositors);
              held.launch = null;
            }
          }
          const inSlot = sniped.reduce((n, r) => n + r.inSlot.length, 0);
          console.log(`${inSlot} of the bot's transactions landed in a creation slot over ${sniped.length} launch(es)`);
          expect(inSlot).toBeGreaterThanOrEqual(IN_SLOT_WANTED);
          for (const r of sniped) await expectPassed(r);
        } finally {
          if (held.launch) {
            const left = await fetchMaybeLaunch(rpc, held.launch.launch);
            if (left.exists && left.data.status === LaunchStatus.Opened) {
              await pushAll(held.launch.launch, left.data.mint, (await seatsOf(held.launch.launch)).filter((x) => !x.seat.delivered).map((x) => ({ seat: x.address, wallet: x.seat.wallet })));
              await settleOpened(held.launch.launch);
              for (const w of held.depositors) await sellAll(w, left.data.mint);
              await closeNonce(held.launch.nonce, held.launch.creator.address);
            } else {
              await recoverDeposits(held.launch.launch, held.launch.creator, held.depositors);
            }
            await sweep(...held.depositors);
          }
          await settleBot(bot, coins);
        }
      },
      MAX_LAUNCHES * 8 * 60_000,
    );
  }
});
