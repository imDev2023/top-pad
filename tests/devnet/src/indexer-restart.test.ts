// Stopping and restarting the indexer loses no trade (#42): the API runs under `wrangler dev` on a throwaway database,
// a pool on Heat's config trades once while the indexer runs, then three times while its process is killed; once it
// runs again, reconciliation must hold exactly the trades the chain has for the pool, read back from the chain itself.
// It spends a little devnet SOL from the Solana CLI's wallet, and the Worker needs HELIUS_API_KEY for its RPC (spec
// 10.5): run it as `direnv exec . pnpm test:devnet`. Without the key, or TEST_DATABASE_URL, it is skipped.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { address } from "@solana/kit";
import { afterAll, describe, expect, it } from "vitest";
import { CLUSTERS } from "@top-pad/chain";
import { CoinTrades } from "@top-pad/contract";
import { createTestDatabase } from "@top-pad/db/testing";
import { decodeTransaction, fetchRawTransaction } from "@top-pad/indexer";
import { fundedWallets, poolAroundHeat, rpc, rpcUrl, swap, sweep } from "./devnet";

const helius = process.env.HELIUS_API_KEY;
const PORT = 8802;
const API = `http://localhost:${PORT}`;
const apiDir = join(dirname(fileURLToPath(import.meta.url)), "../../../apps/api");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `check` until it gives something, or fails after `ms`. */
async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(1_000);
  }
}

describe.skipIf(!helius || !process.env.TEST_DATABASE_URL)("the indexer stopped and started again", () => {
  let api: ChildProcess | null = null;
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const state = mkdtempSync(join(tmpdir(), "heat-indexer-"));

  const logFile = join(state, "wrangler.log");

  /**
   * The API and its indexer, as `wrangler dev` runs them, on this test's database and Durable Object state: wrangler
   * itself rather than through pnpm, in a process group of its own, so stopping it stops its workerd too.
   */
  async function start() {
    const log = openSync(logFile, "a");
    api = spawn(
      join(apiDir, "node_modules/.bin/wrangler"),
      ["dev", "--port", String(PORT), "--inspector-port", "9332", "--persist-to", state, "--var", `RPC_URL:https://devnet.helius-rpc.com/?api-key=${helius}`],
      { cwd: apiDir, env: { ...process.env, CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: database.url }, stdio: ["ignore", log, log], detached: true },
    );
    try {
      await until("the API to answer", async () => (await fetch(`${API}/platform`)).ok, 90_000);
      // Waking the indexer starts its alarm, which opens the logs socket and reconciles.
      return await until("the indexer to reconcile", async () => {
        const status = (await (await fetch(`${API}/indexer`)).json()) as { reconciledAt: string | null; lastError: string | null };
        if (status.lastError) throw new Error(status.lastError);
        return status.reconciledAt;
      }, 120_000);
    } catch (e) {
      throw new Error(`${(e as Error).message}; wrangler said:\n${readFileSync(logFile, "utf8").slice(-3_000)}`, { cause: e });
    }
  }

  async function stop() {
    const running = api!;
    api = null;
    const exited = new Promise((done) => running.once("exit", done));
    process.kill(-running.pid!, "SIGTERM");
    await exited;
    // Nothing answers on the port any more: the indexer is gone, socket and all.
    await until("the API to stop", async () => !(await fetch(`${API}/platform`).then(() => true).catch(() => false)), 30_000);
  }

  afterAll(async () => {
    if (api) await stop();
    await database?.drop();
    rmSync(state, { recursive: true, force: true });
  });

  it("indexes every trade made while it was down, as the chain has them", { timeout: 6 * 60_000 }, async () => {
    database = await createTestDatabase();
    await start();
    const [stranger, trader] = await fundedWallets(30_000_000n, 60_000_000n);
    const { mint, pool } = await poolAroundHeat(stranger);
    const trades = async () => CoinTrades.parse(await (await fetch(`${API}/coins/${mint}/trades?limit=50`)).json()).trades;

    // While it runs: the trade is indexed live.
    const live = await swap(trader, address(mint), "buy", 10_000_000n);
    await until("the live trade", async () => (await trades()).some((t) => t.signature === live), 60_000);

    // Stopped: three trades land on devnet with no indexer running.
    await stop();
    const missed = [
      await swap(trader, address(mint), "buy", 5_000_000n),
      await swap(trader, address(mint), "buy", 5_000_000n),
      await swap(trader, address(mint), "sell", 1_000_000_000n),
    ];

    // Started again: reconciliation finds them.
    await start();
    const indexed = await until("the missed trades", async () => {
      const all = await trades();
      return missed.every((s) => all.some((t) => t.signature === s)) && all;
    }, 120_000);

    // Checked against the chain: every swap the pool's transactions hold, decoded from the chain, is indexed, and nothing else.
    const signatures = await rpc.getSignaturesForAddress(address(pool), { commitment: "confirmed" }).send();
    const configs = new Set<string>([CLUSTERS.devnet!.configs!.instant, CLUSTERS.devnet!.configs!.fairOpen]);
    const onChain = [];
    for (const { signature, err } of signatures) {
      if (err) continue;
      const raw = await until(`transaction ${signature}`, () => fetchRawTransaction(rpcUrl, signature), 30_000);
      onChain.push(...decodeTransaction(raw, configs).swaps.map((s) => ({ signature, eventIndex: s.eventIndex, side: s.side, quoteAmount: String(s.quoteAmount), fee: String(s.fee) })));
    }
    expect(onChain).toHaveLength(4);
    const key = (t: { signature: string; eventIndex: number }) => `${t.signature}:${t.eventIndex}`;
    expect(indexed.map((t) => ({ signature: t.signature, eventIndex: t.eventIndex, side: t.side, quoteAmount: t.quoteAmount, fee: t.fee })).sort((a, b) => key(a).localeCompare(key(b)))).toEqual(
      onChain.sort((a, b) => key(a).localeCompare(key(b))),
    );

    await sweep(stranger, trader);
  });
});
