"use client";

import { useId, useRef, useState, type DragEvent } from "react";
import { kb } from "@/lib/format";
import { fitImage, ImageProblem, type FittedImage } from "@/lib/image";
import styles from "./Launch.module.css";

/** The coin's picture: chosen or dropped, then made to fit what the launch service stores on Arweave. */
export function ImagePicker({
  image,
  previewUrl,
  maxBytes,
  onChange,
}: {
  image: FittedImage | null;
  previewUrl: string | null;
  maxBytes: number;
  onChange: (image: FittedImage | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [dragging, setDragging] = useState(false);

  async function take(file: File | undefined) {
    if (!file) return;
    setProblem(null);
    setWorking(true);
    try {
      onChange(await fitImage(file, maxBytes));
    } catch (e) {
      onChange(null);
      setProblem(e instanceof ImageProblem ? e.message : "That image could not be read.");
    } finally {
      setWorking(false);
    }
  }

  const drop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void take(e.dataTransfer.files[0]);
  };

  return (
    <div className="field">
      <span className="label" id={`${id}-label`}>
        Image
      </span>
      <div
        className={`${styles.picker} ${dragging ? styles.pickerOver : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        <button
          type="button"
          className={styles.pickerTile}
          onClick={() => input.current?.click()}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-help`}
        >
          {previewUrl ? <img src={previewUrl} alt="The chosen image" /> : <span aria-hidden="true">+</span>}
        </button>
        <div className={styles.pickerText}>
          <button type="button" className="btn btn-sm" onClick={() => input.current?.click()} disabled={working}>
            {working ? "Fitting the image…" : image ? "Choose another" : "Choose an image"}
          </button>
          <span className="note" id={`${id}-help`}>
            {image
              ? `${image.name} · ${image.width} × ${image.height} · ${kb(image.bytes)}${image.redrawn ? ` · redrawn to fit ${kb(maxBytes)}` : ""}`
              : `PNG, JPEG, GIF or WebP. A larger one is redrawn to fit ${kb(maxBytes)}, the most a coin's picture can be on Arweave here. Square works best.`}
          </span>
        </div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/*"
          className="visually-hidden"
          tabIndex={-1}
          onChange={(e) => {
            void take(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      {problem && (
        <p className={styles.fieldProblem} role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
