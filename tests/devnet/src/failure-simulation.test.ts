// The failure simulation (spec 11.1, #60), repeatable: every attempt to spoil, rush or hijack a Fair Open's open, each sent
// to the chain without preflight so its refusal lands there as a failed transaction, against the Fair Open program
// deployed from its verified build. A Fair Open is scheduled by script, as the launch service schedules one (its own
// creator wallet, our keeper co-signing and holding the nonce), and four depositors of every tier join it. Then:
//
// - the creator tries to spoil the signed ladder through the launch's durable nonce: advancing it, making themselves its
//   authority, and withdrawing its rent; the system program refuses each, since our keeper is its authority, and the
//   nonce keeps its value;
// - the keeper sends the right rung 20 s early: `open` refuses it as too early;
// - at the open, the keeper sends a rung one step smaller than the pot covers: refused as the wrong rung;
// - a rung for a coin other than the one the creator sealed (its name changed by a character): refused, since its
//   identity does not hash to the launch's committed hash;
// - 15 minutes after the open, the right rung at last: refused as too late.
//
// A rung that fails on chain still advances its nonce, voiding every other rung signed on it (CLAUDE.md, Traps), so the
// run signs a fresh ladder after each, as only a test holding the creator's and a mint key can. Then, with the keeper
// switched off (nothing of Heat's runs for a launch the launch service did not schedule, and the run sends nothing as the
// keeper), a depositor marks the launch failed and every depositor withdraws their deposit and both rents on chain alone,
// each transaction built from the chain and nothing else, to the lamport less their own fees.
//
// Real devnet SOL: about 0.01 a run, the failed transactions' fees; every deposit and rent comes back. About 20 minutes,
// most of it the 15 minutes' wait. Its wallets derive from the bank's key and the run's name, which it logs. It signs with
// the keeper and admission keys, which only this Mac holds (~/.config/top-pad/devnet); without them it is skipped.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Address, KeyPairSigner } from "@solana/kit";
import { fetchNonce, getAdvanceNonceAccountInstruction, getAuthorizeNonceAccountInstruction, getWithdrawNonceAccountInstruction } from "@solana-program/system";
import { allocate, closeLaunchInstructions, LATE_OPEN_SECONDS, rungAtOrBelow, Tier, type SignedRung } from "@top-pad/chain";
import {
  FAIR_OPEN_ERROR__IDENTITY_MISMATCH,
  FAIR_OPEN_ERROR__TOO_EARLY,
  FAIR_OPEN_ERROR__TOO_LATE,
  FAIR_OPEN_ERROR__WRONG_RUNG,
  fetchLaunch,
  fetchMaybeLaunch,
  LaunchStatus,
} from "@top-pad/clients/fair-open";
import { describe, expect, it } from "vitest";
import { chainTime, fund, rpc, send, sendRefused, sweep } from "./devnet";
import { admitted, closeNonce, deposit, depositorsOf, markFailed, newPerson, recoverDeposits, refund, scheduleFairOpen, seatOf, signedLadder, type ScheduledFairOpen } from "./fairOpen";
import { json, landRefused, newRun, simulationWallet, untilChainTime } from "./simulation";

const keys = ["keeper.json", "admission.json", "bank.json"].every((name) => existsSync(join(homedir(), ".config/top-pad/devnet", name)));
const SOL = 1_000_000_000n;
const STEP = 10_000_000n;
/** A transaction's base fee, which each depositor's own transactions pay. */
const FEE = 5_000n;
/** How far ahead of now the window closes: time to deposit and sign the ladder, with 20 s to send a rung early. */
const OPENS_IN = 150n;
/** Every tier, and a pot the lowest rung covers. */
const ASKS: [Tier, bigint][] = [
  [Tier.Verified, 40n],
  [Tier.Scored, 30n],
  [Tier.Scored, 15n],
  [Tier.Unverified, 10n],
];

const lamports = async (owner: Address) => (await rpc.getBalance(owner, { commitment: "confirmed" }).send()).value;
const nonceValue = async (nonce: Address) => (await fetchNonce(rpc, nonce, { commitment: "confirmed" })).data.blockhash;

/** The rung the pot covers on a fresh ladder, and the one a step smaller, signed on the nonce's current value. */
async function freshLadder(s: ScheduledFairOpen, rung: bigint, coin = s.coin) {
  const { ladder } = await signedLadder({ ...s, coin });
  const at = ladder.findIndex((r) => r.rung === rung);
  return { right: ladder[at]!, smaller: ladder[at + 1]! } as { right: SignedRung; smaller: SignedRung };
}

