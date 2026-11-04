import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64Encoder,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Nonce,
} from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS } from "@top-pad/clients/dbc";
import { Tier } from "@top-pad/clients/fair-open";
import { describe, expect, it } from "vitest";
import cases from "./fixtures/allocations.json";
import { allocate, DEPOSIT_STEP, refundsInstructions, REFUND_SEATS, REFUND_SEATS_IN_TOKENS, rungAtOrBelow, type QuoteToken } from "./fairOpen";
import { CLUSTERS, FAIR_OPEN_PROGRAM_ADDRESS } from "./index";
import {
  creationInstructions,
  creationMessage,
  fairOpenLookupTableAddresses,
  pushInstructions,
  PUSH_SEATS,
  PUSH_SEATS_IN_TOKENS,
  seatOutcome,
  shareOf,
  signLadder,
  tokenBadgeAddress,
  type Creation,
} from "./open";
import { DEVNET_XSTOCK_STAND_IN } from "./quotes";
import { DEVNET_USDC } from "./index";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";

const devnet = CLUSTERS.devnet!;
const random = async () => (await generateKeyPairSigner()).address;
const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111";
const LIMIT = 1_232;

/** A creation for a launch on devnet's Fair Open config, with the longest coin a creator can enter. */
async function creation(over: Partial<Creation> = {}): Promise<Creation> {
  const [creator, keeper, mint] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
  return {
    launch: await random(),
    dbcConfig: devnet.configs!.fairOpen,
    quoteMint: devnet.quote.mint,
    creator,
    keeper,
    mint,
    // Metaplex's longest name and Heat's longest ticker; a Turbo URI is the gateway and a 43-character id.
    coin: { name: "N".repeat(32), ticker: "T".repeat(10), uri: `https://turbo-gateway.com/${"i".repeat(43)}` },
    rung: 1_615_000_000n,
    computeUnitPrice: 0n,
    ...over,
  };
}

const table = async () => ({ address: await random(), addresses: await fairOpenLookupTableAddresses(devnet) });
/** Devnet's stand-in xStock, a Token-2022 quote DBC takes only with its TokenBadge (ADR 0007). */
const XSTOCK: QuoteToken = { mint: DEVNET_XSTOCK_STAND_IN, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS };
/** A transaction's size, through the shared lookup table as our keeper sends it. */
async function pushSize(payer: Parameters<typeof setTransactionMessageFeePayerSigner>[0], ixs: Parameters<typeof appendTransactionMessageInstructions>[0]) {
  const { address: tableAddress, addresses } = await table();
  const message = compressTransactionMessageUsingAddressLookupTables(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 0n }, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    ),
    { [tableAddress]: addresses },
  );
  return getTransactionEncoder().encode(compileTransaction(message)).length;
}

describe("a seat's part of the open", () => {
  it("matches the program's shares, added up, on every fixture pot that opens", () => {
    let opens = 0;
    for (const c of cases) {
      const counts = new Array<number>(200).fill(0);
      const unverified = new Array<number>(10).fill(0);
      for (const [k, n] of c.counts as [number, number][]) counts[k] = n;
      for (const [k, n] of c.unverifiedCounts as [number, number][]) unverified[k] = n;
      const a = allocate(counts, unverified, DEPOSIT_STEP, BigInt(c.cap));
      const rung = rungAtOrBelow(BigInt(c.cap), a.spend);
      if (!c.open) {
        expect(rung === null || a.spend === 0n, c.name).toBe(true);
        continue;
      }
      opens++;
      const open = { spend: a.spend, spent: BigInt(c.open.rung), coins: BigInt(c.open.coins), othersLevel: a.others.level, unverifiedLevel: a.unverified.level };
      let [spent, bought] = [0n, 0n];
      for (const [list, tier] of [[counts, Tier.Scored], [unverified, Tier.Unverified]] as const) {
        list.forEach((n, k) => {
          const o = seatOutcome(open, tier, BigInt(k + 1) * DEPOSIT_STEP);
          expect(o.spent <= o.fill && o.fill <= BigInt(k + 1) * DEPOSIT_STEP).toBe(true);
          spent += o.spent * BigInt(n);
          bought += o.coins * BigInt(n);
        });
      }
      expect([spent, bought], c.name).toEqual([BigInt(c.open.spent), BigInt(c.open.bought)]);
    }
    expect(opens).toBeGreaterThan(390);
  });

  it("rounds a seat's spend up and its coins down", () => {
    expect(shareOf(1n, 3n, 2n, 2n)).toEqual({ spent: 1n, coins: 0n });
    expect(shareOf(240_000_000n, 15_000_000_000n, 14_250_000_000n, 300_000_000_000_000n)).toEqual({ spent: 228_000_000n, coins: 4_800_000_000_000n });
    expect(shareOf(5n, 0n, 0n, 0n)).toEqual({ spent: 0n, coins: 0n });
  });
});

