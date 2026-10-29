import { address, lamports, type Rpc, type GetBalanceApi } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, operatorAlerts, type Db } from "@top-pad/db";
import { createTestDatabase } from "@top-pad/db/testing";
import { checkKeeperFloat, loadKeeper } from "./keeper";
import { testKeypair } from "./test/fakes";

let db: Db;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  const test = await createTestDatabase();
  const conn = createDb(test.url);
  db = conn.db;
  cleanup = async () => {
    await conn.close();
    await test.drop();
  };
});
afterAll(() => cleanup());

const KEEPER = address("GpDvDUpEC9ynHTJBt3XaZcTvBUw1HaMnU9Wwox18xfNi");
const holding = (amount: bigint) =>
  ({ getBalance: () => ({ send: async () => ({ context: { slot: 1n }, value: lamports(amount) }) }) }) as unknown as Rpc<GetBalanceApi>;

describe("the keeper's float", () => {
  it("raises an alert below its floor and resolves it once topped up", async () => {
    const low = await checkKeeperFloat(db, holding(100_000_000n), KEEPER, 250_000_000n);
    expect(low).toMatchObject({ low: true, lamports: "100000000" });
    const [alert] = await db.select().from(operatorAlerts);
    expect(alert).toMatchObject({ kind: "keeper_low_balance", subject: KEEPER, resolvedAt: null });
    expect(alert!.message).toContain("0.100 SOL, below its 0.250 SOL floor");

    expect((await checkKeeperFloat(db, holding(500_000_000n), KEEPER, 250_000_000n)).low).toBe(false);
    expect((await db.select().from(operatorAlerts))[0]!.resolvedAt).not.toBeNull();
  });
});

describe("the keeper key", () => {
  it("loads from its binding only when it is the key the cluster records", async () => {
    const { signer, secret } = await testKeypair();
    const binding = { get: async () => JSON.stringify(Array.from(secret)) };
    expect((await loadKeeper(binding, signer.address)).signer.address).toBe(signer.address);
    await expect(loadKeeper(binding, KEEPER)).rejects.toThrow(`the bound keeper key is ${signer.address}, not ${KEEPER}`);
    await expect(loadKeeper({ get: async () => "not a keypair" }, KEEPER)).rejects.toThrow("does not hold a keypair array");
    await expect(loadKeeper({ get: async () => "[1,2,3]" }, KEEPER)).rejects.toThrow("64-byte keypair");
  });
});
