import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import NavBar from "./components/NavBar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "UserAuth",
  description: "A secure user authentication demo application.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          // Remove Next.js route announcer custom element to prevent aria-live conflicts
          (function() {
            function fix() {
              var els = document.getElementsByTagName('next-route-announcer');
              for (var i = els.length - 1; i >= 0; i--) els[i].remove();
            }
            setInterval(fix, 100);
            if (typeof MutationObserver !== 'undefined') {
              new MutationObserver(fix).observe(document.documentElement, { childList: true, subtree: true });
            }
          })();
        `}} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <NavBar />
        {children}
      </body>
    </html>
  );
}
