// A coin's image, made to fit what the launch service takes: PNG, JPEG, GIF or WebP up to its size limit (under
// Turbo's free 100 KiB per Arweave data item on devnet). An image that already fits is sent untouched, an animated GIF
// included; anything else is redrawn smaller, as WebP, or as JPEG where the browser cannot encode WebP.
const TAKEN = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const SIDES = [1024, 768, 512, 384, 256];
const QUALITIES = [0.92, 0.85, 0.78, 0.7, 0.6];

export type FittedImage = {
  blob: Blob;
  name: string;
  type: string;
  width: number;
  height: number;
  bytes: number;
  /** Whether it had to be redrawn to fit. */
  redrawn: boolean;
};

export class ImageProblem extends Error {}

const encode = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

export async function fitImage(file: File, maxBytes: number): Promise<FittedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ImageProblem("That file is not an image this browser can read. Use a PNG, JPEG, GIF or WebP.");
  }
  const { width, height } = bitmap;
  const base = file.name.replace(/\.[^.]+$/, "") || "coin";
  try {
    if (file.size <= maxBytes && TAKEN.has(file.type)) {
      return { blob: file, name: file.name, type: file.type, width, height, bytes: file.size, redrawn: false };
    }
    for (const side of SIDES) {
      const scale = Math.min(1, side / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new ImageProblem("This browser cannot redraw the image. Use one under the size limit.");
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const type of ["image/webp", "image/jpeg"]) {
        if (type === "image/jpeg") {
          // JPEG has no transparency: what was clear becomes white, as most coin pictures expect.
          context.globalCompositeOperation = "destination-over";
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.globalCompositeOperation = "source-over";
        }
        for (const quality of QUALITIES) {
          const blob = await encode(canvas, type, quality);
          // A browser that cannot encode a type quietly hands back a PNG: try the next type.
          if (!blob || blob.type !== type) break;
          if (blob.size <= maxBytes) {
            const extension = type === "image/webp" ? "webp" : "jpg";
            return { blob, name: `${base}.${extension}`, type, width: canvas.width, height: canvas.height, bytes: blob.size, redrawn: true };
          }
        }
      }
    }
  } finally {
    bitmap.close();
  }
  throw new ImageProblem("This image has too much detail to fit. Try a simpler or smaller one.");
}
