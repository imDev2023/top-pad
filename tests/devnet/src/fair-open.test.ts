// A Fair Open's window and its failure path on devnet (#45), against the Fair Open program deployed from its verified
// build, with no Heat server: launches scheduled by script, deposits admitted with the devnet admission key and sent
// straight to the program, and every refund built from the chain alone. The program refuses on chain a second wallet of
// a seated person, a deposit over its cap or off the step, and one without a valid, unexpired admission; it fails a
// launch at once when its pot misses the minimum raise, and 15 minutes after a missed open whatever the pot holds, when
// it also refuses any rung (#46); and each depositor takes back their deposit and both rents to the lamport, the
// creator its rent, and our keeper closes the nonce. It spends about 0.05 devnet SOL in fees from
// Heat's devnet bank (the deposits and rents come back) and signs with the keeper and admission keys, which, like the
// bank, only this Mac holds (~/.config/top-pad/devnet); without them it is skipped.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, generateKeyPairSigner, getAddressFromPublicKey, type Address, type Instruction, type KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  admissionMessage,
  allocate,
  closeLaunchInstructions,
  depositInstructions,
  ED25519_PROGRAM_ADDRESS,
  ed25519Instruction,
  FAIR_OPEN_PROGRAM_ADDRESS,
  markFailedInstructions,
  rungAtOrBelow,
  signAdmission,
  Tier,
} from "@top-pad/chain";
import { FAIR_OPEN_ERROR__TOO_LATE, fetchLaunch, fetchMaybeLaunch, Failure, LaunchStatus } from "@top-pad/clients/fair-open";
import { decodeTransaction } from "@top-pad/indexer";
import { bank, chainTime, devnet, fundedWallets, landed, programCompute, rpc, send, sendRefused, simulatedError, simulatedWireError, sweep } from "./devnet";
import {
  admitted,
  creationSignedNow,
  deposit,
  keeper,
  markFailed,
  newPerson,
  recoverDeposits,
  refund,
  scheduleFairOpen,
  seatOf,
  withdraw,
  type ScheduledFairOpen,
} from "./fairOpen";

