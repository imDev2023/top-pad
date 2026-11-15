// The Fairness card as an image (spec 9, #58): X's large link card, 2:1 and under 5 MB, the one channel to traders fully
// Heat's own (research/terminal-distribution). Satori lays the card out into an SVG and resvg draws it as a PNG, both
// from WebAssembly, which a Worker may only run from modules bundled with it: `cardAssets.ts` imports them for the
// Worker, and a test passes them in from the disk.
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import satori, { init as initSatori } from "satori/standalone";
import { countsInOrder, type FairnessCard, type FairnessFlag } from "@top-pad/contract";
import { shortAddress } from "@top-pad/contract/format";
import { CARD_HEIGHT, CARD_WIDTH } from "./cardSize";

/** The WebAssembly and the fonts the drawing needs: compiled modules in a Worker, bytes in Node. */
export type CardAssets = {
  layout: WebAssembly.Module | ArrayBuffer;
  resvg: WebAssembly.Module | ArrayBuffer;
  fonts: { name: string; data: ArrayBuffer; weight: 400 | 500 | 600 | 700 }[];
};

/** Heat's dark theme, the image's (spec 9: dark-first on asphalt grey), as `globals.css` defines it. */
const C = {
  bg: "#14171a",
  panel: "#1b1f23",
  panel2: "#23282d",
  line: "#2f363c",
  fg: "#e7ebe8",
  muted: "#9ba6a0",
  faint: "#6c7671",
  go: "#33c27a",
  caution: "#f0c234",
  stop: "#f0604f",
};
const FLAG_COLOR: Record<FairnessFlag, string> = { green: C.go, checkered: C.fg, yellow: C.caution, red: C.stop, neutral: C.muted };
const COUNT_WORD = { green: "green", yellow: "yellow", red: "red" } as const;
/** How long the coin's own picture may take to fetch before the card draws its initials instead. */
const IMAGE_TIMEOUT_MS = 3_000;
/** Pictures resvg draws; anything else gets the initials. */
const DRAWN_TYPES = new Set(["image/png", "image/jpeg", "image/gif"]);

type El = { type: string; props: Record<string, unknown> };
const el = (type: string, style: Record<string, unknown>, children?: unknown, props: Record<string, unknown> = {}): El => ({
  type,
  props: { ...props, style, children },
});
const box = (style: Record<string, unknown>, ...children: unknown[]) => el("div", { display: "flex", ...style }, children);

/** A race marshal's flag on its pole, as the site's `.flag` draws it; checkered at Graduation. */
function flagIcon(flag: FairnessFlag, size: number): El {
  const pole = el("rect", {}, undefined, { x: 0, y: 0, width: 3, height: 26, rx: 1, fill: flag === "checkered" ? C.fg : FLAG_COLOR[flag] });
  if (flag !== "checkered") {
    return el("svg", { flex: "none" }, [pole, el("path", {}, undefined, { d: "M3 1H22L18.2 7.5L22 14H3Z", fill: FLAG_COLOR[flag] })], {
      viewBox: "0 0 22 26",
      width: (size * 22) / 26,
      height: size,
    });
  }
  const squares: El[] = [el("rect", {}, undefined, { x: 3, y: 1, width: 19, height: 13, fill: C.bg })];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      if ((row + col) % 2 === 0) squares.push(el("rect", {}, undefined, { x: 3 + col * 4.75, y: 1 + (row * 13) / 3, width: 4.75, height: 13 / 3, fill: C.fg }));
    }
  }
  return el("svg", { flex: "none" }, [pole, ...squares], { viewBox: "0 0 22 26", width: (size * 22) / 26, height: size });
}

