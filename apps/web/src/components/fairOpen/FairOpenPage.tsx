"use client";

import type { FairOpen, LiveBatch } from "@top-pad/contract";
import { useCallback, useEffect, useState } from "react";
import { fairOpenLiveUrl, getFairOpen } from "@/lib/api";
import { coinAmount, compactNumber, shortAddress, sol } from "@/lib/format";
import { useLiveRoom } from "../coin/useLiveRoom";
import { useWallet } from "../WalletProvider";
import { DepositPanel } from "./DepositPanel";
import styles from "./FairOpen.module.css";
import { PotMeter } from "./PotMeter";

const REFRESH_MS = 15_000;

/** A countdown as a clock reads it: 4:07 under an hour, 2 h 05 min under a day, then days and hours. */
export function countdown(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 3_600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  if (s < 86_400) return `${Math.floor(s / 3_600)}\u{a0}h ${String(Math.floor((s % 3_600) / 60)).padStart(2, "0")}\u{a0}min`;
  return `${Math.floor(s / 86_400)}\u{a0}d ${Math.floor((s % 86_400) / 3_600)}\u{a0}h`;
}

/** A time as the page names it, in UTC: 14:00:00, with the date when it is not today's. */
export function clock(iso: string, now: number) {
  const at = new Date(iso);
  const time = at.toISOString().slice(11, 19);
  const sameDay = at.toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10);
  return sameDay ? `${time} UTC` : `${at.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}, ${time} UTC`;
}

const FAILURES = {
  below_lowest_rung: "its pot was below the smallest buy the open can make",
  min_raise_missed: "its pot missed the creator's minimum raise",
  late: "the open had not run 15 minutes after its time",
} as const;

/** The phase's headline: what the countdown counts to. */
function headline(view: FairOpen, now: number) {
  switch (view.phase) {
    case "scheduled":
      return { label: "Deposits open in", value: countdown(Date.parse(view.depositsOpenAt) - now), note: `at ${clock(view.depositsOpenAt, now)} · a 10-minute window` };
    case "window":
      return { label: "Window closes in", value: countdown(Date.parse(view.opensAt) - now), note: `at ${clock(view.opensAt, now)} · the open is due then` };
    case "due":
      return { label: "The open is due", value: "Now", note: `If it has not run by ${clock(view.lateAt, now)}, the launch fails and every deposit comes back.` };
    case "opened":
      return { label: "The coin is live", value: "Opened", note: "The pot bought first, and public trading opened in the same second." };
    case "failing":
      return { label: "This Fair Open cannot open", value: "Failing", note: `It fails because ${FAILURES[view.failure!]}. Anyone can mark it failed now.` };
    case "failed":
      return { label: "This Fair Open failed", value: "Failed", note: `No coin was created: ${FAILURES[view.failure!]}. Every depositor takes their SOL back.` };
    case "closed":
      return { label: "This Fair Open is closed", value: "Closed", note: "It failed, and every deposit and rent has gone back." };
  }
}

/**
 * A Fair Open's page (spec 9, screen 2): the sealed coin, the countdown, the pot filling against its cap with the line
 * past which Unverified deposits stop counting, the minimum raise, the visitor's own deposit, what the pot would buy if
 * the window closed now, and what happens at the open; once it has opened, the coin revealed, what the pot bought, and
 * the visitor's coins and refund. Every deposit, withdrawal, open, delivery and failure reloads it live; on a phone the
 * deposit panel comes first.
 */
