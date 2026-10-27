// Copied from Stoker (github.com/imDev2023/Stoker-Markets) at commit 43e196b: packages/arweave/src/turbo.ts.
// ArDrive Turbo's HTTP API, the part a launchpad uses: upload a signed data item, see what it costs, and buy credits
// with SOL. The SDK (@ardrive/turbo-sdk) runs in a Worker too (spike/turbo-workers), but these few calls need none of
// its weight. Endpoints as the SDK calls them (packages/turbo-sdk/src/common/{upload,payment}.ts).
import { plainBytes } from "./dataItem";

export type TurboUrls = {
  /** https://upload.ardrive.io */
  upload: string;
  /** https://payment.ardrive.io */
  payment: string;
};

/** What the upload service answers: the item's id and what it charged in winc ("0" when free, or already held). */
export type UploadReceipt = {
  id: string;
  winc: string;
  timestamp: number;
  version: string;
  deadlineHeight: number;
  owner: string;
  dataCaches: string[];
  fastFinalityIndexes: string[];
};

/** The upload service wants paying: the wallet's credits do not cover the item. */
export class PaymentRequired extends Error {
  constructor(readonly bytes: number) {
    super(`Turbo wants paying for an upload of ${bytes} bytes`);
  }
}

export class TurboError extends Error {
  constructor(readonly status: number, body: string, what: string) {
    super(`${what} failed with ${status}: ${body.slice(0, 300)}`);
  }
}

async function failed(res: Response, what: string) {
  return new TurboError(res.status, await res.text().catch(() => ""), what);
}

/** Posts one signed data item. The service holds every item by its id, so sending one twice charges nothing twice. */
export async function uploadDataItem(urls: TurboUrls, bytes: Uint8Array): Promise<UploadReceipt> {
  const res = await fetch(`${urls.upload}/v1/tx/solana`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "content-length": String(bytes.byteLength) },
    body: plainBytes(bytes),
  });
  if (res.status === 402) throw new PaymentRequired(bytes.byteLength);
  if (!res.ok) throw await failed(res, "upload");
  return (await res.json()) as UploadReceipt;
}

/** The wallet's credits, in winc; a wallet the service has never seen holds none. */
export async function creditBalance(urls: TurboUrls, address: string): Promise<bigint> {
  const res = await fetch(`${urls.payment}/v1/account/balance/solana?address=${address}`);
  if (res.status === 404) return 0n;
  if (!res.ok) throw await failed(res, "balance");
  return BigInt(((await res.json()) as { winc: string }).winc);
}

/** What the service charges for an item of this many bytes, in winc, before any free allowance. */
export async function priceForBytes(urls: TurboUrls, bytes: number): Promise<bigint> {
  const res = await fetch(`${urls.payment}/v1/price/bytes/${bytes}`);
  if (!res.ok) throw await failed(res, "price");
  return BigInt(((await res.json()) as { winc: string }).winc);
}

/** The credits this many lamports buy, after the service's fee. */
export async function wincForLamports(urls: TurboUrls, lamports: bigint): Promise<bigint> {
  const res = await fetch(`${urls.payment}/v1/price/solana/${lamports}`);
  if (!res.ok) throw await failed(res, "price in SOL");
  return BigInt(((await res.json()) as { winc: string }).winc);
}

/** The service's SOL deposit address, read live and never hard-coded. */
export async function depositAddress(urls: TurboUrls): Promise<string> {
  const res = await fetch(`${urls.payment}/v1/info`);
  if (!res.ok) throw await failed(res, "info");
  const info = (await res.json()) as { addresses?: { solana?: string } };
  if (!info.addresses?.solana) throw new Error("Turbo's info names no SOL deposit address");
  return info.addresses.solana;
}

export type CreditResult =
  | { status: "credited"; winc: string }
  | { status: "pending" }
  | { status: "failed"; reason: string };

/**
 * Tells the payment service about a SOL transfer to its deposit address, so the sender's credits grow. The transfer
 * must be finalized; until then the service answers pending, and the same transaction can be submitted again.
 */
export async function creditTransfer(urls: TurboUrls, signature: string): Promise<CreditResult> {
  const res = await fetch(`${urls.payment}/v1/account/balance/solana`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tx_id: signature }),
  });
  if (!res.ok) throw await failed(res, "credit top-up");
  const body = (await res.json()) as {
    creditedTransaction?: { winstonCreditAmount: string };
    pendingTransaction?: unknown;
    failedTransaction?: { failedReason?: string };
  };
  if (body.creditedTransaction) return { status: "credited", winc: body.creditedTransaction.winstonCreditAmount };
  if (body.pendingTransaction) return { status: "pending" };
  if (body.failedTransaction) return { status: "failed", reason: body.failedTransaction.failedReason ?? "the service refused the transaction" };
  throw new Error(`unexpected answer to a top-up: ${JSON.stringify(body).slice(0, 300)}`);
}
