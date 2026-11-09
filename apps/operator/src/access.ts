// Cloudflare Access in front of the operator app (spec 10.2). Access signs the operator in before a request reaches the
// Worker, and the runtime hands the Worker `ctx.access`: the application's audience tag and the signed-in identity. The
// Worker trusts nothing else: a request with no `ctx.access`, or one Access let through for another application (an
// account-wide policy, say), is refused, so the app is closed to anyone the application's own policy does not name.
import type { Operator } from "./env";

/** The operator a request comes from, or null when Access did not sign them in for this application. */
export async function operatorOf(access: CloudflareAccessContext | undefined, aud: string | undefined): Promise<Operator | null> {
  if (!aud || !access || access.aud !== aud) return null;
  const identity = await access.getIdentity().catch(() => undefined);
  const email = identity?.email?.trim().toLowerCase();
  return email ? { email } : null;
}
