// A Fair Open's open on devnet (#46), against Meteora's deployed DBC and both our programs from their verified builds. A
// scripted launch takes deposits; at its time our keeper sends the rung of the creator's ladder the pot covers, and one
// transaction creates the coin and its pool with the pot's buy as the pool's first swap at the 1.25% ending fee, while a
// sniper's own buy in the same slot pays the 99% cliff; the levels and every seat's coins and refund match the reference
// calculation to the lamport, on an oversubscribed pot with an Unverified sub-level and on a partial fill; pushes and a
// claim deliver them; the coin's record names its launch; the open refuses an early rung, a smaller one, and any other
// transaction; and the nonce's rent goes back to the creator. It measures the creation transaction's size and compute.
// After an open (#49): the creator's coins go into a Jupiter Lock escrow, released from day 7 to day 30 to the Creator
// wallet with nobody able to cancel it; at 60 s the window's fees, less the pot's own fee, become the Tax Share, paid to
// every other seat in proportion to what it spent as the seat closes; and the launch closes, its rent back to the creator.
// Every run settles its launch so: the seats' rent comes back to wallets derived from the bank's key and the launch.
// It spends about 0.2 devnet SOL from Heat's devnet bank: fees, each coin's pool accounts, the creator's escrow, and 1.25%
// each way on the pot's coins, which its depositors sell back once the tax window ends. It signs with the keeper and
// admission keys, which, like the bank, only this Mac holds (~/.config/top-pad/devnet).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
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
import { getTransferSolInstruction } from "@solana-program/system";
import {
  allocate,
  claimablePool,
  claimInstructions,
  collectTaxShareInstructions,
  CREATOR_LOCK_CLIFF_SECONDS,
  CREATOR_LOCK_END_SECONDS,
  creatorLockEscrowAddress,
  dbcPoolAddress,
  FAIR_OPEN_PROGRAM_ADDRESS,
  lockCreatorInstructions,
  pushTaxShareInstructions,
  rungAtOrBelow,
  seatOutcome,
  swapInstructions,
  taxShareOf,
  Tier,
  type Creation,
  type SignedRung,
} from "@top-pad/chain";
import {
  FAIR_OPEN_ERROR__IDENTITY_MISMATCH,
  FAIR_OPEN_ERROR__NOT_THE_CREATION_TRANSACTION,
  FAIR_OPEN_ERROR__TOO_EARLY,
  FAIR_OPEN_ERROR__WRONG_RUNG,
  fetchLaunch,
  LaunchStatus,
  type Launch,
} from "@top-pad/clients/fair-open";
import { fetchVirtualPool } from "@top-pad/clients/dbc";
import { fetchCoinRecord, findCoinRecordPda, LaunchMode } from "@top-pad/clients/fee";
import { fetchVestingEscrow } from "@top-pad/clients/jupiter-lock";
import { decodeTransaction } from "@top-pad/indexer";
import { describe, expect, it } from "vitest";
import { bank, chainTime, coinBalance, devnet, fund, fundedWallets, landed, programCompute, rpc, send, simulatedWireError, swap, sweep } from "./devnet";
import {
  admitted,
  closeNonce,
  creationSignedNow,
  deposit,
  depositorsOf,
  keeper,
  lookupTable,
  newPerson,
  pushAll,
  recoverDeposits,
  scheduleFairOpen,
  seatOf,
  seatsOf,
  sellAll,
  settleOpened,
  signedLadder,
  type ScheduledFairOpen,
} from "./fairOpen";

