import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import type { ReactNode } from "react";

import "./globals.css";
import "./webmcp-probe/probe.css";

export const metadata: Metadata = {
  title: "ClaimGate | People verify, secrets stay private",
  description:
    "A privacy-safe lost property claim desk where AI helps find and people verify.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();

  return (
    <html lang="en">
      <body>
        <div className="site-shell">
          <header className="masthead" aria-label="ClaimGate">
            <Link className="wordmark" href="/">
              <span className="wordmark-mark" aria-hidden="true">
                CG
              </span>
              <span>
                <strong>ClaimGate</strong>
                <small>Northbridge property desk</small>
              </span>
            </Link>
            <span className="desk-label">Public service prototype · Desk 04</span>
          </header>
          {children}
          <footer className="footer-line">
            <span>AI helps find.</span>
            <span>People verify.</span>
            <span>Secrets stay private.</span>
          </footer>
        </div>
      </body>
    </html>
  );
}