export function FairOpenPage({ initial }: { initial: FairOpen }) {
  const launch = initial.launch;
  const { account } = useWallet();
  const wallet = account?.address;
  const [view, setView] = useState(initial);
  const [offsetMs, setOffsetMs] = useState(0);
  // The API's clock as the page was served: the server's render and the browser's first one must say the same.
  const [now, setNow] = useState(() => Date.parse(initial.serverTime));

  const load = useCallback(async () => {
    const asked = Date.now();
    const latest = await getFairOpen(launch, wallet).catch(() => null);
    if (!latest) return;
    setOffsetMs(Date.parse(latest.serverTime) - (asked + Date.now()) / 2);
    setView(latest);
  }, [launch, wallet]);

  // Now, whenever the wallet changes, every 15 s, and just after each of the launch's own times.
  useEffect(() => {
    void load();
    const refresh = setInterval(load, REFRESH_MS);
    return () => clearInterval(refresh);
  }, [load]);
  useEffect(() => {
    const at = Date.now() + offsetMs;
    const next = [view.depositsOpenAt, view.opensAt, view.lateAt].map(Date.parse).find((t) => t > at);
    if (next === undefined) return;
    const wake = setTimeout(load, next - at + 1_500);
    return () => clearTimeout(wake);
  }, [view.depositsOpenAt, view.opensAt, view.lateAt, offsetMs, load]);

  const onBatch = useCallback((batch: LiveBatch) => {
    if (batch.events.some((e) => e.type === "fair_open" && e.launch === launch)) void load();
  }, [launch, load]);
  useLiveRoom(fairOpenLiveUrl(launch), { onBatch, onOpen: load });

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, []);
  const at = now + offsetMs;
  const head = headline(view, at);
  const minRaise = BigInt(view.minRaise);
  const reached = BigInt(view.allocation.spend) >= minRaise;
  const windowOpen = view.phase === "scheduled" || view.phase === "window";
  const ended = view.phase === "failing" || view.phase === "failed" || view.phase === "closed";
  const people = view.pot.seats;
  const open = view.open;
  const coin = open?.coin ?? null;
  const hash = (
    <span className={`mono ${styles.hash}`} title="SHA-256 of the coin's name, ticker and metadata URI, which fixes its image too">
      {view.identityHash.slice(0, 16).replace(/(.{4})/g, "$1\u{a0}").trim()}…
    </span>
  );

  return (
    <div className={styles.page}>
      <header className={`panel ${styles.head}`}>
        <div className={styles.identity}>
          <span className={open ? styles.revealed : styles.sealed} aria-hidden="true">
            {open ? (coin?.ticker.slice(0, 1) ?? "") : "?"}
          </span>
          <div className={styles.title}>
            <p className="eyebrow">{open ? "Fair Open · opened" : "Fair Open"}</p>
            <h1 data-testid="fair-open-coin">
              {open ? (coin ? coin.name : "The coin is live") : "Sealed coin"}
              {coin && <span className={`mono ${styles.ticker}`}>{coin.ticker}</span>}
            </h1>
            <p className="muted">
              by{" "}
              {view.creator.handle ? (
                <b className={styles.handle}>@{view.creator.handle}</b>
              ) : (
                <span className="mono">{shortAddress(view.creator.wallet)}</span>
              )}
            </p>
          </div>
        </div>
        {view.teaser && <p className={styles.teaser}>&ldquo;{view.teaser}&rdquo;</p>}
        {open ? (
          <p className="note">
            Revealed at the open, and the coin the creator committed to in advance: its name, ticker and metadata URI match {hash}, or the open could not
            have run.
          </p>
        ) : (
          <p className="note">
            Its name, ticker and image are revealed at the open. The creator committed to them in advance: the coin created at the open must match {hash} or
            the open fails and everyone is refunded.
          </p>
        )}
      </header>

      <div className={styles.layout}>
        <aside className={styles.side}>
          <DepositPanel view={view} onChanged={load} />
          {!ended && <IfClosedNow view={view} />}
        </aside>

        <div className={styles.main}>
          <section className={styles.figures} aria-label="Where the Fair Open stands">
            <div className={`panel ${styles.figure} ${styles[view.phase]}`} data-testid="fair-open-phase">
              <span className="eyebrow">{head.label}</span>
              <span className={`num ${styles.big}`}>{head.value}</span>
              <span className="note">{head.note}</span>
            </div>
            {open ? (
              <div className={`panel ${styles.figure}`}>
                <span className="eyebrow">The pot bought with</span>
                <span className={styles.big}>
                  <span className="num" data-testid="fair-open-spent">
                    {sol(open.spent, 4)}
                  </span>
                  <span className={styles.unit}> SOL</span>
                </span>
                <span className="note">
                  of the <span className="num">{sol(view.pot.total, 2)}</span>&nbsp;SOL {people} {people === 1 ? "person" : "people"} deposited; the rest was
                  refunded
                </span>
              </div>
            ) : (
            <div className={`panel ${styles.figure}`}>
              <span className="eyebrow">In the pot</span>
              <span className={styles.big}>
                <span className="num" data-testid="fair-open-pot">
                  {sol(view.pot.total, 2)}
                </span>
                <span className={styles.unit}> SOL</span>
              </span>
              <span className="note">
                {!ended ? (
                  <>
                    from {people} {people === 1 ? "person" : "people"}, buying up to <span className="num">{sol(view.potCap, 2)}</span>&nbsp;SOL
                  </>
                ) : people > 0 ? (
                  `from ${people} ${people === 1 ? "person" : "people"}, still to go back`
                ) : (
                  "Every deposit has gone back."
                )}
              </span>
            </div>
            )}
            <div className={`panel ${styles.figure}`}>
              <span className="eyebrow">Minimum raise</span>
              {minRaise === 0n ? (
                <>
                  <span className={styles.big}>None</span>
                  <span className="note">{ended ? "The creator set none." : "The coin opens with whatever the pot holds, down to its smallest buy."}</span>
                </>
              ) : (
                <>
                  <span className={`${styles.big} ${reached ? styles.reached : ""}`}>
                    <span className="num">{sol(minRaise, 2)}</span>
                    <span className={styles.unit}> SOL{reached ? " \u{2713}" : ""}</span>
                  </span>
                  <span className="note">
                    {reached
                      ? windowOpen
                        ? "Reached. If the pot misses it, no coin is created and everyone is refunded."
                        : "Reached."
                      : windowOpen
                        ? "Not reached yet. If the pot misses it, no coin is created and everyone is refunded."
                        : "Missed: no coin is created, and everyone is refunded."}
                  </span>
                </>
              )}
            </div>
          </section>

          <PotMeter view={view} />

          {open ? <AfterOpen view={view} /> : ended ? <AfterFailure view={view} /> : <OpenSteps view={view} at={at} />}
        </div>
      </div>
    </div>
  );
}

