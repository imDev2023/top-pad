// A coin's picture for one run, drawn in the page's canvas from a seed (#107). Every Fair Open's coin, and an Instant coin
// at 100 holders, becomes a protected Heat coin (spec 6.2), and Vamp Shield labels a later launch whose picture SSCD rates
// at 0.60 or more against a protected one's. The first recipe (a dark square, nine shapes, the ticker centred) drew
// pictures SSCD rated close to the protected set and to each other: on 2026-11-15, 19 of 30 reached 0.60 against the
// devnet protected set. Flat compositions (stripes, rings, tiles, polygons) stayed close to the flat logos most of the set
// holds, and smooth noise and pixel grids close to each other; what SSCD keeps apart is dense, multi-scale clutter: 700
// marks of four kinds, every colour and opacity, mostly tiny with a few large, encoded as WebP. Measured with the vision
// service on 2026-11-15 over 300 pictures: as PNG, before any picture of this recipe was protected, the nearest of the
// 5,000-odd protected images on devnet at SSCD 0.351 (median 0.227); as WebP, once that day's runs had opened a few
// coins drawn this way, the nearest at 0.520, an earlier run's picture; and of the 44,850 pairs drawn, the
// closest at 0.588 (median about 0.40), none at the 0.60 label, PDQ 90 apart at the closest. So a picture of this recipe
// is far from every real coin's and, rarely, near an earlier run's: the margin to watch as test coins accumulate.
// `pnpm --filter @top-pad/tests-ui picture-check` measures it again.

/**
 * Draws the picture for `seed` and answers it as WebP, base64. It runs inside the page (`page.evaluate`, through
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
  // WebP, under the launch service's 96 KiB for a coin's image (`MAX_IMAGE_BYTES`): as a PNG this clutter comes to 105 to
  // 126 KiB, which the site would redraw as WebP anyway and the API refuses when a spec posts it directly.
  let blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.9 });
  for (const quality of [0.8, 0.7, 0.6]) if (blob.size > 90 * 1024) blob = await canvas.convertToBlob({ type: "image/webp", quality });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * The script that draws `seed`'s picture in a page, for `page.evaluate`: the function's source with a stand-in for the
 * `__name` helper that tsx's and Playwright's transforms add to named functions, which the page does not have.
 */
export const pictureScript = (seed: string) => `(async () => { const __name = (f) => f; return (${drawCoinPicture.toString()})(${JSON.stringify(seed)}); })()`;
