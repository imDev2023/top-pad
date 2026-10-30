// Fair Opens on devnet for the tests here and in tests/ui (spec 2.1, 5.3): a launch scheduled by script, as this slice
// schedules them, and deposits admitted with the devnet admission key straight to the program, for what only the chain
// can show: its refusals, and every deposit coming back with no Heat server running. The keeper and admission keys are
// this Mac's (~/.config/top-pad/devnet).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createKeyPairFromBytes,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  type Address,
  type Base58EncodedBytes,
  type KeyPairSigner,
} from "@solana/kit";
import {
  admissionMessage,
  closeLaunchInstructions,
  createLaunchInstructions,
  depositInstructions,
  FAIR_OPEN_PROGRAM_ADDRESS,
  fairOpenAccounts,
  fairOpenPhase,
  identityHash,
  markFailedInstructions,
  NONCE_ACCOUNT_SPACE,
  SEAT_LAYOUT,
  signAdmission,
  Tier,
  tierCap,
  withdrawFailedInstructions,
  withdrawInstructions,
  type Admission,
} from "@top-pad/chain";
import { fetchMaybeLaunch, getSeatDecoder, getSeatSize, type Seat } from "@top-pad/clients/fair-open";
import { chainTime, devnet, rpc, send } from "./devnet";

const keyFile = (name: string) => Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".config/top-pad/devnet", name), "utf8")) as number[]);

/** Heat's devnet keeper, which co-signs every launch and holds its nonce. */
export const keeper = () => createKeyPairSignerFromBytes(keyFile("keeper.json"));

/** The devnet admission key, whose public half the Fair Open program's `ProgramConfig` names. */
export const admissionKey = () => createKeyPairFromBytes(keyFile("admission.json"));

export type ScheduledFairOpen = { launch: Address; vault: Address; nonce: Address; creator: KeyPairSigner; coin: { name: string; ticker: string; uri: string } };

/**
 * Schedules a Fair Open whose window opens at `depositsOpenAt` (Unix seconds), signed by `creator` and our keeper, on
 * Heat's Fair Open config: the creator pays the rent of the launch, its vault and its nonce. Its coin is a made-up test
 * coin, sealed behind its hash and never revealed, since this slice never opens.
 */
export async function scheduleFairOpen(creator: KeyPairSigner, depositsOpenAt: bigint, minRaise = 0n): Promise<ScheduledFairOpen> {
  const nonce = await generateKeyPairSigner();
  const tag = Math.random().toString(36).slice(2, 8).toUpperCase();
  const coin = { name: `Sealed test ${tag}`, ticker: `S${tag}`, uri: `https://turbo-gateway.com/sealed-test-${tag.toLowerCase()}` };
  const nonceRent = await rpc.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_SPACE).send();
  await send(
    creator,
    await createLaunchInstructions({
      creator,
      keeper: await keeper(),
      nonce,
      nonceRent,
      dbcConfig: devnet.configs!.fairOpen,
      depositsOpenAt,
      minRaise,
      identityHash: await identityHash(coin),
      computeUnitPrice: 0n,
    }),
  );
  return { ...(await fairOpenAccounts(nonce.address)), nonce: nonce.address, creator, coin };
}

/** A test person: a random pseudonym, as our admission server would give one in a launch. */
export const newPerson = () => crypto.getRandomValues(new Uint8Array(32));

/** An admission for `wallet` in `launch`, signed with the devnet admission key: their tier's cap, for two minutes. */
export async function admitted(launch: Address, wallet: Address, person: Uint8Array, tier: Tier, over: Partial<Admission> = {}) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const admission: Admission = { person, tier, cap: tierCap(tier), expiresAt: now + 120n, ...over };
  const key = await admissionKey();
  return { admission, signature: await signAdmission(key.privateKey, admissionMessage(launch, wallet, admission)) };
}

