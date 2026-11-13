"use client";

// The launch flow (spec 9, screen 4): connect a wallet and sign in with it, X offered once as optional (ADR 0008); choose
// the launch mode and the quote the coin is priced in (ADR 0007), with the quote's Quote Risk Labels; enter the coin with
// Vamp Shield's live verdicts; then for a Fair Open, the default, its schedule and one approval that signs its open in
// advance (spec 2.1 steps 2 to 8), or for an Instant launch its one signature; done.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ImageVerdict, LaunchRefusal, LaunchStatus, ListedQuote, Me, Platform, VampShieldVerdict } from "@top-pad/contract";
import { canonicalTicker, nameVerdict, NAME_MAX_BYTES, teaserVerdict, tickerVerdict } from "@top-pad/vamp-shield/rules";
import { checkImage, checkVampShield, getMe, getPlatform, getQuotes, linkXUrl, logout } from "@/lib/api";
import { quoteText, shortAddress, SOL_UNIT } from "@/lib/format";
import type { FittedImage } from "@/lib/image";
import { QuoteLabels } from "../quote/QuoteLabels";
import { WalletButton } from "../WalletButton";
import { useWallet } from "../WalletProvider";
import { signedInAs, WalletSignIn } from "../WalletSignIn";
import { CoinCard, SealedCard } from "./CoinCard";
import { ImagePicker } from "./ImagePicker";
import { EMPTY_SCHEDULE, readSchedule, Schedule, span, when, type ScheduleDraft } from "./Schedule";
import { SignFairOpen } from "./SignFairOpen";
import { SignLaunch } from "./SignLaunch";
import { VampVerdict, type ImageCheckState } from "./VampVerdict";
import styles from "./Launch.module.css";

type LinkOutcome = "linked" | "denied" | "failed" | "taken" | null;
type Mode = "fairOpen" | "instant";

