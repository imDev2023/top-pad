"use client";

// The visitor's Solana wallet, found through the Wallet Standard: Kit's own packages, no web3.js (spec 10.1). Any
// installed wallet that can sign transactions on this cluster is offered. The one picked is remembered in this browser,
// and reconnected without a prompt on the next visit, when the wallet allows it.
import { getWalletFeature, useWallets, type UiWallet, type UiWalletAccount } from "@wallet-standard/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

const REMEMBERED = "heat.wallet";
const SIGN_TRANSACTION = "solana:signTransaction";

type ConnectFeature = { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly { address: string }[] }> };
type DisconnectFeature = { disconnect(): Promise<void> };

export type SolanaChain = `solana:${string}`;

type WalletState = {
  /** Installed wallets that can sign transactions on this cluster. */
  wallets: readonly UiWallet[];
  wallet: UiWallet | null;
  account: UiWalletAccount | null;
  chain: SolanaChain;
  connecting: string | null;
  connect(wallet: UiWallet): Promise<void>;
  disconnect(): Promise<void>;
};

const WalletContext = createContext<WalletState | null>(null);

export function useWallet() {
  const state = useContext(WalletContext);
  if (!state) throw new Error("useWallet needs a WalletProvider");
  return state;
}

type Remembered = { wallet: string; address: string };

function remembered(): Remembered | null {
  try {
    const value = JSON.parse(localStorage.getItem(REMEMBERED) ?? "null") as Remembered | null;
    return value && typeof value.wallet === "string" && typeof value.address === "string" ? value : null;
  } catch {
    return null;
  }
}

function remember(value: Remembered | null) {
  try {
    if (value) localStorage.setItem(REMEMBERED, JSON.stringify(value));
    else localStorage.removeItem(REMEMBERED);
  } catch {
    // Storage can be off (a private window); the wallet then just asks again next visit.
  }
}

export function WalletProvider({ chain, children }: { chain: SolanaChain; children: ReactNode }) {
  const all = useWallets();
  const wallets = useMemo(
    () => all.filter((w) => w.features.includes(SIGN_TRANSACTION) && w.chains.includes(chain)),
    [all, chain],
  );
  const [selected, setSelected] = useState<Remembered | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const triedSilently = useRef(new Set<string>());

  const wallet = selected ? (wallets.find((w) => w.name === selected.wallet) ?? null) : null;
  const account = wallet?.accounts.find((a) => a.address === selected?.address) ?? null;

  const connect = useCallback(async (target: UiWallet) => {
    setConnecting(target.name);
    try {
      const { accounts } = await (getWalletFeature(target, "standard:connect") as ConnectFeature).connect();
      const first = accounts[0];
      if (!first) return;
      const pick = { wallet: target.name, address: first.address };
      setSelected(pick);
      remember(pick);
    } finally {
      setConnecting(null);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const current = wallet;
    setSelected(null);
    remember(null);
    if (current?.features.includes("standard:disconnect")) {
      await (getWalletFeature(current, "standard:disconnect") as DisconnectFeature).disconnect().catch(() => undefined);
    }
  }, [wallet]);

  // A wallet picked on an earlier visit reconnects silently once it registers; it asks only when the visitor clicks.
  useEffect(() => {
    const saved = remembered();
    if (!saved || selected) return;
    const target = wallets.find((w) => w.name === saved.wallet);
    if (!target || triedSilently.current.has(target.name)) return;
    triedSilently.current.add(target.name);
    (getWalletFeature(target, "standard:connect") as ConnectFeature)
      .connect({ silent: true })
      .then(({ accounts }) => {
        if (accounts.some((a) => a.address === saved.address)) setSelected(saved);
      })
      .catch(() => undefined);
  }, [wallets, selected]);

  // A wallet that drops the account (disconnected from the wallet itself) is no longer connected here. Only once the
  // account has shown up: right after a connect, the wallet's list of accounts can lag one render behind.
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (account) seen.current = account.address;
    else if (selected && seen.current === selected.address) {
      seen.current = null;
      setSelected(null);
      remember(null);
    }
  }, [selected, account]);

  const value = useMemo<WalletState>(
    () => ({ wallets, wallet, account, chain, connecting, connect, disconnect }),
    [wallets, wallet, account, chain, connecting, connect, disconnect],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