/** A deposit straight to the program, with an admission signed by `signer` (the admission key unless a test says). */
export async function deposit(launch: Address, wallet: KeyPairSigner, amount: bigint, admission: { admission: Admission; signature: Uint8Array }) {
  const instructions = await depositInstructions({
    launch,
    wallet,
    amount,
    admission: admission.admission,
    admissionSigner: devnet.keys!.admission,
    signature: admission.signature,
    computeUnitPrice: 0n,
  });
  return send(wallet, instructions);
}

/** A wallet's seat in a launch, found from the chain alone, as a depositor with no Heat server finds it. */
export async function seatOf(launch: Address, wallet: Address): Promise<{ address: Address; seat: Seat; lamports: bigint } | null> {
  const found = await rpc
    .getProgramAccounts(FAIR_OPEN_PROGRAM_ADDRESS, {
      encoding: "base64",
      commitment: "confirmed",
      filters: [
        { dataSize: BigInt(getSeatSize()) },
        { memcmp: { offset: BigInt(SEAT_LAYOUT.launchOffset), bytes: launch as string as Base58EncodedBytes, encoding: "base58" } },
        { memcmp: { offset: BigInt(SEAT_LAYOUT.walletOffset), bytes: wallet as string as Base58EncodedBytes, encoding: "base58" } },
      ],
    })
    .send();
  const first = found[0];
  if (!first) return null;
  const data = Uint8Array.from(atob(first.account.data[0]), (c) => c.charCodeAt(0));
  return { address: first.pubkey, seat: getSeatDecoder().decode(data), lamports: first.account.lamports };
}

export async function withdraw(launch: Address, wallet: KeyPairSigner, amount: bigint) {
  const found = await seatOf(launch, wallet.address);
  if (!found) throw new Error(`${wallet.address} holds no seat in ${launch}`);
  return send(wallet, await withdrawInstructions({ launch, seat: found.address, wallet, amount, computeUnitPrice: 0n }));
}

/** `mark_failed`, sent by anyone. */
export const markFailed = async (launch: Address, sender: KeyPairSigner) => send(sender, await markFailedInstructions({ launch, computeUnitPrice: 0n }));

/** A failed launch's seat returned to its wallet, built from the chain alone and sent by the wallet itself. */
export async function refund(launch: Address, wallet: KeyPairSigner) {
  const found = await seatOf(launch, wallet.address);
  if (!found) throw new Error(`${wallet.address} holds no seat in ${launch}`);
  return send(wallet, await withdrawFailedInstructions({ launch, seat: found.address, wallet: wallet.address, computeUnitPrice: 0n }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Brings back what a run left in a launch, whether it finished or stopped partway: waits until the launch may fail (its
 * window closed with a pot that cannot open, or 15 minutes after its open), marks it failed if nobody has, returns the
 * seats of `wallets` to them, and once no seat is left closes the launch, returning its creator's rent, so the sweep
 * after it leaves nothing behind in the program. The nonce's rent comes back only through the keeper (#46).
 */
export async function recoverDeposits(launch: Address, sender: KeyPairSigner, wallets: KeyPairSigner[]) {
  const seated: KeyPairSigner[] = [];
  for (const wallet of wallets) if (await seatOf(launch, wallet.address)) seated.push(wallet);
  while (seated.length) {
    const account = await fetchMaybeLaunch(rpc, launch);
    if (!account.exists) return;
    const now = await chainTime();
    const phase = fairOpenPhase(account.data, now);
    if (phase.phase === "failed") break;
    if (phase.phase === "failing") {
      await markFailed(launch, sender);
      break;
    }
    const until = phase.phase === "due" ? phase.lateAt : account.data.opensAt;
    console.log(`waiting ${until - now} s to bring back the deposits left in ${launch}`);
    await sleep(Number(until - now) * 1_000 + 2_000);
  }
  for (const wallet of seated) await refund(launch, wallet);
  const account = await fetchMaybeLaunch(rpc, launch);
  if (account.exists && account.data.seats === 0 && fairOpenPhase(account.data, await chainTime()).phase === "failed") {
    await send(sender, await closeLaunchInstructions({ launch, creator: account.data.creator, computeUnitPrice: 0n }));
  }
}