const keys = ["keeper.json", "admission.json", "bank.json"].every((name) => existsSync(join(homedir(), ".config/top-pad/devnet", name)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SOL = 1_000_000_000n;
const STEP = 10_000_000n;
const HEAT = new Set<string>([devnet.configs!.instant, devnet.configs!.fairOpen]);
const FAIR_OPEN_CONFIG = devnet.configs!.fairOpen;
/** The fee schedule's two ends (spec 3.2), out of 1,000,000,000. */
const [CLIFF, ENDING] = [989_999_960n, 12_500_000n];
/** How far ahead of now a test's window closes: time to deposit and sign the ladder. */
const OPENS_IN = 150n;

const lamports = async (owner: Address) => (await rpc.getBalance(owner, { commitment: "confirmed" }).send()).value;
const decoded = async (signature: string) => decodeTransaction(await landed(signature), HEAT);

/** Waits until the chain's clock reaches `at` (Unix seconds), which can trail this Mac's by a few seconds. */
async function untilChainTime(at: bigint) {
  for (;;) {
    const now = await chainTime();
    if (now >= at) return;
    await sleep(Math.min(Number(at - now) * 1_000, 20_000) + 500);
  }
}

/** A signed transaction's first signature, which follows its one-byte count. */
const signatureOf = (wire: string) => getBase58Decoder().decode(getBase64Encoder().encode(wire).slice(1, 65)) as Signature;
const sendWire = (wire: string) => rpc.sendTransaction(wire as Base64EncodedWireTransaction, { encoding: "base64", skipPreflight: true }).send();

/** Each signature's landing, once every one has landed or failed: its slot and error. */
async function landings(signatures: Signature[]) {
  const found = new Map<Signature, { slot: bigint; err: unknown }>();
  for (let poll = 0; poll < 60 && found.size < signatures.length; poll++) {
    await sleep(1_000);
    const { value } = await rpc.getSignatureStatuses(signatures.filter((s) => !found.has(s))).send();
    signatures
      .filter((s) => !found.has(s))
      .forEach((s, i) => {
        const status = value[i];
        if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") found.set(s, { slot: status.slot, err: status.err });
      });
  }
  return found;
}

/** Buys a sniper signs as the open comes, against the coin's known pool, each a lamport apart so each is its own. */
async function sniperBuys(sniper: KeyPairSigner, mint: Address, count: number, amountIn: bigint) {
  const pool = await dbcPoolAddress(FAIR_OPEN_CONFIG, mint, devnet.quote.mint);
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const buy = await swapInstructions({ config: FAIR_OPEN_CONFIG, pool, mint, quoteMint: devnet.quote.mint, trader: sniper, side: "buy", amountIn: amountIn + BigInt(i), minimumOut: 1n });
      const transaction = await signTransactionMessageWithSigners(
        pipe(
          createTransactionMessage({ version: 0 }),
          (m) => setTransactionMessageFeePayerSigner(sniper, m),
          (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
          (m) => appendTransactionMessageInstructions(buy, m),
        ),
      );
      return { wire: getBase64EncodedWireTransaction(transaction), signature: getSignatureFromTransaction(transaction) };
    }),
  );
}

/** A test's depositors: a launch's derived wallets, funded for their deposits, the seat and coin account rent, and fees. */
async function depositors(launch: Address, asks: [Tier, bigint][]) {
  const wallets = await depositorsOf(launch, asks.length);
  await fund(wallets, asks.map(([, steps]) => steps * STEP + SOL / 50n));
  for (const [i, [tier, steps]] of asks.entries()) {
    await deposit(launch, wallets[i]!, steps * STEP, await admitted(launch, wallets[i]!.address, newPerson(), tier));
  }
  return wallets.map((wallet, i) => ({ wallet, tier: asks[i]![0], deposit: asks[i]![1] * STEP }));
}

/** Every seat of a launch matches the reference: its fill, spend, coins and refund, all delivered. */
async function expectDelivered(launch: Launch, launchAddress: Address, people: { wallet: KeyPairSigner; tier: Tier; deposit: bigint }[]) {
  for (const p of people) {
    const found = await seatOf(launchAddress, p.wallet.address);
    const o = seatOutcome(launch, p.tier, p.deposit);
    expect(found!.seat).toMatchObject({ delivered: true, spent: o.spent, coins: o.coins, refund: o.refund, coinRent: 0n });
    expect(await coinBalance(p.wallet.address, launch.mint)).toBe(o.coins);
    // No seat's fill is over its tier's cap.
    expect(o.fill <= p.deposit).toBe(true);
  }
}

/**
 * After a run: an opened launch settled to its end, every seat delivered, locked and paid its Tax Share, so its rent comes
 * back; then what each wallet holds sold back, the nonce closed, and every wallet swept.
 */
async function settleRun(s: ScheduledFairOpen | null, wallets: KeyPairSigner[]) {
  if (!s) return sweep(...wallets);
  const account = await fetchLaunch(rpc, s.launch).catch(() => null);
  if (account?.data.status === LaunchStatus.Opened) {
    const undelivered = (await seatsOf(s.launch)).filter((x) => !x.seat.delivered && x.seat.wallet !== account.data.creator);
    await pushAll(s.launch, account.data.mint, undelivered.map((x) => ({ seat: x.address, wallet: x.seat.wallet })));
    await settleOpened(s.launch);
    for (const w of wallets) await sellAll(w, account.data.mint);
    await closeNonce(s.nonce, s.creator.address);
  } else {
    await recoverDeposits(s.launch, s.creator, wallets);
  }
  await sweep(...wallets);
}