const STEPS = {
  instant: ["Connect wallet", "Launch mode", "Coin", "Sign", "Done"],
  fairOpen: ["Connect wallet", "Launch mode", "Coin", "Schedule", "Sign", "Done"],
} as const;
type StepName = (typeof STEPS)[Mode][number];
const LINK_NOTES: Record<Exclude<LinkOutcome, null>, { tone: "go" | "caution" | "stop"; text: string }> = {
  linked: { tone: "go", text: "Your X account is linked." },
  denied: { tone: "caution", text: "You declined on X. Linking X is optional: you can launch without it." },
  failed: { tone: "stop", text: "Linking X did not go through. Try again, or launch without it." },
  taken: { tone: "caution", text: "That X account is linked to another Creator record, or yours has another one. Nothing changed." },
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
  // The image's verdict, for the image it was asked for: a newer image is checked afresh.
  const [imageChecked, setImageChecked] = useState<{ image: FittedImage; verdict: ImageVerdict | null; problem: string | null } | null>(null);
  const [imageAsked, setImageAsked] = useState<{ image: FittedImage; at: number; attempt: number } | null>(null);
  // The launch service's refusal, for the coin it refused: changing the ticker, the name or the image puts it away.
  const [refusal, setRefusal] = useState<{ refusal: LaunchRefusal; image: FittedImage | null } | null>(null);
  const [landed, setLanded] = useState<LaunchStatus | null>(null);
  const [schedule, setSchedule] = useState<ScheduleDraft>(EMPTY_SCHEDULE);
  // The quotes a coin can be priced in here, as the chain holds them, and the one chosen: SOL until another is.
  const [quotes, setQuotes] = useState<ListedQuote[] | null>(null);
  const [quoteMint, setQuoteMint] = useState<string | null>(null);
  const [scheduleProblem, setScheduleProblem] = useState<string | null>(null);
  // The clock the schedule is judged by, moved on every 15 s so "now" stays now.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(tick);
  }, []);
  const heading = useRef<HTMLHeadingElement>(null);
  // Set when the creator moves between steps, so the new step's heading takes focus then, and only then.
  const moved = useRef(false);
  // A browser already signed in as the connected wallet starts at the launch mode, once: Back still reaches the first step.
  const skipped = useRef(false);

  useEffect(() => {
    Promise.all([getPlatform(), getMe(), getQuotes().catch(() => null)])
      .then(([p, m, q]) => {
        setPlatform(p);
        setMe(m);
        setQuotes(q?.quotes ?? []);
        setQuoteMint((chosen) => chosen ?? q?.quotes.find((quote) => quote.offered)?.mint ?? q?.quotes[0]?.mint ?? null);
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

  const signedIn = signedInAs(me, account?.address);
  // The wallet reconnects a moment after the page loads, so this waits for both it and the session.
  useEffect(() => {
    if (!signedIn || skipped.current) return;
    skipped.current = true;
    setStep((s) => (s === 0 ? 1 : s));
  }, [signedIn]);

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

  // Vamp Shield's verdict on the image, asked once per image picked; the vision service may wake for it.
  const attempt = imageAsked?.image === image ? imageAsked.attempt : 0;
  useEffect(() => {
    if (!image) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setImageAsked({ image, at: Date.now(), attempt });
      checkImage(image.blob, image.name, controller.signal)
        .then((verdict) => setImageChecked({ image, verdict, problem: null }))
        .catch((e: Error) => {
          if (!controller.signal.aborted) setImageChecked({ image, verdict: null, problem: e.message });
        });
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [image, attempt]);
  const imageCurrent = imageChecked?.image === image ? imageChecked : null;
  const imageState: ImageCheckState = !image
    ? { state: "none" }
    : imageCurrent?.verdict
      ? { state: "done", verdict: imageCurrent.verdict }
      : imageCurrent?.problem
        ? { state: "problem", problem: imageCurrent.problem }
        : { state: "checking", startedAt: imageAsked?.image === image ? imageAsked.at : Date.now() };
  const retryImage = () => {
    if (!image) return;
    setImageChecked(null);
    setImageAsked({ image, at: Date.now(), attempt: attempt + 1 });
  };

  const current = checked?.key === key ? checked : null;
  const serverVerdict = current?.verdict ?? null;
  const tickerProblem = !tickerRule.ok ? tickerRule.reason : serverVerdict?.verdicts.ticker.status === "refused" ? serverVerdict.verdicts.ticker.reason : null;
  const nameProblem = !nameRule.ok ? nameRule.reason : serverVerdict?.verdicts.name.status === "refused" ? serverVerdict.verdicts.name.reason : null;
  const imageVerdict = imageState.state === "done" ? imageState.verdict : null;
  const coinReady = tickerRule.ok && nameRule.ok && serverVerdict?.clear === true && image !== null && imageVerdict !== null && imageVerdict.verdict.status !== "refused";
  const shownRefusal =
    refusal && refusal.image === image && (!refusal.refusal.verdict || (refusal.refusal.verdict.ticker === ticker && refusal.refusal.verdict.name === name)) ? refusal.refusal : null;
  const appealHref = `/appeal?${new URLSearchParams({
    ticker,
    name,
    ...(shownRefusal?.imageVerdict?.status === "refused" && shownRefusal.imageSha256
      ? { image: shownRefusal.imageSha256 }
      : imageVerdict?.verdict.status === "refused"
        ? { image: imageVerdict.sha256 }
        : {}),
  })}`;

  const creatorWallet = me?.creatorWallet ?? null;
  const wrongWallet = account && creatorWallet && account.address !== creatorWallet;

  async function signOut() {
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
    setImageChecked(null);
    setImageAsked(null);
    setRefusal(null);
    setLanded(null);
    setSchedule(EMPTY_SCHEDULE);
    setScheduleProblem(null);
    getMe().then(setMe).catch(() => undefined);
    goTo(1);
  }

  const steps = STEPS[mode];
  const at: StepName = steps[step]!;
  const terms = platform?.fairOpen ?? null;
  const quote = quotes?.find((q) => q.mint === quoteMint) ?? null;
  const pot = quote?.settings ? { potCap: quote.settings.potCap, quote } : null;
  const scheduled = terms && pot ? readSchedule(schedule, terms, pot, now) : null;
  const modeOpen = platform ? (mode === "instant" ? platform.launchModes.instant : platform.launchModes.fairOpen) : false;
  const canContinue =
    at === "Connect wallet"
      ? signedIn
      : at === "Launch mode"
        ? modeOpen && quote?.offered === true
        : at === "Coin"
          ? coinReady
          : at === "Schedule"
            ? scheduled?.ok === true
            : false;
  const signStep = steps.indexOf("Sign" as never);
  // The calendar preview shows what is valid so far: a refused teaser is not shown as if it would go out.
  const teaserRule = teaserVerdict(schedule.teaser);
  const teaserPreview = teaserRule.ok ? teaserRule.teaser : "";
  const startPreview = schedule.start === "now" ? now : Date.parse(schedule.start);
  const opensAtPreview = terms && !Number.isNaN(startPreview) ? startPreview + terms.windowSeconds * 1000 : null;
  const doneStep = steps.length - 1;
  const linkNote = linkOutcome ? LINK_NOTES[linkOutcome] : null;

  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        <div className={styles.head}>
          <h1>Launch a coin</h1>
          <p className="note">Takes about two minutes. Nothing is public until you sign.</p>
        </div>

        <ol className={styles.stepper} aria-label="Steps">
          {steps.map((label, i) => {
            const done = i < step;
            const reachable = done && step < doneStep;
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
          {at === "Connect wallet" && (
            <>
              <h2 id="step-heading" ref={heading} tabIndex={-1}>
                Connect your wallet
              </h2>
              <p className="muted">
                Anyone can launch with a wallet. It becomes your Creator wallet: the only one that signs your launches, and the coin&apos;s creator on every
                terminal. Signing in costs nothing.
              </p>
              {me === undefined ? (
                <p className="note">Checking whether this browser is signed in…</p>
              ) : signedIn && me ? (
                <SignedIn me={me} xLinking={platform?.xLinking ?? false} onSignOut={signOut} />
              ) : (
                <WalletSignIn
                  me={me}
                  connectNote={
                    me?.creatorWallet
                      ? `This browser is signed in as ${shortAddress(me.creatorWallet)}. Connect that wallet to go on.`
                      : "Connect the wallet you launch from. Heat never moves anything without your approval."
                  }
                  onSignedIn={(m) => {
                    setMe(m);
                    skipped.current = true;
                    goTo(1);
                  }}
                />
              )}
            </>
          )}

          {at === "Launch mode" && (
            <>
              <h2 id="step-heading" ref={heading} tabIndex={-1}>
                How should your coin start trading?
              </h2>
              <fieldset className={styles.modes}>
                <legend className="visually-hidden">Launch mode</legend>
                <label className={styles.mode}>
                  <input
                    type="radio"
                    name="launch-mode"
                    value="fairOpen"
                    checked={mode === "fairOpen"}
                    onChange={() => setMode("fairOpen")}
                    aria-labelledby="mode-fair-open mode-fair-open-default"
                    aria-describedby="mode-fair-open-note"
                  />
                  <span className="row">
                    <b id="mode-fair-open">Fair Open</b>
                    <span className="chip chip-go" id="mode-fair-open-default">
                      default
                    </span>
                  </span>
                  <span className="note" id="mode-fair-open-note">
                    A 10-minute deposit window, then everyone in the pot buys at one price. You can deposit like anyone else, up
                    to your tier&apos;s cap, and your share is locked: nothing for 7 days, all free by day 30.
                  </span>
                </label>
                <label className={styles.mode}>
                  <input
                    type="radio"
                    name="launch-mode"
                    value="instant"
                    checked={mode === "instant"}
                    onChange={() => setMode("instant")}
                    aria-labelledby="mode-instant"
                    aria-describedby="mode-instant-note"
                  />
                  <b id="mode-instant">Instant launch</b>
                  <span className="note" id="mode-instant-note">
                    Trading starts the moment the coin exists. There is no creator buy: any buy in the first second, yours
                    included, pays the 99% sniper tax, and the first minute&apos;s tax goes to Heat.
                  </span>
                </label>
              </fieldset>
              {platform && !modeOpen && (
                <p className="note">
                  {mode === "fairOpen" ? "Fair Opens are" : "Instant launches are"} not open on this deployment yet. Choose the other mode to launch now.
                </p>
              )}
              <QuotePicker
                quotes={quotes}
                chosen={quoteMint}
                onChoose={(mint) => {
                  setQuoteMint(mint);
                  // A minimum raise typed in one quote means nothing in another.
                  setSchedule((d) => ({ ...d, minRaise: "" }));
                }}
              />
              {quote && <QuoteLabels quote={quote} place="launch" />}
            </>
          )}

          {at === "Coin" && (
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
                text={serverVerdict}
                textProblem={current?.problem ?? null}
                image={imageState}
                refusal={shownRefusal}
                appealHref={appealHref}
                onRetryImage={retryImage}
              />
            </>
          )}

          {at === "Schedule" && terms && (
            <>
              <h2 id="step-heading" ref={heading} tabIndex={-1}>
                Schedule the window
              </h2>
              <p className="muted">
                Deposits run for {Math.round(terms.windowSeconds / 60)} minutes, then the coin opens and everyone in the pot buys at one price. Until then
                your coin stays sealed: only the teaser, the time and you show on the calendar.
              </p>
              {pot && <Schedule draft={schedule} terms={terms} pot={pot} now={now} onChange={(d) => (setSchedule(d), setScheduleProblem(null))} />}
              {scheduleProblem && (
                <div className="verdict verdict-stop" role="alert">
                  <b>Refused</b>
                  <span className="note">{scheduleProblem}</span>
                </div>
              )}
            </>
          )}

          {at === "Sign" && mode === "fairOpen" && image && terms && quote?.settings && scheduled?.ok && (
            <>
              <h2 id="step-heading" ref={heading} tabIndex={-1}>
                Sign your open in advance
              </h2>
              <WalletGate account={account} creatorWallet={creatorWallet} wrongWallet={!!wrongWallet} cluster={platform?.cluster ?? null}>
                {account && (
                  <SignFairOpen
                    account={account}
                    chain={chain}
                    coin={{ name: nameRule.ok ? nameRule.name : name, ticker, depositsOpenAt: scheduled.depositsOpenAt, minRaise: scheduled.minRaise, teaser: scheduled.teaser }}
                    image={image}
                    quote={quote}
                    rungs={quote.settings.rungs}
                    onScheduled={(status) => {
                      setLanded(status);
                      goTo(doneStep);
                    }}
                    onRefused={(r) => {
                      setRefusal({ refusal: r, image });
                      if (r.code === "teaser" || r.code === "schedule") {
                        setScheduleProblem(r.error);
                        goTo(steps.indexOf("Schedule" as never));
                      } else goTo(2);
                    }}
                  />
                )}
              </WalletGate>
            </>
          )}

          {at === "Sign" && mode === "instant" && image && quote && (
            <>
              <h2 id="step-heading" ref={heading} tabIndex={-1}>
                Sign the launch
              </h2>
              <p className="muted">One signature creates your coin and its pool. Your wallet is the coin&apos;s creator on every terminal.</p>
              <div className="verdict verdict-caution">
                <b>No creator buy</b>
                <span className="note">If you buy in the first second, you pay the 99% sniper tax like anyone else.</span>
              </div>
              <WalletGate account={account} creatorWallet={creatorWallet} wrongWallet={!!wrongWallet} cluster={platform?.cluster ?? null}>
                {account && (
                  <SignLaunch
                    account={account}
                    chain={chain}
                    coin={{ name: nameRule.ok ? nameRule.name : name, ticker }}
                    image={image}
                    quote={quote.mint}
                    onLanded={(status) => {
                      setLanded(status);
                      goTo(doneStep);
                    }}
                    onRefused={(r) => {
                      setRefusal({ refusal: r, image });
                      goTo(2);
                    }}
                  />
                )}
              </WalletGate>
            </>
          )}

          {at === "Done" && landed?.fairOpen && (
            <>
              <h2 id="step-heading" ref={heading} tabIndex={-1}>
                Scheduled
              </h2>
              <p className="muted">
                Your Fair Open is on the calendar. Deposits open {Date.parse(landed.fairOpen.depositsOpenAt) <= now ? "now" : when(Date.parse(landed.fairOpen.depositsOpenAt))}, and
                the coin opens {when(Date.parse(landed.fairOpen.opensAt))}.
              </p>
              {landed.fairOpen.ladder === "signed" ? (
                <div className="verdict verdict-go">
                  <b>Your open is signed</b>
                  <span className="note">Heat&apos;s keeper opens the coin at its time, even if you are offline, and sends everyone in the pot their coins.</span>
                </div>
              ) : (
                <div className="verdict verdict-caution" role="status">
                  <b>Come back at {when(Date.parse(landed.fairOpen.opensAt))} to sign your open</b>
                  <span className="note">
                    The Fair Open&apos;s page asks your wallet then. Until you sign, the coin cannot open; if it has not opened 15 minutes later, the launch
                    fails and every deposit comes back.
                  </span>
                </div>
              )}
              <dl className={styles.facts}>
                <div>
                  <dt>Window</dt>
                  <dd>{span(Date.parse(landed.fairOpen.depositsOpenAt), Date.parse(landed.fairOpen.opensAt))}</dd>
                </div>
                <div>
                  <dt>Minimum raise</dt>
                  <dd>{landed.fairOpen.minRaise === "0" ? "None" : quoteText(landed.fairOpen.minRaise, quotes?.find((q) => q.mint === landed.quoteMint) ?? SOL_UNIT)}</dd>
                </div>
                <div>
                  <dt>Sealed coin</dt>
                  <dd>
                    {landed.name} <span className="mono">${landed.ticker}</span>, revealed at the open
                  </dd>
                </div>
              </dl>
              <div className={styles.links}>
                {landed.explorer.transaction && (
                  <a className="btn" href={landed.explorer.transaction} target="_blank" rel="noreferrer">
                    The schedule on the explorer
                  </a>
                )}
              </div>
            </>
          )}

          {at === "Done" && landed && !landed.fairOpen && (
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

        {step < signStep && (
          <div className="spread">
            <button type="button" className="btn btn-ghost" onClick={() => goTo(Math.max(0, step - 1))} disabled={step === 0}>
              Back
            </button>
            <button type="button" className="btn btn-go" onClick={() => goTo(step + 1)} disabled={!canContinue}>
              Continue
            </button>
          </div>
        )}
        {at === "Sign" && (
          <div className="spread">
            <button type="button" className="btn btn-ghost" onClick={() => goTo(signStep - 1)}>
              Back
            </button>
          </div>
        )}
        {at === "Done" && landed && (
          <div className="spread">
            <button type="button" className="btn btn-ghost" onClick={restart}>
              Launch another
            </button>
            {landed.fairOpen ? (
              <Link className="btn btn-go" href={`/fair-open/${landed.fairOpen.launch}`}>
                Open its page
              </Link>
            ) : (
              <Link className="btn btn-go" href={`/coin/${landed.mint}`}>
                Watch it trade
              </Link>
            )}
          </div>
        )}
      </div>

      <aside className={`panel ${styles.aside}`} aria-labelledby="preview-heading">
        <h3 id="preview-heading">What traders will see</h3>
        <span className="eyebrow">{mode === "instant" ? "Coin card at launch" : "Launch calendar entry"}</span>
        {mode === "instant" ? (
          <CoinCard ticker={ticker} name={nameRule.ok ? nameRule.name : name.trim()} imageUrl={imageUrl} creator={creatorOf(me)} mode={mode} />
        ) : (
          <SealedCard
            creator={creatorOf(me)}
            teaser={teaserPreview}
            opensAt={opensAtPreview}
            minRaise={scheduled?.ok ? scheduled.minRaise : 0n}
            potCap={quote?.settings?.potCap ?? null}
            quote={quote ?? SOL_UNIT}
            scheduled={!!landed?.fairOpen}
          />
        )}
        <p className="note">
          {mode === "instant"
            ? "Instant launch: visible and trading the moment it is created. No Creator lock, because there is no creator buy, and the card says the first minute's tax went to Heat."
            : "Fair Open: sealed on the calendar until its window opens, then everyone in the pot buys at one price."}
        </p>
      </aside>
    </div>
  );
}

/**
 * The wallet that signs a launch: connect one if none is, refuse one that is not the record's Creator wallet, and say
 * which one signs before handing over to the signing step.
 */
function WalletGate({
  account,
  creatorWallet,
  wrongWallet,
  cluster,
  children,
}: {
  account: { address: string } | null;
  creatorWallet: string | null;
  wrongWallet: boolean;
  cluster: Platform["cluster"] | null;
  children: React.ReactNode;
}) {
  return (
    <>
      {cluster && cluster !== "mainnet" && (
        <p className="note">
          Your wallet signs on Solana {cluster}: set it to {cluster} first, so it can show what the launch costs (in Phantom: Settings, Developer
          Settings, Testnet Mode).
        </p>
      )}
      {!account ? (
        <div className="stack">
          <p className="note">
            {creatorWallet ? (
              <>
                Connect your Creator wallet, <span className="mono">{shortAddress(creatorWallet)}</span>: it is the only wallet that can sign your launches.
              </>
            ) : (
              "The wallet that signs this launch becomes your Creator wallet, the only one that can sign your launches."
            )}
          </p>
          <WalletButton variant="inline" />
        </div>
      ) : wrongWallet ? (
        <div className="verdict verdict-stop" role="alert">
          <b>This is not your Creator wallet</b>
          <span className="note">
            You are signed in as <span className="mono">{shortAddress(creatorWallet!)}</span>, which signs your launches. Connect that wallet, or go back to
            the first step and sign in with this one.
          </span>
        </div>
      ) : (
        <>
          <p className="note">
            Signing with <span className="mono">{shortAddress(account.address)}</span>
            {creatorWallet ? ", your Creator wallet." : ", which becomes your Creator wallet."}
          </p>
          {children}
        </>
      )}
    </>
  );
}

/** Who the coin's card names: the linked X handle, else the Creator wallet. */
const creatorOf = (me: Me | null | undefined) => ({ handle: me?.x?.handle ?? null, wallet: me?.creatorWallet ?? null });

/** The browser signed in as the connected wallet, and X offered once, never required (ADR 0008). */
function SignedIn({ me, xLinking, onSignOut }: { me: Me; xLinking: boolean; onSignOut: () => void }) {
  return (
    <div className="stack">
      <div className="verdict verdict-go" data-testid="signed-in">
        <b>
          Signed in as <span className="mono">{shortAddress(me.creatorWallet!)}</span>
        </b>
        <span className="note">
          Your Creator wallet: the only wallet that can sign your launches.{" "}
          {me.launches > 0 ? `${me.launches} launch${me.launches === 1 ? "" : "es"} so far.` : "Record: first launch."}
        </span>
        <span>
          <button type="button" className={styles.linkButton} onClick={onSignOut}>
            Not you? Sign out
          </button>
        </span>
      </div>
      {me.x ? (
        <p className="note" data-testid="x-linked">
          X: <b>@{me.x.handle}</b>, shown on your record and in your coins&apos; details.
        </p>
      ) : (
        xLinking && (
          <div className={styles.optionalX}>
            <a className="btn btn-sm" href={linkXUrl("/launch")}>
              Link X
            </a>
            <span className="note">Optional. Your handle then shows on your record and in your coins&apos; details, and your wallets can deposit as Scored.</span>
          </div>
        )
      )}
    </div>
  );
}

/**
 * The quote the coin is priced in (ADR 0007): SOL, or another quote Heat lists here once the band job has named its
 * configs. A quote that waits can still be chosen, to read its labels, and says what it waits for; the flow goes on only
 * with one that is offered.
 */
function QuotePicker({ quotes, chosen, onChoose }: { quotes: ListedQuote[] | null; chosen: string | null; onChoose: (mint: string) => void }) {
  if (quotes === null) return <p className="note">Loading the quotes a coin can be priced in…</p>;
  if (quotes.length === 0) return <p className="note">The quotes a coin can be priced in could not be read just now. Reload the page to try again.</p>;
  const sol = quotes.find((q) => q.symbol === "SOL")?.settings ?? null;
  const note = (q: ListedQuote) => {
    if (!q.offered || !q.settings) return q.waiting;
    if (q.symbol === "SOL") return `Graduates at ${quoteText(q.settings.graduationTarget, q, 2)}.`;
    const worth = sol ? `, ${quoteText(sol.graduationTarget, SOL_UNIT, 2)}'s worth when its configs were made` : "";
    return `Graduates at ${quoteText(q.settings.graduationTarget, q, 2)}${worth}. Trades, deposits and payouts are all in ${q.symbol}.`;
  };
  return (
    <fieldset className={styles.quotes} data-testid="quote-picker">
      <legend className="label">Priced in</legend>
      <div className={styles.quoteOptions}>
        {quotes.map((q) => (
          <label key={q.mint} className={`${styles.option} ${q.offered ? "" : styles.quoteWaiting}`}>
            <input type="radio" name="quote" value={q.mint} checked={q.mint === chosen} onChange={() => onChoose(q.mint)} aria-describedby={`quote-note-${q.mint}`} />
            <span>
              <b>{q.symbol}</b>
              <span className="note" id={`quote-note-${q.mint}`}>
                {note(q)}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
