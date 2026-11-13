"use client";

import { useState } from "react";
import { BAR_TEXT_MAX, type AppealGrounds, type BarEvidence, type PrivateBar, type PublicBar } from "@top-pad/contract";
import { ApiProblem, appealBar, replyToBar } from "@/lib/api";
import { coinAmount, dayOf, momentOf, ordinal, shortAddress, sol } from "@/lib/format";
import styles from "./Bars.module.css";

// Bars on a Creator record (spec 6.5, 9 screen 5): the published finding anyone sees, and the barred creator's own
// private view, with the evidence pack, a reply box and the appeal form.

const LABELS: Record<string, string> = {
  creator_funded: "Direct transfers with the Creator wallet",
  creator_signed: "The Creator wallet signed or paid",
  after_creation: "Bought right after the creation",
  jito_bundle: "In the creation's Jito bundle",
  same_slot: "Same slot as the creation",
};

const GROUNDS: Record<AppealGrounds, { title: string; hint: string }> = {
  shared_exchange: { title: "A shared exchange or custodian", hint: "The wallets' SOL came from an exchange or custodian you share with them, not from you." },
  launch_service: { title: "A launch service", hint: "A launch service bundled for its customers, and you were one of them, not the bundler." },
  other: { title: "Another reason a link is wrong", hint: "Say which link is wrong, and why." },
};

