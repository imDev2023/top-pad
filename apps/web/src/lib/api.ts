import {
  ApiError,
  BarAppeal,
  BarReply,
  BundleRadar,
  ClaimOutcome,
  Coin,
  CoinCandles,
  CoinTrades,
  CreatorEarnings,
  CreatorRecord,
  CreatorRoleOutcome,
  CreatorSummary,
  EnforcementCounts,
  FairOpen,
  FairOpenOutcome,
  HandoverOffers,
  Health,
  Holdings,
  LaunchRefusal,
  LaunchStatus,
  Me,
  Platform,
  QuoteList,
  PreparedClaim,
  PreparedCreatorRole,
  PreparedFairOpenTransaction,
  PreparedLaunch,
  PreparedSwap,
  PrivateBars,
  SwapOutcome,
  SwapQuote,
  ImageVerdict,
  VampAppeal,
  VampAppeals,
  VampShieldVerdict,
  VerifiedWallet,
  VerifyMessage,
  WalletChange,
  WalletChangeMessage,
  WalletSignInMessage,
  type VampAppealForm,
  type BarAppealRequest,
  type CandleSeconds,
  type ClaimRequest,
  type LaunchForm,
  type SwapRequest,
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

/** A JSON body to POST. */
const postJson = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const getPlatform = () => call(Platform, "/platform");

/** `GET /quotes`: every quote a coin can be priced in here, each offered or saying what it waits for (ADR 0007). */
export const getQuotes = () => call(QuoteList, "/quotes");

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

/** The Creator this browser is signed in as, by its wallet or by X, or null when it is signed in neither way. */
export const getMe = (): Promise<Me | null> => call(Me.nullable(), "/me");

/** Signing in with a wallet (ADR 0008): the Sign In With Solana message the wallet signs, taken once within ten minutes. */
export const walletSignInMessage = (wallet: string) => call(WalletSignInMessage, "/auth/wallet/message", postJson({ wallet }));

/** The signed message, base64 signature: the browser is signed in as the wallet's Creator record from now on. */
export const walletSignIn = (wallet: string, message: string, signature: string) => call(Me, "/auth/wallet", postJson({ wallet, message, signature }));

/** "Verify once" (spec 6.3): the message the wallet signs for the X account this browser linked. */
export const verifyMessage = (wallet: string) => call(VerifyMessage, "/verify/message", postJson({ wallet }));

/** The signed message, base64 signature: the wallet has the person's tier in every Fair Open from now on. */
export const verifyWallet = (wallet: string, message: string, signature: string) => call(VerifiedWallet, "/verify", postJson({ wallet, message, signature }));

export const logout = () => fetch(`${API_URL}/auth/logout`, { method: "POST", credentials: "include" });

export const checkVampShield = (ticker: string, name: string, signal?: AbortSignal) =>
  call(VampShieldVerdict, "/vamp-shield/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticker, name }),
    signal,
  });

/** Vamp Shield's verdict on a coin's image (spec 6.2): the vision service may wake for it, so it can take seconds. */
export function checkImage(image: Blob, imageName: string, signal?: AbortSignal) {
  const body = new FormData();
  body.set("image", image, imageName);
  return call(ImageVerdict, "/vamp-shield/image", { method: "POST", body, signal });
}

/** The signed-in creator's own latest verdict on an image, by its hash. */
export const getImageVerdict = (sha256: string) => call(ImageVerdict, `/vamp-shield/image/${sha256}`);

