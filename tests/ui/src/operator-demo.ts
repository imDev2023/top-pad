// The operator app's local demo data (`playwright.operator.config.ts`): a database of its own, `operator_demo` on the
// local Postgres, made afresh each run, migrated and seeded with one of each kind of queue item, shaped as the API writes
// them on devnet, and a Bar another operator confirmed, with the creator's reply and appeal; and the evidence pack of one
// case in the operator Worker's local R2. Prints the database's URL, the
// only thing on stdout, for `wrangler dev`'s Hyperdrive. The shared local database is never touched.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { admissionReviews, barAppeals, barReplies, bars, bundleCases, createDb, creators, knownBots, launches, linkageHubs, vampAppeals, vampChecks, xMessages } from "@top-pad/db";
import { runMigrations } from "@top-pad/db/migrate";

import { FIRST_OPERATOR, NAME, SERVER } from "./operator-demo-shared";
const operatorApp = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps", "operator");

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const BONK = { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", ticker: "Bonk", name: "Bonk", source: "jupiter_verified", url: "https://jup.ag/tokens/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", imageUrl: null };
const PEPE = { mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", ticker: "PEPE", name: "Pepe", source: "jupiter_verified", url: "https://jup.ag/tokens/2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", imageUrl: null };
const GLOW = { mint: "GLoWx7Hn5h8yT3qVdV2Wq8c6m4c1sYk5dUe9pJb3rLqA", ticker: "GLOW", name: "Glow", source: "heat", url: "http://localhost:3110/coin/GLoWx7Hn5h8yT3qVdV2Wq8c6m4c1sYk5dUe9pJb3rLqA", imageUrl: null };
// Devnet addresses of the shapes the queue shows: wallets, their funders, the launches and the coins.
const W = {
  merged: "DKAsk4f4m95vsBCcHMZEkfp3ScQmTU66hWc1aUy3hCVc",
  hop: "5yWkVJtD4wLKjTpU9QmMa3tR7hZ2cVnXbF8sEoG6dPqi",
  root: "8BV3n6VByqZqZSoNFydbzccoSA5U1Qd2bx5wMUoxkUkU",
  refused: "4KVCJX8uTh1ApQxsczYow83R9mZz8rTKbSQf6ZHdBUPn",
  creator: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  bank: "Ew6E318g8SYCSjCUdRqcpSywRUzuFUPoxLAQWYfZD933",
  linkedA: "3Mc6vR2uX8yQnJ5tL1wKp9fZhB7dGsE4aT6oYcVmNiRu",
  linkedB: "HqT5bW1nZ8eK3vX7mJ2cR9yL4sG6dF1pA5uN8oQwEiTt",
  faucet: "FauCetDr1p2wV9mQ4kZ7tH3nB6xR8yL5cJ1sE4aG2dPu",
  sniper: "SnipEr7bQ2wV9mQ4kZ7tH3nB6xR8yL5cJ1sE4aG2dPuX",
  looper: "LooPer4kZ7tH3nB6xR8yL5cJ1sE4aG2dPu9mQ2wVb7Q",
};
const SEALED = "LNTRNSeaLedFa1rWindowAccount11111111111111111";
const MOON = "MooNx1WmjBp2nN7JyKuJ8rMjQQYmex3f6aEaYZ6PwLJQh";
const OPENED = "GLoWSeason2Fa1rOpenAccount1111111111111111111";
const sig = (n: number) => `${n}`.repeat(88).slice(0, 88).replace(/0/g, "z");

const step = (wallet: string, funder: string, sol: number, hours: number, passThrough = false) => ({
  wallet,
  funder,
  signature: sig(wallet.length + funder.length + hours),
  amount: `${Math.round(sol * 1e9)}`,
  at: hoursAgo(hours).toISOString(),
  passThrough,
});

function evidencePack(mint: string, openedHours: number) {
  return {
    version: 1,
    cluster: "devnet",
    reviewedAt: hoursAgo(openedHours - 1).toISOString(),
    rule: "Wallets directly linked to the Creator wallet bought 1% or more of the coin's supply between them, across the pot and the first hour of trading (spec 6.5).",
    coin: { mint, pool: "GFfJALA3B4bwfgeky2ZyzzKVzvm8tWLvLENhkAVk7nsg", launchMode: "fair_open" },
    creator: { wallet: W.creator, recordId: null, xHandle: "frog_bundler" },
    openedAt: hoursAgo(openedHours).toISOString(),
    creation: { signature: sig(3), slot: 519179470, blockIndex: 13, jitoBundle: null },
    jito: false,
    floor: { supply: "1000000000000000", floor: "10000000000000", linkedCoins: "158264351050603", share: "15.82%" },
    wallets: [
      {
        wallet: W.linkedA,
        creator: false,
        linked: true,
        labels: ["creator_funded"],
        counted: "90304748460142",
        potCoins: "90304748460142",
        buys: [],
        deposits: [{ signature: sig(4), at: hoursAgo(openedHours + 0.05).toISOString(), amount: "400000000", creatorSigned: false }],
        transfers: [
          { signature: sig(5), at: hoursAgo(openedHours + 0.06).toISOString(), direction: "from_creator", asset: "SOL", amount: "420000000" },
          { signature: sig(6), at: hoursAgo(openedHours - 0.1).toISOString(), direction: "to_creator", asset: "SOL", amount: "44917261" },
        ],
      },
      {
        wallet: W.linkedB,
        creator: false,
        linked: true,
        labels: ["after_creation", "creator_funded"],
        counted: "67959602590461",
        potCoins: "0",
        buys: [{ signature: sig(7), at: hoursAgo(openedHours).toISOString(), position: 2, baseAmount: "67959602590461", quoteAmount: "250000000", firstHour: true }],
        deposits: [],
        transfers: [{ signature: sig(8), at: hoursAgo(openedHours + 0.04).toISOString(), direction: "from_creator", asset: "SOL", amount: "260000000" }],
      },
    ],
  };
}

async function main() {
  // stdout carries the database's URL alone: the database's notices go to stderr.
  console.log = (...args: unknown[]) => console.error(...args);
  const admin = createDb(SERVER);
  await admin.db.execute(sql.raw(`drop database if exists ${NAME} with (force)`));
  await admin.db.execute(sql.raw(`create database ${NAME}`));
  await admin.close();
  const url = new URL(SERVER);
  url.pathname = `/${NAME}`;
  await runMigrations(url.toString());
  const { db, close } = createDb(url.toString());
  try {
    const made = await db
      .insert(creators)
      .values(["relaunch_team", "frogmaker", "lantern_dev", "frog_bundler", "moon_bundler"].map((h, i) => ({ xUserId: `${800 + i}`, xHandle: h, xName: h })))
      .returning();
    const [relaunch, frogmaker, lantern, bundler, mooner] = made;
    const imageRefused = [{ field: "image", rule: "pdq", status: "refused", coin: BONK, reason: "The image is the picture of $Bonk, a protected coin, mirrored." }];
    const textRefused = [
      { field: "ticker", status: "refused", coin: PEPE, reason: "The ticker is PEPE's, a protected coin's." },
      { field: "name", status: "refused", coin: PEPE, reason: "The name folds to Pepe's, a protected coin's." },
    ];
    await db.insert(vampChecks).values([
      ...[31, 30, 29].map((h) => ({ stage: "prepare" as const, creatorId: relaunch!.id, ticker: "B0NK", name: "Bonk Relaunch", imageSha256: "694020a6c1fc773191c3f6596f8ef238b165dea0467d520b604adcafeb693cc6", outcome: "refused" as const, matches: imageRefused, at: hoursAgo(h) })),
      { stage: "prepare", creatorId: frogmaker!.id, ticker: "PEPE", name: "Pepe Classic", imageSha256: null, outcome: "refused", matches: textRefused, at: hoursAgo(52) },
    ]);
    await db.insert(vampAppeals).values([
      {
        creatorId: relaunch!.id,
        ticker: "B0NK",
        name: "Bonk Relaunch",
        imageSha256: "694020a6c1fc773191c3f6596f8ef238b165dea0467d520b604adcafeb693cc6",
        original: BONK.mint,
        message: "We are Bonk's original team relaunching for the devnet cohort. The mint authority of the original can sign a message for you if you want proof.",
        verdict: { text: null, image: { matches: imageRefused, outcome: "refused" } },
        createdAt: hoursAgo(20),
      },
      {
        creatorId: lantern!.id,
        ticker: "GLOW",
        name: "Glow Lantern",
        imageSha256: null,
        original: null,
        message: "GLOW is our own Heat coin from last week; this is its second season.",
        verdict: { text: { ticker: "GLOW", name: "Glow Lantern", clear: false, verdicts: { ticker: { status: "refused", reason: "The ticker is held by $GLOW, a protected Heat coin.", match: GLOW }, name: { status: "clear", reason: null, match: null } } }, image: null },
        createdAt: hoursAgo(6),
      },
    ]);
    const launch = (o: { creatorId: string; account: string; ticker: string; name: string; teaser: string; opensHours: number; opened: boolean }) => ({
      creatorId: o.creatorId,
      wallet: W.creator,
      mode: "fair_open" as const,
      name: o.name,
      ticker: o.ticker,
      mint: `${o.account.slice(0, 40)}mint`,
      pool: `${o.account.slice(0, 40)}pool`,
      config: "config",
      quoteMint: "So11111111111111111111111111111111111111112",
      metadataUri: "https://turbo-gateway.com/demo",
      imageUri: "https://turbo-gateway.com/demo",
      message: "",
      lastValidBlockHeight: 0n,
      fairOpen: o.account,
      teaser: o.teaser,
      opensAt: hoursAgo(-o.opensHours),
      openLandedAt: o.opened ? hoursAgo(-o.opensHours) : null,
    });
    await db.insert(launches).values([
      launch({ creatorId: lantern!.id, account: SEALED, ticker: "SECRET", name: "Sealed Until Open", teaser: "lantern", opensHours: 3, opened: false }),
      launch({ creatorId: lantern!.id, account: OPENED, ticker: "GLOW", name: "Glow", teaser: "season", opensHours: -8, opened: true }),
      { ...launch({ creatorId: bundler!.id, account: "FRoGBundLeFairOpen11111111111111111111111111", ticker: "FROG", name: "Frog Bundle", teaser: "pond", opensHours: -3, opened: true }), mint: "8cWz1WmjBp2nN7JyKuJ8rMjQQYmex3f6aEaYZ6PwLJQh" },
      // The bundler's next Fair Open, scheduled for tomorrow: confirming the case cancels it.
      { ...launch({ creatorId: bundler!.id, account: "FRoGNextFairOpen1111111111111111111111111111", ticker: "TADPOLE", name: "Tadpole", teaser: "tadpoles", opensHours: 20, opened: false }), status: "landed" as const, depositsOpenAt: hoursAgo(-20 + 10 / 60) },
      { ...launch({ creatorId: mooner!.id, account: "MooNBundLeFairOpen11111111111111111111111111", ticker: "MOON", name: "Moon Bundle", teaser: "moon", opensHours: -84, opened: true }), mint: MOON, status: "landed" as const },
    ]);
    await db.insert(admissionReviews).values([
      {
        launch: SEALED,
        wallet: W.merged,
        kind: "merged",
        cluster: `wallet:${W.root}`,
        reason: `Heat counts this wallet as one person with every wallet funded from it: its SOL came from ${W.root.slice(0, 4)}…${W.root.slice(-4)}, through 1 pass-through wallet in between. They share one seat in each Fair Open.`,
        evidence: { wallet: { wallet: W.merged, root: W.root, chain: [step(W.merged, W.hop, 0.12, 41, true), step(W.hop, W.root, 0.5, 42)], funders: [W.hop, W.root, W.bank] } },
        createdAt: hoursAgo(40),
      },
      {
        launch: OPENED,
        wallet: W.refused,
        kind: "refused",
        cluster: `wallet:${W.refused}`,
        reason: "The Creator wallet funded this wallet, directly. Wallets tied to the creator cannot deposit in their Fair Open. You can still buy the coin once it opens.",
        evidence: { wallet: { wallet: W.refused, root: W.creator, chain: [step(W.refused, W.creator, 0.42, 13)], funders: [W.creator, W.bank] }, creator: { wallet: W.creator, root: W.creator, chain: [], funders: [W.bank] } },
        createdAt: hoursAgo(12),
      },
    ]);
    const frog = "8cWz1WmjBp2nN7JyKuJ8rMjQQYmex3f6aEaYZ6PwLJQh";
    const other = "7ZzYfQ2k3mNpR8sT4vW6xA9bC1dE5gH7jK2LM4nP6qRs";
    const frogPack = evidencePack(frog, 3);
    await db.insert(bundleCases).values([
      { mint: frog, creatorWallet: W.creator, creatorId: bundler!.id, linkedWallets: 2, linkedCoins: 158264351050603n, supply: 1000000000000000n, evidence: frogPack, evidenceKey: `bundle-radar/cases/${frog}.json`, openedAt: hoursAgo(2) },
      { mint: other, creatorWallet: W.bank, creatorId: null, linkedWallets: 1, linkedCoins: 21000000000000n, supply: 1000000000000000n, evidence: { ...evidencePack(other, 1.5), floor: { supply: "1000000000000000", floor: "10000000000000", linkedCoins: "21000000000000", share: "2.10%" } }, evidenceKey: `bundle-radar/cases/${other}.json`, openedAt: hoursAgo(0.5) },
    ]);
    // A case another operator confirmed 80 hours ago, its Bar public since its 72 hours ended: the X message sent, the
    // creator's reply and their appeal.
    const [moonCase] = await db
      .insert(bundleCases)
      .values({
        mint: MOON,
        creatorWallet: W.creator,
        creatorId: mooner!.id,
        status: "confirmed",
        linkedWallets: 2,
        linkedCoins: 158264351050603n,
        supply: 1000000000000000n,
        evidence: evidencePack(MOON, 84),
        evidenceKey: `bundle-radar/cases/${MOON}.json`,
        openedAt: hoursAgo(82),
        decidedAt: hoursAgo(80),
        decidedBy: FIRST_OPERATOR,
        decisionNote: "Two wallets the Creator wallet funded minutes before the open bought 15.8% of supply.",
      })
      .returning();
    const [moonBar] = await db
      .insert(bars)
      .values({
        caseId: moonCase!.id,
        mint: MOON,
        creatorId: mooner!.id,
        creatorWallet: W.creator,
        xUserId: mooner!.xUserId,
        confirmedBy: FIRST_OPERATOR,
        confirmedAt: hoursAgo(80),
        publishAt: hoursAgo(80 - 72),
        note: "Two wallets the Creator wallet funded minutes before the open bought 15.8% of supply.",
      })
      .returning();
    await db.insert(xMessages).values({ barId: moonBar!.id, xUserId: mooner!.xUserId!, text: "Heat: an operator confirmed a creator bundle in $MOON.", sentAt: hoursAgo(79.9), xEventId: "1580705921830768640", attempts: 1, createdAt: hoursAgo(80) });
    await db.insert(barReplies).values({ barId: moonBar!.id, creatorId: mooner!.id, body: "Those two wallets are my brother's; he bought on his own with SOL I lent him for rent.", at: hoursAgo(78) });
    await db.insert(barAppeals).values({
      barId: moonBar!.id,
      creatorId: mooner!.id,
      grounds: "shared_exchange",
      statement: "The SOL both wallets got came from my Coinbase account, which my brother and I share; neither bought for me.",
      evidence: "Coinbase's statement of the two withdrawals, sent to appeals@heat.local.",
      filedAt: hoursAgo(9),
    });
    await db.insert(linkageHubs).values({ address: W.faucet, label: "Devnet faucet drip", addedBy: null, createdAt: hoursAgo(70) });
    // The known-bot list (spec 8, #57): a sniper of three launches, and a wallet that bought and sold in one transaction.
    await db.insert(knownBots).values([
      {
        wallet: W.sniper,
        earlyLaunches: 3,
        roundTrips: 0,
        evidence: { early: [MOON, OPENED, frog].map((mint, i) => ({ mint, signature: sig(i + 5), seconds: i % 2 })), roundTrips: [] },
        listedAt: hoursAgo(5),
      },
      { wallet: W.looper, earlyLaunches: 0, roundTrips: 2, evidence: { early: [], roundTrips: [sig(8), sig(9)] }, listedAt: hoursAgo(2) },
    ]);
    // The first case's pack in the operator Worker's local R2, as the case job stores it; the second has none.
    const dir = mkdtempSync(join(tmpdir(), "operator-demo-"));
    const file = join(dir, "pack.json");
    writeFileSync(file, JSON.stringify(frogPack, null, 2));
    execFileSync("pnpm", ["exec", "wrangler", "r2", "object", "put", `top-pad-blobs-local/bundle-radar/cases/${frog}.json`, "--file", file, "--local", "--content-type", "application/json"], {
      cwd: operatorApp,
      stdio: ["ignore", "ignore", "inherit"],
    });
  } finally {
    await close();
  }
  process.stdout.write(url.toString());
}

await main();
