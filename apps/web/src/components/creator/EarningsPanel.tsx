"use client";

import { getBase58Decoder } from "@solana/kit";
import { useSignAndSendTransactions } from "@solana/react";
import type { UiWalletAccount } from "@wallet-standard/react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { ClaimOutcome, CreatorEarnings, EarningsCoin, EarningsQuote, QuoteInfo } from "@top-pad/contract";
import { ApiProblem, getEarnings, prepareClaim, prepareCreatorRole, reportClaim, reportCreatorRole } from "@/lib/api";
import { quoteText, shortAddress, type QuoteUnit } from "@/lib/format";
import type { SolanaChain } from "../WalletProvider";
import { LooksLikeChip } from "../vampShield/LooksLike";
import styles from "./Creator.module.css";

const SIGN_AND_SEND = "solana:signAndSendTransaction";
/** Every raw unit shows, through the quote's multiplier: a claim pays exactly what the page says, to the lamport. */
export const earned = (raw: string, quote: QuoteUnit) => quoteText(raw, quote, quote.decimals);
/** Amounts in several quotes in a sentence: "0.01 SOL and 0.5 USDC". */
const inWords = (amounts: { raw: string; quote: QuoteUnit }[]) => {
  const texts = amounts.map((a) => earned(a.raw, a.quote));
  return texts.length <= 1 ? (texts[0] ?? "") : `${texts.slice(0, -1).join(", ")} and ${texts.at(-1)}`;
};

/** One amount a line, each in its own quote. */
export function QuoteAmounts({ amounts, testId }: { amounts: { raw: string; quote: QuoteInfo }[]; testId?: string }) {
  return (
    <span className={styles.amounts} data-testid={testId}>
      {amounts.map(({ raw, quote }) => (
        <span key={quote.mint} className={styles.amount}>
          {earned(raw, quote)}
        </span>
      ))}
    </span>
  );
}

