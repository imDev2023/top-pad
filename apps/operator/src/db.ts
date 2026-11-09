import { sql } from "drizzle-orm";
import type { Db, DbOrTransaction } from "@top-pad/db";

/**
 * Runs `work` in one transaction as `heat_operator` (migration 0016), the role whose grants are the operator app's: it
 * reads the queue, records decisions, and may insert into the audit log and read it, never update or delete it. `SET
 * LOCAL` ends with the transaction, so a pooled connection never keeps the role. An action and its audit row go in the
 * same transaction: an action is never taken without its row, nor a row written for an action that failed.
 */
export function asOperator<T>(db: Db, work: (tx: DbOrTransaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role heat_operator`);
    return work(tx);
  });
}
