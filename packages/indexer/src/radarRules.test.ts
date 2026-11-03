// The rules `radarOf` and the Bundle Radar evaluation (spec 11.5) share, with no database.
import { describe, expect, it } from "vitest";
import { FUNDING_WINDOW_MS, fundingLinks, isDirectLink, labelBuy, walletLabels, type RadarCreation } from "./radar";

const creation: RadarCreation = { creator: "Creator", slot: 100, blockIndex: 10, jitoBundle: "bundle" };
const buy = (over: Partial<Parameters<typeof labelBuy>[1]> = {}) => ({ trader: "Buyer", slot: 100, blockIndex: 11, signers: ["Buyer"], jitoBundle: null, ...over });

describe("labelBuy", () => {
  it("labels the four positions after the creation, and only same_slot past them", () => {
    expect(labelBuy(creation, buy({ blockIndex: 14 }))).toEqual({ position: 4, labels: ["same_slot", "after_creation"] });
    expect(labelBuy(creation, buy({ blockIndex: 15 }))).toEqual({ position: 5, labels: ["same_slot"] });
    expect(labelBuy(creation, buy({ slot: 101, blockIndex: 0 }))).toEqual({ position: null, labels: [] });
  });

  it("counts no position when the creation's place is not known, or for a buy before it", () => {
    expect(labelBuy({ ...creation, blockIndex: null }, buy())).toEqual({ position: null, labels: ["same_slot"] });
    expect(labelBuy(creation, buy({ blockIndex: 9 }))).toEqual({ position: null, labels: ["same_slot"] });
  });

  it("labels the creation's own Jito bundle, and the Creator wallet signing for another wallet but not for itself", () => {
    expect(labelBuy(creation, buy({ blockIndex: 30, jitoBundle: "bundle", signers: ["Creator", "Buyer"] })).labels).toEqual(["same_slot", "jito_bundle", "creator_signed"]);
    expect(labelBuy(creation, buy({ blockIndex: 30, jitoBundle: "other" })).labels).toEqual(["same_slot"]);
    expect(labelBuy({ ...creation, jitoBundle: null }, buy({ blockIndex: 30, jitoBundle: null })).labels).toEqual(["same_slot"]);
    expect(labelBuy(creation, buy({ trader: "Creator", blockIndex: 30, signers: ["Creator"] })).labels).toEqual(["same_slot"]);
  });
});

describe("fundingLinks", () => {
  const open = new Date("2026-10-25T12:00:00Z");
  const t = (source: string, destination: string, offsetMs: number) => ({ source, destination, at: new Date(open.getTime() + offsetMs) });

  it("groups the Creator wallet's transfers within 7 days either side of the open by the other wallet", () => {
    const links = fundingLinks("Creator", open, [
      t("Creator", "A", -FUNDING_WINDOW_MS),
      t("B", "Creator", FUNDING_WINDOW_MS),
      t("Creator", "C", -FUNDING_WINDOW_MS - 1),
      t("D", "E", 0),
      t("Creator", "A", 1),
    ]);
    expect([...links.keys()]).toEqual(["A", "B"]);
    expect(links.get("A")).toHaveLength(2);
  });
});

describe("walletLabels", () => {
  it("adds creator_funded for a wallet that passed funds with the Creator wallet, never for the Creator wallet", () => {
    expect(walletLabels({ buyLabels: ["creator_signed", "same_slot", "same_slot"], funded: true, creator: false })).toEqual(["same_slot", "creator_signed", "creator_funded"]);
    expect(walletLabels({ buyLabels: ["same_slot"], funded: true, creator: true })).toEqual(["same_slot"]);
  });

  it("counts every label but same_slot as a direct link", () => {
    expect(isDirectLink(["same_slot"])).toBe(false);
    expect(isDirectLink(["same_slot", "after_creation"])).toBe(true);
  });
});
