import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getBase58Encoder } from "@solana/kit";
import { CLUSTERS } from "@top-pad/chain";
import { EVT_SWAP3_EVENT_DISCRIMINATOR } from "@top-pad/clients/dbc";
import { dammPoolsIn, decodeTransaction, type RawTransaction } from "./decode";

// Real devnet transactions (2026-10-29): an Instant launch whose creator bought in the same transaction, paying the
// 99% cliff (tests/devnet), a launch from the launch flow with no buy, and a coin's window claim and its creator's first
// claim (tests/devnet/src/fee-claims.test.ts). And two Fair Opens (2026-10-30): one through its page end to end
// (tests/ui/src/fair-open.spec.ts), its pot missing the minimum raise, and one failed 15 minutes late and closed
// (tests/devnet/src/fair-open.test.ts). And a coin's Graduation on devnet's rehearsal config (2026-11-02,
// tests/devnet/src/graduation.test.ts): the buy that completed its curve, the migration, the surplus split and the
// leftover burnt, a buy and a sell on its DAMM v2 pool, Heat's LP fee claim and the creator's claim of both earnings.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as RawTransaction;
const { instant, fairOpen } = CLUSTERS.devnet!.configs!;
const HEAT = new Set<string>([instant, fairOpen]);
const base58 = getBase58Encoder();

const E2E_LAUNCH = "FLdTZ9qAbNVp4QTvdS8TyK3Vbnidy9DxSBowRdZ3yRLJ";
const DEPOSITOR = "ExjeR7CttzZhwoDyzbFptwXeWwMauYLZs1LTPerAJMoo";
const PERSON = "37b3121364e33954eee4c3225e8704a4e24e4b7fcfe60faad3d41aed77554fce";
const LATE_LAUNCH = "8EQ7fu8Fb4gt7jNqmnkSFk9Htx1oRKxapgwyQ9sp21xf";

