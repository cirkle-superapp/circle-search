import type { Metadata, Viewport } from "next";
// Using system fonts via CSS variables (no Google Fonts dependency)
import { Inter, Fraunces, Tajawal } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

let inter: { variable: string };
try {
  inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });
} catch { inter = { variable: "--font-inter" }; }
let fraunces: { variable: string };
try {
  fraunces = Fraunces({ variable: "--font-fraunces", subsets: ["latin"], display: "swap", weight: ["300", "400", "500", "600", "700"] });
} catch { fraunces = { variable: "--font-fraunces" }; }
let tajawal: { variable: string };
try {
  tajawal = Tajawal({ variable: "--font-tajawal", subsets: ["arabic", "latin"], display: "swap", weight: ["300", "400", "500", "700"] });
} catch { tajawal = { variable: "--font-tajawal" }; }

export const metadata: Metadata = {
  title: "CIRKLE — Search the open web. Decide for yourself.",
  description:
    "CIRKLE is an independent, privacy-first web search engine with its own crawler, index, ranking, source transparency, evidence-grounded AI, and user-controlled search modes.",
  keywords: [
    "CIRKLE",
    "search engine",
    "privacy search",
    "independent search",
    "evidence-grounded AI",
    "deep research",
    "source transparency",
    "دواير",
  ],
  authors: [{ name: "CIRKLE" }],
  manifest: "/manifest.json",
  icons: {
    icon: "/cirkle-favicon.svg",
    apple: "/cirkle-logo.svg",
  },
  openGraph: {
    title: "CIRKLE",
    description: "Search the open web. Decide for yourself.",
    siteName: "CIRKLE",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "CIRKLE",
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
        className={`${inter.variable} ${fraunces.variable} ${tajawal.variable} antialiased bg-background text-foreground`}
      >
        {/* Prevent FOUC: apply saved theme before hydration.
            Respects prefers-color-scheme for first-time visitors. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("cirkle-theme");if(t===null){t=window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";}if(t==="dark"){document.documentElement.classList.add("dark");}}catch(e){}})();`,
          }}
        />
        {children}
        <Toaster />
      </body>
    </html>
  );
}
