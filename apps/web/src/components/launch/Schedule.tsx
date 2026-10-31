"use client";

// The Fair Open's schedule (spec 2.1 step 4, spec 9 screen 4): when its 10-minute window starts, up to 7 days ahead; an
// optional minimum raise; and the one-line teaser the calendar shows while the coin is sealed.
import type { Platform } from "@top-pad/contract";
import { teaserVerdict } from "@top-pad/vamp-shield/rules";
import { sol } from "@/lib/format";
import styles from "./Launch.module.css";

export type ScheduleDraft = {
  /** "now", or a local date and time as a datetime-local input holds it. */
  start: "now" | string;
  /** SOL as typed, or empty for none. */
  minRaise: string;
  teaser: string;
};

export const EMPTY_SCHEDULE: ScheduleDraft = { start: "now", minRaise: "", teaser: "" };

type Terms = NonNullable<Platform["fairOpen"]>;

/** A datetime-local value for a moment, in this browser's time zone, to the minute. */
export function localInput(ms: number) {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A moment as the flow names it, in this browser's time zone: "Sat 1 Nov, 14:05". */
export const when = (ms: number) =>
  new Date(ms).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** A window as the flow names it: "Sat 1 Nov, 14:05 to 14:15", the date once when both ends share it. */
export function span(from: number, to: number) {
  const sameDay = new Date(from).toDateString() === new Date(to).toDateString();
  const end = sameDay ? new Date(to).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : when(to);
  return `${when(from)} to ${end}`;
}

/** What the draft schedules, or the first reason it cannot: the window's start in Unix seconds, and the minimum raise in lamports. */
export function readSchedule(draft: ScheduleDraft, terms: Terms, now: number):
  | { ok: true; depositsOpenAt: number; minRaise: bigint; teaser: string }
  | { ok: false; field: "start" | "minRaise" | "teaser"; reason: string } {
  const start = draft.start === "now" ? now : Date.parse(draft.start);
  if (Number.isNaN(start)) return { ok: false, field: "start", reason: "Pick the day and time the window starts." };
  if (start < now - 60_000) return { ok: false, field: "start", reason: "The window must start now or later." };
  if (start > now + terms.maxAheadSeconds * 1000) return { ok: false, field: "start", reason: "The window can start at most 7 days ahead." };
  let minRaise = 0n;
  if (draft.minRaise.trim() !== "") {
    if (!/^\d+(\.\d{1,2})?$/.test(draft.minRaise.trim())) return { ok: false, field: "minRaise", reason: "Enter SOL to two decimal places, such as 0.5." };
    const [whole, fraction = ""] = draft.minRaise.trim().split(".");
    minRaise = BigInt(whole!) * 1_000_000_000n + BigInt(fraction.padEnd(2, "0")) * 10_000_000n;
    if (minRaise > BigInt(terms.potCap)) return { ok: false, field: "minRaise", reason: `At most the pot's cap, ${sol(terms.potCap)} SOL.` };
  }
  const teaser = teaserVerdict(draft.teaser);
  if (!teaser.ok) return { ok: false, field: "teaser", reason: teaser.reason };
  return { ok: true, depositsOpenAt: Math.floor(start / 1000), minRaise, teaser: teaser.teaser };
}

export function Schedule({ draft, terms, now, onChange }: { draft: ScheduleDraft; terms: Terms; now: number; onChange: (draft: ScheduleDraft) => void }) {
  const read = readSchedule(draft, terms, now);
  const problem = (field: "start" | "minRaise" | "teaser") => (!read.ok && read.field === field ? read.reason : null);
  const startMs = draft.start === "now" ? now : Date.parse(draft.start);
  const windowMinutes = Math.round(terms.windowSeconds / 60);
  const teaserLength = Array.from(draft.teaser.trim()).length;
  const set = (patch: Partial<ScheduleDraft>) => onChange({ ...draft, ...patch });

  return (
    <div className={styles.schedule}>
      <fieldset className={styles.startChoice}>
        <legend className="label">When the window starts</legend>
        <div className={styles.startOptions}>
          <label className={styles.option}>
            <input type="radio" name="start" checked={draft.start === "now"} onChange={() => set({ start: "now" })} />
            <span>
              <b>Now</b>
              <span className="note">Deposits open as soon as you sign.</span>
            </span>
          </label>
          <label className={styles.option}>
            <input
              type="radio"
              name="start"
              checked={draft.start !== "now"}
              onChange={() => set({ start: localInput(now + 60 * 60_000) })}
            />
            <span>
              <b>Later</b>
              <span className="note">Up to 7 days ahead, so people can plan for it.</span>
            </span>
          </label>
        </div>
        {draft.start !== "now" && (
          <div className="field">
            <label htmlFor="window-start">Starts at, your local time</label>
            <input
              id="window-start"
              className="input"
              type="datetime-local"
              value={draft.start}
              min={localInput(now)}
              max={localInput(now + terms.maxAheadSeconds * 1000)}
              aria-invalid={!!problem("start")}
              aria-describedby="window-start-help"
              onChange={(e) => set({ start: e.target.value })}
            />
            <span id="window-start-help" className={problem("start") ? styles.fieldProblem : "note"}>
              {problem("start") ?? `The window is a fixed ${windowMinutes} minutes.`}
            </span>
          </div>
        )}
        {!Number.isNaN(startMs) && (
          <p className={styles.timeline} data-testid="schedule-timeline">
            <span>
              Deposits <b>{draft.start === "now" ? "open now" : when(startMs)}</b>
            </span>
            <span aria-hidden="true">→</span>
            <span>
              The coin opens <b>{when(startMs + terms.windowSeconds * 1000)}</b>
            </span>
          </p>
        )}
      </fieldset>

      <div className={styles.fields}>
        <div className="field">
          <label htmlFor="min-raise">Minimum raise (SOL, optional)</label>
          <input
            id="min-raise"
            className="input num"
            inputMode="decimal"
            placeholder="None"
            value={draft.minRaise}
            aria-invalid={!!problem("minRaise")}
            aria-describedby="min-raise-help"
            onChange={(e) => set({ minRaise: e.target.value.replace(",", ".") })}
          />
          <span id="min-raise-help" className={problem("minRaise") ? styles.fieldProblem : "note"}>
            {problem("minRaise") ?? `If the pot holds less at the open, the launch fails and every deposit comes back. The pot buys at most ${sol(terms.potCap)} SOL.`}
          </span>
        </div>
        <div className="field">
          <label htmlFor="teaser">Teaser for the calendar (optional)</label>
          <input
            id="teaser"
            className="input"
            value={draft.teaser}
            maxLength={terms.teaserMaxLength * 2}
            placeholder="The first coin with a heartbeat"
            autoComplete="off"
            aria-invalid={!!problem("teaser")}
            aria-describedby="teaser-help"
            onChange={(e) => set({ teaser: e.target.value })}
          />
          <span id="teaser-help" className={problem("teaser") ? styles.fieldProblem : "note"}>
            {problem("teaser") ?? `${teaserLength} of ${terms.teaserMaxLength} characters. Plain text: no links, no cashtags, no other coin's name.`}
          </span>
        </div>
      </div>

      <div className="verdict verdict-neutral">
        <b>About 0.03 SOL of rent, refundable</b>
        <span className="note">
          It pays for the launch&apos;s accounts and the coin&apos;s pool, and nearly all of it comes back once the launch closes; all of it if the Fair Open fails.
          It is not a fee.
        </span>
      </div>
    </div>
  );
}
