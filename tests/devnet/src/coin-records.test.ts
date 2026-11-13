// The signed daily snapshot of Heat's coins verifies against the chain (spec 8, #57): the deployed API's latest snapshot
// is signed by the launch key the cluster names, its body hashes to what was signed, and its coins are exactly the fee
// program's `CoinRecord` accounts registered before its day ended on the configs it names, each with the same pool,
// config, launch mode and Fair Open launch. Then the public mirror, read page by page now, against the chain likewise.
// Read-only: the public devnet endpoint and the deployed API, no transaction.
import { describe, expect, it } from "vitest";
import { compareCoinRecords, readCoinRecords, verifySnapshot } from "@top-pad/chain";
import { CoinRecordList, CoinRecordSnapshot, type CoinRecordEntry } from "@top-pad/contract";
import { devnet, rpc } from "./devnet";

const API = process.env.HEAT_API ?? "https://top-pad-api-devnet.rc-labs.workers.dev";
const get = async <T>(path: string, schema: { parse(v: unknown): T }) => {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${await res.text()}`);
  return schema.parse(await res.json());
};

describe("the CoinRecord list", () => {
  it("publishes a daily snapshot, signed by the launch key, that matches the chain's records", async () => {
    const snapshot = await get("/coin-records/snapshots/latest", CoinRecordSnapshot);
    const body = await verifySnapshot(snapshot, devnet.keys!.keeper);
    const chain = await readCoinRecords(rpc);
    const mismatches = compareCoinRecords(body.coins, chain, new Date(body.through), body.configs);
    console.log(`snapshot of ${body.day}: ${body.coins.length} coins on ${body.configs.length} configs; ${chain.length} records on chain, ${mismatches.outside} of them on other configs`);
    expect(mismatches).toMatchObject({ missing: [], extra: [], different: [] });
    expect(body.coins.length).toBeGreaterThan(0);
  });

  it("mirrors every record on Heat's configs as it stands now", async () => {
    const snapshot = await get("/coin-records/snapshots/latest", CoinRecordSnapshot);
    const { configs } = JSON.parse(snapshot.body) as { configs: string[] };
    const mirrored: CoinRecordEntry[] = [];
    for (let after: string | null = ""; after !== null; ) {
      const page: CoinRecordList = await get(`/coin-records?limit=1000${after ? `&after=${after}` : ""}`, CoinRecordList);
      mirrored.push(...page.coins);
      after = page.next;
    }
    // Records registered in the last minute may not be indexed yet; the mirror's cache is up to a minute old as well.
    const through = new Date(Date.now() - 2 * 60_000);
    const chain = await readCoinRecords(rpc);
    const mismatches = compareCoinRecords(
      mirrored.filter((c) => new Date(c.registeredAt) < through),
      chain.filter((r) => new Date(r.registeredAt) < through),
      through,
      configs,
    );
    expect(mismatches).toMatchObject({ missing: [], extra: [], different: [] });
  });
});
