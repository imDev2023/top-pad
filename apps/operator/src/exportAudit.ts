// The audit log's daily export to R2 (spec 10.2, 10.4): each whole UTC day's rows, one JSON object a line, at
// `operator-audit/<day>.jsonl`. The log is append-only, so a day once over never changes and is written once; a day with
// no action is written too, empty, so the export's own record has no gaps. Run by the Worker's daily Cron Trigger, and
// from the audit page.
import { and, asc, gte, lt, sql } from "drizzle-orm";
import { auditLog, type Db } from "@top-pad/db";
import { asOperator } from "./db";

export const auditKey = (day: string) => `operator-audit/${day}.jsonl`;

/** How many days back one run looks for a day not yet written: older ones were written by older runs. */
const LOOKBACK_DAYS = 35;
const DAY_MS = 86_400_000;

const dayOf = (at: Date) => at.toISOString().slice(0, 10);
const startOf = (day: string) => new Date(`${day}T00:00:00.000Z`);

/** The store the export writes to: R2, or a test's stand-in. */
export type AuditStore = Pick<R2Bucket, "head" | "put">;

export type ExportSummary = { exported: { day: string; rows: number }[]; alreadyThere: number; through: string | null };

/**
 * Writes every whole day not yet in R2, from the day of the log's first row (or 35 days back, whichever is later) up to
 * yesterday. A row written in the last seconds of a day can commit just after midnight, so the Cron Trigger runs well
 * into the next day (00:15 UTC).
 */
export async function exportAudit(db: Db, store: AuditStore, now = new Date()): Promise<ExportSummary> {
  const yesterday = dayOf(new Date(now.getTime() - DAY_MS));
  const [first] = await asOperator(db, (tx) => tx.select({ at: sql<Date | string | null>`min(${auditLog.at})` }).from(auditLog));
  if (!first?.at) return { exported: [], alreadyThere: 0, through: null };
  const firstDay = dayOf(new Date(first.at));
  const earliest = dayOf(new Date(startOf(yesterday).getTime() - (LOOKBACK_DAYS - 1) * DAY_MS));
  const exported: ExportSummary["exported"] = [];
  let alreadyThere = 0;
  for (let day = firstDay > earliest ? firstDay : earliest; day <= yesterday; day = dayOf(new Date(startOf(day).getTime() + DAY_MS))) {
    if (await store.head(auditKey(day))) {
      alreadyThere++;
      continue;
    }
    const from = startOf(day);
    const rows = await asOperator(db, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(gte(auditLog.at, from), lt(auditLog.at, new Date(from.getTime() + DAY_MS))))
        .orderBy(asc(auditLog.id)),
    );
    const body = rows.map((r) => JSON.stringify({ ...r, at: r.at.toISOString() })).join("\n");
    await store.put(auditKey(day), body ? `${body}\n` : "", {
      httpMetadata: { contentType: "application/x-ndjson" },
      customMetadata: { rows: `${rows.length}`, exportedAt: now.toISOString() },
    });
    exported.push({ day, rows: rows.length });
  }
  return { exported, alreadyThere, through: yesterday };
}
