import type { Metadata, Viewport } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthStatusBanner } from "../components/AuthStatusBanner";
import VersionFooter from "../components/VersionFooter";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Liliput — Agent Orchestrator",
  description: "Your tiny workers, building features at scale. A Gulliver's Travels-inspired AI agent platform.",
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#050510',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${geistMono.variable} antialiased bg-[#0a0a0f] text-[#e0e0e8] min-h-screen font-mono`}>
        <AuthStatusBanner />
        {children}
        <VersionFooter />
      </body>
    </html>
  );
}
