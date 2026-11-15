// The Fairness card image's WebAssembly and fonts, bundled into the Worker: a Worker may not compile WebAssembly from
// bytes, so wrangler compiles each `.wasm` as a module, and takes each `.woff` as bytes (the `rules` in wrangler.jsonc).
// Only the Worker imports this, lazily, as it draws its first card; a test passes the same files read from the disk.
import plexMono400 from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff";
import plexSans400 from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff";
import plexSans600 from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff";
import saira700 from "@fontsource/saira-condensed/files/saira-condensed-latin-700-normal.woff";
import resvg from "@resvg/resvg-wasm/index_bg.wasm";
import layout from "satori/yoga.wasm";
import type { CardAssets } from "./cardImage";

export const cardAssets: CardAssets = {
  layout,
  resvg,
  fonts: [
    { name: "IBM Plex Sans", data: plexSans400, weight: 400 },
    { name: "IBM Plex Sans", data: plexSans600, weight: 600 },
    { name: "IBM Plex Mono", data: plexMono400, weight: 400 },
    { name: "Saira Condensed", data: saira700, weight: 700 },
  ],
};
