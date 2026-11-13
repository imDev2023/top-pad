import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { creatorName } from "@/components/creator/CreatorSummaryCard";
import { RecordPage } from "@/components/creator/RecordPage";
import { loadCreatorRecord } from "@/lib/api";

type Props = { params: Promise<{ key: string }> };

// The title and the page ask once between them.
const recordAt = cache(loadCreatorRecord);

/** A record's id, or a wallet's address: what could name a record at all. */
const KEY = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { key } = await params;
  if (!KEY.test(key)) return { title: "No such Creator record" };
  const record = await recordAt(key);
  return { title: typeof record === "object" ? `${creatorName(record.summary)} · Creator record` : "Creator record" };
}

/** A Creator record (spec 7; spec 9, screen 5), by its id or by any wallet that is or was its Creator wallet. */
export default async function Page({ params }: Props) {
  const { key } = await params;
  if (!KEY.test(key)) notFound();
  const record = await recordAt(key);
  if (record === "missing") notFound();
  return (
    <div className="page">
      {record === "unavailable" ? (
        <div className="verdict verdict-stop" role="alert">
          <b>Heat&apos;s API did not answer</b>
          <span className="note">The record could not be loaded just now. Reload the page in a moment.</span>
        </div>
      ) : (
        <RecordPage key={record.summary.id} initial={record} />
      )}
    </div>
  );
}