describe("decoding a transaction", () => {
  it("finds a launch's pool, its coin's registration and the creator's creation-slot buy at the 99% cliff", () => {
    const decoded = decodeTransaction(fixture("launch-with-creator-buy"), HEAT);
    const pool = "HLzYgbHReBQxdungMNakZT72MFQrjmkDWhJk773CWKkw";
    const mint = "EcQZjuhGWVjF3GjSPj6e9XzCchMy7B338Ug9VNgraf1L";
    const creator = "3hTTgfj2YqqYJeEgSF49U8ZyZwyHnwPhF9LRsXy4fMY8";
    expect(decoded.pools).toEqual([
      expect.objectContaining({ pool, mint, config: instant, creator, activationPoint: 1_793_247_380n }),
    ]);
    expect(decoded.pools[0]!.ticker).toMatch(/^[A-Z0-9]{2,10}$/);
    expect(decoded.pools[0]!.uri).toMatch(/^https:\/\//);
    expect(decoded.coins).toEqual([{ mint, pool, config: instant, creator, launchMode: "instant" }]);
    expect(decoded.swaps).toEqual([
      {
        eventIndex: 0,
        venue: "curve",
        pool,
        mint,
        config: instant,
        trader: creator,
        side: "buy",
        quoteAmount: 10_000_000n,
        baseAmount: 26_962_757_915n,
        fee: 9_900_000n,
        sqrtPrice: 35_525_545_851_457_242n,
        quoteReserve: 100_000n,
        timestamp: 1_793_247_380n,
      },
    ]);
  });

  it("finds a plain launch's pool and registration, and no trade", () => {
    const decoded = decodeTransaction(fixture("launch"), HEAT);
    expect(decoded.pools).toHaveLength(1);
    expect(decoded.coins).toHaveLength(1);
    expect(decoded.swaps).toEqual([]);
  });

  it("finds a window claim: the Tax window's fees paid to the treasury, three seconds after the window ended", () => {
    const decoded = decodeTransaction(fixture("window-claim"), HEAT);
    expect(decoded.windowClaims).toEqual([
      {
        pool: "D5Wtpu6jo7a63EEWXBhxWPQQmFafbLn4wxMH5CGh7FDP",
        mint: "BNSwjpDtyeewLsiMXdh7YpngXjPKgDgVvnanMPu8g593",
        config: instant,
        heat: true,
        // The treasury's wrapped SOL account.
        destination: "CrQJCsFgWLETU8vPcavPV6SWyQsVSFJ5RkYxckpXWXu7",
        amount: 15_818_667n,
        windowEndedAt: 1_793_306_730n,
        claimedAt: 1_793_306_733n,
      },
    ]);
    expect([decoded.pools, decoded.coins, decoded.swaps, decoded.feeClaims]).toEqual([[], [], [], []]);
  });

  it("finds a creator's claim, split between the creator role holder and the treasury", () => {
    const decoded = decodeTransaction(fixture("creator-claim"), HEAT);
    expect(decoded.feeClaims).toEqual([
      {
        eventIndex: 0,
        pool: "D5Wtpu6jo7a63EEWXBhxWPQQmFafbLn4wxMH5CGh7FDP",
        mint: "BNSwjpDtyeewLsiMXdh7YpngXjPKgDgVvnanMPu8g593",
        config: instant,
        creator: "4hsJPxhF2aeyuRK9s9d4HKdinmDTVMbdHp5Z3UoAbyB1",
        creatorAmount: 400_000n,
        treasuryAmount: 400_000n,
      },
    ]);
    expect(decoded.windowClaims).toEqual([]);
  });

  it("finds a Fair Open scheduled, with its terms", () => {
    const decoded = decodeTransaction(fixture("fair-open-created"), HEAT);
    expect(decoded.fairOpens).toEqual([
      {
        launch: E2E_LAUNCH,
        creator: "3hTTgfj2YqqYJeEgSF49U8ZyZwyHnwPhF9LRsXy4fMY8",
        nonce: "4hTdL9g7NaQS4Pn7Zwqf7badUTxjprJKv8xKgPVft7SM",
        dbcConfig: fairOpen,
        quoteMint: "So11111111111111111111111111111111111111112",
        identityHash: "d91f0113e70121f7efb0fc50c6b1193d9f48c6d8cd9cbe7064cd9e2132b78ae6",
        depositsOpenAt: 1_793_330_703n,
        opensAt: 1_793_331_303n,
        minRaise: 1_000_000_000n,
        potCap: 1_700_000_000n,
        lowestRung: 67_148_451n,
        step: 10_000_000n,
      },
    ]);
    expect([decoded.seatEvents, decoded.fairOpenEnds, decoded.pools]).toEqual([[], [], []]);
  });

  it("finds a seat's deposits and withdrawal, each with what it holds after", () => {
    const seat = (name: string) => decodeTransaction(fixture(name), HEAT).seatEvents;
    const common = { eventIndex: 0, launch: E2E_LAUNCH, wallet: DEPOSITOR, person: PERSON, rent: null, spent: null, coins: null, seatClosed: false };
    expect(seat("fair-open-deposit")).toEqual([{ ...common, kind: "deposit", tier: "unverified", amount: 50_000_000n, deposit: 50_000_000n, seatOpened: true }]);
    expect(seat("fair-open-top-up")).toEqual([{ ...common, kind: "deposit", tier: "unverified", amount: 30_000_000n, deposit: 80_000_000n, seatOpened: false }]);
    expect(seat("fair-open-withdraw")).toEqual([{ ...common, kind: "withdraw", tier: null, amount: 20_000_000n, deposit: 60_000_000n, seatOpened: false }]);
  });

  it("finds a launch marked failed with the sender's own refund, and another depositor's refund", () => {
    const failed = decodeTransaction(fixture("fair-open-failed-with-refund"), HEAT);
    expect(failed.fairOpenEnds).toEqual([{ launch: E2E_LAUNCH, kind: "failed", failure: "min_raise_missed" }]);
    // The deposit back, and both rents: the coin account's 1,488,440 lamports and the seat's 1,554,480 on devnet.
    const refund = { eventIndex: 0, launch: E2E_LAUNCH, kind: "refund", tier: null, deposit: 0n, rent: 3_042_920n, spent: null, coins: null, seatOpened: false, seatClosed: true };
    expect(failed.seatEvents).toEqual([{ ...refund, wallet: DEPOSITOR, person: PERSON, amount: 360_000_000n }]);
    expect(decodeTransaction(fixture("fair-open-refund"), HEAT).seatEvents).toEqual([
      { ...refund, wallet: "EfPnzdQ5FKXMEwFuAhRU3QRNjvAcGG3stRP6KG4hNZRy", person: "1b8c0a794baa0825101492343ce0fd73bb10a245aefc3475c5addbf074ae19d8", amount: 100_000_000n },
    ]);
  });

  it("finds a launch failed 15 minutes after its open, then closed", () => {
    expect(decodeTransaction(fixture("fair-open-late"), HEAT).fairOpenEnds).toEqual([{ launch: LATE_LAUNCH, kind: "failed", failure: "late" }]);
    expect(decodeTransaction(fixture("fair-open-closed"), HEAT).fairOpenEnds).toEqual([{ launch: LATE_LAUNCH, kind: "closed" }]);
  });

  it("holds nothing on configs that are not Heat's, or when the transaction failed", () => {
    const none = {
      pools: [],
      coins: [],
      swaps: [],
      curveCompletes: [],
      graduations: [],
      surplusSplits: [],
      leftoverBurns: [],
      lpFeeClaims: [],
      windowClaims: [],
      feeClaims: [],
      fairOpens: [],
      fairOpenOpens: [],
      seatEvents: [],
      fairOpenEnds: [],
      creatorLocks: [],
      taxShares: [],
    };
    for (const name of ["launch-with-creator-buy", "window-claim", "creator-claim"]) {
      expect(decodeTransaction(fixture(name), new Set())).toEqual({ ...none, unknownConfigs: expect.any(Array) });
    }
    // A launch on a config the caller does not know says so, for the indexer to read Heat's configs again (ADR 0007).
    expect(decodeTransaction(fixture("launch-with-creator-buy"), new Set()).unknownConfigs).toContain(instant);
    const failed = fixture("launch-with-creator-buy");
    failed.meta!.err = { InstructionError: [4, { Custom: 6000 }] };
    expect(decodeTransaction(failed, HEAT)).toEqual({ ...none, unknownConfigs: [] });
  });

  it("refuses a swap whose event is missing rather than index it half right", () => {
    const tx = fixture("launch-with-creator-buy");
    // EvtSwap3's event CPI: Anchor's event tag, then the event's discriminator.
    const evtSwap3 = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d, ...EVT_SWAP3_EVENT_DISCRIMINATOR];
    const isEvtSwap3 = (data: string) => evtSwap3.every((b, i) => base58.encode(data)[i] === b);
    let removed = 0;
    for (const group of tx.meta!.innerInstructions!) {
      const kept = group.instructions.filter((ix) => !isEvtSwap3(ix.data));
      removed += group.instructions.length - kept.length;
      group.instructions = kept;
    }
    expect(removed).toBe(1);
    expect(() => decodeTransaction(tx, HEAT)).toThrow("emitted 0 EvtSwap3 events, not one");
  });
});

