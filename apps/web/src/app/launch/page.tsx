import type { Metadata } from "next";
import { LaunchFlow } from "@/components/launch/LaunchFlow";

export const metadata: Metadata = { title: "Launch a coin" };

/** `?x=` is how linking X reports back: linked, denied or failed. */
export default async function LaunchPage({ searchParams }: { searchParams: Promise<{ x?: string }> }) {
  const { x } = await searchParams;
  return (
    <div className="page">
      <LaunchFlow linkOutcome={x === "linked" || x === "denied" || x === "failed" ? x : null} />
    </div>
  );
}
