import type { Health } from "@top-pad/contract";
import { getHealth } from "@/lib/api";
import styles from "./page.module.css";

// Read on every request: the page is the deployed build's live health check.
export const dynamic = "force-dynamic";

const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;

type State = { label: string; tone: "ok" | "warn" | "bad"; summary: string };

function stateOf(health: Health | null): State {
  if (!health) return { label: "Unreachable", tone: "bad", summary: "The API did not answer." };
  if (!health.database.ok) return { label: "Degraded", tone: "warn", summary: "The API is up, but its database did not answer." };
  return { label: "Healthy", tone: "ok", summary: "The API is up and reading its database." };
}

export default async function StatusPage() {
  const health = await getHealth();
  const state = stateOf(health);
  const checkedAt = new Date().toISOString();

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Devnet status</h1>
        <p className={styles.checked}>Checked {utc(checkedAt)}</p>
      </header>

      <section className={styles.card} aria-labelledby="api-status">
        <div className={styles.status}>
          <h2 id="api-status" className={styles.statusTitle}>API</h2>
          <span className={`${styles.pill} ${styles[state.tone]}`}>
            <span className={styles.dot} aria-hidden="true" />
            {state.label}
          </span>
        </div>
        <p className={styles.summary}>{state.summary}</p>

        {health && (
          <dl className={styles.rows}>
            <div className={styles.row}>
              <dt>Cluster</dt>
              <dd>{health.cluster}</dd>
            </div>
            <div className={styles.row}>
              <dt>Database</dt>
              <dd>{health.database.ok ? `Answered in ${health.database.latencyMs} ms` : "Did not answer"}</dd>
            </div>
            {health.database.migrations !== null && (
              <div className={styles.row}>
                <dt>Migrations applied</dt>
                <dd className={styles.figure}>{health.database.migrations}</dd>
              </div>
            )}
            {health.database.serverTime && (
              <div className={styles.row}>
                <dt>Database clock</dt>
                <dd className={styles.figure}>{utc(health.database.serverTime)}</dd>
              </div>
            )}
          </dl>
        )}
      </section>
    </main>
  );
}
