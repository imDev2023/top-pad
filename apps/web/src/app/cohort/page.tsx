import type { Metadata } from "next";
import { CohortPage, type LinkOutcome } from "@/components/cohort/CohortPage";

export const metadata: Metadata = { title: "Devnet cohort" };

const OUTCOMES = new Set(["linked", "denied", "failed", "taken"]);

/** The devnet cohort (spec 11.3): `?x=` is how linking X reports back. */
export default async function Cohort({ searchParams }: { searchParams: Promise<{ x?: string }> }) {
  const { x } = await searchParams;
  return (
    <div className="page">
      <CohortPage linkOutcome={x && OUTCOMES.has(x) ? (x as LinkOutcome) : null} />
    </div>
  );
}
