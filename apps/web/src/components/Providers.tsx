"use client";

import type { ReactNode } from "react";
import { WalletProvider, type SolanaChain } from "./WalletProvider";

/** Everything client-side the pages share: for now, the visitor's wallet. */
export function Providers({ chain, children }: { chain: SolanaChain; children: ReactNode }) {
  return <WalletProvider chain={chain}>{children}</WalletProvider>;
}