describe.skipIf(!keys)("the failure simulation on devnet", () => {
  it(
    "refuses the creator's nonce, an early, smaller, other-coin and late open, and every depositor withdraws on chain alone",
    async () => {
      const run = newRun("failure");
      const creator = await simulationWallet("failure", run, "creator");
      console.log(`run ${run}: creator ${creator.address}`);
      await fund([creator], [SOL / 10n]);
      let s: ScheduledFairOpen | null = null;
      let depositors: KeyPairSigner[] = [];
      try {
        s = await scheduleFairOpen(creator, (await chainTime()) + OPENS_IN - 600n);
        depositors = await depositorsOf(s.launch, ASKS.length);
        await fund(depositors, ASKS.map(([, steps]) => steps * STEP + SOL / 100n));
        for (const [i, [tier, steps]] of ASKS.entries()) await deposit(s.launch, depositors[i]!, steps * STEP, await admitted(s.launch, depositors[i]!.address, newPerson(), tier));
        const launch = (await fetchLaunch(rpc, s.launch)).data;
        const rung = rungAtOrBelow(launch.potCap, allocate(launch.counts, launch.unverifiedCounts, launch.step, launch.potCap).spend)!;
        console.log(`Fair Open ${s.launch}: ${ASKS.length} seats, the pot covers the ${rung} rung, opens at ${launch.opensAt}`);
        const attempts: string[] = [];

        // The creator tries the launch's durable nonce three ways; our keeper is its authority, so each is refused.
        const nonce = s.nonce;
        const value = await nonceValue(nonce);
        const nonceRent = await lamports(nonce);
        const creatorTries = {
          advance: getAdvanceNonceAccountInstruction({ nonceAccount: nonce, nonceAuthority: creator }),
          authorize: getAuthorizeNonceAccountInstruction({ nonceAccount: nonce, nonceAuthority: creator, newNonceAuthority: creator.address }),
          withdraw: getWithdrawNonceAccountInstruction({ nonceAccount: nonce, recipientAccount: creator.address, nonceAuthority: creator, withdrawAmount: nonceRent }),
        };
        for (const [what, ix] of Object.entries(creatorTries)) {
          const refused = await sendRefused(creator, [ix]);
          expect(refused.error, `the creator's nonce ${what} landed`).not.toBeNull();
          attempts.push(`the creator's nonce ${what}: ${refused.signature}`);
        }
        expect(await nonceValue(nonce)).toBe(value);
        expect(await lamports(nonce)).toBe(nonceRent);

        // The keeper sends the right rung 20 s early.
        let ladder = await freshLadder(s, rung);
        await untilChainTime(launch.opensAt - 20n);
        const early = await landRefused(ladder.right.transaction);
        expect(early.error, json(early.err)).toBe(FAIR_OPEN_ERROR__TOO_EARLY);
        attempts.push(`the right rung 20 s early: ${early.signature}`);
        const advanced = (await nonceValue(nonce)) !== value;
        console.log(`a rung refused on chain ${advanced ? "advanced" : "did not advance"} its nonce`);

        // At the open, a rung one step smaller than the pot covers.
        await untilChainTime(launch.opensAt);
        ladder = await freshLadder(s, rung);
        const smaller = await landRefused(ladder.smaller.transaction);
        expect(smaller.error, json(smaller.err)).toBe(FAIR_OPEN_ERROR__WRONG_RUNG);
        attempts.push(`a rung smaller than the pot covers: ${smaller.signature}`);

        // The right rung for another coin than the one sealed at scheduling.
        const other = await freshLadder(s, rung, { ...s.coin, name: `${s.coin.name}.` });
        const vamp = await landRefused(other.right.transaction);
        expect(vamp.error, json(vamp.err)).toBe(FAIR_OPEN_ERROR__IDENTITY_MISMATCH);
        attempts.push(`a coin other than the one sealed: ${vamp.signature}`);

        // Nothing opens it: 15 minutes after its time, the right rung is too late.
        await untilChainTime(launch.opensAt + LATE_OPEN_SECONDS);
        ladder = await freshLadder(s, rung);
        const late = await landRefused(ladder.right.transaction);
        expect(late.error, json(late.err)).toBe(FAIR_OPEN_ERROR__TOO_LATE);
        attempts.push(`the right rung 15 minutes late: ${late.signature}`);
        expect((await fetchLaunch(rpc, s.launch)).data.status).toBe(LaunchStatus.Scheduled);
        for (const line of attempts) console.log(`refused on chain: ${line}`);

        // The keeper is off: a depositor marks the launch failed, and each withdraws alone, from the chain alone.
        const before = await Promise.all(depositors.map((w) => lamports(w.address)));
        const seats = await Promise.all(depositors.map(async (w) => (await seatOf(s!.launch, w.address))!));
        const marked = await markFailed(s.launch, depositors[0]!);
        console.log(`marked failed by a depositor: ${marked}`);
        for (const [i, w] of depositors.entries()) {
          const signature = await refund(s.launch, w);
          const back = (await lamports(w.address)) - before[i]!;
          const owed = seats[i]!.seat.deposit + seats[i]!.seat.coinRent + seats[i]!.lamports;
          // Depositor 0 also paid for marking the launch failed.
          const fees = FEE + (i === 0 ? FEE : 0n);
          console.log(`depositor ${i} withdrew ${back + fees} lamports alone (${signature}): deposit ${seats[i]!.seat.deposit}, both rents ${seats[i]!.seat.coinRent + seats[i]!.lamports}`);
          expect(back).toBe(owed - fees);
          expect(await seatOf(s.launch, w.address)).toBeNull();
        }
        expect((await fetchLaunch(rpc, s.launch)).data.seats).toBe(0);
      } finally {
        if (s) {
          const left = await fetchMaybeLaunch(rpc, s.launch);
          if (left.exists && left.data.seats > 0) await recoverDeposits(s.launch, creator, depositors);
          const closing = await fetchMaybeLaunch(rpc, s.launch);
          if (closing.exists && closing.data.seats === 0 && closing.data.failure.__option === "Some") {
            await send(creator, await closeLaunchInstructions({ launch: s.launch, creator: creator.address, computeUnitPrice: 0n }));
          }
          await closeNonce(s.nonce, creator.address);
        }
        await sweep(...depositors, creator);
      }
    },
    30 * 60_000,
  );
});
