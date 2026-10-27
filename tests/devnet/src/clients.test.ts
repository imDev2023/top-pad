// The generated Kit clients read Meteora's real accounts on devnet (spec 5.1: integration tests run against Meteora's
// programs as deployed on devnet; no Meteora binary is ever loaded). DBC configs and DAMM v2 pools are never closed,
// so these two stay readable.
import { address, createSolanaRpc } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { CP_AMM_PROGRAM_ADDRESS, fetchPool } from "@top-pad/clients/damm-v2";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, fetchPoolConfig } from "@top-pad/clients/dbc";
import { LOCKER_PROGRAM_ADDRESS } from "@top-pad/clients/jupiter-lock";

// Free tiers only during the devnet build (spec 10.5); the public endpoint by default.
const rpc = createSolanaRpc(process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com");
const WSOL = "So11111111111111111111111111111111111111112";

// Found on devnet on 2026-10-27 with getProgramAccounts on each program, filtered on the account's discriminator.
const DBC_CONFIG = address("18Z5gjcqe584Xdz3aumaG4TN5Pk88MBVvi5pHZ4tJ3U");
const DAMM_V2_POOL = address("13VShFJP7VaJHp6x1nE1q16RrXZooAYGewDGFgmcbCd");

describe("the generated clients on devnet", () => {
  it("decode a real DBC config", async () => {
    const config = await fetchPoolConfig(rpc, DBC_CONFIG);
    expect(config.programAddress).toBe(DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS);
    expect(config.data).toMatchObject({
      quoteMint: WSOL,
      feeClaimer: "7mWZqXXV1FqNqeavqiPjnB7QGGpRvhGrMhQ6UAshF7Bn",
      // Graduates to DAMM v2 at 760 SOL, a 9-decimal coin.
      migrationOption: 1,
      migrationQuoteThreshold: 760_000_000_000n,
      tokenDecimal: 9,
    });
    // The curve's points climb: each segment's square-root price is above the one before it.
    const points = config.data.curve.map((p) => p.sqrtPrice).filter((p) => p > 0n);
    expect(points.length).toBeGreaterThan(0);
    for (let i = 1; i < points.length; i++) expect(points[i]!).toBeGreaterThan(points[i - 1]!);
  });

  it("decode a real DAMM v2 pool", async () => {
    const pool = await fetchPool(rpc, DAMM_V2_POOL);
    expect(pool.programAddress).toBe(CP_AMM_PROGRAM_ADDRESS);
    expect(pool.data.tokenAMint).toBe("9vWWHZb4JVhurCxuQ2bMsEcagUB1eS2DuwwKWx7FayfY");
    expect(pool.data.tokenBMint).toBe(WSOL);
    // Liquidity and price move with trades, so only their shape is checked: the price sits inside the pool's range.
    expect(pool.data.liquidity).toBeGreaterThan(0n);
    expect(pool.data.sqrtPrice).toBeGreaterThanOrEqual(pool.data.sqrtMinPrice);
    expect(pool.data.sqrtPrice).toBeLessThanOrEqual(pool.data.sqrtMaxPrice);
  });

  it("name programs that are deployed on devnet", async () => {
    for (const program of [DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, CP_AMM_PROGRAM_ADDRESS, LOCKER_PROGRAM_ADDRESS]) {
      const { value } = await rpc.getAccountInfo(program, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }).send();
      expect(value?.executable, program).toBe(true);
    }
  });
});
