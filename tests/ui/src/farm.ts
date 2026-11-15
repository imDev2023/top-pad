// The farm simulation's wallets and what it does through Heat's API rather than a page (farm-simulation.spec.ts): every
// wallet derives from the bank's key and the run's name, so a run stopped partway is swept back by name
// (`pnpm exec tsx tests/ui/src/farm-sweep.ts <run> [mint]`); a person links X on the stand-in and verifies a wallet once,
// as the Fair Open page does it, over plain HTTP; and a deposit is prepared by the API, which runs admission, signed by
// the wallet and sent.
import {
  getBase64Decoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  signBytes,
  signTransaction,
  type Address,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import { coinBalance, rpc, sweep } from "@top-pad/tests-devnet/devnet";
import { sellAll } from "@top-pad/tests-devnet/fair-open";
import { simulationWallet } from "@top-pad/tests-devnet/simulation";
import { TARGET } from "./target";

/** How many wallets the farm has, and how many honest depositors stand beside it (spec 11.1). */
export const FARM_SIZE = 100;
export const HONEST = 20;
/** Of the honest depositors, how many link X and verify their wallet once, so they are Scored (spec 6.3). */
export const SCORED = 12;
/** Wallets the Creator wallet funds: directly, and the last through one pass-through wallet. */
export const TIED = 4;

/** Every wallet of a farm run. */
export async function farmWallets(run: string) {
  const w = (label: string) => simulationWallet("farm", run, label);
  const many = (label: string, n: number) => Promise.all(Array.from({ length: n }, (_, i) => w(`${label} ${i}`)));
  const wallets = {
    creator: await w("creator"),
    root: await w("farm root"),
    farm: await many("farm", FARM_SIZE),
    honest: await many("honest", HONEST),
    tied: await many("tied", TIED),
    hop: await w("hop"),
  };
  return { ...wallets, all: [...wallets.farm, ...wallets.honest, ...wallets.tied, wallets.hop, wallets.root, wallets.creator] };
}

/** Cookies a browser would keep for the API, by name. */
type Jar = Map<string, string>;
const remember = (jar: Jar, res: Response) => {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const at = pair!.indexOf("=");
    jar.set(pair!.slice(0, at), pair!.slice(at + 1));
  }
};
const cookies = (jar: Jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

/**
 * Links X on the stand-in as `handle`, as a browser does from the Fair Open page: the API's start sends it to the
 * authorize page, the stand-in's "Authorize app" back to the API's callback, which starts the browser's session. The
 * session's cookies come back.
 */
export async function linkX(handle: string): Promise<Jar> {
  const jar: Jar = new Map();
  const start = await fetch(`${TARGET.api}/auth/x/start?return=/`, { redirect: "manual" });
  remember(jar, start);
  const authorize = new URL(start.headers.get("location")!);
  const form = new URLSearchParams(authorize.searchParams);
  form.set("username", handle);
  form.set("decision", "allow");
  const approved = await fetch(`${authorize.origin}${authorize.pathname}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  const callback = approved.headers.get("location");
  if (approved.status !== 302 || !callback) throw new Error(`the stand-in answered ${approved.status} to ${handle}'s approval`);
  const back = await fetch(callback, { redirect: "manual", headers: { cookie: cookies(jar) } });
  remember(jar, back);
  if (!new URL(back.headers.get("location")!).searchParams.get("x")?.startsWith("linked")) throw new Error(`linking X as ${handle} ended at ${back.headers.get("location")}`);
  return jar;
}

const post = (path: string, body: unknown, jar?: Jar) =>
  fetch(`${TARGET.api}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: TARGET.web, ...(jar ? { cookie: cookies(jar) } : {}) },
    body: JSON.stringify(body),
  });

/** Verifies `wallet` once for the X account linked in `jar`'s session: it signs Heat's message, no transaction. */
export async function verifyOnce(jar: Jar, wallet: KeyPairSigner) {
  const asked = await post("/verify/message", { wallet: wallet.address }, jar);
  const { message } = (await asked.json()) as { message: string };
  if (!asked.ok) throw new Error(`/verify/message answered ${asked.status}`);
  const signature = getBase64Decoder().decode(await signBytes(wallet.keyPair.privateKey, new TextEncoder().encode(message)));
  const verified = await post("/verify", { wallet: wallet.address, message, signature }, jar);
  if (!verified.ok) throw new Error(`/verify answered ${verified.status}: ${await verified.text()}`);
  return (await verified.json()) as { tier: string; handle: string };
}

/** What the API answered a deposit: the transaction it prepared, the wallet's admission, or the refusal. */
export type Prepared = { status: number; transaction?: string; admission?: { tier: string; cap: string }; error?: string; code?: string };

/**
 * Asks the API for a deposit, as the Fair Open page does: admission runs (the linkage pipeline, the creator's cluster,
 * one seat a person), and an admitted wallet gets the deposit with its admission to sign. A wallet whose funding the
 * API's node does not serve yet is told to try again, and is asked again.
 */
export async function prepareDeposit(launch: Address, wallet: Address, amount: bigint): Promise<Prepared> {
  for (let attempt = 0; ; attempt++) {
    const res = await post(`/fair-opens/${launch}/deposit`, { wallet, amount: `${amount}` });
    const body = (await res.json()) as Omit<Prepared, "status">;
    if (res.status === 503 && body.code === "unavailable" && attempt < 6) {
      await new Promise((r) => setTimeout(r, 3_000 * (attempt + 1)));
      continue;
    }
    return { status: res.status, ...body };
  }
}

/** A prepared transaction signed by `wallet`, as a wire, and its signature. */
export async function signPrepared(wallet: KeyPairSigner, transaction: string): Promise<{ wire: string; signature: Signature }> {
  const signed = await signTransaction([wallet.keyPair], getTransactionDecoder().decode(getBase64Encoder().encode(transaction)));
  return { wire: getBase64EncodedWireTransaction(signed), signature: getSignatureFromTransaction(signed) };
}

/** Sends a signed wire after preflight and waits for it to confirm. */
export async function sendConfirmed(wire: string, signature: Signature) {
  await rpc.sendTransaction(wire as never, { encoding: "base64", preflightCommitment: "confirmed" }).send();
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    if (value[0]?.err) throw new Error(`${signature} failed: ${JSON.stringify(value[0].err, (_k, v) => (typeof v === "bigint" ? `${v}` : v))}`);
    if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") return signature;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`${signature} did not confirm`);
}

/** Sells back what a run's wallets hold of its coin, then sends everything they hold back to the bank. */
export async function sweepFarm(run: string, mint: Address | null) {
  const w = await farmWallets(run);
  if (mint) {
    for (const wallet of [...w.honest, ...w.farm.slice(0, 2)]) {
      if ((await coinBalance(wallet.address, mint)) > 0n) await sellAll(wallet, mint).catch((e) => console.warn(`selling ${mint} from ${wallet.address} failed`, e));
    }
  }
  // A wallet the run never funded holds nothing: only those holding SOL are swept, a few at a time.
  const held: KeyPairSigner[] = [];
  for (let i = 0; i < w.all.length; i += 100) {
    const batch = w.all.slice(i, i + 100);
    const { value } = await rpc.getMultipleAccounts(batch.map((x) => x.address), { commitment: "confirmed", encoding: "base64" }).send();
    batch.forEach((x, j) => value[j] && held.push(x));
  }
  for (let i = 0; i < held.length; i += 4) await Promise.all(held.slice(i, i + 4).map((x) => sweep(x).catch((e) => console.warn(`sweeping ${x.address} failed`, e))));
}
