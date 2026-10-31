// Fair Opens on devnet for the tests here and in tests/ui (spec 2.1, 5.3): a launch scheduled by script, as this build
// schedules them, deposits admitted with the devnet admission key straight to the program, the creator's ladder signed
// at scheduling, and the open, pushes and nonce close our keeper's Workflow will send (#47), for what only the chain can
// show. The keeper and admission keys are this Mac's (~/.config/top-pad/devnet).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createKeyPairFromBytes,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  generateKeyPairSigner,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getUtf8Encoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Base58EncodedBytes,
  type Instruction,
  type KeyPairSigner,
  type Nonce,
} from "@solana/kit";
import { fetchNonce } from "@solana-program/system";
import { findAssociatedTokenPda, getCloseAccountInstruction } from "@solana-program/token";
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
  potCapOf,
  pushInstructions,
  PUSH_SEATS,
  SEAT_LAYOUT,
  swapInstructions,
  TOKEN_PROGRAM_ADDRESS,
  closeNonceInstruction,
  creationInstructions,
  dbcPoolAddress,
  fetchLookupTable,
  signAdmission,
  signLadder,
  Tier,
  tierCap,
  withdrawFailedInstructions,
  withdrawInstructions,
  type Admission,
  type Creation,
  type LookupTable,
  type SignedRung,
} from "@top-pad/chain";
import { fetchMaybeLaunch, getSeatDecoder, getSeatSize, type Seat } from "@top-pad/clients/fair-open";
import { bankFile, chainTime, coinBalance, devnet, rpc, send } from "./devnet";

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

/**
 * A launch's test depositors: wallets derived from Heat's bank key and the launch, so a later run can find them again,
 * as #49 must to pay out each seat's Tax Share and its own rent, which stay in the seat after the open.
 */
export async function depositorsOf(launch: Address, count: number): Promise<KeyPairSigner[]> {
  const secret = Uint8Array.from(JSON.parse(readFileSync(bankFile, "utf8")) as number[]).slice(0, 32);
  const launchBytes = getAddressEncoder().encode(launch);
  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const label = getUtf8Encoder().encode(`heat devnet depositor ${i}`);
      const seed = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...secret, ...launchBytes, ...label])));
      return createKeyPairSignerFromPrivateKeyBytes(seed);
    }),
  );
}

/** Heat's shared lookup table on devnet, read from the chain. */
export async function lookupTable(): Promise<LookupTable> {
  return fetchLookupTable(rpc, devnet.lookupTable!);
}

/**
 * The creator's ladder for a scheduled launch (ADR 0005), signed now on its nonce by the creator, our keeper and a new
 * mint key, which comes back too, for a test that signs a transaction of another shape with it.
 */
export async function signedLadder(s: ScheduledFairOpen): Promise<{ ladder: SignedRung[]; mint: KeyPairSigner }> {
  const mint = await generateKeyPairSigner();
  const { data: nonce } = await fetchNonce(rpc, s.nonce, { commitment: "confirmed" });
  const ladder = await signLadder({
    launch: s.launch,
    dbcConfig: devnet.configs!.fairOpen,
    quoteMint: devnet.quote.mint,
    creator: s.creator,
    keeper: await keeper(),
    mint,
    coin: s.coin,
    computeUnitPrice: 0n,
    potCap: potCapOf(devnet.graduationTarget),
    nonce: s.nonce,
    nonceValue: nonce.blockhash as string as Nonce,
    table: await lookupTable(),
  });
  return { ladder, mint };
}

/**
 * A creation transaction signed now, on a recent blockhash, as a creator signing at the open would, through the shared
 * lookup table; with `extra` after it for a transaction of another shape. Base64, for a test to simulate or send.
 */
export async function creationSignedNow(c: Creation, extra: Instruction[] = []): Promise<string> {
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const { address, addresses } = await lookupTable();
  const instructions = [...(await creationInstructions(c)), ...extra];
  const transaction = await signTransactionMessageWithSigners(
    compressTransactionMessageUsingAddressLookupTables(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(c.keeper, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      ),
      { [address]: addresses },
    ),
  );
  return getBase64EncodedWireTransaction(transaction);
}

/** Pushes seats their coins and refund, `PUSH_SEATS` a transaction, our keeper paying; the push signatures. */
export async function pushAll(launch: Address, mint: Address, seats: { seat: Address; wallet: Address }[]): Promise<string[]> {
  const payer = await keeper();
  const { address, addresses } = await lookupTable();
  const signatures: string[] = [];
  for (let i = 0; i < seats.length; i += PUSH_SEATS) {
    const instructions = await pushInstructions({ launch, mint, payer, seats: seats.slice(i, i + PUSH_SEATS), computeUnitPrice: 0n });
    signatures.push(await send(payer, instructions, { [address]: addresses }));
  }
  return signatures;
}

/** Our keeper closes a launch's nonce once it has opened or failed, its rent going to the creator; null if it is gone. */
export async function closeNonce(nonce: Address, creator: Address): Promise<string | null> {
  const { value: lamports } = await rpc.getBalance(nonce, { commitment: "confirmed" }).send();
  if (lamports === 0n) return null;
  const signer = await keeper();
  return send(signer, [closeNonceInstruction({ nonce, keeper: signer, creator, lamports })]);
}

/** Sells back every coin a wallet holds of `mint` once the tax window is over, and closes its coin account. */
export async function sellAll(wallet: KeyPairSigner, mint: Address) {
  const coins = await coinBalance(wallet.address, mint);
  if (coins === 0n) return;
  const pool = await dbcPoolAddress(devnet.configs!.fairOpen, mint, devnet.quote.mint);
  const [coinAccount] = await findAssociatedTokenPda({ owner: wallet.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const sell = await swapInstructions({ config: devnet.configs!.fairOpen, pool, mint, quoteMint: devnet.quote.mint, trader: wallet, side: "sell", amountIn: coins, minimumOut: 1n });
  await send(wallet, [...sell, getCloseAccountInstruction({ account: coinAccount, destination: wallet.address, owner: wallet })]);
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
 * seats of `wallets` to them, and once no seat is left closes the launch, returning its creator's rent, and our keeper
 * closes its nonce, so the sweep after it leaves nothing behind. A launch that opened is left to its own test.
 */
export async function recoverDeposits(launch: Address, sender: KeyPairSigner, wallets: KeyPairSigner[]) {
  const seated: KeyPairSigner[] = [];
  for (const wallet of wallets) if (await seatOf(launch, wallet.address)) seated.push(wallet);
  // A launch with no seat left still holds its creator's rent, so it is failed and closed too.
  for (;;) {
    const account = await fetchMaybeLaunch(rpc, launch);
    if (!account.exists) return;
    const now = await chainTime();
    const phase = fairOpenPhase(account.data, now);
    if (phase.phase === "opened") return;
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
  if (!account.exists || fairOpenPhase(account.data, await chainTime()).phase !== "failed") return;
  if (account.data.seats === 0) await send(sender, await closeLaunchInstructions({ launch, creator: account.data.creator, computeUnitPrice: 0n }));
  await closeNonce(account.data.nonce, account.data.creator);
}
