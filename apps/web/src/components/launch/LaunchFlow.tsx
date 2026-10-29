"use client";

// The launch flow (spec 9, screen 4): link X, choose the launch mode, enter the coin with Vamp Shield's live verdicts,
// sign, done. Fair Open is preselected, as it will be the default, and shown as coming until its scheduling lands; an
// Instant launch goes through end to end.
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LaunchRefusal, LaunchStatus, Me, Platform, VampShieldVerdict } from "@top-pad/contract";
import { canonicalTicker, nameVerdict, NAME_MAX_BYTES, tickerVerdict } from "@top-pad/vamp-shield/rules";
import { checkVampShield, getMe, getPlatform, linkXUrl, logout } from "@/lib/api";
import { shortAddress } from "@/lib/format";
import type { FittedImage } from "@/lib/image";
import { WalletButton } from "../WalletButton";
import { useWallet } from "../WalletProvider";
import { CoinCard } from "./CoinCard";
import { ImagePicker } from "./ImagePicker";
import { SignLaunch } from "./SignLaunch";
import styles from "./Launch.module.css";

type LinkOutcome = "linked" | "denied" | "failed" | null;
type Mode = "fairOpen" | "instant";

const STEPS = ["Link X", "Launch mode", "Coin", "Sign", "Done"] as const;
const LINK_NOTES: Record<Exclude<LinkOutcome, null>, { tone: "go" | "caution" | "stop"; text: string }> = {
  linked: { tone: "go", text: "Your X account is linked." },
  denied: { tone: "caution", text: "You declined on X. Every launch needs a linked X account." },
  failed: { tone: "stop", text: "Linking X did not go through. Try again." },
};

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

