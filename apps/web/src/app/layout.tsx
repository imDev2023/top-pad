import "./globals.css";
import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Saira_Condensed } from "next/font/google";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { DevnetStrip } from "@/components/DevnetStrip";
import { Providers } from "@/components/Providers";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { getPlatformOrNull } from "@/lib/api";
import { isTheme, THEME_COOKIE, THEME_GROUNDS } from "@/lib/theme";

// The race marshal's board (spec 9): a condensed display face for the voice, a plain sans and its mono for the figures.
const saira = Saira_Condensed({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-saira", display: "swap" });
const plexSans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-sans", display: "swap" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Heat", template: "%s · Heat" },
  description: "A fair-launch token launchpad on Solana: every coin starts together, under a sniper tax that never pays its creator.",
  // Devnet carries test coins only, so nothing here is for search engines.
  robots: { index: false, follow: false },
};

/** The browser's own chrome follows the page: the toggle's choice when there is one, the system's otherwise. */
export async function generateViewport(): Promise<Viewport> {
  const theme = (await cookies()).get(THEME_COOKIE)?.value;
  return {
    width: "device-width",
    initialScale: 1,
    themeColor: isTheme(theme)
      ? THEME_GROUNDS[theme]
      : [
          { media: "(prefers-color-scheme: light)", color: THEME_GROUNDS.light },
          { media: "(prefers-color-scheme: dark)", color: THEME_GROUNDS.dark },
        ],
  };
}

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [jar, platform] = await Promise.all([cookies(), getPlatformOrNull()]);
  const theme = jar.get(THEME_COOKIE)?.value;
  const cluster = platform?.cluster ?? "devnet";
  return (
    // The toggle changes `data-theme` after hydration on purpose; that is not a mismatch.
    <html
      lang="en"
      data-theme={isTheme(theme) ? theme : undefined}
      className={`${saira.variable} ${plexSans.variable} ${plexMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <Providers chain={`solana:${cluster}`}>
          {cluster !== "mainnet" && <DevnetStrip cluster={cluster} />}
          <SiteHeader cluster={cluster} />
          <main>{children}</main>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
