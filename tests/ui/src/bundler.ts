// The bundle a creator's bundler sends as their Instant launch goes out (spec 11.1, 6.4): the Creator wallet and the 4
// wallets it funded directly buy in the creation slot, a sniper with no tie behind them. Devnet runs no Jito block engine,
// and on Heat our launch key sends the creation itself, so the bundle's buys are signed in advance and sent again and
// again, a lamport apart, as the launch goes out (tests/devnet's bundle.ts). Shared by bundle-radar.spec.ts and
// bundler-simulation.spec.ts.
import type { Page } from "@playwright/test";
import { address, type Address, type KeyPairSigner } from "@solana/kit";
import { PreparedLaunch } from "@top-pad/contract";
import { createDb } from "@top-pad/db";
import { signedBundle, spray, type BundleCopy } from "@top-pad/tests-devnet/bundle";
import { devnet } from "@top-pad/tests-devnet/devnet";
import { launchCoin, newTicker } from "./steps";
import { TARGET } from "./target";

export const SOL = 1_000_000_000n;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const INSTANT = devnet.configs!.instant;
/**
 * Each creation-slot buy, and how many copies of each bundle transaction go out as the launch is sent, 100 ms apart: 28
 * rounds cover 2.8 s after the submit. With 16 (1.6 s), five tries of five on 2026-11-15 (#62) had the creation land at
 * the end of the spray, every copy in its slot ordered before it and failing on the missing pool.
 */
export const BUY = 300_000n;
export const COPIES = 28;
/** What each wallet the creator funds gets (its copies' wrapped SOL, its buy past the tax, fees and rent), and that buy. */
export const FUNDED = (40n * SOL) / 1_000n;
export const PAST_TAX = (2n * SOL) / 100n;

export const api = async <T>(path: string, schema: { parse(v: unknown): T }) => schema.parse(await (await fetch(`${TARGET.api}${path}`)).json());
export const database = () => createDb(TARGET.name === "devnet" ? process.env.DATABASE_URL! : "postgres://toppad:toppad@127.0.0.1:5452/toppad");

export type Attempt = { mint: Address; copies: BundleCopy[]; sniperCopies: BundleCopy[]; submittedAt: number };

/**
 * Launches a coin from the site with the bundle's buys signed the moment the launch is prepared and sent from the moment
 * it is submitted: copies of the two bundle transactions (the Creator wallet with two funded wallets, then the other two)
 * together each round, 100 ms apart for 2.8 s, the sniper's from the ninth round. On devnet the launch service's creation
 * landed 0.4 to 1.4 s after the submit on 2026-11-02 and up to about 1.6 s on 2026-11-15; the copies sent before it fail
 * for their fee alone, and those that land after its slot buy again, which the loss measure shares out by coins.
 */
export async function launchWithBundle(page: Page, creator: KeyPairSigner, funded: KeyPairSigner[], sniper: KeyPairSigner, o: { linked: boolean; linkX?: boolean }): Promise<Attempt & { handle: string | null }> {
  let signing: Promise<[BundleCopy[], BundleCopy[]]> | null = null;
  let sent: Promise<void> | null = null;
  let mint: Address | null = null;
  let submittedAt = 0;
  let launched: { handle: string | null } | undefined;
  const onResponse = async (res: import("@playwright/test").Response) => {
    if (res.request().method() !== "POST" || new URL(res.url()).pathname !== "/launches" || !res.ok()) return;
    const prepared = PreparedLaunch.parse(await res.json());
    if (prepared.mode !== "instant") return;
    const coin = (mint = address(prepared.mint));
    signing = Promise.all([
      signedBundle([[creator, funded[0]!, funded[1]!], [funded[2]!, funded[3]!]], coin, INSTANT, BUY, COPIES),
      signedBundle([[sniper]], coin, INSTANT, BUY, COPIES - 8),
    ]);
  };
  const onRequest = (req: import("@playwright/test").Request) => {
    if (req.method() !== "POST" || !/\/launches\/[^/]+\/submit$/.test(new URL(req.url()).pathname)) return;
    submittedAt = Date.now();
    sent = (async () => {
      const [bundle, snipes] = await signing!;
      // Both bundle transactions at once each round; the sniper joins from the ninth: a buy in the four transactions right
      // after the creation is a direct link by spec 6.5, so the sniper, to be only labelled, must land further down.
      const rounds: BundleCopy[][] = [];
      for (let i = 0; i < bundle.length; i += 2) rounds.push([...bundle.slice(i, i + 2), ...(i >= 16 && snipes.length ? [snipes.shift()!] : [])]);
      await spray(rounds, 100);
    })();
  };
  page.on("response", onResponse);
  page.on("request", onRequest);
  try {
    // A drawn picture may look like an earlier test coin's to SSCD (#107): the label does not stop the bundle's launch.
    launched = await launchCoin(page, creator, { name: "Radar Bundle", ticker: newTicker() }, { linked: o.linked, linkX: o.linkX, looksLike: true });
  } finally {
    page.off("response", onResponse);
    page.off("request", onRequest);
  }
  await sent;
  const [copies, sniperCopies] = await signing!;
  return { mint: mint!, copies, sniperCopies, submittedAt, handle: launched?.handle ?? null };
}

/** Asks `read` every half second until `ok` holds of its answer, for at most `ms`. */
export async function waitFor<T>(read: () => Promise<T>, ok: (t: T) => boolean, ms: number): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read().catch(() => null);
    if (value !== null && ok(value)) return value;
    if (Date.now() > until) throw new Error(`not so within ${ms} ms: ${JSON.stringify(value)?.slice(0, 500)}`);
    await sleep(500);
  }
}
