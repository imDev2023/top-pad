import {
  ApiError,
  ClaimOutcome,
  Coin,
  CoinCandles,
  CoinTrades,
  CreatorEarnings,
  FairOpen,
  FairOpenOutcome,
  Health,
  LaunchRefusal,
  LaunchStatus,
  Me,
  Platform,
  PreparedClaim,
  PreparedFairOpenTransaction,
  PreparedLaunch,
  VampShieldVerdict,
  type CandleSeconds,
  type ClaimRequest,
  type LaunchForm,
} from "@top-pad/contract";
import type { z } from "zod";

/** The web app is a pure client of our API (spec 10.1): it reads everything through it, like any other client. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8801").replace(/\/$/, "");

/** The API's health, or null when the API itself did not answer. A 503 still carries a health body to show. */
export async function getHealth(): Promise<Health | null> {
  try {
    const res = await fetch(`${API_URL}/health`, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
    const parsed = Health.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Where a browser goes to link X; X sends it back to `returnTo` on this site. */
export const linkXUrl = (returnTo: string) => `${API_URL}/auth/x/start?return=${encodeURIComponent(returnTo)}`;

/** A refusal or error from the API, with the sentence to show. */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly refusal: LaunchRefusal | null = null,
  ) {
    super(message);
  }
}

/**
 * A call from the browser, with the session cookie: the API is another origin on the same site, so the cookie only
 * rides along when asked to.
 */
async function call<T extends z.ZodType>(schema: T, path: string, init: RequestInit = {}): Promise<z.infer<T>> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, credentials: "include", cache: "no-store" });
  } catch {
    throw new ApiProblem(0, "Heat's API did not answer. Check your connection and try again.");
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const refusal = LaunchRefusal.safeParse(body);
    if (refusal.success) throw new ApiProblem(res.status, refusal.data.error, refusal.data);
    const error = ApiError.safeParse(body);
    throw new ApiProblem(res.status, error.success ? error.data.error : `Heat's API answered ${res.status}.`);
  }
  return schema.parse(body);
}

export const getPlatform = () => call(Platform, "/platform");

/** The platform as the server renders a page, or null when the API does not answer in time. */
export async function getPlatformOrNull(): Promise<Platform | null> {
  try {
    const res = await fetch(`${API_URL}/platform`, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    const parsed = Platform.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The Creator this browser linked, or null when it has not linked X. */
export const getMe = (): Promise<Me | null> => call(Me.nullable(), "/me");

export const logout = () => fetch(`${API_URL}/auth/logout`, { method: "POST", credentials: "include" });

export const checkVampShield = (ticker: string, name: string, signal?: AbortSignal) =>
  call(VampShieldVerdict, "/vamp-shield/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticker, name }),
    signal,
  });

export function prepareLaunch(form: LaunchForm, image: Blob, imageName: string) {
  const body = new FormData();
  body.set("mode", form.mode);
  body.set("name", form.name);
  body.set("ticker", form.ticker);
  body.set("wallet", form.wallet);
  body.set("image", image, imageName);
  return call(PreparedLaunch, "/launches", { method: "POST", body });
}

export const submitLaunch = (id: string, transaction: string) =>
  call(LaunchStatus, `/launches/${id}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction }),
  });

export const getLaunch = (id: string) => call(LaunchStatus, `/launches/${id}`);

/** A coin as the server renders its page: "missing" when Heat has no coin at the address, "unavailable" when the API did not answer. */
export async function loadCoin(mint: string): Promise<Coin | "missing" | "unavailable"> {
  try {
    const res = await fetch(`${API_URL}/coins/${encodeURIComponent(mint)}`, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
    if (res.status === 404) return "missing";
    const parsed = Coin.safeParse(await res.json());
    return res.ok && parsed.success ? parsed.data : "unavailable";
  } catch {
    return "unavailable";
  }
}

export const getCoin = (mint: string) => call(Coin, `/coins/${encodeURIComponent(mint)}`);

/** A coin's latest trades, newest first; or with `after`, every trade since that order key, oldest first. */
export function getCoinTrades(mint: string, query: { after?: string; before?: string; limit?: number } = {}) {
  const params = new URLSearchParams(Object.entries(query).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])));
  return call(CoinTrades, `/coins/${encodeURIComponent(mint)}/trades${params.size ? `?${params}` : ""}`);
}

export const getCoinCandles = (mint: string, seconds: CandleSeconds) => call(CoinCandles, `/coins/${encodeURIComponent(mint)}/candles?seconds=${seconds}`);

/** A coin's live room: its trades as they land (spec 10.2). */
export const coinLiveUrl = (mint: string) => `${API_URL.replace(/^http/, "ws")}/live/coins/${encodeURIComponent(mint)}`;

/** The Creator Earnings waiting for a wallet, in each Heat coin whose creator role it holds. */
export const getEarnings = (wallet: string) => call(CreatorEarnings, `/earnings/${encodeURIComponent(wallet)}`);

/** A claim of the coins shown, each capped at the partner fees the page showed, for the wallet to sign and send. */
export const prepareClaim = (wallet: string, claims: ClaimRequest["claims"]) =>
  call(PreparedClaim, `/earnings/${encodeURIComponent(wallet)}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ claims }),
  });

/** A sent claim's transactions, settled by the API against the chain: what they paid. */
export const reportClaim = (signatures: string[]) =>
  call(ClaimOutcome, "/earnings/claims", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signatures }),
  });

/** A Fair Open as the server renders its page: "missing" when there is none at the address, "unavailable" when the API did not answer. */
export async function loadFairOpen(launch: string): Promise<FairOpen | "missing" | "unavailable"> {
  try {
    const res = await fetch(`${API_URL}/fair-opens/${encodeURIComponent(launch)}`, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
    if (res.status === 404) return "missing";
    const parsed = FairOpen.safeParse(await res.json());
    return res.ok && parsed.success ? parsed.data : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** A Fair Open, with the wallet's admission and seat when there is a wallet. */
export const getFairOpen = (launch: string, wallet?: string) =>
  call(FairOpen, `/fair-opens/${encodeURIComponent(launch)}${wallet ? `?wallet=${encodeURIComponent(wallet)}` : ""}`);

const postJson = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** A Fair Open transaction for the wallet to sign and send: a deposit, a withdrawal, the failure or a refund. */
export const prepareFairOpen = (launch: string, action: "deposit" | "withdraw" | "mark-failed" | "refund" | "claim", body: { wallet: string; amount?: string }) =>
  call(PreparedFairOpenTransaction, `/fair-opens/${encodeURIComponent(launch)}/${action}`, postJson(body));

/** A sent Fair Open transaction, settled by the API against the chain. */
export const reportFairOpen = (signature: string) => call(FairOpenOutcome, "/fair-opens/transactions", postJson({ signature }));

/** A Fair Open's live room: its deposits, withdrawals and failure as they land (spec 10.2). */
export const fairOpenLiveUrl = (launch: string) => `${API_URL.replace(/^http/, "ws")}/live/fair-opens/${encodeURIComponent(launch)}`;