/** What happens at the open (spec 2.1 steps 10 to 14), and when the launch fails if it never comes. */
function OpenSteps({ view, at }: { view: FairOpen; at: number }) {
  const closed = view.phase === "due";
  return (
    <section className={`panel ${styles.steps}`} aria-labelledby="open-steps">
      <h2 id="open-steps" className={styles.sectionTitle}>
        What happens at the open
      </h2>
      <ol className={styles.list}>
        <li>
          <b>The window {closed ? "closed" : "closes"} at {clock(view.opensAt, at)}.</b>{" "}
          <span className="muted">{closed ? "Every deposit is locked until the open." : "Until then you can take back any or all of your deposit."}</span>
        </li>
        <li>
          <b>One transaction creates the coin, its pool and the pot&apos;s buy.</b>{" "}
          <span className="muted">The pot buys first and pays the normal 1.25% fee. Anyone else buying in that second pays the 99% sniper tax.</span>
        </li>
        <li>
          <b>Everyone in the pot pays the same price.</b>{" "}
          <span className="muted">
            If more is deposited than the pot can buy, everyone gets an equal share; if you asked for less than the share, you get all of yours. The
            rest is refunded.
          </span>
        </li>
        <li>
          <b>Coins and refunds arrive in your wallet within seconds.</b> <span className="muted">Sent by Heat&apos;s labelled keeper. Nothing to claim, no vesting.</span>
        </li>
        <li>
          <b>A minute later, you get your Tax Share.</b>{" "}
          <span className="muted">Fees snipers pay in the first minute go to the pot&apos;s depositors, in proportion to what each deposit bought.</span>
        </li>
      </ol>
      <p className="note">
        If the coin has not been created by <span className="mono">{clock(view.lateAt, at)}</span>, anyone can mark this launch failed, and you take your
        deposit and both rents back on chain yourself, with no Heat server needed.
      </p>
      <div className="verdict verdict-info">
        <b>Devnet build</b>
        <span className="note">
          Heat&apos;s keeper does not send the open on its own yet: here a Fair Open opens when Heat runs it by hand, and one nobody opens fails 15 minutes
          after its time, every depositor taking their SOL back.
        </span>
      </div>
    </section>
  );
}

