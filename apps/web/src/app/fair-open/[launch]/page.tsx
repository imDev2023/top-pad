import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FairOpenPage } from "@/components/fairOpen/FairOpenPage";
import { loadFairOpen } from "@/lib/api";

type Props = { params: Promise<{ launch: string }> };

/** Base58, 32 to 44 characters: what could be a launch's address at all. */
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const metadata: Metadata = { title: "Fair Open" };

/** A Fair Open's page (spec 9, screen 2): its window, its pot, and the visitor's deposit. */
export default async function Page({ params }: Props) {
  const { launch } = await params;
  if (!ADDRESS.test(launch)) notFound();
  const view = await loadFairOpen(launch);
  if (view === "missing") notFound();
  return (
    <div className="page">
      {view === "unavailable" ? (
        <div className="verdict verdict-stop" role="alert">
          <b>Heat&apos;s API did not answer</b>
          <span className="note">The Fair Open could not be loaded just now. Reload the page in a moment.</span>
        </div>
      ) : (
        <FairOpenPage initial={view} />
      )}
    </div>
  );
}
