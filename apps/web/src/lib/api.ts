import { Health } from "@top-pad/contract";

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
