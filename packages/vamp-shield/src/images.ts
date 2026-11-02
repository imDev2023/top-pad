// Vamp Shield's image rules (spec 6.2, 12): a launch's image against the Protected coins' images, by PDQ in all 8
// orientations and by SSCD. The scores come from the vision service and the database's nearest-neighbour search; this
// only decides. Thresholds are starting values (research/copycat-detection section 3), re-measured against the log.
import type { ProtectedCoin } from "./match";

/** A PDQ match: Hamming distance 31 or less, Meta's own confident-match threshold. */
export const PDQ_MATCH_DISTANCE = 31;
/** Below this quality Meta says a PDQ hash is not to be trusted (flat or featureless images), so only SSCD judges it. */
export const PDQ_MIN_QUALITY = 50;
/** SSCD cosine similarity from which an image is a copy: 90% precision on DISC21, per SSCD's README. */
export const SSCD_COPY = 0.75;
/** SSCD similarity from which an image is near a Protected coin's, labelled "looks like X". */
export const SSCD_NEAR = 0.6;

/** A Protected coin's image near the candidate's: its best PDQ distance over the 8 orientations, and its SSCD similarity. */
export type ImageNeighbour = {
  coin: ProtectedCoin;
  /** Null when either image's PDQ quality is too low to compare. */
  pdqDistance: number | null;
  /** Which of the candidate's orientations was closest, an index into the vision service's dihedral order. */
  orientation: number | null;
  sscd: number | null;
};

export type ImageJudgement =
  | { verdict: "clear" }
  | { verdict: "looks_like"; neighbour: ImageNeighbour }
  | { verdict: "refused"; neighbour: ImageNeighbour; by: "pdq" | "sscd" };

/**
 * Refused when any Protected image is within PDQ distance 31 in any orientation, or at SSCD 0.75 or more; the closest
 * such image is reported, a PDQ match before an SSCD one, since PDQ's are nearly always the same picture. Otherwise
 * labelled at SSCD 0.60 to 0.75, by the most similar image; otherwise clear.
 */
export function judgeImage(neighbours: readonly ImageNeighbour[]): ImageJudgement {
  const pdq = neighbours
    .filter((n) => n.pdqDistance !== null && n.pdqDistance <= PDQ_MATCH_DISTANCE)
    .sort((a, b) => a.pdqDistance! - b.pdqDistance!);
  if (pdq[0]) return { verdict: "refused", neighbour: pdq[0], by: "pdq" };
  const bySimilarity = neighbours.filter((n) => n.sscd !== null).sort((a, b) => b.sscd! - a.sscd!);
  const best = bySimilarity[0];
  if (best && best.sscd! >= SSCD_COPY) return { verdict: "refused", neighbour: best, by: "sscd" };
  if (best && best.sscd! >= SSCD_NEAR) return { verdict: "looks_like", neighbour: best };
  return { verdict: "clear" };
}