const toBytes =(base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const declined = (e: unknown) => {
  const error = e as { code?: number; message?: string };
  return error?.code === 4001 || /reject|declin|cancel|denied/i.test(error?.message ?? "");
};

type Claim =
  | { phase: "idle" }
  | { phase: "preparing" | "signing" | "confirming" }
  | { phase: "done"; outcome: ClaimOutcome }
  | { phase: "failed"; problem: string };

/**
 * A wallet's Creator Earnings (spec 4, 7): what waits in each Heat coin whose creator role it holds, read from the chain,
 * with a graduated coin's LP fees from its Meteora pool, by the quote each coin is priced in (#99), and one claim of it
 * all, in one wallet request however many quotes it pays, which pays the amounts shown (LP fees that accrue meanwhile
 * come too). A claim the wallet signs is sent by the wallet, and the API then reads what it paid from the chain.
 */
export function EarningsPanel({ account, chain, onChanged }: { account: UiWalletAccount; chain: SolanaChain; onChanged?: () => Promise<void> }) {
  const wallet = account.address;
  const [earnings, setEarnings] = useState<CreatorEarnings | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [claim, setClaim] = useState<Claim>({ phase: "idle" });

  const load = useCallback(async () => {
    setProblem(null);
    try {
      setEarnings(await getEarnings(wallet));
    } catch (e) {
      setProblem(e instanceof ApiProblem ? e.message : `Your earnings could not be read: ${(e as Error).message}`);
    }
  }, [wallet]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!earnings) {
    return (
      <section className={`panel ${styles.panel}`} aria-busy={!problem} aria-label="Creator Earnings">
        {problem ? (
          <div className="verdict verdict-stop" role="alert">
            <b>Your earnings could not be read</b>
            <span className="note">{problem}</span>
            <button type="button" className={`btn btn-sm ${styles.retry}`} onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : (
          <p className="muted">Reading what waits for {shortAddress(wallet)} from the chain…</p>
        )}
      </section>
    );
  }

  const claimable = earnings.quotes.flatMap((q) => q.coins.filter((coin) => BigInt(coin.waiting) > 0n));
  const owed = earnings.quotes.filter((q) => BigInt(q.waiting) > 0n);
  const withCoins = earnings.quotes.filter((q) => q.coins.length > 0);
  const busy = claim.phase === "preparing" || claim.phase === "signing" || claim.phase === "confirming";
  return (
    <>
      <section className={`panel ${styles.summary}`} aria-label="Your Creator Earnings">
        <dl className={styles.figures}>
          <div>
            <dt className="eyebrow">Waiting for you</dt>
            <dd className={`num ${styles.waiting}`}>
              <QuoteAmounts amounts={(owed.length ? owed : earnings.quotes.slice(0, 1)).map((q) => ({ raw: q.waiting, quote: q.quote }))} testId="earnings-waiting" />
            </dd>
          </div>
          <div>
            <dt className="eyebrow">Claimed so far</dt>
            <dd className={`num ${styles.claimed}`}>
              <QuoteAmounts amounts={claimedFigures(earnings.quotes).map((q) => ({ raw: q.claimed, quote: q.quote }))} testId="earnings-claimed" />
            </dd>
          </div>
        </dl>
        <div className={styles.action}>
          {account.features.includes(SIGN_AND_SEND) ? (
            <ClaimButton account={account} chain={chain} coins={claimable} owed={owed} busy={busy} onClaim={setClaim} onClaimed={load} />
          ) : (
            <p className="note">Your wallet can sign but not send a transaction from a page, which a claim needs. Claim with Phantom, Solflare or Backpack.</p>
          )}
        </div>
        <ClaimStatus claim={claim} quotes={earnings.quotes} />
      </section>

      {withCoins.length === 0 ? (
        <section className={`panel ${styles.empty}`}>
          <p>
            No Heat coin&apos;s creator role is held by <span className={`mono ${styles.address}`}>{shortAddress(wallet)}</span>. A coin you launch, or one whose
            creator role is handed to this wallet, shows here.
          </p>
          <Link href="/launch" className="btn btn-go">
            Launch a coin
          </Link>
        </section>
      ) : (
        withCoins.map((group) => (
          <section
            key={group.quote.mint}
            className={`panel ${styles.coins}`}
            aria-label={withCoins.length > 1 ? `Your coins priced in ${group.quote.symbol}` : "Your coins"}
            data-testid="earnings-quote"
          >
            {withCoins.length > 1 && (
              <div className={styles.quoteHead}>
                <h3>Priced in {group.quote.symbol}</h3>
                <p className="note">
                  <span className="num">{earned(group.waiting, group.quote)}</span> waiting, claimed in a transaction of its own
                </p>
              </div>
            )}
            <div className={styles.columns} aria-hidden="true">
              <span>Coin</span>
              <span>Waiting</span>
              <span>Claimed</span>
            </div>
            <ul className={styles.list}>
              {group.coins.map((coin) => (
                <CoinRow
                  key={coin.mint}
                  coin={coin}
                  quote={group.quote}
                  account={account}
                  chain={chain}
                  onHandedOver={async () => {
                    await load();
                    await onChanged?.();
                  }}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </>
  );
}

/** What claims paid, a line a quote paid in, or SOL's nothing when none has. */
const claimedFigures = (quotes: EarningsQuote[]) => {
  const paid = quotes.filter((q) => BigInt(q.claimed) > 0n);
  return paid.length ? paid : quotes.slice(0, 1);
};

function CoinRow({
  coin,
  quote,
  account,
  chain,
  onHandedOver,
}: {
  coin: EarningsCoin;
  quote: QuoteInfo;
  account: UiWalletAccount;
  chain: SolanaChain;
  onHandedOver: () => Promise<void>;
}) {
  return (
    <li className={styles.coin} data-testid="earnings-coin">
      <Link href={`/coin/${coin.mint}`} className={styles.identity}>
        {coin.imageUri ? (
          <img src={coin.imageUri} alt="" width={40} height={40} className={styles.image} />
        ) : (
          <span className={styles.monogram} aria-hidden="true">
            {coin.ticker.slice(0, 1)}
          </span>
        )}
        <span className={styles.names}>
          <b>{coin.name}</b>
          <span className="mono muted">{coin.ticker}</span>
          <LooksLikeChip labels={coin.looksLike} />
        </span>
      </Link>
      <span className={styles.cell}>
        <span className={`eyebrow ${styles.label}`}>Waiting</span>
        {coin.windowClaimed ? (
          <span className={styles.waitingCell}>
            <span className="num">{earned(coin.waiting, quote)}</span>
            {BigInt(coin.lpFees) > 0n && (
              <span className="note" data-testid="earnings-lp-fees">
                with <span className="num">{earned(coin.lpFees, quote)}</span> of LP fees from its Meteora pool
              </span>
            )}
          </span>
        ) : (
          <span className="chip chip-caution" title="Heat's keeper claims the first minute's tax for the treasury when the minute ends; your half of every fee after it waits here from then.">
            First minute&apos;s claim pending
          </span>
        )}
      </span>
      <span className={styles.cell}>
        <span className={`eyebrow ${styles.label}`}>Claimed</span>
        <span className="num muted">{earned(coin.claimed, quote)}</span>
      </span>
      {account.features.includes(SIGN_AND_SEND) && <RoleHandover coin={coin} account={account} chain={chain} onHandedOver={onHandedOver} />}
    </li>
  );
}

type Handing = { phase: "closed" } | { phase: "open" } | { phase: "sending" } | { phase: "failed"; problem: string };

/**
 * The coin's creator role handed to another wallet (spec 7), DBC's own `transfer_pool_creator`, signed and sent by this
 * wallet: what waits now and every fee after goes to the new holder, while the coin stays on its launcher's record.
 */
function RoleHandover({ coin, account, chain, onHandedOver }: { coin: EarningsCoin; account: UiWalletAccount; chain: SolanaChain; onHandedOver: () => Promise<void> }) {
  const signAndSend = useSignAndSendTransactions(account, chain);
  const [to, setTo] = useState("");
  const [handing, setHanding] = useState<Handing>({ phase: "closed" });
  const valid = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to.trim()) && to.trim() !== account.address;

  async function handOver() {
    setHanding({ phase: "sending" });
    try {
      const { transaction } = await prepareCreatorRole(coin.mint, account.address, to.trim());
      let sent;
      try {
        sent = await signAndSend({ transaction: toBytes(transaction) });
      } catch (e) {
        setHanding({ phase: "failed", problem: declined(e) ? "You declined in your wallet. Nothing was sent." : `Your wallet could not send it: ${(e as Error).message}` });
        return;
      }
      const outcome = await reportCreatorRole(coin.mint, getBase58Decoder().decode(sent[0]!.signature));
      if (outcome.status !== "landed") {
        setHanding({ phase: "failed", problem: outcome.status === "failed" ? `It failed on chain: ${outcome.error ?? "no reason given"}.` : "It has not confirmed yet. Check it on the explorer." });
        return;
      }
      setHanding({ phase: "closed" });
      await onHandedOver();
    } catch (e) {
      setHanding({ phase: "failed", problem: e instanceof ApiProblem ? e.message : `It did not go through: ${(e as Error).message}` });
    }
  }

  if (handing.phase === "closed") {
    return (
      <div className={styles.roleAction}>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setHanding({ phase: "open" })}>
          Hand over creator role
        </button>
      </div>
    );
  }
  return (
    <form
      className={styles.roleForm}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void handOver();
      }}
    >
      <div className="field">
        <label htmlFor={`role-to-${coin.mint}`}>Hand {coin.ticker}&apos;s creator role to</label>
        <input
          id={`role-to-${coin.mint}`}
          className="input mono"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="A wallet's address"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={to.trim() !== "" && !valid}
        />
      </div>
      <p className="note">
        That wallet gets what waits now and every fee after, and can claim them; the coin stays on the record that launched it. One transaction, signed by{" "}
        <span className="mono">{shortAddress(account.address)}</span>.
      </p>
      <div className="row">
        <button type="submit" className="btn btn-sm btn-go" disabled={!valid || handing.phase === "sending"}>
          {handing.phase === "sending" ? "Handing over…" : "Sign and hand over"}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setHanding({ phase: "closed" })} disabled={handing.phase === "sending"}>
          Keep it
        </button>
      </div>
      {handing.phase === "failed" && (
        <div className="verdict verdict-stop" role="alert">
          <b>The creator role was not handed over</b>
          <span className="note">{handing.problem}</span>
        </div>
      )}
    </form>
  );
}

/**
 * The claim: built by Heat's API for exactly the amounts shown, each quote's coins in transactions of their own, all
 * signed and sent by the wallet in one request, then read back from the chain.
 */
function ClaimButton({
  account,
  chain,
  coins,
  owed,
  busy,
  onClaim,
  onClaimed,
}: {
  account: UiWalletAccount;
  chain: SolanaChain;
  coins: EarningsCoin[];
  owed: EarningsQuote[];
  busy: boolean;
  onClaim: (claim: Claim) => void;
  onClaimed: () => Promise<void>;
}) {
  const signAndSend = useSignAndSendTransactions(account, chain);
  const total = inWords(owed.map((q) => ({ raw: q.waiting, quote: q.quote })));

  async function claimAll() {
    try {
      onClaim({ phase: "preparing" });
      const prepared = await prepareClaim(
        account.address,
        coins.map((coin) => ({ mint: coin.mint, partnerFees: coin.partnerFees, lpFees: coin.lpFees })),
      );
      const pays = inWords(
        prepared.quotes.flatMap((p) => {
          const quote = owed.find((q) => q.quote.mint === p.mint)?.quote;
          return quote ? [{ raw: p.pays, quote }] : [];
        }),
      );
      const exact = prepared.quotes.length === owed.length && owed.every((q) => prepared.quotes.find((p) => p.mint === q.quote.mint)?.pays === q.waiting);
      if (!exact) throw new Error(`the claim would pay ${pays}, not the ${total} shown`);
      onClaim({ phase: "signing" });
      let sent;
      try {
        sent = await signAndSend(...prepared.transactions.map((transaction) => ({ transaction: toBytes(transaction) })));
      } catch (e) {
        onClaim({ phase: "failed", problem: declined(e) ? "You declined in your wallet. Nothing was sent." : `Your wallet could not send the claim: ${(e as Error).message}` });
        return;
      }
      onClaim({ phase: "confirming" });
      const outcome = await reportClaim(sent.map(({ signature }) => getBase58Decoder().decode(signature)));
      onClaim(outcome.transactions.every((t) => t.status === "landed") ? { phase: "done", outcome } : { phase: "failed", problem: unlanded(outcome) });
      await onClaimed();
    } catch (e) {
      onClaim({ phase: "failed", problem: e instanceof ApiProblem ? e.message : `The claim did not go through: ${(e as Error).message}` });
      if (e instanceof ApiProblem && e.status === 409) await onClaimed();
    }
  }

  const nothing = coins.length === 0;
  return (
    <button type="button" className="btn btn-go" onClick={claimAll} disabled={busy || nothing}>
      {busy ? "Claiming…" : nothing ? "Nothing to claim yet" : `Claim ${total}`}
    </button>
  );
}

const unlanded = (outcome: ClaimOutcome) => {
  const failed = outcome.transactions.find((t) => t.status === "failed");
  return failed
    ? `The claim failed on chain: ${failed.error ?? "no reason given"}.`
    : "The claim has not confirmed yet. Check it on the explorer before claiming again.";
};

const STEPS = [
  { phase: "preparing", label: "Built for the amounts shown" },
  { phase: "signing", label: "Signed and sent by your wallet" },
  { phase: "confirming", label: "Confirmed on Solana" },
] as const;

function ClaimStatus({ claim, quotes }: { claim: Claim; quotes: EarningsQuote[] }) {
  if (claim.phase === "idle") return null;
  if (claim.phase === "done") {
    const { outcome } = claim;
    const paid = outcome.quotes.flatMap((p) => {
      const quote = quotes.find((q) => q.quote.mint === p.mint)?.quote;
      return quote ? [{ raw: p.paid, quote }] : [];
    });
    return (
      <div className={`verdict verdict-go ${styles.status}`} role="status">
        <b>{paid.length ? `Claimed ${inWords(paid)}` : "Claimed"}</b>
        <span className="note">
          It is in your wallet{paid.length === 1 && paid[0]!.quote.symbol === "SOL" ? " as SOL" : ""}.{" "}
          {outcome.transactions.map((t, i) => (
            <a key={t.signature} href={t.explorer} target="_blank" rel="noreferrer">
              {outcome.transactions.length > 1 ? `Transaction ${i + 1}` : "See it on the explorer"}
            </a>
          ))}
        </span>
      </div>
    );
  }
  if (claim.phase === "failed") {
    return (
      <div className={`verdict verdict-stop ${styles.status}`} role="alert">
        <b>The claim did not go through</b>
        <span className="note">{claim.problem}</span>
      </div>
    );
  }
  const reached = STEPS.findIndex((s) => s.phase === claim.phase);
  return (
    <ol className={`${styles.steps} ${styles.status}`} aria-label="Claim progress">
      {STEPS.map((step, i) => {
        const state = i < reached ? "done" : i === reached ? "active" : "pending";
        return (
          <li key={step.phase} className={styles[state]} aria-current={state === "active" ? "step" : undefined}>
            <span className={styles.mark} aria-hidden="true" />
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}
