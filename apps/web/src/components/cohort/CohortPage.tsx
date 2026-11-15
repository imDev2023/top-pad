"use client";

// The devnet cohort's page (spec 11.3, #63): sign in with a wallet, link X if you choose, and join; a member whose record
// linked X gets 1 devnet SOL once from the cohort tap (spec 10.2), sent to their Creator wallet.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { CohortStatus, Me } from "@top-pad/contract";
import { ApiProblem, getCohort, getMe, joinCohort, linkXUrl, tapCohort } from "@/lib/api";
import { shortAddress, solAmount } from "@/lib/format";
import { signedInAs, WalletSignIn } from "../WalletSignIn";
import { useWallet } from "../WalletProvider";
import styles from "./Cohort.module.css";

export type LinkOutcome = "linked" | "denied" | "failed" | "taken" | null;

const LINK_NOTES: Record<Exclude<LinkOutcome, null>, { tone: "go" | "caution" | "stop"; text: string }> = {
  linked: { tone: "go", text: "Your X account is linked." },
  denied: { tone: "caution", text: "You declined on X. Linking X is optional, but the tap gives devnet SOL only to members who link it." },
  failed: { tone: "stop", text: "Linking X did not go through. Try again." },
  taken: { tone: "caution", text: "That X account is linked to another Creator record, or yours has another one. Nothing changed." },
};

type Busy = "idle" | "joining" | "tapping";

export function CohortPage({ linkOutcome: arrived }: { linkOutcome: LinkOutcome }) {
  const router = useRouter();
  // Kept from the first render: the address is cleaned of `?x=` right away, which renders the page again without it.
  const [linkOutcome] = useState(arrived);
  const { account, chain } = useWallet();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [cohort, setCohort] = useState<CohortStatus | null | undefined>(undefined);
  const [busy, setBusy] = useState<Busy>("idle");
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [who, status] = await Promise.all([getMe().catch(() => null), getCohort().catch(() => null)]);
    setMe(who);
    setCohort(status);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (linkOutcome) router.replace("/cohort", { scroll: false });
  }, [linkOutcome, router]);

  const signedIn = signedInAs(me, account?.address);
  const linked = !!me?.x;
  const cluster = chain.split(":")[1] ?? "devnet";
  const explorerTx = (signature: string) => `https://explorer.solana.com/tx/${signature}${cluster === "mainnet" ? "" : `?cluster=${cluster}`}`;
  const linkNote = linkOutcome ? LINK_NOTES[linkOutcome] : null;

  async function act(kind: Exclude<Busy, "idle">) {
    setBusy(kind);
    setProblem(null);
    try {
      setCohort(await (kind === "tapping" ? tapCohort() : joinCohort()));
    } catch (e) {
      setProblem(e instanceof ApiProblem ? e.message : `It did not go through: ${(e as Error).message}`);
      await load();
    } finally {
      setBusy("idle");
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <p className="eyebrow">Devnet cohort</p>
        <h1>Join the cohort</h1>
        <p className={styles.lead}>
          Two weeks of launching and trading on devnet, before Heat goes to mainnet. Sign in with your wallet and join; link X and the tap sends 1 devnet SOL to your wallet, once, to launch and
          deposit with.
        </p>
      </header>

      {linkNote && (
        <div className={`verdict verdict-${linkNote.tone}`} role="status">
          <span>{linkNote.text}</span>
        </div>
      )}

      <ol className={styles.steps} aria-label="Steps">
        <li className={`panel ${styles.step}`} aria-labelledby="step-wallet">
          <span className={styles.number} aria-hidden="true">
            1
          </span>
          <div className={styles.body}>
            <h2 id="step-wallet" className={styles.title}>
              Sign in with your wallet
            </h2>
            {me === undefined ? (
              <p className="note">Checking whether this browser is signed in…</p>
            ) : signedIn ? (
              <p className="note" data-testid="cohort-signed-in">
                Signed in as <span className="mono">{shortAddress(me!.creatorWallet!)}</span>, your Creator wallet: the tap pays it.
              </p>
            ) : (
              <WalletSignIn
                me={me}
                connectNote="Connect the wallet you will launch and deposit with. Signing in costs nothing and sends no transaction."
                onSignedIn={(who) => {
                  setMe(who);
                  void load();
                }}
              />
            )}
          </div>
        </li>

        <li className={`panel ${styles.step}`} aria-labelledby="step-x">
          <span className={styles.number} aria-hidden="true">
            2
          </span>
          <div className={styles.body}>
            <h2 id="step-x" className={styles.title}>
              Link X <span className={styles.optional}>optional</span>
            </h2>
            {linked ? (
              <p className="note" data-testid="cohort-x-linked">
                Linked as <b>@{me!.x!.handle}</b>.
              </p>
            ) : (
              <>
                <p className="note">The tap gives devnet SOL once an X account, so only members who link X get it. You can join without it.</p>
                {signedIn && (
                  <a className="btn btn-sm" href={linkXUrl("/cohort")}>
                    Link X
                  </a>
                )}
              </>
            )}
          </div>
        </li>

        <li className={`panel ${styles.step}`} aria-labelledby="step-join">
          <span className={styles.number} aria-hidden="true">
            3
          </span>
          <div className={styles.body}>
            <h2 id="step-join" className={styles.title}>
              {linked ? "Join and get 1 devnet SOL" : "Join the cohort"}
            </h2>
            <JoinStep cohort={cohort} signedIn={signedIn} linked={linked} busy={busy} explorerTx={explorerTx} onJoin={() => act("joining")} onTap={() => act("tapping")} />
            {problem && (
              <div className="verdict verdict-stop" role="alert">
                <span>{problem}</span>
              </div>
            )}
          </div>
        </li>
      </ol>
    </div>
  );
}

