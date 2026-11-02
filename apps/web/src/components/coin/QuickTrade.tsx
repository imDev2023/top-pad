"use client";

import { getBase58Decoder } from "@solana/kit";
import { useSignAndSendTransaction } from "@solana/react";
import type { UiWalletAccount } from "@wallet-standard/react";
import type { Coin, Holdings, QuoteStep, SwapOutcome, SwapQuote, Trade } from "@top-pad/contract";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ApiProblem, getHoldings, getSwapQuote, prepareSwap, reportTrade } from "@/lib/api";
import { coinAmount, rawAmountOf, sol, solAmount, typedAmount } from "@/lib/format";
import { WalletButton } from "../WalletButton";
import { useWallet, type SolanaChain } from "../WalletProvider";
import styles from "./QuickTrade.module.css";

const SIGN_AND_SEND = "solana:signAndSendTransaction";
const SOL_DECIMALS = 9;
const BUY_PRESETS = ["0.05", "0.1", "0.5", "1"] as const;
const SELL_PRESETS = [25, 50, 100] as const;
const SLIPPAGES = [50, 100, 300] as const;
/**
 * How long after a click a trade lands, in seconds, until this page has seen its own: building it, the wallet sending
 * it, and the chain confirming it. The fee shown is the one of the second a trade sent now would land in.
 */
const LANDING_SECONDS = 2;
const MAX_LANDING_SECONDS = 8;
const QUOTE_DEBOUNCE_MS = 250;
const toBytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const declined = (e: unknown) => {
  const error = e as { code?: number; message?: string };
  return error?.code === 4001 || /reject|declin|cancel|denied/i.test(error?.message ?? "");
};
const percent = (fee: string, base: string) => `${((Number(fee) / Number(base)) * 100).toFixed(2)}%`;

type Side = "buy" | "sell";
type Quoted = { quote: SwapQuote; at: number };
type Sending =
  | { phase: "idle" }
  | { phase: "preparing" | "signing" | "confirming" }
  | { phase: "done"; text: string; detail: string; explorer: string }
  | { phase: "failed"; text: string; explorer?: string };

/**
 * Quick buy and sell (spec 9, screen 3): an amount, the fee it pays shown before signing (the sniper tax's live value
 * while it runs, falling every second), what it gets and the least it may get. Heat's API quotes it by DBC's own maths
 * and builds it with Heat's referral account; the wallet signs and sends it, and the trade shows on the page the moment
 * it confirms, before the indexer reports it.
 */