describe("the creation transaction", () => {
  it("is in the order the open checks, the pot's buy passing the instructions sysvar", async () => {
    const c = await creation();
    const ixs = await creationInstructions(c);
    const programs = ixs.map((ix) => ix.programAddress);
    expect(programs.slice(1)).toEqual([
      FAIR_OPEN_PROGRAM_ADDRESS,
      DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
      ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
      FAIR_OPEN_PROGRAM_ADDRESS,
    ]);
    const swap = ixs[4]!;
    expect(swap.accounts!).toHaveLength(16);
    expect(swap.accounts!.at(-1)!.address).toBe(SYSVAR_INSTRUCTIONS);
    // The pot's buy, exact in, of exactly the rung.
    expect(Buffer.from(swap.data!).readBigUInt64LE(8)).toBe(c.rung);
    expect(swap.data![24]).toBe(0);
    // DBC's pool creation names the creator as a signer and our keeper as the payer of its accounts.
    const init = ixs[2]!.accounts!;
    expect([init[2]!.address, init[10]!.address]).toEqual([c.creator.address, c.keeper.address]);
  });

  it("fits a transaction with the shared lookup table, its longest coin included, and not without it", async () => {
    const c = await creation();
    const lifetime = { nonce: await random(), value: "11111111111111111111111111111111" as Nonce, authority: c.keeper.address };
    const message = await creationMessage(c, lifetime, await table());
    const ixs = await creationInstructions(c);
    const size = getTransactionEncoder().encode(compileTransaction(message)).length;
    console.log(`the creation transaction: ${size} bytes with the lookup table`);
    expect(size).toBeLessThanOrEqual(LIMIT);
    // The durable nonce's advance comes first, as a nonce transaction requires.
    expect(message.instructions[0]!.programAddress).toBe(SYSTEM_PROGRAM_ADDRESS);

    // The same transaction with every address in full would not fit.
    const plain = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(c.keeper, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 0n }, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
    expect(getTransactionEncoder().encode(compileTransaction(plain)).length).toBeGreaterThan(LIMIT);
  });

  it("fits in a Token-2022 quote with DBC's TokenBadge, with room for a compute unit price, by the shared table", async () => {
    const nonce = await random();
    const sizeOf = async (c: Creation) => {
      const lifetime = { nonce, value: "11111111111111111111111111111111" as Nonce, authority: c.keeper.address };
      return getTransactionEncoder().encode(compileTransaction(await creationMessage(c, lifetime, await table()))).length;
    };
    const priced = { computeUnitPrice: 1n };
    const xstock = await creation({ ...priced, quoteMint: XSTOCK.mint, quoteTokenProgram: XSTOCK.tokenProgram, quoteBadge: true });
    const ixs = await creationInstructions(xstock);
    const init = ixs[3]!;
    expect(init.accounts!.at(-1)!.address).toBe(await tokenBadgeAddress(XSTOCK.mint));
    expect(init.accounts![11]!.address).toBe(XSTOCK.tokenProgram);
    expect(ixs[5]!.accounts![11]!.address).toBe(XSTOCK.tokenProgram);
    expect(ixs[2]!.accounts!.find((a) => a.address === XSTOCK.tokenProgram)).toBeTruthy();
    const [inSol, inXstock, inUsdc] = [
      await sizeOf(await creation(priced)),
      await sizeOf(xstock),
      await sizeOf(await creation({ ...priced, quoteMint: DEVNET_USDC })),
    ];
    console.log(`the creation transaction with a compute unit price: ${inSol} bytes in SOL, ${inXstock} in an xStock, ${inUsdc} in USDC`);
    // The table holds the listed quotes' mints, their badges and Token-2022, so each costs a byte, not 32.
    expect(inXstock).toBeLessThanOrEqual(inSol + 3);
    expect(inUsdc).toBe(inSol);
    // A Token-2022 quote the table does not list still fits, priced, its mint and badge 32 bytes each (#88); before the
    // table held Token-2022 too, an unpriced creation in one came to exactly the 1,232-byte limit.
    const unlisted = await creation({ ...priced, quoteMint: await random(), quoteTokenProgram: XSTOCK.tokenProgram, quoteBadge: true });
    const inUnlisted = await sizeOf(unlisted);
    console.log(`in a Token-2022 quote the table does not list: ${inUnlisted} bytes`);
    expect(inUnlisted).toBe(inXstock + 2 * 31);
    expect(inUnlisted).toBeLessThanOrEqual(LIMIT);
  });

  it("signs a 64-rung ladder on one nonce, each rung complete", async () => {
    const c = await creation();
    const ladder = await signLadder({ ...c, potCap: 1_700_000_000n, nonce: await random(), nonceValue: "11111111111111111111111111111111" as Nonce, table: await table() });
    expect(ladder).toHaveLength(64);
    expect(ladder[0]!.rung).toBe(1_700_000_000n);
    expect(new Set(ladder.map((r) => r.transaction)).size).toBe(64);
    expect(Math.max(...ladder.map((r) => r.bytes))).toBeLessThanOrEqual(LIMIT);
  });
});

