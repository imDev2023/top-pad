// Copied from Stoker (github.com/imDev2023/Stoker-Markets) at commit 43e196b: apps/api/src/graduation.ts (`notifyPending`
// and `notify`), taking the webhook's URL rather than Stoker's whole configuration, with `raise` and `resolve` added for
// alerts that are a condition rather than a failed run, such as the keeper's float running low (spec 10.3).
import { and, eq, isNull, sql } from "drizzle-orm";
import { operatorAlerts, type Db } from "@top-pad/db";

type Alert = typeof operatorAlerts.$inferSelect;
export type AlertKind = Alert["kind"];

/**
 * Raises an alert, or keeps an open one current with the latest message. One stays open per kind and subject; once
 * resolved, the same condition raising it again opens it afresh, to be notified again.
 */
export async function raiseAlert(db: Db, kind: AlertKind, subject: string, message: string) {
  await db
    .insert(operatorAlerts)
    .values({ kind, subject, message })
    .onConflictDoUpdate({
      target: [operatorAlerts.kind, operatorAlerts.subject],
      set: {
        message: sql`excluded.message`,
        raisedAt: sql`case when ${operatorAlerts.resolvedAt} is null then ${operatorAlerts.raisedAt} else now() end`,
        notifiedAt: sql`case when ${operatorAlerts.resolvedAt} is null then ${operatorAlerts.notifiedAt} else null end`,
        resolvedAt: sql`null`,
      },
    });
}

/** Resolves an open alert of this kind and subject, if there is one: the condition is over. */
export async function resolveAlert(db: Db, kind: AlertKind, subject: string) {
  await db
    .update(operatorAlerts)
    .set({ resolvedAt: sql`now()` })
    .where(and(eq(operatorAlerts.kind, kind), eq(operatorAlerts.subject, subject), isNull(operatorAlerts.resolvedAt)));
}

/**
 * Sends every open alert that has not reached the alert webhook yet; one that fails is tried again next run. An alert is
 * claimed (marked notified) before it is posted and released if the post fails, so two runs never post it twice.
 */
export async function notifyPending(db: Db, webhookUrl: string | null) {
  const pending = await db
    .select()
    .from(operatorAlerts)
    .where(and(isNull(operatorAlerts.notifiedAt), isNull(operatorAlerts.resolvedAt)));
  for (const a of pending) {
    const claimed = await db
      .update(operatorAlerts)
      .set({ notifiedAt: sql`now()` })
      .where(and(eq(operatorAlerts.kind, a.kind), eq(operatorAlerts.subject, a.subject), isNull(operatorAlerts.notifiedAt)))
      .returning({ subject: operatorAlerts.subject });
    if (claimed.length === 0) continue;
    if (await notify(webhookUrl, a)) continue;
    await db
      .update(operatorAlerts)
      .set({ notifiedAt: null })
      .where(and(eq(operatorAlerts.kind, a.kind), eq(operatorAlerts.subject, a.subject)));
  }
}

async function notify(webhookUrl: string | null, alert: Pick<Alert, "kind" | "subject" | "message" | "raisedAt">) {
  console.error(`operator alert: ${alert.message}`);
  if (!webhookUrl) return true;
  const body = { kind: alert.kind, subject: alert.subject, message: alert.message, raisedAt: alert.raisedAt.toISOString() };
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // `text` and `content` are what Slack-style and Discord webhooks display.
    body: JSON.stringify({ text: alert.message, content: alert.message, alert: body }),
  }).catch((e: Error) => e);
  if (res instanceof Error || !res.ok) {
    console.error(`operator alert webhook failed: ${res instanceof Error ? res.message : res.status}`);
    return false;
  }
  return true;
}
