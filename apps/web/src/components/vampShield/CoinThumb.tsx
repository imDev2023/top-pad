"use client";

// A protected coin's picture beside a verdict or a label: its source's URL, which can be slow, gone or refused, so a
// picture that fails shows the coin's initials instead of an empty box.
import { useState } from "react";
import type { ProtectedMatch } from "@top-pad/contract";

export function CoinThumb({ coin, size, className, initialsClassName }: { coin: ProtectedMatch; size: number; className?: string; initialsClassName?: string }) {
  const [failed, setFailed] = useState(false);
  if (coin.imageUrl && !failed) {
    return <img src={coin.imageUrl} alt="" width={size} height={size} className={className} referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
  }
  return (
    <span className={initialsClassName} aria-hidden="true">
      {(coin.ticker || coin.name).replace(/^\$/, "").slice(0, 2).toUpperCase()}
    </span>
  );
}