/** The coin's picture as a data URL, or null for one that is slow, missing or of a kind the drawing cannot embed. */
async function pictureOf(uri: string | null): Promise<string | null> {
  if (!uri) return null;
  try {
    const res = await fetch(uri, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!res.ok || !DRAWN_TYPES.has(type)) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${type};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

let ready: Promise<CardAssets> | null = null;

/** The WebAssembly started once an isolate, with the fonts it was given. */
async function start(assets: () => Promise<CardAssets>): Promise<CardAssets> {
  ready ??= (async () => {
    const loaded = await assets();
    await Promise.all([initSatori(loaded.layout), initWasm(loaded.resvg)]);
    return loaded;
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

/** The Worker's assets, bundled with it. */
const workerAssets = async () => (await import("./cardAssets")).cardAssets;

/** The card's layout: the coin and its counts at the top, its rows in two columns, where to check it at the foot. */
export function cardLayout(card: FairnessCard, o: { cluster: string; web: string; picture: string | null }): El {
  const red = card.counts.red > 0;
  const initials = (card.ticker || card.name || "?").slice(0, 2).toUpperCase();
  const picture = o.picture
    ? el("img", { width: 84, height: 84, borderRadius: 8, objectFit: "cover" }, undefined, { src: o.picture, width: 84, height: 84 })
    : box(
        { width: 84, height: 84, borderRadius: 8, background: C.panel2, border: `1px solid ${C.line}`, alignItems: "center", justifyContent: "center" },
        el("span", { fontFamily: "Saira Condensed", fontSize: 40, fontWeight: 700, color: C.muted }, initials),
      );
  const counts = countsInOrder(card.counts).map(({ flag, count }) =>
    box(
      {
        alignItems: "center",
        gap: 10,
        padding: "6px 14px",
        borderRadius: 4,
        background: count === 0 ? C.panel2 : flag === "green" ? "rgba(51,194,122,0.14)" : flag === "yellow" ? "rgba(240,194,52,0.14)" : "rgba(240,96,79,0.15)",
        color: count === 0 ? C.muted : FLAG_COLOR[flag],
        fontSize: 26,
        fontWeight: 600,
      },
      flagIcon(count === 0 ? "neutral" : flag, 22),
      el("span", {}, `${count} ${COUNT_WORD[flag]}`),
    ),
  );
  // Eight rows at most fit, four a column: an Instant launch has seven, a Fair Open eight, a finding adds one.
  const rows = card.rows.slice(0, 8);
  const half = Math.ceil(rows.length / 2);
  const rowEl = (r: FairnessCard["rows"][number]) =>
    box(
      { gap: 14, alignItems: "flex-start", height: 82 },
      box({ paddingTop: 4 }, flagIcon(r.flag, 24)),
      box(
        { flexDirection: "column", gap: 2, flex: 1 },
        el("span", { fontSize: 15, fontWeight: 600, letterSpacing: 1.5, textTransform: "uppercase", color: C.faint }, r.title),
        el("span", { fontSize: 21, lineHeight: 1.3, color: r.flag === "red" ? C.stop : C.fg, lineClamp: 2, display: "block" }, r.value),
      ),
    );
  const host = o.web.replace(/^https?:\/\//, "");
  // The frame is exactly the image; the card inside it takes its border and padding from that, never adding to it.
  return box(
    { width: CARD_WIDTH, height: CARD_HEIGHT, background: C.bg },
    box(
      {
        flex: 1,
        flexDirection: "column",
        color: C.fg,
        fontFamily: "IBM Plex Sans",
        border: `8px solid ${red ? C.stop : C.line}`,
        padding: "24px 40px 18px",
      },
      box(
        { alignItems: "center", gap: 24 },
        picture,
        box(
          { flexDirection: "column", flex: 1, gap: 4, minWidth: 0 },
          box(
            { alignItems: "baseline", gap: 16 },
            el("span", { fontFamily: "Saira Condensed", fontSize: 50, fontWeight: 700, lineHeight: 1, maxWidth: 560, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, card.name),
            el("span", { fontFamily: "IBM Plex Mono", fontSize: 26, color: C.muted }, `$${card.ticker}`),
          ),
          box(
            { alignItems: "center", gap: 12, fontSize: 20, color: C.muted },
            el("span", {}, card.launchMode === "fair_open" ? "Fair Open" : "Instant launch"),
            el("span", { color: C.faint }, "·"),
            el("span", { fontFamily: "IBM Plex Mono" }, shortAddress(card.mint)),
          ),
        ),
        box(
          { flexDirection: "column", alignItems: "flex-end", gap: 6 },
          box(
            { alignItems: "center", gap: 10 },
            flagIcon("green", 30),
            el("span", { fontFamily: "Saira Condensed", fontSize: 38, fontWeight: 700, letterSpacing: 1 }, "HEAT"),
          ),
          el("span", { fontSize: 16, fontWeight: 600, letterSpacing: 2, textTransform: "uppercase", color: C.faint }, o.cluster === "mainnet" ? "Fairness card" : `Fairness card · ${o.cluster}`),
        ),
      ),
      box({ gap: 12, marginTop: 18 }, ...counts),
      box(
        { marginTop: 18, gap: 36, flex: 1 },
        box({ flexDirection: "column", flex: 1, gap: 2 }, ...rows.slice(0, half).map(rowEl)),
        box({ flexDirection: "column", flex: 1, gap: 2 }, ...rows.slice(half).map(rowEl)),
      ),
      box(
        { justifyContent: "space-between", alignItems: "center", borderTop: `1px solid ${C.line}`, paddingTop: 12, fontSize: 17, color: C.muted },
        el("span", {}, "Every row links to the chain on the coin's page"),
        el("span", { fontFamily: "IBM Plex Mono", color: C.fg }, `${host}/coin/${shortAddress(card.mint)}`),
      ),
    ),
  );
}

/** The card as a PNG of `CARD_WIDTH` by `CARD_HEIGHT`. */
export async function renderCardImage(card: FairnessCard, o: { cluster: string; web: string; assets?: () => Promise<CardAssets> }): Promise<Uint8Array> {
  const [assets, picture] = await Promise.all([start(o.assets ?? workerAssets), pictureOf(card.imageUri)]);
  const svg = await satori(cardLayout(card, { cluster: o.cluster, web: o.web, picture }) as never, {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    fonts: assets.fonts.map((f) => ({ ...f, style: "normal" as const })),
  });
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: CARD_WIDTH }, font: { loadSystemFonts: false } });
  const rendered = resvg.render();
  const png = rendered.asPng();
  rendered.free();
  resvg.free();
  return png;
}
