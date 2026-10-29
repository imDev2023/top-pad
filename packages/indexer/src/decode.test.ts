import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getBase58Encoder } from "@solana/kit";
import { CLUSTERS } from "@top-pad/chain";
import { EVT_SWAP3_EVENT_DISCRIMINATOR } from "@top-pad/clients/dbc";
import { decodeTransaction, type RawTransaction } from "./decode";

// Real devnet transactions (2026-10-29): an Instant launch whose creator bought in the same transaction, paying the
// 99% cliff (tests/devnet), and a launch from the launch flow with no buy.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as RawTransaction;
const { instant, fairOpen } = CLUSTERS.devnet!.configs!;
const HEAT = new Set<string>([instant, fairOpen]);
const base58 = getBase58Encoder();

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

  it("holds nothing on configs that are not Heat's, or when the transaction failed", () => {
    expect(decodeTransaction(fixture("launch-with-creator-buy"), new Set())).toEqual({ pools: [], coins: [], swaps: [] });
    const failed = fixture("launch-with-creator-buy");
    failed.meta!.err = { InstructionError: [4, { Custom: 6000 }] };
    expect(decodeTransaction(failed, HEAT)).toEqual({ pools: [], coins: [], swaps: [] });
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
