"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useConnection } from "@solana/wallet-adapter-react";
import { fetchConfig } from "@/lib/config";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false },
);

export default function NavBar() {
  const { connection } = useConnection();
  const [slot, setSlot] = useState<number | null>(null);
  const [supply, setSupply] = useState<bigint | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const [s, config] = await Promise.all([connection.getSlot(), fetchConfig(connection)]);
        if (!cancelled) {
          setSlot(s);
          setSupply(config?.supply ?? null);
        }
      } catch {
        // ticker is decorative; ignore transient RPC hiccups
      }
    }
    poll();
    const id = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connection]);

  return (
    <nav className="panel panel-green border-b sticky top-0 z-10 px-4 sm:px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
      <div className="flex items-center gap-6 flex-wrap">
        <a href="/" className="flex items-center gap-2 text-lg font-bold tracking-tight">
          <span>🐼</span>
          <span className="text-[var(--green)]">HASH</span>
          <span>PANDAS</span>
        </a>
        <div className="hidden md:flex items-center gap-4 label">
          <a href="/" className="hover:text-[var(--green)]">MINE</a>
          <span className="opacity-40">COLLECTION</span>
          <span className="opacity-40">$PANDA</span>
          <a
            href="https://claude.ai/code/artifact/efda0aaa-50fb-4bed-a40a-262e723adc61"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-[var(--cyan)]"
          >
            DOCS
          </a>
        </div>
      </div>
      <div className="flex items-center gap-4">
        <div className="label text-right hidden sm:block">
          <div>
            SLOT <span className="text-[var(--foreground)]">{slot ?? "—"}</span>
          </div>
          <div>
            MINTED <span className="text-[var(--foreground)]">{supply?.toString() ?? "—"}</span>
          </div>
        </div>
        <WalletMultiButton style={{ fontFamily: "inherit", fontSize: "0.75rem" }} />
      </div>
    </nav>
  );
}