/** After the open (spec 2.1 steps 10 to 12): what the pot bought and at what price, and every seat's coins and refund. */
function AfterOpen({ view }: { view: FairOpen }) {
  const open = view.open!;
  const coins = Number(BigInt(open.coins)) / 10 ** open.coinDecimals;
  const price = coins > 0 ? Number(BigInt(open.spent)) / 1e9 / coins : 0;
  const seats = view.pot.seats;
  const name = open.coin?.ticker ?? "coins";
  return (
    <section className={`panel ${styles.steps}`} aria-labelledby="after-open">
      <h2 id="after-open" className={styles.sectionTitle}>
        What happened at the open
      </h2>
      <ol className={styles.list}>
        <li>
          <b>One transaction created the coin, its pool and the pot&apos;s buy.</b>{" "}
          <span className="muted">The pot bought first and paid the normal 1.25% fee. Anyone else buying in that second paid the 99% sniper tax.</span>
        </li>
        <li>
          <b>
            The pot bought <span className="num">{coinAmount(open.coins, open.coinDecimals)}</span> {name} with{" "}
            <span className="num">{sol(open.spent, 4)}</span>&nbsp;SOL.
          </b>{" "}
          <span className="muted">
            Everyone in the pot paid the same price, <span className="num">{compactNumber(price)}</span>&nbsp;SOL a coin, and got back what the pot did not
            spend of their deposit.
          </span>
        </li>
        <li>
          <b data-testid="fair-open-delivered">
            {open.delivered >= seats
              ? "Every seat has its coins and refund."
              : `${open.delivered} of ${seats} seats ${open.delivered === 1 ? "has its" : "have their"} coins and refund.`}
          </b>{" "}
          <span className="muted">Heat&apos;s keeper sends them to each depositor&apos;s wallet; anyone can, and a depositor can claim their own here.</span>
        </li>
      </ol>
      <a className={`btn btn-go ${styles.trade}`} href={`/coin/${open.mint}`}>
        Trade {open.coin ? open.coin.ticker : "the coin"} on its page
      </a>
      <div className="verdict verdict-info">
        <b>Devnet build</b>
        <span className="note">
          The Tax Share and the Creator lock come in Heat&apos;s next build. Until then, the sniper tax of this coin&apos;s first minute waits in its pool,
          and a creator&apos;s own coins wait in the pot.
        </span>
      </div>
    </section>
  );
}

/** Once a launch cannot open: no coin, and every deposit and rent back, from the page or on chain alone. */
function AfterFailure({ view }: { view: FairOpen }) {
  const settled = view.phase === "closed" || view.pot.seats === 0;
  return (
    <section className={`panel ${styles.steps}`} aria-labelledby="after-failure">
      <h2 id="after-failure" className={styles.sectionTitle}>
        What happens now
      </h2>
      <ol className={styles.list}>
        <li>
          <b>No coin is created.</b> <span className="muted">The sealed coin is never revealed, and nothing is bought.</span>
        </li>
        <li>
          <b>Every depositor takes back their deposit and both rents.</b>{" "}
          <span className="muted">
            {settled
              ? "Every seat has been returned."
              : `${view.pot.seats} ${view.pot.seats === 1 ? "seat is" : "seats are"} still to be returned, from this page or on chain alone, with no Heat server needed: anyone can send a seat's refund, and it pays only that seat's wallet.`}
          </span>
        </li>
        <li>
          <b>Then the creator&apos;s rent comes back too.</b> <span className="muted">Once every seat is back, the launch closes and returns its rent.</span>
        </li>
      </ol>
    </section>
  );
}

