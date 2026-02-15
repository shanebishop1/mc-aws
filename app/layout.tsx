import { IOSViewportFix } from "@/components/IOSViewportFix";
import { AuthProvider } from "@/components/auth/auth-provider";
import type { Metadata, Viewport } from "next";
import { Inter, Playfair_Display } from "next/font/google";
import "./globals.css";

export const metadata: Metadata = {
  title: "mc-aws",
  description: "Minecraft Server Management Interface",
  applicationName: "mc-aws",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "mc-aws",
    statusBarStyle: "default",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    apple: [
      {
        url: "/apple-icon",
        sizes: "180x180",
        type: "image/png",
      },
    ],
    icon: [
      {
        url: "/icon.svg",
        type: "image/svg+xml",
      },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: "#1A4222",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const playfair = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
  display: "swap",
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        data-testid="root-layout"
        className={`${inter.variable} ${playfair.variable} antialiased bg-cream text-charcoal font-sans`}
      >
        <IOSViewportFix />
        <div id="app-root">
          <AuthProvider>{children}</AuthProvider>
        </div>
      </body>
    </html>
  );
}
