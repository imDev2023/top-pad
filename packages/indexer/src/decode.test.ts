import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getBase58Encoder } from "@solana/kit";
import { CLUSTERS } from "@top-pad/chain";
import { EVT_SWAP3_EVENT_DISCRIMINATOR } from "@top-pad/clients/dbc";
import { decodeTransaction, type RawTransaction } from "./decode";

// Real devnet transactions (2026-10-29): an Instant launch whose creator bought in the same transaction, paying the
// 99% cliff (tests/devnet), a launch from the launch flow with no buy, and a coin's window claim and its creator's first
// claim (tests/devnet/src/fee-claims.test.ts). And two Fair Opens (2026-10-30): one through its page end to end
// (tests/ui/src/fair-open.spec.ts), its pot missing the minimum raise, and one failed 15 minutes late and closed
// (tests/devnet/src/fair-open.test.ts).
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
    const none = { pools: [], coins: [], swaps: [], windowClaims: [], feeClaims: [], fairOpens: [], fairOpenOpens: [], seatEvents: [], fairOpenEnds: [] };
    for (const name of ["launch-with-creator-buy", "window-claim", "creator-claim"]) expect(decodeTransaction(fixture(name), new Set())).toEqual(none);
    const failed = fixture("launch-with-creator-buy");
    failed.meta!.err = { InstructionError: [4, { Custom: 6000 }] };
    expect(decodeTransaction(failed, HEAT)).toEqual(none);
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
