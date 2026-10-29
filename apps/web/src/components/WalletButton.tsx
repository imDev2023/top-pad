"use client";

import { useEffect, useRef, useState } from "react";
import { shortAddress } from "@/lib/format";
import { useWallet } from "./WalletProvider";
import styles from "./WalletButton.module.css";

function Glyph() {
  return (
    <svg className={styles.glyph} viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <path
        d="M3 6.5A2.5 2.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5V6h-1V5.5a.5.5 0 0 0-.5-.5h-9A1.5 1.5 0 0 0 4 6.5v7A1.5 1.5 0 0 0 5.5 15h9a.5.5 0 0 0 .5-.5V13h1v1.5a1.5 1.5 0 0 1-1.5 1.5h-9A2.5 2.5 0 0 1 3 13.5v-7Z"
        fill="currentColor"
      />
      <path d="M11 8h5.5a.5.5 0 0 1 .5.5v3a.5.5 0 0 1-.5.5H11a2 2 0 1 1 0-4Zm0 1.25a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" fill="currentColor" />
    </svg>
  );
}

/**
 * Connects a Solana wallet, or shows the connected one with a way out. `inline` sits in page content, where connecting
 * is the step's main action; in the header it is a quiet button, and on a phone only its glyph.
 */
export function WalletButton({ variant = "header" }: { variant?: "header" | "inline" }) {
  const { wallets, wallet, account, connecting, connect, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const wrap = `${styles.wrap} ${styles[variant]}`;

  if (account) {
    return (
      <div className={wrap} ref={root}>
        <button
          type="button"
          className={`btn btn-ghost ${styles.connected}`}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="menu"
          title={wallet ? `Connected with ${wallet.name}` : undefined}
        >
          {wallet?.icon ? <img src={wallet.icon} alt="" width={18} height={18} className={styles.icon} /> : <Glyph />}
          <span className="mono">{shortAddress(account.address)}</span>
        </button>
        {open && (
          <div className={styles.menu} role="menu" aria-label={wallet ? `Connected with ${wallet.name}` : "Wallet"}>
            <p className={styles.menuNote}>
              Connected with {wallet?.name}
              <span className="mono">{shortAddress(account.address)}</span>
            </p>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void disconnect();
              }}
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  const kind = variant === "header" ? "btn-ghost" : "btn-go";
  return (
    <div className={wrap} ref={root}>
      <button
        type="button"
        className={`btn ${kind} ${styles.connect}`}
        onClick={() => {
          setProblem(null);
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={connecting !== null}
      >
        {variant === "header" && <Glyph />}
        <span className={styles.connectWord}>{connecting ? "Connecting…" : "Connect wallet"}</span>
      </button>
      {open && (
        <div className={styles.menu} role="menu" aria-label="Choose a wallet">
          {wallets.length === 0 ? (
            <p className={styles.empty}>
              No Solana wallet that signs on this network was found in this browser. Install{" "}
              <a href="https://phantom.com" target="_blank" rel="noreferrer">Phantom</a>,{" "}
              <a href="https://solflare.com" target="_blank" rel="noreferrer">Solflare</a> or{" "}
              <a href="https://backpack.app" target="_blank" rel="noreferrer">Backpack</a>, then reload.
            </p>
          ) : (
            wallets.map((w) => (
              <button
                key={w.name}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  connect(w).catch((e: Error) => {
                    if (!/reject|declin|cancel/i.test(e.message)) setProblem(`${w.name} did not connect: ${e.message}`);
                  });
                }}
              >
                <img src={w.icon} alt="" width={20} height={20} className={styles.icon} />
                {w.name}
              </button>
            ))
          )}
        </div>
      )}
      {problem && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
