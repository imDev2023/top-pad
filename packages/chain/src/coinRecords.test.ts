import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { compareCoinRecords, signSnapshot, verifySnapshot, type ChainCoinRecord } from "./coinRecords";

const record = (mint: string, o: Partial<ChainCoinRecord> = {}): ChainCoinRecord => ({
  mint,
  pool: `${mint}-pool`,
  config: "heat-instant",
  launchMode: "instant",
  fairOpenLaunch: null,
  registeredAt: "2026-11-12T10:00:00.000Z",
  ...o,
});

describe("the signed daily snapshot", () => {
  it("verifies when signed by the launch key, and names what fails otherwise", async () => {
    const launchKey = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const body = JSON.stringify({
      version: 1,
      cluster: "devnet",
      day: "2026-11-12",
      through: "2026-11-13T00:00:00.000Z",
      program: "HeatFEzySQiaWqxR7cDza9WP2B15AxMfsgSS5p6Bdn97",
      launchKey: launchKey.address,
      configs: [],
      coins: [],
    });
    const signed = await signSnapshot(body, launchKey);
    expect(signed.message).toBe(`heat:coin-records:v1:${signed.sha256}`);
    const snapshot = { body, signer: launchKey.address, ...signed };
    expect((await verifySnapshot(snapshot, launchKey.address)).day).toBe("2026-11-12");

    await expect(verifySnapshot({ ...snapshot, body: body.replace("devnet", "mainnet") }, launchKey.address)).rejects.toThrow(/hashes to/);
    await expect(verifySnapshot(snapshot, other.address)).rejects.toThrow(/not the launch key/);
    const forged = await signSnapshot(body, other);
    await expect(verifySnapshot({ ...snapshot, signature: forged.signature }, launchKey.address)).rejects.toThrow(/not the launch key's/);
  });

  it("compares with the chain's records registered before the day ended", () => {
    const through = new Date("2026-11-13T00:00:00Z");
    const chain = [
      record("a"),
      record("b", { launchMode: "fair_open", fairOpenLaunch: "L" }),
      record("c"),
      // Registered after the day ended: not expected in the snapshot.
      record("late", { registeredAt: "2026-11-13T00:00:01.000Z" }),
      // On a config Heat does not list, such as devnet's rehearsal configs, or with its pool gone: never listed.
      record("rehearsal", { config: "rehearsal" }),
      record("gone", { config: null }),
    ];
    const configs = ["heat-instant"];
    expect(compareCoinRecords([record("a"), record("b", { launchMode: "fair_open", fairOpenLaunch: "L" }), record("c")], chain, through, configs)).toEqual({ missing: [], extra: [], different: [], outside: 2 });
    expect(compareCoinRecords([record("a"), record("b"), record("ghost")], chain, through, configs)).toEqual({ missing: ["c"], extra: ["ghost"], different: ["b"], outside: 2 });
  });
});
