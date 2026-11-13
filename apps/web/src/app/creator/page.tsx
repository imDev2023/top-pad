import type { Metadata } from "next";
import { CreatorPage } from "@/components/creator/CreatorPage";

export const metadata: Metadata = { title: "Creator Earnings" };

/** The creator's page (spec 9, screen 5): the connected wallet's Creator record, its handovers and rotation, and its Creator Earnings. */
export default function Creator() {
  return (
    <div className="page">
      <CreatorPage />
    </div>
  );
}