/** The evidence pack: each wallet directly linked to the Creator wallet, with the transfers, deposits and buys behind it. */
export function Evidence({ evidence, ticker }: { evidence: BarEvidence; ticker: string }) {
  return (
    <div className={styles.evidence}>
      <p className="note">
        {evidence.wallets.length} {evidence.wallets.length === 1 ? "wallet" : "wallets"} directly linked to the Creator wallet{" "}
        <span className="mono">{shortAddress(evidence.creatorWallet)}</span> bought <span className="num">{evidence.floor.share}</span> of ${ticker}&apos;s supply
        between {evidence.wallets.length === 1 ? "it" : "them"} across the pot and the first hour; a case needs 1%. The coin was created by{" "}
        <a href={evidence.creation.explorer} target="_blank" rel="noreferrer">
          this transaction
        </a>
        , in slot <span className="num">{evidence.creation.slot}</span>.
      </p>
      <ul className={styles.wallets}>
        {evidence.wallets.map((w) => (
          <li key={w.wallet} className={styles.wallet} data-testid="bar-evidence-wallet">
            <div className={styles.walletHead}>
              <a className="mono" href={w.explorer} target="_blank" rel="noreferrer" title={w.wallet}>
                {shortAddress(w.wallet)}
              </a>
              <span className={styles.labels}>
                {w.labels.map((l) => (
                  <span key={l} className={`chip ${l === "same_slot" ? "chip-caution" : "chip-stop"}`}>
                    {LABELS[l] ?? l}
                  </span>
                ))}
              </span>
            </div>
            <ul className={styles.lines}>
              {w.transfers.map((t) => (
                <li key={`${t.signature}:${t.direction}:${t.amount}`}>
                  <span>
                    {t.direction === "from_creator" ? "Got" : "Sent"} {t.asset === "SOL" ? `${sol(t.amount)} SOL` : `${t.amount} units of ${shortAddress(t.asset)}`}{" "}
                    {t.direction === "from_creator" ? "from" : "to"} the Creator wallet, {momentOf(t.at)}
                  </span>
                  <a href={t.explorer} target="_blank" rel="noreferrer">
                    Transfer
                  </a>
                </li>
              ))}
              {w.deposits.map((d) => (
                <li key={d.signature}>
                  <span>
                    Deposited in the pot, {momentOf(d.at)}
                    {d.creatorSigned ? ", signed or paid for by the Creator wallet" : ""}
                  </span>
                  <a href={d.explorer} target="_blank" rel="noreferrer">
                    Deposit
                  </a>
                </li>
              ))}
              {w.buys.map((b) => (
                <li key={`${b.signature}:${b.eventIndex}`}>
                  <span>
                    Bought <span className="num">{coinAmount(b.baseAmount)}</span> {ticker}
                    {b.position ? `, ${ordinal(b.position)} after the creation` : ""}
                    {b.labels.includes("same_slot") ? ", in the creation slot" : `, ${momentOf(b.at)}`}
                  </span>
                  <a href={b.explorer} target="_blank" rel="noreferrer">
                    Buy
                  </a>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

const appealLine = (appeal: PublicBar["appeal"]) =>
  appeal.status === "none" ? "No appeal filed" : appeal.status === "open" ? `Appeal waiting since ${dayOf(appeal.filedAt!)}` : `Appeal denied on ${dayOf(appeal.decidedAt!)}`;

/** A published Bar (spec 6.5): "Barred: confirmed creator bundle in <coin>, <date>", its evidence and its appeal status. */
export function PublicBars({ bars }: { bars: PublicBar[] }) {
  return (
    <>
      {bars.map((bar) => (
        <section key={bar.coin.mint} className={`panel ${styles.barred}`} aria-label={`Barred over $${bar.coin.ticker}`} data-testid="public-bar">
          <div className={styles.barHead}>
            <span className="chip chip-stop flag">Barred</span>
            <h2 className={styles.barTitle}>
              Barred: confirmed creator bundle in <a href={`/coin/${bar.coin.mint}`}>${bar.coin.ticker}</a>, {dayOf(bar.confirmedAt)}
            </h2>
          </div>
          <p className="muted">
            An operator confirmed that wallets directly linked to this record&apos;s Creator wallet bundled ${bar.coin.ticker}&apos;s launch, so Heat&apos;s launch
            key co-signs none of its launches. A Bar never expires; it stops only new launches. {appealLine(bar.appeal)}.
          </p>
          <details className={styles.details}>
            <summary>The evidence</summary>
            <Evidence evidence={bar.evidence} ticker={bar.coin.ticker} />
          </details>
        </section>
      ))}
    </>
  );
}

const APPEAL_STATUS = { open: ["chip-info", "Waiting"], upheld: ["chip-go", "Upheld"], denied: ["chip-stop", "Denied"] } as const;

/**
 * The barred creator's own view of a Bar (spec 6.5): private until its 72 hours are up, the evidence, their replies for
 * the operator, and the appeal form, or where their appeals stand.
 */
export function PrivateBarPanel({ bar, now, onChanged }: { bar: PrivateBar; now: number; onChanged: () => Promise<void> }) {
  const lifted = bar.liftedAt !== null;
  const tone = lifted ? "verdict-go" : bar.published ? "verdict-stop" : "verdict-caution";
  return (
    <section className={`panel ${styles.private}`} aria-labelledby={`bar-${bar.id}`} data-testid="private-bar">
      <div className={`verdict ${tone} ${styles.privateHead}`}>
        <b id={`bar-${bar.id}`}>
          {lifted
            ? `Lifted on appeal on ${dayOf(bar.liftedAt!)}: the Bar over $${bar.coin.ticker} is gone`
            : bar.published
              ? `Barred over $${bar.coin.ticker}, in public since ${dayOf(bar.publishAt)}`
              : `Only you see this until ${momentOf(bar.publishAt)}`}
        </b>
        <span className="note">
          {lifted
            ? "Heat's launch key co-signs your launches again, and no public page shows the finding. Heat's audit log keeps it."
            : `An operator confirmed a creator bundle in $${bar.coin.ticker} on ${momentOf(bar.confirmedAt)}, and from then Heat's launch key co-signs none of your launches. ${
                bar.published
                  ? "The finding is on this record, the coin's page and its Fairness card."
                  : `In ${hoursLeft(bar.publishAt, now)} it is published on this record, $${bar.coin.ticker}'s page and its Fairness card.`
              }`}
        </span>
      </div>
      {!lifted && (
        <p className="note">
          Your coins keep trading, your Creator Earnings keep flowing and your Creator lock keeps vesting; you can still trade and deposit in other creators&apos;
          Fair Opens. {bar.message ? (bar.message.sentAt ? `Heat's X account sent you this by direct message on ${momentOf(bar.message.sentAt)}.` : "Heat's X account is sending you this by direct message.") : ""}
        </p>
      )}
      <details className={styles.details} open={!bar.published && !lifted}>
        <summary>The evidence pack</summary>
        <Evidence evidence={bar.evidence} ticker={bar.coin.ticker} />
      </details>
      <Replies bar={bar} onChanged={onChanged} />
      <Appeals bar={bar} onChanged={onChanged} />
    </section>
  );
}

function hoursLeft(iso: string, now: number) {
  const hours = Math.max(0, (Date.parse(iso) - now) / 3_600_000);
  return hours >= 24 ? `${Math.floor(hours / 24)} d ${Math.floor(hours % 24)} h` : hours >= 1 ? `${Math.floor(hours)} h` : `${Math.ceil(hours * 60)} min`;
}

function Replies({ bar, onChanged }: { bar: PrivateBar; onChanged: () => Promise<void> }) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const send = async () => {
    setSending(true);
    setProblem(null);
    try {
      await replyToBar(bar.id, body.trim());
      setBody("");
      await onChanged();
    } catch (e) {
      setProblem(e instanceof ApiProblem ? e.message : (e as Error).message);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className={styles.block}>
      <h3 className={styles.blockTitle}>Your replies</h3>
      {bar.replies.length > 0 && (
        <ul className={styles.thread}>
          {bar.replies.map((r) => (
            <li key={r.id} className={styles.message} data-testid="bar-reply">
              <span className="note">{momentOf(r.at)}</span>
              <p>{r.body}</p>
            </li>
          ))}
        </ul>
      )}
      {bar.liftedAt === null && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="field">
            <label htmlFor={`reply-${bar.id}`}>Reply to the evidence</label>
            <textarea
              id={`reply-${bar.id}`}
              className={`input ${styles.textarea}`}
              value={body}
              maxLength={BAR_TEXT_MAX}
              rows={3}
              placeholder="What the operator should know about these wallets."
              onChange={(e) => setBody(e.target.value)}
            />
            <span className="note">Read by Heat&apos;s operators with the case. A reply is not an appeal: to have the Bar lifted, appeal below.</span>
          </div>
          {problem && (
            <div className="verdict verdict-stop" role="alert">
              <b>Not sent</b>
              <span className="note">{problem}</span>
            </div>
          )}
          <div className={styles.actions}>
            <button type="submit" className="btn" disabled={sending || body.trim() === ""}>
              {sending ? "Sending…" : "Send the reply"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function Appeals({ bar, onChanged }: { bar: PrivateBar; onChanged: () => Promise<void> }) {
  const [grounds, setGrounds] = useState<AppealGrounds>("shared_exchange");
  const [statement, setStatement] = useState("");
  const [evidence, setEvidence] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const again = bar.canAppeal === "new_evidence";
  const send = async () => {
    setSending(true);
    setProblem(null);
    try {
      await appealBar(bar.id, { grounds, statement: statement.trim(), ...(evidence.trim() ? { evidence: evidence.trim() } : {}) });
      setStatement("");
      setEvidence("");
      await onChanged();
    } catch (e) {
      setProblem(e instanceof ApiProblem ? e.message : (e as Error).message);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className={styles.block}>
      <h3 className={styles.blockTitle}>Appeal</h3>
      {bar.appeals.length > 0 && (
        <ol className={styles.thread}>
          {bar.appeals.map((a, i) => {
            const [chip, label] = APPEAL_STATUS[a.status];
            return (
              <li key={a.id} className={styles.message} data-testid="bar-appeal">
                <div className={styles.appealHead}>
                  <span className={`chip ${chip}`}>{label}</span>
                  <span className="note">
                    {i > 0 ? "Again, with new evidence · " : ""}filed {momentOf(a.filedAt)}
                    {a.status === "open" ? ` · decided by ${momentOf(a.dueAt)}` : a.decidedAt ? ` · decided ${momentOf(a.decidedAt)}` : ""}
                  </span>
                </div>
                <b>{GROUNDS[a.grounds].title}</b>
                <p>{a.statement}</p>
                {a.evidence && <p className="note">Evidence: {a.evidence}</p>}
                {a.decision && <p className={styles.decision}>The operator: &ldquo;{a.decision}&rdquo;</p>}
              </li>
            );
          })}
        </ol>
      )}
      {bar.canAppeal ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <p className="note">
            {again
              ? "Your appeal was denied. You may appeal again only with new evidence the operators have not seen."
              : `One appeal, until ${dayOf(bar.appealBy)}. An operator other than the one who confirmed the case decides it within 48 hours; upheld, it lifts the Bar and takes the finding off every public page.`}
          </p>
          <fieldset className={styles.grounds}>
            <legend className="label">Which link is wrong</legend>
            {(Object.keys(GROUNDS) as AppealGrounds[]).map((g) => (
              <label key={g} className={styles.choice}>
                <input type="radio" name={`grounds-${bar.id}`} value={g} checked={grounds === g} onChange={() => setGrounds(g)} />
                <b>{GROUNDS[g].title}</b>
                <span className="note">{GROUNDS[g].hint}</span>
              </label>
            ))}
          </fieldset>
          <div className="field">
            <label htmlFor={`statement-${bar.id}`}>Why the link is wrong</label>
            <textarea
              id={`statement-${bar.id}`}
              className={`input ${styles.textarea}`}
              value={statement}
              maxLength={BAR_TEXT_MAX}
              rows={4}
              required
              placeholder="For example: these four wallets withdrew from the same exchange account I use; I never sent them SOL."
              onChange={(e) => setStatement(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={`evidence-${bar.id}`}>{again ? "Your new evidence" : "Evidence, if you have it"}</label>
            <textarea
              id={`evidence-${bar.id}`}
              className={`input ${styles.textarea}`}
              value={evidence}
              maxLength={BAR_TEXT_MAX}
              rows={2}
              required={again}
              placeholder="Links to transactions, an exchange's statement, a launch service's receipt."
              onChange={(e) => setEvidence(e.target.value)}
            />
          </div>
          {problem && (
            <div className="verdict verdict-stop" role="alert">
              <b>Not filed</b>
              <span className="note">{problem}</span>
            </div>
          )}
          <div className={styles.actions}>
            <button type="submit" className="btn btn-go" disabled={sending || statement.trim() === "" || (again && evidence.trim() === "")}>
              {sending ? "Filing…" : "File the appeal"}
            </button>
          </div>
        </form>
      ) : (
        bar.appeals.length === 0 && <p className="note">The 30 days to appeal this Bar passed on {dayOf(bar.appealBy)} with none filed.</p>
      )}
    </div>
  );
}
