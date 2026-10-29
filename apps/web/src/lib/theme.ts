/**
 * The cookie that holds a visitor's light-or-dark choice: the header's toggle sets it, and the root layout writes it
 * onto <html> as `data-theme` so a page never paints the other one first. Without it the page follows the system, dark
 * when the system says nothing (spec 9: dark-first). A plain module, so a server component can import the name.
 */
export const THEME_COOKIE = "heat_theme";
export type Theme = "light" | "dark";
export const isTheme = (value: string | undefined): value is Theme => value === "light" || value === "dark";

/** The page ground in each theme, for the browser's own chrome. */
export const THEME_GROUNDS: Record<Theme, string> = { dark: "#14171a", light: "#eef1ef" };