const keys = ["keeper.json", "admission.json", "bank.json"].every((name) => existsSync(join(homedir(), ".config/top-pad/devnet", name)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SOL = 1_000_000_000n;
const STEP = 10_000_000n;
const HEAT = new Set<string>([devnet.configs!.instant, devnet.configs!.fairOpen]);
/** One signature's network fee; a deposit pays two, its admission's precompile signature counting like a transaction's. */
const SIGNATURE_FEE = 5_000n;
/** The Fair Open program's custom errors this test meets (programs/fair_open, `FairOpenError`). */
const OFF_STEP = 6014;
const NO_ADMISSION = 6015;
const NOT_OUR_ADMISSION = 6016;
const ADMISSION_EXPIRED = 6018;
const SEAT_HELD_BY_ANOTHER_WALLET = 6020;
const OVER_CAP = 6021;
const CAN_STILL_OPEN = 6029;

const lamports = async (owner: Address) => (await rpc.getBalance(owner, { commitment: "confirmed" }).send()).value;
const compute = (signature: string) => programCompute(signature, FAIR_OPEN_PROGRAM_ADDRESS);
const decoded = async (signature: string) => decodeTransaction(await landed(signature), HEAT);

/** Waits until the chain's clock reaches `at` (Unix seconds), which can trail this Mac's by a few seconds. */
async function untilChainTime(at: bigint) {
  for (;;) {
    const now = await chainTime();
    if (now >= at) return;
    await sleep(Math.min(Number(at - now) * 1_000, 30_000) + 1_000);
  }
}

/**
 * A deposit's instructions with its admission's precompile instruction as signed, swapped for `precompile`, or left out
 * when `precompile` is null.
 */
async function depositWith(launch: Address, wallet: KeyPairSigner, amount: bigint, a: Awaited<ReturnType<typeof admitted>>, precompile?: Instruction | null) {
  const instructions = await depositInstructions({
    launch,
    wallet,
    amount,
    admission: a.admission,
    admissionSigner: devnet.keys!.admission,
    signature: a.signature,
    computeUnitPrice: 0n,
  });
  if (precompile === undefined) return instructions;
  return instructions.flatMap((ix) => (ix.programAddress === ED25519_PROGRAM_ADDRESS ? (precompile ? [precompile] : []) : [ix]));
}

describe.skipIf(!keys).concurrent("a Fair Open on devnet, with no Heat server", () => {
  it(
    "takes deposits, refuses what the rules refuse, fails on a missed minimum raise and returns every deposit and both rents",
    async () => {
      const creator = await bank();
      const [alice, bob, carol, bobAgain, stranger] = await fundedWallets(SOL / 5n, SOL / 2n, (SOL * 7n) / 10n, SOL / 20n, SOL / 50n);
      let scheduled: ScheduledFairOpen | null = null;
      try {
        // A window that closes about three minutes from now, with a minimum raise of 1 SOL this pot will miss.
        const opensIn = 180n;
        const launch = (scheduled = await scheduleFairOpen(creator, (await chainTime()) + opensIn - 600n, SOL));
        const created = await fetchLaunch(rpc, launch.launch);
        expect(created.data).toMatchObject({ creator: creator.address, potCap: 1_700_000_000n, minRaise: SOL, status: LaunchStatus.Scheduled });
        const people = { alice: newPerson(), bob: newPerson(), carol: newPerson() };
        const before = { alice: await lamports(alice.address), bob: await lamports(bob.address), carol: await lamports(carol.address) };

        // Three people deposit 0.9 SOL between them, each through an admission our server would sign.
        const aliceDeposit = await deposit(launch.launch, alice, 10n * STEP, await admitted(launch.launch, alice.address, people.alice, Tier.Unverified));
        await deposit(launch.launch, bob, 40n * STEP, await admitted(launch.launch, bob.address, people.bob, Tier.Scored));
        await deposit(launch.launch, carol, 60n * STEP, await admitted(launch.launch, carol.address, people.carol, Tier.Verified));
        const seated = await decoded(aliceDeposit);
        expect(seated.seatEvents).toEqual([expect.objectContaining({ kind: "deposit", wallet: alice.address, tier: "unverified", amount: 10n * STEP, seatOpened: true })]);
        console.log(`deposit taking a seat: ${await compute(aliceDeposit)} compute units`);

        // Refused on chain. Bob's person through another wallet: sent with no preflight, so the refusal lands.
        const second = await sendRefused(
          bobAgain,
          await depositWith(launch.launch, bobAgain, STEP, await admitted(launch.launch, bobAgain.address, people.bob, Tier.Scored)),
        );
        expect(second.error).toBe(SEAT_HELD_BY_ANOTHER_WALLET);
        console.log(`a second wallet of a seated person, refused on chain: ${second.signature}`);
        // Over Alice's Unverified cap of 0.1 SOL, and off the 0.01 SOL step.
        const aliceAgain = await admitted(launch.launch, alice.address, people.alice, Tier.Unverified);
        expect(await simulatedError(alice, await depositWith(launch.launch, alice, STEP, aliceAgain))).toBe(OVER_CAP);
        const carolAgain = await admitted(launch.launch, carol.address, people.carol, Tier.Verified);
        expect(await simulatedError(carol, await depositWith(launch.launch, carol, STEP + STEP / 2n, carolAgain))).toBe(OFF_STEP);
        // With no admission, with one signed by any other key, and with one expired.
        expect(await simulatedError(carol, await depositWith(launch.launch, carol, STEP, carolAgain, null))).toBe(NO_ADMISSION);
        const impostor = await generateKeyPair();
        const message = admissionMessage(launch.launch, carol.address, carolAgain.admission);
        const forged = ed25519Instruction(await getAddressFromPublicKey(impostor.publicKey), await signAdmission(impostor.privateKey, message), message);
        expect(await simulatedError(carol, await depositWith(launch.launch, carol, STEP, carolAgain, forged))).toBe(NOT_OUR_ADMISSION);
        const lapsed = await admitted(launch.launch, carol.address, people.carol, Tier.Verified, { expiresAt: (await chainTime()) - 60n });
        expect(await simulatedError(carol, await depositWith(launch.launch, carol, STEP, lapsed))).toBe(ADMISSION_EXPIRED);

        // Carol takes back 0.2 SOL in the window.
        const taken = await withdraw(launch.launch, carol, 20n * STEP);
        console.log(`withdraw: ${await compute(taken)} compute units`);
        const pot = await fetchLaunch(rpc, launch.launch);
        expect(pot.data).toMatchObject({ seats: 3, unverifiedDeposits: 10n * STEP, scoredDeposits: 40n * STEP, verifiedDeposits: 40n * STEP });

        // The window closes with 0.9 SOL against a 1 SOL minimum: anyone marks it failed at once.
        await untilChainTime(pot.data.opensAt);
        const failed = await markFailed(launch.launch, stranger);
        console.log(`mark_failed: ${await compute(failed)} compute units`);
        expect((await fetchLaunch(rpc, launch.launch)).data).toMatchObject({ status: LaunchStatus.Failed, failure: { __option: "Some", value: Failure.MinRaiseMissed } });
        expect((await decoded(failed)).fairOpenEnds).toEqual([{ launch: launch.launch, kind: "failed", failure: "min_raise_missed" }]);

        // Each depositor takes back their deposit and both rents, alone: everything they put in comes back, and only the
        // network fees are spent (a deposit's two signatures, one for each other transaction).
        for (const [name, wallet, transactions] of [["alice", alice, [2n]], ["bob", bob, [2n]], ["carol", carol, [2n, 1n]]] as const) {
          const seat = await seatOf(launch.launch, wallet.address);
          expect(seat).not.toBeNull();
          const back = await refund(launch.launch, wallet);
          if (name === "alice") console.log(`withdraw_failed: ${await compute(back)} compute units`);
          const fees = [...transactions, 1n].reduce((sum, signatures) => sum + signatures * SIGNATURE_FEE, 0n);
          expect(before[name] - (await lamports(wallet.address)), name).toBe(fees);
          expect(await seatOf(launch.launch, wallet.address)).toBeNull();
        }

        // With every seat back, the creator's rent comes back too.
        const creatorBefore = await lamports(creator.address);
        const rent = (await rpc.getBalance(launch.launch).send()).value + (await rpc.getBalance(launch.vault).send()).value;
        await send(stranger, await closeLaunchInstructions({ launch: launch.launch, creator: creator.address, computeUnitPrice: 0n }));
        expect((await lamports(creator.address)) - creatorBefore).toBe(rent);
        expect((await fetchMaybeLaunch(rpc, launch.launch)).exists).toBe(false);
      } finally {
        if (scheduled) await recoverDeposits(scheduled.launch, stranger, [alice, bob, carol]);
        await sweep(alice, bob, carol, bobAgain, stranger);
      }
    },
    10 * 60_000,
  );

  it(
    "fails 15 minutes after a missed open, whatever its pot holds, and the depositor takes everything back alone",
    async () => {
      const creator = await bank();
      const [dana, stranger] = await fundedWallets(SOL / 5n, SOL / 50n);
      let scheduled: ScheduledFairOpen | null = null;
      try {
        // A window closing about a minute from now, no minimum raise, and a pot of 0.1 SOL above the lowest rung.
        const launch = (scheduled = await scheduleFairOpen(creator, (await chainTime()) + 60n - 600n));
        const before = await lamports(dana.address);
        await deposit(launch.launch, dana, 10n * STEP, await admitted(launch.launch, dana.address, newPerson(), Tier.Scored));
        const { data } = await fetchLaunch(rpc, launch.launch);

        // The pot could open, so nobody may fail it until 15 minutes after its scheduled time; from then on no rung opens
        // it either (#46), even one the creator signs at that moment.
        await untilChainTime(data.opensAt);
        expect(await simulatedError(stranger, await markFailedInstructions({ launch: launch.launch, computeUnitPrice: 0n }))).toBe(CAN_STILL_OPEN);
        await untilChainTime(data.opensAt + 900n);
        const { spend } = allocate(data.counts, data.unverifiedCounts, data.step, data.potCap);
        const late = await creationSignedNow({
          launch: launch.launch,
          dbcConfig: devnet.configs!.fairOpen,
          quoteMint: devnet.quote.mint,
          creator,
          keeper: await keeper(),
          mint: await generateKeyPairSigner(),
          coin: launch.coin,
          rung: rungAtOrBelow(data.potCap, spend)!,
          computeUnitPrice: 0n,
        });
        expect(await simulatedWireError(late)).toBe(FAIR_OPEN_ERROR__TOO_LATE);
        await markFailed(launch.launch, stranger);
        expect((await fetchLaunch(rpc, launch.launch)).data.failure).toEqual({ __option: "Some", value: Failure.Late });

        await refund(launch.launch, dana);
        expect(before - (await lamports(dana.address))).toBe(3n * SIGNATURE_FEE);
        await send(stranger, await closeLaunchInstructions({ launch: launch.launch, creator: creator.address, computeUnitPrice: 0n }));
      } finally {
        if (scheduled) await recoverDeposits(scheduled.launch, stranger, [dana]);
        await sweep(dana, stranger);
      }
    },
    25 * 60_000,
  );
});