function JoinStep(p: {
  cohort: CohortStatus | null | undefined;
  signedIn: boolean;
  linked: boolean;
  busy: Busy;
  explorerTx: (signature: string) => string;
  onJoin: () => void;
  onTap: () => void;
}) {
  const { cohort } = p;
  if (!p.signedIn || !cohort) return <p className="note">Sign in first.</p>;
  if (cohort.tap) {
    return (
      <div className="verdict verdict-go" data-testid="cohort-tapped">
        <b>
          {cohort.tap.status === "sent" ? `${solAmount(cohort.tap.lamports)} devnet SOL sent` : `${solAmount(cohort.tap.lamports)} devnet SOL on its way`} to{" "}
          <span className="mono">{shortAddress(cohort.tap.wallet)}</span>
        </b>
        <span className="note">
          You are in the cohort. The tap gives once.{" "}
          <a href={p.explorerTx(cohort.tap.signature)} target="_blank" rel="noreferrer">
            See the transfer
          </a>
        </span>
      </div>
    );
  }
  if (p.linked) {
    return (
      <div className="stack">
        <p className="note">{cohort.member ? "You are in the cohort." : "Joining is free."} The tap sends 1 devnet SOL to your Creator wallet and pays the fee itself.</p>
        <button type="button" className="btn btn-go" disabled={!cohort.tapOpen || p.busy !== "idle"} onClick={p.onTap}>
          {p.busy === "tapping" ? "Sending…" : "Get 1 devnet SOL"}
        </button>
        {!cohort.tapOpen && <p className="note">The tap is being topped up. Try again later; your SOL waits for you.</p>}
      </div>
    );
  }
  if (cohort.member) {
    return (
      <div className="verdict verdict-go" data-testid="cohort-joined">
        <b>You are in the cohort</b>
        <span className="note">Link X above to get 1 devnet SOL from the tap.</span>
      </div>
    );
  }
  return (
    <div className="stack">
      <p className="note">Your launches and deposits then count toward what the cohort measures. Without X, the tap gives you nothing.</p>
      <button type="button" className="btn" disabled={p.busy !== "idle"} onClick={p.onJoin}>
        {p.busy === "joining" ? "Joining…" : "Join without X"}
      </button>
    </div>
  );
}
