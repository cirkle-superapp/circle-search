import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { JsonLd, homePageJsonLd } from "@/components/search/JsonLd";

export const metadata: Metadata = {
  title: "Cirkle Search Engine — Search the open web. Decide for yourself.",
  description:
    "Cirkle Search Engine (دواير) — an independent, privacy-first web search engine with its own crawler, index, ranking, source transparency, evidence-grounded AI, and user-controlled search modes.",
  keywords: [
    "Cirkle Search Engine",
    "search engine",
    "privacy search",
    "independent search",
    "evidence-grounded AI",
    "deep research",
    "source transparency",
    "Cirkle",
  ],
  authors: [{ name: "Cirkle" }],
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any", type: "image/x-icon" },
      { url: "/cirkle-favicon.ico", sizes: "256x256", type: "image/x-icon" },
    ],
    apple: "/cirkle-favicon.ico",
  },
  openGraph: {
    title: "Cirkle Search Engine",
    description: "Search the open web. Decide for yourself.",
    siteName: "Cirkle Search Engine",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Cirkle Search Engine",
    description: "Search the open web. Decide for yourself.",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  maximumScale: 5,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FDFCF9" },
    { media: "(prefers-color-scheme: dark)", color: "#1A4A5A" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className="antialiased bg-background text-foreground"
        style={{
          fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        }}
      >
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("cirkle-theme");if(t===null){t=window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";}if(t==="dark"){document.documentElement.classList.add("dark");}}catch(e){}})();`,
          }}
        />
        {children}
        <Toaster />
        <JsonLd data={homePageJsonLd()} />
      </body>
    </html>
  );
}
