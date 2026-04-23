import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Liliput — Agent Orchestrator",
  description: "Your tiny workers, building features at scale. A Gulliver's Travels-inspired AI agent platform.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${geistMono.variable} antialiased bg-[#0a0a0f] text-[#e0e0e8] min-h-screen font-mono`}>
        {children}
      </body>
    </html>
  );
}
