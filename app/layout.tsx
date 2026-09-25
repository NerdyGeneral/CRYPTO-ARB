import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Arbiter Live | Crypto Arbitrage Paper Bot",
  description: "Watch live Coinbase and Kraken order books and test fee-aware crypto arbitrage routes with simulated trades.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
