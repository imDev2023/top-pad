// A coin's picture for one run, drawn in the page's canvas from a seed (#107). Every Fair Open's coin, and an Instant coin
// at 100 holders, becomes a protected Heat coin (spec 6.2), and Vamp Shield labels a later launch whose picture SSCD rates
// at 0.60 or more against a protected one's. The first recipe (a dark square, nine shapes, the ticker centred) drew
// pictures SSCD rated close to the protected set and to each other: on 2026-11-15, 19 of 30 reached 0.60 against the
// devnet protected set. Flat compositions (stripes, rings, tiles, polygons) stayed close to the flat logos most of the set
// holds, and smooth noise and pixel grids close to each other; what SSCD keeps apart is dense, multi-scale clutter: 700
// marks of four kinds, every colour and opacity, mostly tiny with a few large. Measured with the vision service on
// 2026-11-15 over 300 pictures: the nearest protected image of the 5,000-odd on devnet at SSCD 0.351 at most (median
// 0.227), and no two of the 44,850 pairs at 0.60 (the closest 0.586, the median about 0.39; PDQ 90 apart at the closest).
// `pnpm --filter @top-pad/tests-ui picture-check` measures it again.

/**
 * Draws the picture for `seed` and answers its PNG as base64. It runs inside the page (`page.evaluate`, through
 * `pictureScript`), so it may use nothing from outside its own body.
 */
export async function drawCoinPicture(seed: string): Promise<string> {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const random = () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return (h >>> 0) / 4294967296;
  };
  const size = 256;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = `hsl(${random() * 360} 50% ${10 + random() * 80}%)`;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 700; i++) {
    const colour = `hsla(${random() * 360} ${30 + random() * 70}% ${random() * 100}% / ${0.2 + random() * 0.8})`;
    ctx.fillStyle = colour;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 0.5 + random() * 3;
    ctx.save();
    ctx.translate(random() * size, random() * size);
    ctx.rotate(random() * Math.PI * 2);
    // Mostly a few pixels across, now and then up to 60.
    const r = 1 + random() ** 3 * 60;
    ctx.beginPath();
    const kind = Math.floor(random() * 4);
    if (kind === 0) {
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 1) {
      ctx.rect(-r, -r / 3, 2 * r, r * random());
      ctx.fill();
    } else if (kind === 2) {
      ctx.moveTo(-r, 0);
      ctx.lineTo(r, (random() - 0.5) * r);
      ctx.stroke();
    } else {
      ctx.arc(0, 0, r, 0, 1 + random() * 5);
      ctx.stroke();
    }
    ctx.restore();
  }
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * The script that draws `seed`'s picture in a page, for `page.evaluate`: the function's source with a stand-in for the
 * `__name` helper that tsx's and Playwright's transforms add to named functions, which the page does not have.
 */
export const pictureScript = (seed: string) => `(async () => { const __name = (f) => f; return (${drawCoinPicture.toString()})(${JSON.stringify(seed)}); })()`;
