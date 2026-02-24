import "./globals.css";
import type { ReactNode } from "react";
import { TopNav } from "@/components/layout/TopNav";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <TopNav />
        {children}
      </body>
    </html>
  );
}
