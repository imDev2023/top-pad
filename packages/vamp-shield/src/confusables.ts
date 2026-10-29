// Reads the confusables table that scripts/generate-confusables.ts writes into confusables.generated.ts: one line per
// prototype, its code points, a colon, then every code point whose prototype it is, all in hex as in confusables.txt
// ("0045:0395 0415 ..." maps Greek and Cyrillic capital E to Latin capital E). The script decodes its own output with
// this function before writing, so the two cannot drift apart.

const fromHex = (h: string) => Number.parseInt(h, 16);

/** Each source code point's prototype: the string UTS #39 replaces it with in a skeleton. */
export function decodeConfusables(data: string): Map<number, string> {
  const prototypes = new Map<number, string>();
  for (const line of data.split("\n")) {
    if (line === "") continue;
    const [target = "", sources = ""] = line.split(":");
    const prototype = String.fromCodePoint(...target.split(" ").map(fromHex));
    for (const source of sources.split(" ")) prototypes.set(fromHex(source), prototype);
  }
  return prototypes;
}