/** A creator's appeal against Vamp Shield's refusal, to the operator queue (spec 6.6). */
export const submitAppeal = (form: VampAppealForm) =>
  call(VampAppeal, "/vamp-shield/appeals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });

export const getAppeals = () => call(VampAppeals, "/vamp-shield/appeals");

export function prepareLaunch(form: LaunchForm, image: Blob, imageName: string) {
  const body = new FormData();
  body.set("mode", form.mode);
  body.set("name", form.name);
  body.set("ticker", form.ticker);
  body.set("wallet", form.wallet);
  body.set("quote", form.quote);
  if (form.mode === "fair_open") {
    body.set("depositsOpenAt", form.depositsOpenAt);
    body.set("minRaise", form.minRaise);
    body.set("teaser", form.teaser);
  }
  body.set("image", image, imageName);
  return call(PreparedLaunch, "/launches", { method: "POST", body });
}

/** A signed launch back to the API: for a Fair Open with its signed ladder, or null to sign the open at the open. */
export const submitLaunch = (id: string, transaction: string, rungs?: string[] | null) =>
  call(LaunchStatus, `/launches/${id}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction, rungs }),
  });

/** A Fair Open's schedule again, on a fresh blockhash, when the wallet took too long to sign the first. */
export const renewLaunch = (id: string) => call(PreparedLaunch, `/launches/${id}/renew`, { method: "POST" });

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

/** What Bundle Radar labels on a coin, with the evidence behind each label. */
export const getCoinRadar = (mint: string) => call(BundleRadar, `/coins/${encodeURIComponent(mint)}/radar`);

export const getCoinCandles = (mint: string, seconds: CandleSeconds) => call(CoinCandles, `/coins/${encodeURIComponent(mint)}/candles?seconds=${seconds}`);

/** A quick buy's or sell's quote: what it does in each second from now, by DBC's own maths on the pool as it stands. */
export const getSwapQuote = (mint: string, request: SwapRequest, signal?: AbortSignal) =>
  call(SwapQuote, `/coins/${encodeURIComponent(mint)}/quote`, { ...postJson(request), signal });

/** A quick buy or sell for the wallet to sign and send, with the quote it was built on. */
export const prepareSwap = (mint: string, request: SwapRequest & { wallet: string }) => call(PreparedSwap, `/coins/${encodeURIComponent(mint)}/swap`, postJson(request));

/** A sent trade, read back from the chain the moment it confirms, so the page shows it at once (spec 10.2). */
export const reportTrade = (mint: string, signature: string) => call(SwapOutcome, `/coins/${encodeURIComponent(mint)}/trades`, postJson({ signature }));

/** What a wallet holds to trade a coin with. */
export const getHoldings = (mint: string, wallet: string) => call(Holdings, `/coins/${encodeURIComponent(mint)}/holdings/${encodeURIComponent(wallet)}`);

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


/** A Fair Open transaction for the wallet to sign and send: a deposit, a withdrawal, the failure or a refund. */
export const prepareFairOpen = (launch: string, action: "deposit" | "withdraw" | "mark-failed" | "refund" | "claim", body: { wallet: string; amount?: string }) =>
  call(PreparedFairOpenTransaction, `/fair-opens/${encodeURIComponent(launch)}/${action}`, postJson(body));

/** The rung the pot covers, for the Creator wallet to sign at the open when it could not sign the ladder in advance. */
export const prepareOpenSignature = (launch: string, wallet: string) =>
  call(PreparedFairOpenTransaction, `/fair-opens/${encodeURIComponent(launch)}/open`, postJson({ wallet }));

/** That rung signed: our keeper co-signs and sends it. */
export const submitOpenSignature = (launch: string, transaction: string) =>
  call(FairOpenOutcome, `/fair-opens/${encodeURIComponent(launch)}/open/submit`, postJson({ transaction }));

/** A sent Fair Open transaction, settled by the API against the chain. */
export const reportFairOpen = (signature: string) => call(FairOpenOutcome, "/fair-opens/transactions", postJson({ signature }));

/** A Fair Open's live room: its deposits, withdrawals and failure as they land (spec 10.2). */
export const fairOpenLiveUrl = (launch: string) => `${API_URL.replace(/^http/, "ws")}/live/fair-opens/${encodeURIComponent(launch)}`;

/** A Creator record (spec 7, screen 5), by its id or by any wallet that is or was its Creator wallet. */
export const getCreatorRecord = (key: string) => call(CreatorRecord, `/creators/${encodeURIComponent(key)}`);

/** The summary of the record whose Creator wallet `wallet` is now, or null. */
export const getCurrentRecord = (wallet: string) => call(CreatorSummary.nullable(), `/creators/current/${encodeURIComponent(wallet)}`);

/** A Creator record as the server renders its page: "missing" when there is none, "unavailable" when the API did not answer. */
export async function loadCreatorRecord(key: string): Promise<CreatorRecord | "missing" | "unavailable"> {
  try {
    const res = await fetch(`${API_URL}/creators/${encodeURIComponent(key)}`, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
    if (res.status === 404) return "missing";
    const parsed = CreatorRecord.safeParse(await res.json());
    return res.ok && parsed.success ? parsed.data : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** The message the current Creator wallet signs to offer its record to another wallet. */
export const handoverMessage = (from: string, to: string) => call(WalletChangeMessage, "/creators/handover/message", postJson({ from, to }));

/** The old wallet's signature, base64: the record is offered to the new wallet for a day. */
export const offerHandover = (wallet: string, message: string, signature: string) => call(WalletChange, "/creators/handover", postJson({ wallet, message, signature }));

/** The handovers offered to a wallet and not yet taken. */
export const getHandoverOffers = (wallet: string) => call(HandoverOffers, `/creators/offers/${encodeURIComponent(wallet)}`);

/** The new wallet's signature over the handover's message, base64: it is the record's Creator wallet from now on. */
export const acceptHandover = (id: string, signature: string) => call(WalletChange, `/creators/changes/${encodeURIComponent(id)}/accept`, postJson({ signature }));

/** The message a new wallet signs to rotate a lost Creator wallet through X, from a browser X signed in just now. */
export const rotationMessage = (to: string) => call(WalletChangeMessage, "/creators/rotation/message", postJson({ to }));

/** The new wallet's signature, base64: the rotation waits out its public 7-day cooldown. */
export const requestRotation = (wallet: string, message: string, signature: string) => call(WalletChange, "/creators/rotation", postJson({ wallet, message, signature }));

/** The message the current Creator wallet signs to cancel a pending handover or rotation. */
export const cancelMessage = (id: string) => call(WalletChangeMessage, `/creators/changes/${encodeURIComponent(id)}/cancel/message`, postJson({}));

/** The current Creator wallet's signature, base64: the change is cancelled. */
export const cancelChange = (id: string, wallet: string, message: string, signature: string) =>
  call(WalletChange, `/creators/changes/${encodeURIComponent(id)}/cancel`, postJson({ wallet, message, signature }));

/** A coin's creator role, handed by the wallet holding it to another: the transaction for that wallet to sign and send. */
export const prepareCreatorRole = (mint: string, holder: string, to: string) => call(PreparedCreatorRole, `/coins/${encodeURIComponent(mint)}/creator-role`, postJson({ holder, to }));

/** A sent hand-over, settled by the API against the chain and indexed at once. */
export const reportCreatorRole = (mint: string, signature: string) => call(CreatorRoleOutcome, `/coins/${encodeURIComponent(mint)}/creator-role/sent`, postJson({ signature }));

/**
 * The record's Bars as its own creator sees them (spec 6.5), private ones included; null for anyone else, whom the API
 * answers 401 or 403 so nothing of a private finding reaches them.
 */
export async function getPrivateBars(key: string): Promise<PrivateBars | null> {
  try {
    return await call(PrivateBars, `/creators/${encodeURIComponent(key)}/bars`);
  } catch (e) {
    if (e instanceof ApiProblem && (e.status === 401 || e.status === 403 || e.status === 404)) return null;
    throw e;
  }
}

/** The barred creator's reply to the evidence, for the operator. */
export const replyToBar = (bar: string, body: string) => call(BarReply, `/bars/${encodeURIComponent(bar)}/replies`, postJson({ body }));

/** The barred creator's appeal (spec 6.5): one within 30 days, another only with new evidence. */
export const appealBar = (bar: string, appeal: BarAppealRequest) =>
  call(BarAppeal.pick({ id: true, status: true, filedAt: true, dueAt: true }), `/bars/${encodeURIComponent(bar)}/appeals`, postJson(appeal));

/** The counts "How this is enforced" publishes, as the server renders it, or null when the API does not answer in time. */
export async function loadEnforcementCounts(): Promise<EnforcementCounts | null> {
  try {
    const res = await fetch(`${API_URL}/enforcement`, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    const parsed = EnforcementCounts.safeParse(await res.json());
    return res.ok && parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
