import { DiscoverBoard } from "@/components/board/DiscoverBoard";
import { loadBoard } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Discover (spec 8, 9 screen 1): the board, rendered with its first read, then kept live in the browser. */
export default async function Home() {
  return <DiscoverBoard initial={await loadBoard()} />;
}