describe.skipIf(!keys).concurrent("a Fair Open's open on devnet", () => {
  it(
    "opens an oversubscribed pot in one transaction, the pot paying 1.25% and a sniper in its slot 99%, and pushes every seat",
    async () => {
      const creator = await bank();
      const [sniper] = await fundedWallets(SOL / 20n);
      let scheduled: ScheduledFairOpen | null = null;
      let people: { wallet: KeyPairSigner; tier: Tier; deposit: bigint }[] = [];
      try {
        const launch = (scheduled = await scheduleFairOpen(creator, (await chainTime()) + OPENS_IN - 600n));
        // The devnet pot of the LiteSVM tests: 3 Verified asking 0.6 SOL and 6 Unverified asking 0.1 SOL into 1.7 SOL.
        people = await depositors(launch.launch, [...Array(3).fill([Tier.Verified, 60n]), ...Array(6).fill([Tier.Unverified, 10n])]);
        const { ladder, mint } = await signedLadder(launch);
        const before = (await fetchLaunch(rpc, launch.launch)).data;
        const a = allocate(before.counts, before.unverifiedCounts, before.step, before.potCap);
        const rung = rungAtOrBelow(before.potCap, a.spend)!;
        expect([a.spend, a.others.level, a.unverified.level, rung]).toEqual([1_699_999_998n, 425_000_000n, 70_833_333n, 1_615_000_000n]);
        const signed = ladder.find((r) => r.rung === rung)!;

        // At the scheduled time our keeper sends the rung, and a sniper fires behind it.
        await untilChainTime(before.opensAt);
        const keeperAddress = (await keeper()).address;
        const keeperBefore = await lamports(keeperAddress);
        const snipes = await sniperBuys(sniper, mint.address, 10, SOL / 1_000n);
        await sendWire(signed.transaction);
        for (const snipe of snipes) {
          await sendWire(snipe.wire).catch(() => undefined);
          await sleep(80);
        }
        const opening = signatureOf(signed.transaction);
        const statuses = await landings([opening, ...snipes.map((s) => s.signature)]);
        const opened = statuses.get(opening)!;
        expect(opened.err).toBeNull();
        const openTx = await rpc.getTransaction(opening, { maxSupportedTransactionVersion: 0, commitment: "confirmed", encoding: "json" }).send();
        console.log(`the creation transaction ${opening}: ${signed.bytes} bytes, ${openTx!.meta!.computeUnitsConsumed} compute units, slot ${opened.slot}`);

        // The pot's buy was the pool's first swap, at the ending fee; our keeper paid only the transaction's fee.
        const [pot] = (await decoded(opening)).swaps;
        expect(pot).toMatchObject({ side: "buy", quoteAmount: rung, fee: (rung * ENDING) / 1_000_000_000n, trader: keeperAddress });
        expect(keeperBefore - (await lamports(keeperAddress))).toBe(openTx!.meta!.fee);
        // A sniper's buy landed in the creation slot, after the open, and paid the cliff.
        const inSlot = [];
        for (const s of snipes) {
          const landing = statuses.get(s.signature);
          if (!landing || landing.err || landing.slot !== opened.slot) continue;
          const [buy] = (await decoded(s.signature)).swaps;
          inSlot.push(buy!);
          console.log(`a sniper's buy in the creation slot: ${s.signature}, fee ${buy!.fee} of ${buy!.quoteAmount}`);
        }
        console.log(`${inSlot.length} of ${snipes.length} sniper buys landed in the creation slot`);
        expect(inSlot.length).toBeGreaterThan(0);
        for (const buy of inSlot) expect(buy.fee * 1_000_000_000n).toBeGreaterThanOrEqual(buy.quoteAmount * CLIFF);

        // The launch recorded the open, by the reference to the lamport, and the coin's record names its launch.
        const after = (await fetchLaunch(rpc, launch.launch)).data;
        expect(after).toMatchObject({
          status: LaunchStatus.Opened,
          mint: mint.address,
          spend: a.spend,
          othersLevel: a.others.level,
          unverifiedLevel: a.unverified.level,
          spent: rung,
          coins: pot!.baseAmount,
          // What is left of the creator's prepaid rent is the Creator lock's: its escrow and the escrow's coin account.
          openRent: (await rpc.getMinimumBalanceForRentExemption(296n).send()) + (await rpc.getMinimumBalanceForRentExemption(165n).send()),
        });
        const record = (await fetchCoinRecord(rpc, (await findCoinRecordPda({ mint: mint.address }))[0])).data;
        expect(record).toMatchObject({ launchMode: LaunchMode.FairOpen, fairOpenLaunch: { __option: "Some", value: launch.launch }, potFee: pot!.fee - pot!.fee / 5n });

        // Pushes deliver every seat its coins and refund, 8 a transaction.
        const balances = await Promise.all(people.map((p) => lamports(p.wallet.address)));
        const pushes = await pushAll(launch.launch, mint.address, await Promise.all(people.map(async (p) => ({ seat: (await seatOf(launch.launch, p.wallet.address))!.address, wallet: p.wallet.address }))));
        for (const push of pushes) console.log(`a push: ${push}, ${await programCompute(push, FAIR_OPEN_PROGRAM_ADDRESS)} compute units`);
        await expectDelivered(after, launch.launch, people);
        for (const [i, p] of people.entries()) expect((await lamports(p.wallet.address)) - balances[i]!).toBe(seatOutcome(after, p.tier, p.deposit).refund);

        // The nonce's rent goes back to the creator.
        const nonceRent = await lamports(launch.nonce);
        const creatorBefore = await lamports(creator.address);
        await closeNonce(launch.nonce, creator.address);
        expect((await lamports(creator.address)) - creatorBefore).toBe(nonceRent);
      } finally {
        await settleRun(scheduled, [...people.map((p) => p.wallet), sniper]);
      }
    },
    12 * 60_000,
  );

  it(
    "opens a partial fill, refuses an early or smaller rung and any other transaction, and lets a depositor claim alone",
    async () => {
      const creator = await bank();
      let scheduled: ScheduledFairOpen | null = null;
      let people: { wallet: KeyPairSigner; tier: Tier; deposit: bigint }[] = [];
      try {
        const launch = (scheduled = await scheduleFairOpen(creator, (await chainTime()) + OPENS_IN + 30n - 600n));
        // 0.9 SOL of asks that all fit: the pot spends the rung below 0.9 SOL, and every fill is scaled to it.
        people = await depositors(launch.launch, [[Tier.Scored, 30n], [Tier.Verified, 50n], [Tier.Unverified, 10n]]);
        const { ladder, mint } = await signedLadder(launch);
        const before = (await fetchLaunch(rpc, launch.launch)).data;
        const a = allocate(before.counts, before.unverifiedCounts, before.step, before.potCap);
        expect([a.spend, a.others.limited, a.unverified.limited]).toEqual([900_000_000n, false, false]);
        const rung = rungAtOrBelow(before.potCap, a.spend)!;
        expect(rung < a.spend).toBe(true);
        const at = ladder.findIndex((r) => r.rung === rung);
        const [signed, smaller] = [ladder[at]!, ladder[at + 1]!] as [SignedRung, SignedRung];

        // Refused: the right rung early, then a smaller one, another shape, and another coin.
        expect(await simulatedWireError(signed.transaction)).toBe(FAIR_OPEN_ERROR__TOO_EARLY);
        await untilChainTime(before.opensAt);
        expect(await simulatedWireError(smaller.transaction)).toBe(FAIR_OPEN_ERROR__WRONG_RUNG);
        const signer = await keeper();
        const creation: Creation = { launch: launch.launch, dbcConfig: FAIR_OPEN_CONFIG, quoteMint: devnet.quote.mint, creator, keeper: signer, mint, coin: launch.coin, rung, computeUnitPrice: 0n };
        const extra = getTransferSolInstruction({ source: signer, destination: creator.address, amount: 1n });
        expect(await simulatedWireError(await creationSignedNow(creation, [extra]))).toBe(FAIR_OPEN_ERROR__NOT_THE_CREATION_TRANSACTION);
        const vamp = await creationSignedNow({ ...creation, coin: { ...launch.coin, name: `${launch.coin.name} 2` } });
        expect(await simulatedWireError(vamp)).toBe(FAIR_OPEN_ERROR__IDENTITY_MISMATCH);

        await sendWire(signed.transaction);
        const opening = signatureOf(signed.transaction);
        expect((await landings([opening])).get(opening)!.err).toBeNull();
        const after = (await fetchLaunch(rpc, launch.launch)).data;
        expect(after).toMatchObject({ status: LaunchStatus.Opened, spend: a.spend, spent: rung });

        // Two seats pushed; the third claims alone, and its coin account's rent comes back with its refund.
        const seats = await Promise.all(people.map(async (p) => ({ seat: (await seatOf(launch.launch, p.wallet.address))!.address, wallet: p.wallet.address })));
        await pushAll(launch.launch, mint.address, seats.slice(0, 2));
        const claimer = people[2]!;
        const claimerBefore = await lamports(claimer.wallet.address);
        const claim = await send(claimer.wallet, await claimInstructions({ launch: launch.launch, mint: mint.address, seat: seats[2]!.seat, wallet: claimer.wallet, computeUnitPrice: 0n }));
        console.log(`a claim: ${claim}, ${await programCompute(claim, FAIR_OPEN_PROGRAM_ADDRESS)} compute units`);
        expect((await lamports(claimer.wallet.address)) - claimerBefore).toBe(seatOutcome(after, claimer.tier, claimer.deposit).refund - 5_000n);
        await expectDelivered(after, launch.launch, people);
        // Each fill was its whole ask, scaled to the rung.
        for (const p of people) expect(seatOutcome(after, p.tier, p.deposit).spent).toBe((p.deposit * rung + a.spend - 1n) / a.spend);
      } finally {
        await settleRun(scheduled, people.map((p) => p.wallet));
      }
    },
    12 * 60_000,
  );
  it(
    "locks the creator's coins in Jupiter Lock, pays every other seat its Tax Share as it closes, and closes the launch",
    async () => {
      const creator = await bank();
      const [sniper] = await fundedWallets(SOL / 10n);
      let scheduled: ScheduledFairOpen | null = null;
      let people: { wallet: KeyPairSigner; tier: Tier; deposit: bigint }[] = [];
      try {
        const launch = (scheduled = await scheduleFairOpen(creator, (await chainTime()) + OPENS_IN + 60n - 600n));
        people = await depositors(launch.launch, [[Tier.Verified, 40n], [Tier.Scored, 20n], [Tier.Unverified, 10n]]);
        // The creator deposits too, under their own tier: their coins go only into the Creator lock.
        await deposit(launch.launch, creator, 30n * STEP, await admitted(launch.launch, creator.address, newPerson(), Tier.Scored));
        const { ladder, mint } = await signedLadder(launch);
        const before = (await fetchLaunch(rpc, launch.launch)).data;
        expect([before.creatorDeposit, before.creatorTier]).toEqual([30n * STEP, Tier.Scored]);
        const a = allocate(before.counts, before.unverifiedCounts, before.step, before.potCap);
        const signed = ladder.find((r) => r.rung === rungAtOrBelow(before.potCap, a.spend))!;
        await untilChainTime(before.opensAt);
        await sendWire(signed.transaction);
        const opening = signatureOf(signed.transaction);
        expect((await landings([opening])).get(opening)!.err).toBeNull();
        const pool = await dbcPoolAddress(FAIR_OPEN_CONFIG, mint.address, devnet.quote.mint);
        // Snipers buy inside the Tax window, each paying the falling tax.
        for (const amount of [SOL / 50n, SOL / 100n]) await swap(sniper, mint.address, "buy", amount, FAIR_OPEN_CONFIG);

        const after = (await fetchLaunch(rpc, launch.launch)).data;
        const seats = await Promise.all(people.map(async (p) => ({ seat: (await seatOf(launch.launch, p.wallet.address))!.address, wallet: p.wallet.address })));
        await pushAll(launch.launch, mint.address, seats);
        const payer = await keeper();
        const { address: tableAddress, addresses } = await lookupTable();
        const table = { [tableAddress]: addresses };

        // The Creator lock: the creator's coins into a Jupiter Lock escrow, the rest of their seat back to them.
        const creatorSeat = (await seatOf(launch.launch, creator.address))!;
        const mine = seatOutcome(after, Tier.Scored, 30n * STEP);
        const creatorBefore = await lamports(creator.address);
        const lock = await send(payer, await lockCreatorInstructions({ launch: launch.launch, creator: creator.address, seat: creatorSeat.address, mint: mint.address, pool, computeUnitPrice: 0n }), table);
        console.log(`the Creator lock: ${lock}, ${await programCompute(lock, FAIR_OPEN_PROGRAM_ADDRESS)} compute units`);
        const escrowAddress = await creatorLockEscrowAddress(launch.launch);
        const escrow = (await fetchVestingEscrow(rpc, escrowAddress, { commitment: "confirmed" })).data;
        const activation = (await fetchVirtualPool(rpc, pool, { commitment: "confirmed" })).data.poolState.activationPoint;
        expect(escrow).toMatchObject({ recipient: creator.address, tokenMint: mint.address, cancelMode: 0, updateRecipientMode: 2, cliffTime: activation + CREATOR_LOCK_CLIFF_SECONDS });
        expect(escrow.cliffTime + escrow.frequency * escrow.numberOfPeriod).toBe(activation + CREATOR_LOCK_END_SECONDS);
        expect(escrow.cliffUnlockAmount + escrow.amountPerPeriod * escrow.numberOfPeriod).toBe(mine.coins);
        expect(await coinBalance(escrowAddress, mint.address)).toBe(mine.coins);
        expect(await seatOf(launch.launch, creator.address)).toBeNull();
        // Its refund, its prepaid coin-account rent and its seat's rent: the escrow came out of the prepaid rent.
        expect((await lamports(creator.address)) - creatorBefore).toBe(mine.refund + creatorSeat.seat.coinRent + creatorSeat.lamports);

        // At 60 s, the Tax Share's collection: the window's fees less the pot's own fee, and the open's dust.
        const record = (await fetchCoinRecord(rpc, (await findCoinRecordPda({ mint: mint.address }))[0])).data;
        await untilChainTime(activation + 60n);
        const state = (await fetchVirtualPool(rpc, pool, { commitment: "confirmed" })).data.poolState;
        const windowFees = state.partnerQuoteFee - record.potFee;
        const collect = await send(payer, await collectTaxShareInstructions({ launch: launch.launch, pool: claimablePool(pool, state, devnet.quote.mint), treasury: devnet.keys!.treasury, computeUnitPrice: 0n }), table);
        console.log(`the Tax Share's collection: ${collect}, ${await programCompute(collect, FAIR_OPEN_PROGRAM_ADDRESS)} compute units`);
        const [collected] = (await decoded(collect)).taxShares;
        const spentBySeats = [...people.map((p) => seatOutcome(after, p.tier, p.deposit).spent), mine.spent].reduce((x, y) => x + y);
        // A late claim moves the seconds' normal fees too: at least the window's, never less.
        expect(collected!.fees >= windowFees).toBe(true);
        expect(collected).toMatchObject({ dust: spentBySeats - after.spent, taxShare: collected!.fees + spentBySeats - after.spent, toTreasury: false });
        expect((await fetchVirtualPool(rpc, pool, { commitment: "confirmed" })).data.poolState.partnerQuoteFee).toBe(record.potFee);
        console.log(`Tax Share: ${collected!.taxShare} lamports, ${collected!.fees} of window fees and ${collected!.dust} of dust`);

        // Every other seat paid its share as it closes, its rent with it; the creator's gets none.
        const open = await seatsOf(launch.launch);
        const balances = await Promise.all(people.map((p) => lamports(p.wallet.address)));
        const push = await send(payer, await pushTaxShareInstructions({ launch: launch.launch, seats: open.map((x) => ({ seat: x.address, wallet: x.seat.wallet })), computeUnitPrice: 0n }), table);
        console.log(`a Tax Share push of ${open.length} seats: ${push}, ${await programCompute(push, FAIR_OPEN_PROGRAM_ADDRESS)} compute units`);
        let paid = 0n;
        for (const x of open) {
          const p = people.find((q) => q.wallet.address === x.seat.wallet)!;
          const fill = seatOutcome(after, p.tier, p.deposit).fill;
          const share = taxShareOf(collected!.taxShare, collected!.basis, paid, fill);
          paid += fill;
          expect((await lamports(p.wallet.address)) - balances[people.indexOf(p)]!).toBe(share + x.lamports);
        }
        expect(await seatsOf(launch.launch)).toEqual([]);

        // Done: the launch closes, its rent and its vault's back to the creator.
        const rent = (await lamports(launch.launch)) + (await lamports(launch.vault));
        const beforeClose = await lamports(creator.address);
        await settleOpened(launch.launch);
        expect((await lamports(creator.address)) - beforeClose).toBe(rent);
        expect(await lamports(launch.launch)).toBe(0n);
      } finally {
        await settleRun(scheduled, [...people.map((p) => p.wallet), sniper]);
      }
    },
    14 * 60_000,
  );
});