/**
 * "If the window closed now" (spec 2.1 step 11): each person's share, and the visitor's fill and refund; once the window
 * has closed, the same figures at the open.
 */
function IfClosedNow({ view }: { view: FairOpen }) {
  const opened = view.phase === "opened";
  const { others, unverified, spend, rung } = view.allocation;
  const twoLevels = unverified.level !== others.level && unverified.limited;
  const seat = view.you?.seat ?? null;
  const rent = BigInt(view.rent.seat) + BigInt(view.rent.coinAccount);
  const share = !others.limited && !unverified.limited ? null : others.limited ? others.level : unverified.level;
  return (
    <section className={`panel ${styles.ifClosed}`} aria-labelledby="if-closed">
      <h2 id="if-closed" className={styles.sectionTitle}>
        {opened || view.phase === "due" ? "At the open" : "If the window closed now"}
      </h2>
      <dl className={styles.facts}>
        <div>
          <dt>Each person&apos;s share</dt>
          <dd data-testid="fair-open-level">{share === null ? "All they asked" : <Sol lamports={share} />}</dd>
        </div>
        {twoLevels && (
          <div>
            <dt>Each Unverified person&apos;s</dt>
            <dd>
              <Sol lamports={unverified.level} />
            </dd>
          </div>
        )}
        <div>
          <dt>The pot {opened ? "bought" : "would buy"} with</dt>
          <dd data-testid="fair-open-rung">{rung === null ? "Nothing: too little" : <Sol lamports={rung} />}</dd>
        </div>
        <div>
          <dt>Your deposit {opened ? "bought" : "buys"} with</dt>
          <dd data-testid="fair-open-fill">{seat ? <Sol lamports={seat.fill} /> : "No deposit yet"}</dd>
        </div>
        <div>
          <dt>Your refund</dt>
          <dd>{seat ? <Sol lamports={seat.refund} /> : "None"}</dd>
        </div>
        <div>
          <dt>Rent for your seat and coin account, all returned</dt>
          <dd>
            <Sol lamports={seat ? BigInt(seat.seatRent) + BigInt(seat.coinRent) : rent} digits={6} />
          </dd>
        </div>
      </dl>
      {rung === null ? (
        BigInt(spend) > 0n && <p className="note">The pot would spend less than its smallest buy, so the open could not run and every deposit would come back.</p>
      ) : (
        BigInt(rung) < BigInt(spend) && (
          <p className="note">
            {opened ? (
              <>
                The open buys in 5% steps down from the pot&apos;s cap, so it spent <span className="num">{sol(rung, 9)}</span> of the{" "}
                <span className="num">{sol(spend, 9)}</span> SOL the shares added up to: every share was scaled down alike, and the rest refunded.
              </>
            ) : (
              <>
                The open buys in 5% steps down from the pot&apos;s cap, so it would spend <span className="num">{sol(rung, 9)}</span> of the{" "}
                <span className="num">{sol(spend, 9)}</span> SOL the shares add up to: every share is scaled down alike, and the rest is refunded.
              </>
            )}
          </p>
        )
      )}
      <p className="note">
        Worked example: a 15 SOL pot with 30 people asking 0.1 SOL and 50 asking 0.5 to 2 SOL. The 30 get 0.1 each, the 50 get 0.24 each, and the rest is
        refunded.
      </p>
    </section>
  );
}

/** An amount of SOL, its figure in the numbers' face and its unit in the text's. */
function Sol({ lamports, digits = 9 }: { lamports: bigint | string; digits?: number }) {
  return (
    <>
      <span className="num">{sol(lamports, digits)}</span> SOL
    </>
  );
}
