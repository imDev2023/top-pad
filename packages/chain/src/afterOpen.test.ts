import {
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  generateKeyPairSigner,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  collectTaxShareInstructions,
  creatorLockEscrowAddress,
  creatorLockerAddress,
  lockCreatorInstructions,
  pushTaxShareInstructions,
  TAX_SHARE_SEATS,
  taxShareOf,
} from "./afterOpen";
import { CLUSTERS } from "./index";
import { fairOpenLookupTableAddresses } from "./open";

const devnet = CLUSTERS.devnet!;
const random = async () => (await generateKeyPairSigner()).address;
const LIMIT = 1_232;

/** A transaction's size, our keeper paying, through Heat's shared lookup table as the keeper sends it. */
async function size(payer: TransactionSigner, ixs: Instruction[]): Promise<number> {
  const message = compressTransactionMessageUsingAddressLookupTables(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 0n }, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    ),
    { [await random()]: await fairOpenLookupTableAddresses(devnet) },
  );
  return getTransactionEncoder().encode(compileTransaction(message)).length;
}

describe("the Tax Share", () => {
  it("pays every lamport of the total, in any order, each seat within a lamport of its share", () => {
    const fills = [425_000_000n, 425_000_000n, 70_833_333n, 70_833_333n, 1n];
    const basis = fills.reduce((a, b) => a + b);
    for (const total of [0n, 1n, 7n, 990_000n, 123_456_789_011n]) {
      for (const order of [[0, 1, 2, 3, 4], [4, 3, 2, 1, 0], [2, 4, 0, 3, 1]]) {
        let paid = 0n;
        let out = 0n;
        for (const i of order) {
          const share = taxShareOf(total, basis, paid, fills[i]!);
          const exact = (Number(total) * Number(fills[i])) / Number(basis);
          expect(Math.abs(Number(share) - exact)).toBeLessThan(1);
          paid += fills[i]!;
          out += share;
        }
        expect(out).toBe(total);
      }
    }
  });

  it(`pushes ${TAX_SHARE_SEATS} seats in a transaction through the shared lookup table`, async () => {
    const [payer, launch] = await Promise.all([generateKeyPairSigner(), random()]);
    const seats = await Promise.all(Array.from({ length: TAX_SHARE_SEATS }, async () => ({ seat: await random(), wallet: await random() })));
    const ixs = await pushTaxShareInstructions({ launch, seats, computeUnitPrice: 1n });
    const bytes = await size(payer, ixs);
    console.log(`a Tax Share push of ${TAX_SHARE_SEATS} seats: ${bytes} bytes`);
    expect(bytes).toBeLessThanOrEqual(LIMIT);
    // One seat more would not fit.
    const more = [...seats, { seat: await random(), wallet: await random() }];
    expect(await size(payer, await pushTaxShareInstructions({ launch, seats: more, computeUnitPrice: 1n }))).toBeGreaterThan(LIMIT);
  });

  it("collects in a transaction our keeper sends", async () => {
    const payer = await generateKeyPairSigner();
    const pool = {
      pool: await random(),
      config: devnet.configs!.fairOpen,
      mint: await random(),
      quoteMint: devnet.quote.mint,
      baseVault: await random(),
      quoteVault: await random(),
      creator: await random(),
      partnerQuoteFee: 0n,
      windowEndsAt: 0n,
    };
    const ixs = await collectTaxShareInstructions({ launch: await random(), pool, treasury: devnet.keys!.treasury, computeUnitPrice: 1n });
    expect(await size(payer, ixs)).toBeLessThanOrEqual(LIMIT);
  });
});

describe("the Creator lock", () => {
  it("sends its coins into the escrow of the launch's own locker", async () => {
    const payer = await generateKeyPairSigner();
    const launch = await random();
    const ixs = await lockCreatorInstructions({ launch, creator: await random(), seat: await random(), mint: await random(), pool: await random(), computeUnitPrice: 1n });
    const lock = ixs.at(-1)!;
    const accounts = lock.accounts!.map((a) => a.address);
    expect(accounts[7]).toBe(await creatorLockerAddress(launch));
    expect(accounts[8]).toBe(await creatorLockEscrowAddress(launch));
    expect(await size(payer, ixs)).toBeLessThanOrEqual(LIMIT);
  });
});