describe("decoding a Graduation", () => {
  const REHEARSAL = CLUSTERS.devnet!.rehearsal!;
  const configs = new Set<string>([REHEARSAL]);
  const MINT = "9Rn22SUjuoJJJoeDrDVhNvokdEr1hFBW31ArLkLxSTxC";
  const CURVE = "3C6upx6nivHsQkoPVjryf2t6whknLHHuvJn8b154EEh6";
  const DAMM_POOL = "4jxAv3LiE7NprE4oT5ouiBQEziBR3ZFqbGn2sqRqZRyu";
  const CREATOR = "923oSKVPTAdwojxpNBjMsbLwUg8bKTPMEp3LGWn7EDus";
  const TRADER = "Fdoaf2zBa4yg2YApHjKkRvcs3Cw4d5YrKwvyhcANWrpm";
  const CREATOR_POSITION = "5p6cnsZgtiCdNt6f883wmmBLwtKKjhsGaYpnFi8Fqwa3";
  const HEAT_POSITION = "5mH7gGn38uVnCwdHmVMCKrttcX6Zs913VWjDAp2FNYDv";
  const graduated = new Map([[DAMM_POOL, { mint: MINT, config: REHEARSAL }]]);

  it("finds the buy that completed the curve, at its Graduation Target", () => {
    const decoded = decodeTransaction(fixture("graduation-completing-buy"), configs);
    expect(decoded.swaps).toEqual([expect.objectContaining({ venue: "curve", pool: CURVE, mint: MINT, side: "buy", quoteReserve: 250_000_000n })]);
    expect(decoded.curveCompletes).toEqual([{ pool: CURVE, mint: MINT, config: REHEARSAL, quoteReserve: 250_000_000n }]);
  });

  it("finds the migration: the DAMM v2 pool at the coin's price, and both positions locked and handed to their owners", () => {
    const decoded = decodeTransaction(fixture("graduation-migration"), configs);
    expect(decoded.graduations).toEqual([
      {
        mint: MINT,
        curvePool: CURVE,
        pool: DAMM_POOL,
        config: REHEARSAL,
        // Curve A's last point for a 0.25 SOL target: the graduated pool opens where the curve ended.
        sqrtPrice: 20_624_086_856_177_974n,
        positions: [
          {
            position: CREATOR_POSITION,
            nftMint: "EqSFT6TmVY1fY8k79J6DoEjY7kKZT5vRXMr6c26j8yxi",
            nftAccount: "HS7WnL3rdZxo9Ptnm6DiRru2pKu4xCMkNeRtLVSstY6a",
            owner: CREATOR,
            liquidity: 2_058_284_296_892_443_127_880_302_231_742n,
          },
          {
            position: HEAT_POSITION,
            nftMint: "4t6T34BF62mjCX21AZUWNxjvjA2zVtmTniWHArzeZje4",
            nftAccount: "DGdHcLxgfCt13Q16SDdUpHtJSYUrzNXHXXZDWBaamZYU",
            owner: "4Garg7N38ShAr8z38ZKkHrgP9Lj5nRKiy3HGtNDqTpko",
            liquidity: 2_058_284_280_393_170_206_898_794_192_622n,
          },
        ],
      },
    ]);
    expect(decoded.swaps).toEqual([]);
    // A migration on another launchpad's config is not Heat's.
    expect(decodeTransaction(fixture("graduation-migration"), HEAT).graduations).toEqual([]);
  });

  it("finds the surplus split and the leftover burnt", () => {
    expect(decodeTransaction(fixture("graduation-surplus"), configs).surplusSplits).toEqual([
      { pool: CURVE, mint: MINT, creator: CREATOR, creatorAmount: 0n, treasuryAmount: 0n },
    ]);
    expect(decodeTransaction(fixture("graduation-leftover"), configs).leftoverBurns).toEqual([{ pool: CURVE, mint: MINT, withdrawn: 800_004n, burnt: 800_004n }]);
  });

  it("finds a graduated pool's buys and sells, their fees in the quote, its reserve after each", () => {
    expect(dammPoolsIn(fixture("graduated-buy"))).toEqual([DAMM_POOL]);
    const common = { eventIndex: 0, venue: "graduated", pool: DAMM_POOL, mint: MINT, config: REHEARSAL, trader: TRADER };
    expect(decodeTransaction(fixture("graduated-buy"), configs, graduated).swaps).toEqual([
      { ...common, side: "buy", quoteAmount: 5_000_000n, baseAmount: 3_873_348_087_078n, fee: 62_500n, sqrtPrice: 21_032_228_772_224_952n, quoteReserve: 254_437_500n, timestamp: 1_793_597_303n },
    ]);
    const [sell] = decodeTransaction(fixture("graduated-sell"), configs, graduated).swaps;
    expect(sell).toEqual(expect.objectContaining({ ...common, side: "sell", quoteAmount: 220_107_106n, fee: 2_707_318n }));
    // 1.23%: the price stood two 9% steps above Graduation.
    expect(Number(sell!.fee) / Number(sell!.quoteAmount)).toBeCloseTo(0.0123, 5);
    // A graduated pool Heat does not know is another's, and left alone.
    expect(decodeTransaction(fixture("graduated-buy"), configs).swaps).toEqual([]);
  });

  it("finds Heat's LP fee claim and the creator's, the creator's beside their curve earnings", () => {
    expect(decodeTransaction(fixture("graduated-heat-lp-claim"), configs, graduated).lpFeeClaims).toEqual([
      { eventIndex: 0, pool: DAMM_POOL, mint: MINT, position: HEAT_POSITION, owner: "4Garg7N38ShAr8z38ZKkHrgP9Lj5nRKiy3HGtNDqTpko", quoteAmount: 1_396_533n, coinAmount: 0n },
    ]);
    const creatorClaim = decodeTransaction(fixture("graduated-creator-claim"), configs, graduated);
    expect(creatorClaim.lpFeeClaims).toEqual([
      { eventIndex: 0, pool: DAMM_POOL, mint: MINT, position: CREATOR_POSITION, owner: CREATOR, quoteAmount: 1_396_534n, coinAmount: 0n },
    ]);
    expect(creatorClaim.feeClaims).toEqual([expect.objectContaining({ mint: MINT, creator: CREATOR, creatorAmount: 1_265_823n, treasuryAmount: 1_265_823n })]);
  });
});
