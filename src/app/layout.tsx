import type { Metadata } from "next";
import { IBM_Plex_Sans_Hebrew } from "next/font/google";
import "./globals.css";

const plex = IBM_Plex_Sans_Hebrew({
  variable: "--font-plex",
  subsets: ["hebrew", "latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "הבוט שלי",
  description: "הגדרות הבוט הטלפוני של העסק",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="he" dir="rtl" className={`${plex.variable} h-full antialiased`}>
      <body className="min-h-full font-sans">{children}</body>
    </html>
  );
}