describe("a ladder signed in parts", () => {
  it("leaves the signatures of signers that cannot sign here for the wallet and our keeper to fill", async () => {
    const c = await creation();
    const creator = createNoopSigner(c.creator.address);
    const keeper = createNoopSigner(c.keeper.address);
    const ladder = await signLadder({ ...c, creator, keeper, potCap: 1_700_000_000n, nonce: await random(), nonceValue: "11111111111111111111111111111111" as Nonce, table: await table() });
    for (const { transaction } of ladder) {
      const signatures = getTransactionDecoder().decode(getBase64Encoder().encode(transaction)).signatures;
      expect(signatures[c.mint.address]).toBeTruthy();
      expect(signatures[c.creator.address]).toBeNull();
      expect(signatures[c.keeper.address]).toBeNull();
    }
  });
});

describe("a push", () => {
  it("fits its seats in a transaction with the shared lookup table", async () => {
    const [payer, launch, mint] = await Promise.all([generateKeyPairSigner(), random(), random()]);
    const seats = await Promise.all(Array.from({ length: PUSH_SEATS }, async () => ({ seat: await random(), wallet: await random() })));
    const ixs = await pushInstructions({ launch, mint, payer, seats, computeUnitPrice: 1n });
    const { address: tableAddress, addresses } = await table();
    const message = compressTransactionMessageUsingAddressLookupTables(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(payer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 0n }, m),
        (m) => appendTransactionMessageInstructions(ixs, m),
      ),
      { [tableAddress]: addresses },
    );
    const size = getTransactionEncoder().encode(compileTransaction(message)).length;
    console.log(`a push of ${PUSH_SEATS} seats: ${size} bytes`);
    expect(size).toBeLessThanOrEqual(LIMIT);
    // Each seat brings its seat, its wallet and the wallet's coin account; the token quote's three are left out.
    expect(ixs.at(-1)!.accounts!.length).toBe(13 + 3 * PUSH_SEATS);
  });

  it(`fits ${PUSH_SEATS_IN_TOKENS} seats in a token quote, each with its wallet's account of the quote`, async () => {
    const [payer, launch, mint] = await Promise.all([generateKeyPairSigner(), random(), random()]);
    const seats = await Promise.all(Array.from({ length: PUSH_SEATS_IN_TOKENS }, async () => ({ seat: await random(), wallet: await random() })));
    const ixs = await pushInstructions({ launch, mint, payer, seats, computeUnitPrice: 1n, quote: XSTOCK });
    const size = await pushSize(payer, ixs);
    console.log(`a push of ${PUSH_SEATS_IN_TOKENS} seats in a Token-2022 quote: ${size} bytes`);
    expect(size).toBeLessThanOrEqual(LIMIT);
    // The pot, the quote and its program, then four accounts a seat.
    expect(ixs.at(-1)!.accounts!.length).toBe(13 + 4 * PUSH_SEATS_IN_TOKENS);
    // One seat more would not fit.
    const more = [...seats, { seat: await random(), wallet: await random() }];
    expect(await pushSize(payer, await pushInstructions({ launch, mint, payer, seats: more, computeUnitPrice: 1n, quote: XSTOCK }))).toBeGreaterThan(LIMIT);
  });
});

describe("the refunds of a failed launch", () => {
  it(`fit ${REFUND_SEATS} seats in SOL and ${REFUND_SEATS_IN_TOKENS} in a token quote`, async () => {
    const payer = await generateKeyPairSigner();
    const launch = await random();
    for (const [quote, n] of [[undefined, REFUND_SEATS], [XSTOCK, REFUND_SEATS_IN_TOKENS]] as const) {
      const seats = await Promise.all(Array.from({ length: n }, async () => ({ seat: await random(), wallet: await random() })));
      const size = await pushSize(payer, await refundsInstructions({ launch, seats, computeUnitPrice: 1n, quote }));
      console.log(`refunds of ${n} seats ${quote ? "in a Token-2022 quote" : "in SOL"}: ${size} bytes`);
      // With room to spare, for a seat more.
      expect(size).toBeLessThanOrEqual(LIMIT - 130);
    }
  });
});

describe("the shared lookup table", () => {
  it("holds every common address once", async () => {
    const addresses = await fairOpenLookupTableAddresses(devnet);
    expect(new Set(addresses).size).toBe(addresses.length);
    expect(addresses).toContain(devnet.configs!.fairOpen as Address);
    expect(addresses).toContain(address(SYSVAR_INSTRUCTIONS));
    // Token-2022 and the listed quotes, with the badge of the one DBC takes only with it (#88).
    expect(addresses).toEqual(expect.arrayContaining([TOKEN_2022_PROGRAM_ADDRESS, DEVNET_USDC, XSTOCK.mint, await tokenBadgeAddress(XSTOCK.mint)]));
    expect(addresses).not.toContain(await tokenBadgeAddress(DEVNET_USDC));
  });
});
