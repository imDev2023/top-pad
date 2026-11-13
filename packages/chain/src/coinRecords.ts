// The `CoinRecord` list (spec 8, #57): every coin our launch key co-signed is registered in the fee program, one account
// per coin, and only those are Heat coins. The API mirrors the list, and each day publishes a snapshot of it signed by
// the launch key; anyone can check a snapshot against the chain with what is here.
import {
  getBase58Decoder,
  getBase58Encoder,
  getBase64Encoder,
  getPublicKeyFromAddress,
  signBytes,
  verifySignature,
  type Address,
  type GetProgramAccountsApi,
  type KeyPairSigner,
  type Rpc,
  type SignatureBytes,
} from "@solana/kit";
import { COIN_RECORD_DISCRIMINATOR, FEE_PROGRAM_ADDRESS, getCoinRecordDecoder, LaunchMode } from "@top-pad/clients/fee";
import { COIN_RECORD_SNAPSHOT_PREFIX, CoinRecordSnapshotBody, type CoinRecordEntry, type CoinRecordSnapshot } from "@top-pad/contract";

/** One `CoinRecord` as the chain holds it. */
export type ChainCoinRecord = Omit<CoinRecordEntry, "slot">;

/** Every `CoinRecord` the fee program holds: one `getProgramAccounts`, filtered by the account's discriminator. */
export async function readCoinRecords(rpc: Rpc<GetProgramAccountsApi>, signal?: AbortSignal): Promise<ChainCoinRecord[]> {
  const accounts = await rpc
    .getProgramAccounts(FEE_PROGRAM_ADDRESS, {
      encoding: "base64",
      filters: [{ memcmp: { offset: 0n, bytes: getBase58Decoder().decode(COIN_RECORD_DISCRIMINATOR) as never, encoding: "base58" } }],
    })
    .send({ abortSignal: signal });
  const decoder = getCoinRecordDecoder();
  return accounts.map(({ account }) => {
    const record = decoder.decode(getBase64Encoder().encode(account.data[0]));
    return {
      mint: record.mint,
      pool: record.pool,
      launchMode: record.launchMode === LaunchMode.FairOpen ? "fair_open" : "instant",
      fairOpenLaunch: record.fairOpenLaunch.__option === "Some" ? record.fairOpenLaunch.value : null,
      registeredAt: new Date(Number(record.registeredAt) * 1000).toISOString(),
    };
  });
}

/** How a snapshot and the chain differ: coins the chain lists that the snapshot lacks, the reverse, and disagreements. */
export type CoinRecordMismatches = { missing: string[]; extra: string[]; different: string[] };

/**
 * Compares a snapshot's coins with the chain's records registered before it ended (records registered later are not
 * expected in it): the same mints, each with the same pool, launch mode and Fair Open launch.
 */
export function compareCoinRecords(snapshot: readonly ChainCoinRecord[], chain: readonly ChainCoinRecord[], through: Date): CoinRecordMismatches {
  const due = chain.filter((r) => new Date(r.registeredAt).getTime() < through.getTime());
  const listed = new Map(snapshot.map((c) => [c.mint, c]));
  const onChain = new Map(chain.map((c) => [c.mint, c]));
  const same = (a: ChainCoinRecord, b: ChainCoinRecord) => a.pool === b.pool && a.launchMode === b.launchMode && a.fairOpenLaunch === b.fairOpenLaunch;
  return {
    missing: due.filter((r) => !listed.has(r.mint)).map((r) => r.mint),
    extra: snapshot.filter((c) => !onChain.has(c.mint)).map((c) => c.mint),
    different: snapshot.filter((c) => onChain.has(c.mint) && !same(c, onChain.get(c.mint)!)).map((c) => c.mint),
  };
}

const utf8 = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the launch key signs for a snapshot body: the prefix and the body's SHA-256, hex. */
export async function snapshotMessage(body: string): Promise<{ sha256: string; message: string }> {
  const sha256 = await sha256Hex(body);
  return { sha256, message: `${COIN_RECORD_SNAPSHOT_PREFIX}${sha256}` };
}

/** Signs a snapshot body with the launch key: its hash, the message and the Ed25519 signature, base58. */
export async function signSnapshot(body: string, signer: KeyPairSigner): Promise<{ sha256: string; message: string; signature: string }> {
  const { sha256, message } = await snapshotMessage(body);
  const signature = getBase58Decoder().decode(await signBytes(signer.keyPair.privateKey, utf8.encode(message)));
  return { sha256, message, signature };
}

/**
 * Checks a published snapshot on its own: its body hashes to `sha256`, its message is the prefix and that hash, its
 * signature is `launchKey`'s on the message, and its body names that launch key. Returns the body, or throws saying what
 * failed.
 */
export async function verifySnapshot(snapshot: Pick<CoinRecordSnapshot, "body" | "sha256" | "message" | "signer" | "signature">, launchKey: Address): Promise<CoinRecordSnapshotBody> {
  const { sha256, message } = await snapshotMessage(snapshot.body);
  if (sha256 !== snapshot.sha256) throw new Error(`the body hashes to ${sha256}, not ${snapshot.sha256}`);
  if (message !== snapshot.message) throw new Error(`the signed message should be ${message}`);
  if (snapshot.signer !== launchKey) throw new Error(`signed by ${snapshot.signer}, not the launch key ${launchKey}`);
  const key = await getPublicKeyFromAddress(launchKey);
  const signature = getBase58Encoder().encode(snapshot.signature) as SignatureBytes;
  if (!(await verifySignature(key, signature, utf8.encode(message)))) throw new Error("the signature is not the launch key's on the message");
  const body = CoinRecordSnapshotBody.parse(JSON.parse(snapshot.body));
  if (body.launchKey !== launchKey) throw new Error(`the body names ${body.launchKey} as the launch key`);
  return body;
}
