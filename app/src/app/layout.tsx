import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import WalletProviders from "@/components/WalletProviders";
import "./globals.css";

const mono = JetBrains_Mono({
  variable: "--font-mono-app",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Hashpandas",
  description: "A proof-of-work NFT collection on Solana devnet",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${mono.variable} h-full antialiased dark`}>
      <body className="min-h-full flex flex-col">
        <WalletProviders>{children}</WalletProviders>
      </body>
    </html>
  );
}
