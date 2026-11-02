import type { Metadata } from "next";
import { AppealForm } from "@/components/appeal/AppealForm";

export const metadata: Metadata = { title: "Appeal a refusal" };

/** An appeal against Vamp Shield's refusal (spec 6.2, 6.6): the launch flow links here with what it refused. */
export default async function AppealPage({ searchParams }: { searchParams: Promise<{ ticker?: string; name?: string; image?: string }> }) {
  const { ticker, name, image } = await searchParams;
  return (
    <div className="page">
      <AppealForm ticker={ticker?.slice(0, 64) ?? ""} name={name?.slice(0, 256) ?? ""} imageSha256={image && /^[0-9a-f]{64}$/.test(image) ? image : null} />
    </div>
  );
}
