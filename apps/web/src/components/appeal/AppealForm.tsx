"use client";

// An appeal against Vamp Shield's refusal (spec 6.2, 6.6): the creator says which coin is the original, theirs, or not
// the one matched, and why; Heat's operators answer within 48 hours. A relaunch, a migration or a community takeover
// passes by linking the original. Until an appeal is upheld, the coin as refused cannot launch.
import Link from "next/link";
import { useEffect, useState } from "react";
import type { FieldVerdict, ImageVerdict, Me, VampAppeal, VampShieldVerdict } from "@top-pad/contract";
import { checkVampShield, getAppeals, getImageVerdict, getMe, linkXUrl, submitAppeal } from "@/lib/api";
import { coinLabel, Matched } from "../launch/VampVerdict";
import styles from "./Appeal.module.css";

const STATUS = { open: { tone: "info", text: "Open" }, upheld: { tone: "go", text: "Upheld" }, denied: { tone: "stop", text: "Denied" } } as const;

export function AppealForm({ ticker, name, imageSha256 }: { ticker: string; name: string; imageSha256: string | null }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [verdict, setVerdict] = useState<VampShieldVerdict | null>(null);
  const [image, setImage] = useState<ImageVerdict | null>(null);
  const [appeals, setAppeals] = useState<VampAppeal[] | null>(null);
  const [original, setOriginal] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<VampAppeal | null>(null);
  const returnTo = `/appeal?${new URLSearchParams({ ticker, name, ...(imageSha256 ? { image: imageSha256 } : {}) })}`;

  useEffect(() => {
    getMe()
      .then((m) => {
        setMe(m);
        if (m) getAppeals().then((a) => setAppeals(a.appeals), () => setAppeals([]));
        if (m && imageSha256) getImageVerdict(imageSha256).then(setImage, () => undefined);
      })
      .catch(() => setMe(null));
    if (ticker || name) checkVampShield(ticker, name).then(setVerdict, () => undefined);
  }, [ticker, name, imageSha256]);

  // Every part Vamp Shield refused, with the coin it matched: the ticker and the name as they read now, the image as it
  // was judged when it was checked.
  const parts: [string, FieldVerdict | undefined][] = [
    ["Ticker", verdict?.verdicts.ticker],
    ["Name", verdict?.verdicts.name],
    ["Image", image?.verdict],
  ];
  const refusals = parts.filter((r): r is [string, FieldVerdict] => r[1]?.status === "refused");

  async function send() {
    setSending(true);
    setProblem(null);
    try {
      const appeal = await submitAppeal({ ticker, name, imageSha256, original: original.trim() || null, message: message.trim() });
      setSent(appeal);
      setAppeals((a) => [appeal, ...(a ?? [])]);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={styles.layout}>
      <div className={styles.head}>
        <h1>Appeal a refusal</h1>
        <p className="muted">Vamp Shield refuses a launch that copies a protected coin. If it got yours wrong, tell Heat&apos;s operators why.</p>
      </div>

      <section className="panel pad stack" aria-labelledby="refused-heading">
        <h2 id="refused-heading" className={styles.subhead}>
          What was refused
        </h2>
        <dl className={styles.facts}>
          <div>
            <dt>Ticker</dt>
            <dd className="mono">{ticker ? `$${ticker}` : "None given"}</dd>
          </div>
          <div>
            <dt>Name</dt>
            <dd>{name || "None given"}</dd>
          </div>
          <div>
            <dt>Image</dt>
            <dd>{imageSha256 ? (image ? (image.verdict.status === "refused" ? "Refused" : "Not refused") : "Reading its check…") : "Not refused"}</dd>
          </div>
        </dl>
        {refusals.map(([field, v]) => (
          <div key={field} className={`verdict verdict-stop ${styles.refusal}`} data-testid={`appeal-refused-${field.toLowerCase()}`}>
            <b>
              {field}: {v.match ? `copies ${coinLabel(v.match)}` : "refused"}
            </b>
            {v.reason && <span className="note">{v.reason}</span>}
            {v.match && <Matched match={v.match} />}
          </div>
        ))}
      </section>

      <section className="panel pad stack" aria-labelledby="appeal-heading">
        <h2 id="appeal-heading" className={styles.subhead}>
          Your appeal
        </h2>
        {me === undefined ? (
          <p className="note">Checking whether this browser has linked X…</p>
        ) : !me ? (
          <div className="stack">
            <p className="muted">An appeal comes from the creator who was refused: link the X account you launch with.</p>
            <a className="btn btn-go" href={linkXUrl(returnTo)}>
              Link X
            </a>
          </div>
        ) : sent ? (
          <div className="verdict verdict-info" role="status" data-testid="appeal-sent">
            <b>Your appeal is in the operator queue</b>
            <span className="note">
              Heat&apos;s operators answer within 48 hours. Until an appeal is upheld, this coin cannot launch as it is; you can still launch it with another
              ticker, name or image.
            </span>
          </div>
        ) : (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <div className="field">
              <label htmlFor="appeal-original">The original coin, if this is a relaunch or a takeover</label>
              <input
                id="appeal-original"
                className="input mono"
                value={original}
                maxLength={200}
                placeholder="Its mint, or a link to it"
                onChange={(e) => setOriginal(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="appeal-message">Why the refusal is wrong</label>
              <textarea
                id="appeal-message"
                className={`input ${styles.message}`}
                value={message}
                maxLength={2000}
                rows={5}
                required
                placeholder="For example: we are the original's team, and its X account links to this one."
                onChange={(e) => setMessage(e.target.value)}
              />
              <span className="note">Signed in as @{me.x.handle}. The operators may ask you to prove control of the original.</span>
            </div>
            {problem && (
              <div className="verdict verdict-stop" role="alert">
                <b>Not sent</b>
                <span className="note">{problem}</span>
              </div>
            )}
            <div className="spread">
              <Link className="btn btn-ghost" href="/launch">
                Back to the launch
              </Link>
              <button type="submit" className="btn btn-go" disabled={sending || message.trim() === ""}>
                {sending ? "Sending…" : "Send the appeal"}
              </button>
            </div>
          </form>
        )}
      </section>

      {appeals && appeals.length > 0 && (
        <section className="panel pad stack" aria-labelledby="appeals-heading">
          <h2 id="appeals-heading" className={styles.subhead}>
            Your appeals
          </h2>
          <ul className={styles.appeals}>
            {appeals.map((a) => (
              <li key={a.id} className={styles.appeal}>
                <span className={styles.appealCoin}>
                  <b>{a.name}</b> <span className="mono muted">${a.ticker}</span>
                </span>
                <span className={`chip chip-${STATUS[a.status].tone}`}>{STATUS[a.status].text}</span>
                <span className="note">{new Date(a.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
