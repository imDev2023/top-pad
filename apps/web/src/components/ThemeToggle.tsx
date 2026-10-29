"use client";

import { useEffect, useState } from "react";
import { THEME_COOKIE, THEME_GROUNDS, type Theme } from "@/lib/theme";
import styles from "./ThemeToggle.module.css";

/**
 * Light or dark: the page follows the system until this is pressed, then the choice holds, as a cookie the layout
 * reads. The button shows what pressing it brings: the sun while dark, the moon while light.
 */
export function ThemeToggle() {
  // Unknown until mounted: the server knows only an explicit choice, not the system setting.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const system = matchMedia("(prefers-color-scheme: light)");
    const read = () => {
      const chosen = document.documentElement.dataset.theme;
      setTheme(chosen === "light" || chosen === "dark" ? chosen : system.matches ? "light" : "dark");
    };
    read();
    system.addEventListener("change", read);
    return () => system.removeEventListener("change", read);
  }, []);

  function flip() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    // The browser's own chrome follows the choice too, whatever the system says.
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
      meta.setAttribute("content", THEME_GROUNDS[next]);
      meta.removeAttribute("media");
    });
    setTheme(next);
  }

  const label = theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme";
  return (
    <button type="button" className={styles.button} onClick={flip} aria-label={label} title={label} disabled={theme === null}>
      {theme === "light" ? (
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M16.5 12.3A6.8 6.8 0 0 1 7.7 3.5a6.8 6.8 0 1 0 8.8 8.8Z" />
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
          <circle cx="10" cy="10" r="3.6" />
          <path d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7l1.3 1.3M14 14l1.3 1.3M4.7 15.3 6 14M14 6l1.3-1.3" />
        </svg>
      )}
    </button>
  );
}