export function QuickTrade({ coin, onTraded }: { coin: Coin; onTraded: (trades: Trade[]) => void }) {
  const { account, chain } = useWallet();
  const [side, setSide] = useState<Side>("buy");
  const [text, setText] = useState("");
  const [slippageBps, setSlippageBps] = useState<number>(100);
  const [quoted, setQuoted] = useState<Quoted | null>(null);
  const [quoteProblem, setQuoteProblem] = useState<string | null>(null);
  const [holdings, setHoldings] = useState<Holdings | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [sending, setSending] = useState<Sending>({ phase: "idle" });
  const busy = sending.phase === "preparing" || sending.phase === "signing" || sending.phase === "confirming";

  const decimals = side === "buy" ? SOL_DECIMALS : coin.decimals;
  const amount = rawAmountOf(text, decimals);
  const typed = text.trim() !== "";
  const held = holdings && holdings.wallet === account?.address ? (side === "buy" ? BigInt(holdings.sol) : BigInt(holdings.coins)) : null;
  const tooMuch = amount !== null && held !== null && amount > held;

  const loadHoldings = useCallback(async () => {
    if (!account) return;
    setHoldings(await getHoldings(coin.mint, account.address).catch(() => null));
  }, [account, coin.mint]);
  useEffect(() => {
    void loadHoldings();
  }, [loadHoldings]);

  // The quote, again whenever the amount, side or slippage changes and whenever a trade moves the price.
  const lastTrade = coin.market.lastTradeKey;
  useEffect(() => {
    if (amount === null) {
      setQuoted(null);
      setQuoteProblem(null);
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      getSwapQuote(coin.mint, { side, amount: `${amount}`, slippageBps }, abort.signal)
        .then((quote) => {
          setQuoted({ quote, at: Date.now() });
          setQuoteProblem(null);
        })
        .catch((e) => {
          if (abort.signal.aborted) return;
          setQuoted(null);
          setQuoteProblem(e instanceof ApiProblem ? e.message : "The quote could not be read just now.");
        });
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [coin.mint, side, amount, slippageBps, lastTrade]);

  // While the sniper tax runs, the fee shown falls with the chain's clock, four times a second.
  const taxing = quoted !== null && quoted.quote.steps.length > 1;
  useEffect(() => {
    if (!taxing) return;
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, [taxing]);

  // How long this page's trades take to land, learned from each one it sends.
  const [landing, setLanding] = useState(LANDING_SECONDS);
  const step = quoted ? stepAt(quoted, now, landing) : null;
  const ticker = coin.ticker;

  const send = useRef<SignAndSend | null>(null);
  async function trade() {
    const signAndSend = send.current;
    if (!account || !signAndSend || amount === null) return;
    // The chain's second as the trader clicked, by the quote's clock: how long the trade then takes to land is learned.
    const clicked = quoted ? quoted.quote.chainTime + (Date.now() - quoted.at) / 1000 : null;
    try {
      setSending({ phase: "preparing" });
      const prepared = await prepareSwap(coin.mint, { side, amount: `${amount}`, slippageBps, wallet: account.address });
      setQuoted({ quote: prepared.quote, at: Date.now() });
      setSending({ phase: "signing" });
      let signature: Uint8Array;
      try {
        ({ signature } = await signAndSend({ transaction: toBytes(prepared.transaction) }));
      } catch (e) {
        setSending({ phase: "failed", text: declined(e) ? "You declined in your wallet. Nothing was sent." : `Your wallet could not send it: ${(e as Error).message}` });
        return;
      }
      setSending({ phase: "confirming" });
      const outcome = await reportTrade(coin.mint, getBase58Decoder().decode(signature));
      if (outcome.status === "landed") {
        onTraded(outcome.trades);
        const ran = outcome.trades[0] ? Date.parse(outcome.trades[0].at) / 1000 : null;
        if (clicked !== null && ran !== null) setLanding((l) => Math.min(MAX_LANDING_SECONDS, Math.max(0, (l + (ran - clicked)) / 2)));
        setSending({ phase: "done", ...doneText(outcome, ticker, coin.decimals), explorer: outcome.explorer });
        setText("");
      } else {
        setSending({
          phase: "failed",
          text: outcome.status === "pending" ? "It has not confirmed yet. Check it on the explorer before trading again." : (outcome.error ?? "It failed on chain."),
          explorer: outcome.explorer,
        });
      }
      await loadHoldings();
    } catch (e) {
      setSending({ phase: "failed", text: e instanceof ApiProblem ? e.message : `It did not go through: ${(e as Error).message}` });
    }
  }

  const pick = (next: Side) => {
    if (next === side) return;
    setSide(next);
    setText("");
    setQuoted(null);
    setSending({ phase: "idle" });
  };

  const invalid = typed && (amount === null || tooMuch);
  return (
    <section className={`panel ${styles.panel}`} aria-labelledby="quick-trade">
      <div className={styles.head}>
        <h2 id="quick-trade" className={styles.title}>
          Quick trade
        </h2>
        <div className={styles.sides} role="radiogroup" aria-label="Buy or sell">
          {(["buy", "sell"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={side === s}
              className={`${styles.side} ${side === s ? (s === "buy" ? styles.buyOn : styles.sellOn) : ""}`}
              onClick={() => pick(s)}
            >
              {s === "buy" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>
      </div>

      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && amount !== null && !tooMuch && step) void trade();
        }}
      >
        <div className="field">
          <div className={styles.labels}>
            <label htmlFor="quick-trade-amount">{side === "buy" ? "Spend" : "Sell"}</label>
            {held !== null && (
              <span className="note" data-testid="quick-trade-held">
                You have <span className="num">{side === "buy" ? `${sol(held, 4)} SOL` : `${coinAmount(held, coin.decimals)} ${ticker}`}</span>
              </span>
            )}
          </div>
          <div className={`${styles.amount} ${invalid ? styles.amountInvalid : ""}`}>
            <input
              id="quick-trade-amount"
              className="mono"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={text}
              aria-invalid={invalid}
              aria-describedby="quick-trade-amount-note"
              onChange={(e) => {
                setText(e.target.value);
                if (sending.phase === "done" || sending.phase === "failed") setSending({ phase: "idle" });
              }}
            />
            <span className={styles.unit}>{side === "buy" ? "SOL" : ticker}</span>
          </div>
          <div className={styles.presets} role="group" aria-label={side === "buy" ? "Amounts of SOL" : "Shares of your coins"}>
            {side === "buy"
              ? BUY_PRESETS.map((p) => (
                  <button key={p} type="button" className={styles.preset} aria-pressed={text === p} onClick={() => setText(p)}>
                    {p} SOL
                  </button>
                ))
              : SELL_PRESETS.map((share) => {
                  const part = held !== null ? (held * BigInt(share)) / 100n : null;
                  const value = part ? typedAmount(part, coin.decimals) : null;
                  return (
                    <button key={share} type="button" className={styles.preset} disabled={!part} aria-pressed={value !== null && text === value} onClick={() => value && setText(value)}>
                      {share === 100 ? "All" : `${share}%`}
                    </button>
                  );
                })}
          </div>
          <span id="quick-trade-amount-note" className={`note ${invalid || quoteProblem ? styles.problem : ""}`} role={quoteProblem ? "alert" : undefined}>
            {typed && amount === null
              ? side === "buy"
                ? "Enter SOL, to at most 9 decimal places."
                : `Enter ${ticker}, to at most ${coin.decimals} decimal places.`
              : tooMuch
                ? side === "buy"
                  ? "That is more SOL than this wallet holds."
                  : `That is more ${ticker} than this wallet holds.`
                : quoteProblem}
          </span>
        </div>

        <Summary quoted={quoted} step={step} side={side} ticker={ticker} decimals={coin.decimals} now={now} pending={amount !== null && !quoteProblem} />

        <div className={styles.slippage}>
          <span className="label" id="quick-trade-slippage">
            Slippage
          </span>
          <div className={styles.slippages} role="radiogroup" aria-labelledby="quick-trade-slippage">
            {SLIPPAGES.map((bps) => (
              <button key={bps} type="button" role="radio" aria-checked={slippageBps === bps} className={styles.preset} onClick={() => setSlippageBps(bps)}>
                {bps / 100}%
              </button>
            ))}
          </div>
        </div>

        {!account ? (
          <div className={styles.connect}>
            <WalletButton variant="inline" />
          </div>
        ) : !account.features.includes(SIGN_AND_SEND) ? (
          <p className="note">Your wallet can sign but not send a transaction from a page, which a trade needs. Trade with Phantom, Solflare or Backpack.</p>
        ) : (
          <>
          <BindSend account={account} chain={chain} into={send} />
          <button type="submit" className={`btn ${side === "buy" ? "btn-go" : styles.sellButton}`} disabled={busy || amount === null || tooMuch || !step}>
            {busy ? (side === "buy" ? "Buying…" : "Selling…") : buttonText(side, amount, ticker, coin.decimals)}
          </button>
          </>
        )}
        <Status sending={sending} />
      </form>
    </section>
  );
}

type SignAndSend = ReturnType<typeof useSignAndSendTransaction>;

/** Keeps the connected wallet's send where the panel's trade reaches it: the hook needs an account to exist. */
function BindSend({ account, chain, into }: { account: UiWalletAccount; chain: SolanaChain; into: RefObject<SignAndSend | null> }) {
  const send = useSignAndSendTransaction(account, chain);
  useEffect(() => {
    into.current = send;
    return () => {
      into.current = null;
    };
  }, [send, into]);
  return null;
}

/** The step of the second a trade sent now would land in, `landing` seconds on, by the chain's clock as the quote read it. */
function stepAt({ quote, at }: Quoted, now: number, landing: number): QuoteStep {
  const second = Math.floor(quote.chainTime + (now - at) / 1000 + landing);
  let found = quote.steps[0]!;
  for (const s of quote.steps) if (s.from <= second) found = s;
  return found;
}

function buttonText(side: Side, amount: bigint | null, ticker: string, decimals: number) {
  if (amount === null) return side === "buy" ? `Buy ${ticker}` : `Sell ${ticker}`;
  return side === "buy" ? `Buy ${ticker} with ${sol(amount, 9)} SOL` : `Sell ${coinAmount(amount, decimals)} ${ticker}`;
}

function doneText(outcome: SwapOutcome, ticker: string, decimals: number) {
  const t = outcome.trades[0];
  if (!t) return { text: "Your trade landed.", detail: "It shows in the trades below once Heat has read it." };
  const detail = `Fee ${solAmount(t.fee)} SOL (${percent(t.fee, t.quoteAmount)}).`;
  return t.side === "buy"
    ? { text: `Bought ${coinAmount(t.baseAmount, decimals)} ${ticker} for ${sol(t.quoteAmount, 9)} SOL`, detail }
    : { text: `Sold ${coinAmount(t.baseAmount, decimals)} ${ticker} for ${sol(BigInt(t.quoteAmount) - BigInt(t.fee), 9)} SOL`, detail };
}

/** What the trade pays and gets, before signing. */
function Summary({
  quoted,
  step,
  side,
  ticker,
  decimals,
  now,
  pending,
}: {
  quoted: Quoted | null;
  step: QuoteStep | null;
  side: Side;
  ticker: string;
  decimals: number;
  now: number;
  pending: boolean;
}) {
  if (!quoted || !step) {
    return (
      <dl className={styles.summary} aria-busy={pending}>
        <div>
          <dt>Fee</dt>
          <dd className="muted">{pending ? "Quoting…" : "Enter an amount"}</dd>
        </div>
        <div>
          <dt>You get</dt>
          <dd className="muted">-</dd>
        </div>
      </dl>
    );
  }
  const { quote } = quoted;
  const taxed = step.from < quote.taxEndsAt;
  const out = (raw: string) => (side === "buy" ? `${coinAmount(raw, decimals)} ${ticker}` : `${sol(raw, 6)} SOL`);
  const left = BigInt(quote.amountLeft);
  const endsIn = Math.max(0, quote.taxEndsAt - (quote.chainTime + Math.floor((now - quoted.at) / 1000)));
  return (
    <>
      <dl className={styles.summary} data-testid="quick-trade-summary">
        <div>
          <dt>{taxed ? "Sniper tax" : "Fee"}</dt>
          <dd className={taxed ? styles.taxed : undefined} data-testid="quick-trade-fee">
            <span className="num">{percent(step.fee, step.quoteAmount)}</span>
            <span className={`num ${styles.feeSol}`}> · {solAmount(step.fee)} SOL</span>
          </dd>
        </div>
        <div>
          <dt>You get</dt>
          <dd className="num" data-testid="quick-trade-out">
            ≈ {out(step.amountOut)}
          </dd>
        </div>
        <div>
          <dt>At least</dt>
          <dd className="num muted" data-testid="quick-trade-minimum">
            {out(quote.minimumOut)}
          </dd>
        </div>
      </dl>
      {taxed && (
        <p className={`note ${styles.taxNote}`}>
          Falls every second for <span className="num">{endsIn}</span>&nbsp;s more: your trade pays the rate of the second it lands.
        </p>
      )}
      {left > 0n && (
        <div className="verdict verdict-caution">
          <b>Only {sol(quote.amountIn, 9)} SOL of it fills</b>
          <span className="note">The curve completes at Graduation first: the other {sol(left, 9)} SOL stays in your wallet.</span>
        </div>
      )}
    </>
  );
}

const STEPS = [
  { phase: "preparing", label: "Quoted and built by Heat" },
  { phase: "signing", label: "Signed and sent by your wallet" },
  { phase: "confirming", label: "Confirmed on Solana" },
] as const;

function Status({ sending }: { sending: Sending }) {
  if (sending.phase === "idle") return null;
  if (sending.phase === "done") {
    return (
      <div className={`verdict verdict-go ${styles.outcome}`} role="status" data-testid="quick-trade-done">
        <b>{sending.text}</b>
        <span className="note">
          {sending.detail}{" "}
          <a href={sending.explorer} target="_blank" rel="noreferrer">
            See it on the explorer
          </a>
        </span>
      </div>
    );
  }
  if (sending.phase === "failed") {
    return (
      <div className={`verdict verdict-stop ${styles.outcome}`} role="alert">
        <b>It did not go through</b>
        <span className="note">{sending.text}</span>
        {sending.explorer && (
          <a className="note" href={sending.explorer} target="_blank" rel="noreferrer">
            See it on the explorer
          </a>
        )}
      </div>
    );
  }
  const reached = STEPS.findIndex((s) => s.phase === sending.phase);
  return (
    <ol className={styles.progress} aria-label="Progress">
      {STEPS.map((s, i) => {
        const state = i < reached ? "done" : i === reached ? "active" : "pending";
        return (
          <li key={s.phase} className={styles[state]} aria-current={state === "active" ? "step" : undefined}>
            <span className={styles.mark} aria-hidden="true" />
            {s.label}
          </li>
        );
      })}
    </ol>
  );
}
