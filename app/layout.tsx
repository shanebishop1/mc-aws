import { IOSViewportFix } from "@/components/IOSViewportFix";
import { AuthProvider } from "@/components/auth/auth-provider";
import type { Metadata } from "next";
import { Inter, Playfair_Display } from "next/font/google";
import "./globals.css";

export const metadata: Metadata = {
  title: "mc-aws",
  description: "Minecraft Server Management Interface",
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
