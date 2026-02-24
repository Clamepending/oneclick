import "./globals.css";
import type { ReactNode } from "react";
import Link from "next/link";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="topbar-inner">
            <Link href="/" className="topbar-brand">
              OneClick
            </Link>
            <Link href="/" className="button secondary">
              Home
            </Link>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
