import type { Metadata } from "next";
import { CreatorPage } from "@/components/creator/CreatorPage";

export const metadata: Metadata = { title: "Creator Earnings" };

/** The creator's page: until the Creator record joins it (spec 9, screen 5), its Creator Earnings and their claim. */
export default function Creator() {
  return (
    <div className="page">
      <CreatorPage />
    </div>
  );
}