export function LaunchFlow({ linkOutcome: arrived }: { linkOutcome: LinkOutcome }) {
  const router = useRouter();
  // Kept from the first render: the address is cleaned of `?x=` right away, which renders the page again without it.
  const [linkOutcome] = useState(arrived);
  const { account, chain } = useWallet();
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<Mode>("fairOpen");
  const [name, setName] = useState("");
  const [ticker, setTicker] = useState("");
  const [touched, setTouched] = useState({ name: false, ticker: false });
  const [image, setImage] = useState<FittedImage | null>(null);
  const [checked, setChecked] = useState<{ key: string; verdict: VampShieldVerdict | null; problem: string | null } | null>(null);
  const [refusal, setRefusal] = useState<LaunchRefusal | null>(null);
  const [landed, setLanded] = useState<LaunchStatus | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Set when the creator moves between steps, so the new step's heading takes focus then, and only then.
  const moved = useRef(false);

  useEffect(() => {
    Promise.all([getPlatform(), getMe()])
      .then(([p, m]) => {
        setPlatform(p);
        setMe(m);
        if (m) setStep(1);
      })
      .catch((e: Error) => {
        setMe(null);
        setLoadProblem(e.message);
      });
    // The outcome of linking X arrives once, in the URL X sent the browser back to; keep the address clean.
    if (linkOutcome) router.replace("/launch", { scroll: false });
  }, [linkOutcome, router]);

  // A step the creator moves to has its heading take focus, so keyboard and screen reader users land on it.
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    heading.current?.focus();
  }, [step]);
  const goTo = (next: number) => {
    moved.current = true;
    setStep(next);
  };

  const imageUrl = useMemo(() => (image ? URL.createObjectURL(image.blob) : null), [image]);
  useEffect(() => () => void (imageUrl && URL.revokeObjectURL(imageUrl)), [imageUrl]);

  const tickerRule = tickerVerdict(ticker);
  const nameRule = nameVerdict(name);
  const key = `${ticker}\n${name}`;

  // Vamp Shield's verdict on the protected coins, asked as the creator types and settled a moment after they stop.
  useEffect(() => {
    if (!tickerRule.ok && !nameRule.ok) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      checkVampShield(ticker, name, controller.signal)
        .then((verdict) => setChecked({ key, verdict, problem: null }))
        .catch((e: Error) => {
          if (!controller.signal.aborted) setChecked({ key, verdict: null, problem: e.message });
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, ticker, name, tickerRule.ok, nameRule.ok]);

  const current = checked?.key === key ? checked : null;
  const serverVerdict = current?.verdict ?? null;
  const tickerProblem = !tickerRule.ok ? tickerRule.reason : serverVerdict?.verdicts.ticker.status === "refused" ? serverVerdict.verdicts.ticker.reason : null;
  const nameProblem = !nameRule.ok ? nameRule.reason : serverVerdict?.verdicts.name.status === "refused" ? serverVerdict.verdicts.name.reason : null;
  const coinReady = tickerRule.ok && nameRule.ok && serverVerdict?.clear === true && image !== null;

  const creatorWallet = me?.creatorWallet ?? null;
  const wrongWallet = account && creatorWallet && account.address !== creatorWallet;

  async function unlink() {
    await logout().catch(() => undefined);
    setMe(null);
    goTo(0);
  }

  function restart() {
    setName("");
    setTicker("");
    setTouched({ name: false, ticker: false });
    setImage(null);
    setChecked(null);
    setRefusal(null);
    setLanded(null);
    getMe().then(setMe).catch(() => undefined);
    goTo(1);
  }

  const canContinue = step === 0 ? !!me : step === 1 ? mode === "instant" : step === 2 ? coinReady : false;
  const linkNote = linkOutcome ? LINK_NOTES[linkOutcome] : null;

  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        <div className={styles.head}>
          <h1>Launch a coin</h1>
          <p className="note">Takes about two minutes. Nothing is public until you sign.</p>
        </div>

        <ol className={styles.stepper} aria-label="Steps">
          {STEPS.map((label, i) => {
            const done = i < step;
            const reachable = done && step < 4;
            return (
              <li key={label}>
                <button
                  type="button"
                  className={`${styles.step} ${done ? styles.stepDone : ""}`}
                  aria-current={i === step ? "step" : undefined}
                  disabled={!reachable && i !== step}
                  onClick={() => reachable && goTo(i)}
                >
                  {done && (
                    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
                      <path d="M2 6.5 5 9l5-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                  <span className={styles.stepLabel}>{label}</span>
                </button>
              </li>
            );
          })}
        </ol>

        {linkNote && step <= 1 && (
          <div className={`verdict verdict-${linkNote.tone}`} role="status">
            <b>{linkNote.text}</b>
          </div>
        )}
        {loadProblem && (
          <div className="verdict verdict-stop" role="alert">
            <b>Heat&apos;s API did not answer</b>
            <span className="note">{loadProblem}</span>
          </div>
        )}

        <section className={`panel ${styles.body}`} aria-labelledby="step-heading">
          {step === 0 && (
            <>
              <h2 id="step-heading" ref={heading} tabIndex={-1}>
                Link your X account
              </h2>
              <p className="muted">
                Every launch needs one. Your Creator record belongs to it, and your handle goes into the coin&apos;s details,
                so traders see who made it wherever the coin shows.
              </p>
              {me === undefined ? (
                <p className="note">Checking whether this browser has linked X…</p>
              ) : me ? (
                <Linked me={me} onUnlink={unlink} />
              ) : platform && !platform.xLinking ? (
                <div className="verdict verdict-caution">
                  <b>Linking X is not open on this deployment yet</b>
                  <span className="note">Its X app has not been set up. Launching needs it.</span>
                </div>
              ) : (
                <div className="row">
                  <a className="btn btn-go" href={linkXUrl("/launch")}>
                    Link X
                  </a>
                  <span className="note">You will authorize Heat on X, which only reads your name and handle.</span>
                </div>
              )}
            </>
          )}

          {step === 1 && (
            <>
              <h2 id="step-heading" ref={heading} tabIndex={-1}>
                How should your coin start trading?
              </h2>
              <div className={styles.modes} role="radiogroup" aria-label="Launch mode">
                <button type="button" role="radio" aria-checked={mode === "fairOpen"} className={styles.mode} onClick={() => setMode("fairOpen")}>
                  <span className="row">
                    <b>Fair Open</b>
                    <span className="chip chip-go">default</span>
                    <span className="chip chip-neutral">coming soon</span>
                  </span>
                  <span className="note">
                    A 10-minute deposit window, then everyone in the pot buys at one price. You can deposit like anyone else, up
                    to your tier&apos;s cap, and your share is locked: nothing for 7 days, all free by day 30.
                  </span>
                </button>
                <button type="button" role="radio" aria-checked={mode === "instant"} className={styles.mode} onClick={() => setMode("instant")}>
                  <b>Instant launch</b>
                  <span className="note">
                    Trading starts the moment the coin exists. There is no creator buy: any buy in the first second, yours
                    included, pays the 99% sniper tax, and the first minute&apos;s tax goes to Heat.
                  </span>
                </button>
              </div>
              {mode === "fairOpen" && (
                <p className="note">Fair Open arrives in a coming release of this devnet build. Choose Instant launch to launch now.</p>
              )}
            </>
          )}

          {step === 2 && (
            <>
              <h2 id="step-heading" ref={heading} tabIndex={-1}>
                Your coin
              </h2>
              <div className={styles.fields}>
                <div className="field">
                  <label htmlFor="coin-name">Name</label>
                  <input
                    id="coin-name"
                    className="input"
                    value={name}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Lumen"
                    aria-invalid={touched.name && !!nameProblem}
                    aria-describedby="coin-name-help"
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => setTouched((t) => ({ ...t, name: true }))}
                  />
                  <span id="coin-name-help" className={touched.name && nameProblem ? styles.fieldProblem : "note"}>
                    {touched.name && nameProblem ? nameProblem : `Up to ${NAME_MAX_BYTES} bytes${utf8Bytes(name) > NAME_MAX_BYTES - 8 ? ` (${utf8Bytes(name)} used)` : ""}.`}
                  </span>
                </div>
                <div className="field">
                  <label htmlFor="coin-ticker">Ticker</label>
                  <input
                    id="coin-ticker"
                    className="input mono"
                    value={ticker}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    maxLength={10}
                    placeholder="LUMEN"
                    aria-invalid={touched.ticker && !!tickerProblem}
                    aria-describedby="coin-ticker-help"
                    onChange={(e) => setTicker(canonicalTicker(e.target.value.replace(/^\s*\$/, "")))}
                    onBlur={() => setTouched((t) => ({ ...t, ticker: true }))}
                  />
                  <span id="coin-ticker-help" className={touched.ticker && tickerProblem ? styles.fieldProblem : "note"}>
                    {touched.ticker && tickerProblem ? tickerProblem : "A to Z and 0 to 9, 2 to 10 characters."}
                  </span>
                </div>
              </div>
              <ImagePicker image={image} previewUrl={imageUrl} maxBytes={platform?.maxImageBytes ?? 98_304} onChange={setImage} />
              <VampVerdict
                ready={tickerRule.ok && nameRule.ok}
                verdict={serverVerdict}
                problem={current?.problem ?? null}
                refusal={refusal?.verdict && refusal.verdict.ticker === ticker && refusal.verdict.name === name ? refusal : null}
              />
            </>
          )}

          {step === 3 && image && (
            <>
              <h2 id="step-heading" ref={heading} tabIndex={-1}>
                Sign the launch
              </h2>
              <p className="muted">One signature creates your coin and its pool. Your wallet is the coin&apos;s creator on every terminal.</p>
              <div className="verdict verdict-caution">
                <b>No creator buy</b>
                <span className="note">If you buy in the first second, you pay the 99% sniper tax like anyone else.</span>
              </div>
              {!account ? (
                <div className="stack">
                  <p className="note">
                    {creatorWallet
                      ? `Connect your Creator wallet, ${shortAddress(creatorWallet)}: it is the only wallet that can sign your launches.`
                      : "The wallet that signs this launch becomes your Creator wallet, the only one that can sign your launches."}
                  </p>
                  <WalletButton variant="inline" />
                </div>
              ) : wrongWallet ? (
                <div className="verdict verdict-stop" role="alert">
                  <b>This is not your Creator wallet</b>
                  <span className="note">
                    Your launches are signed by {shortAddress(creatorWallet!)}. Connect that wallet to launch; a new Creator wallet
                    comes by a handover the old one signs.
                  </span>
                </div>
              ) : (
                <>
                  <p className="note">
                    Signing with <span className="mono">{shortAddress(account.address)}</span>
                    {creatorWallet ? ", your Creator wallet." : ", which becomes your Creator wallet."}
                  </p>
                  <SignLaunch
                    account={account}
                    chain={chain}
                    coin={{ name: nameRule.ok ? nameRule.name : name, ticker }}
                    image={image}
                    onLanded={(status) => {
                      setLanded(status);
                      goTo(4);
                    }}
                    onRefused={(r) => {
                      setRefusal(r);
                      goTo(2);
                    }}
                  />
                </>
              )}
            </>
          )}

          {step === 4 && landed && (
            <>
              <h2 id="step-heading" ref={heading} tabIndex={-1}>
                Launched
              </h2>
              <p className="muted">Your coin is trading. The sniper tax runs for its first minute, then trades pay 1.25%.</p>
              <dl className={styles.facts}>
                <div>
                  <dt>Coin</dt>
                  <dd className="mono">{landed.mint}</dd>
                </div>
                <div>
                  <dt>Pool</dt>
                  <dd className="mono">{landed.pool}</dd>
                </div>
                <div>
                  <dt>Heat&apos;s record</dt>
                  <dd className="mono">{landed.coinRecord}</dd>
                </div>
              </dl>
              <div className={styles.links}>
                {landed.explorer.transaction && (
                  <a className="btn" href={landed.explorer.transaction} target="_blank" rel="noreferrer">
                    The transaction
                  </a>
                )}
                <a className="btn" href={landed.explorer.mint} target="_blank" rel="noreferrer">
                  The coin on the explorer
                </a>
                <a className="btn" href={landed.metadataUri} target="_blank" rel="noreferrer">
                  Its metadata on Arweave
                </a>
              </div>
            </>
          )}
        </section>

        {step < 3 && (
          <div className="spread">
            <button type="button" className="btn btn-ghost" onClick={() => goTo(Math.max(0, step - 1))} disabled={step === 0}>
              Back
            </button>
            <button type="button" className="btn btn-go" onClick={() => goTo(step + 1)} disabled={!canContinue}>
              Continue
            </button>
          </div>
        )}
        {step === 3 && (
          <div className="spread">
            <button type="button" className="btn btn-ghost" onClick={() => goTo(2)}>
              Back
            </button>
          </div>
        )}
        {step === 4 && (
          <div className="spread">
            <span />
            <button type="button" className="btn btn-go" onClick={restart}>
              Launch another
            </button>
          </div>
        )}
      </div>

      <aside className={`panel ${styles.aside}`} aria-labelledby="preview-heading">
        <h3 id="preview-heading">What traders will see</h3>
        <span className="eyebrow">{mode === "instant" ? "Coin card at launch" : "Launch calendar entry"}</span>
        <CoinCard ticker={ticker} name={nameRule.ok ? nameRule.name : name.trim()} imageUrl={imageUrl} handle={me?.x.handle ?? null} mode={mode} />
        <p className="note">
          {mode === "instant"
            ? "Instant launch: visible and trading the moment it is created. No Creator lock, because there is no creator buy, and the card says the first minute's tax went to Heat."
            : "Fair Open: sealed on the calendar until its window opens, then everyone in the pot buys at one price."}
        </p>
      </aside>
    </div>
  );
}

function Linked({ me, onUnlink }: { me: Me; onUnlink: () => void }) {
  return (
    <div className="verdict verdict-go">
      <b>Linked as @{me.x.handle}</b>
      <span className="note">
        {me.creatorWallet
          ? `Creator wallet: ${shortAddress(me.creatorWallet)}. It is the only wallet that can sign your launches.`
          : "Your first launch makes the wallet that signs it your Creator wallet, the only one that can sign your launches."}{" "}
        {me.launches > 0 ? `${me.launches} launch${me.launches === 1 ? "" : "es"} so far.` : "Record: first launch."}
      </span>
      <span>
        <button type="button" className={styles.linkButton} onClick={onUnlink}>
          Not you? Sign out
        </button>
      </span>
    </div>
  );
}

function VampVerdict({
  ready,
  verdict,
  problem,
  refusal,
}: {
  ready: boolean;
  verdict: VampShieldVerdict | null;
  problem: string | null;
  refusal: LaunchRefusal | null;
}) {
  if (refusal) {
    return (
      <div className="verdict verdict-stop" role="alert">
        <b>Refused</b>
        <span className="note">{refusal.error}</span>
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="verdict verdict-neutral">
        <b>Vamp Shield</b>
        <span className="note">Once the name and ticker read right, they are checked against every protected coin.</span>
      </div>
    );
  }
  if (problem) {
    return (
      <div className="verdict verdict-caution" role="status">
        <b>Could not check against protected coins</b>
        <span className="note">{problem}</span>
      </div>
    );
  }
  if (!verdict) {
    return (
      <div className="verdict verdict-neutral" role="status">
        <b>Checking against protected coins…</b>
      </div>
    );
  }
  const match = verdict.verdicts.ticker.match ?? verdict.verdicts.name.match;
  if (!verdict.clear) {
    return (
      <div className="verdict verdict-stop" role="status">
        <b>{match ? `Refused: matches $${match.ticker}` : "Refused"}</b>
        <span className="note">{verdict.verdicts.ticker.reason ?? verdict.verdicts.name.reason}</span>
      </div>
    );
  }
  return (
    <div className="verdict verdict-go" role="status">
      <b>Clear</b>
      <span className="note">No protected coin matches this ticker or name.</span>
    </div>
  );
}
