"use client";

import { useState } from "react";

const DONATION_ADDRESS = "2o3jQhcMKk8moi7uw1Q5XbiwPfYnwZvoqcNqtDHWuvKY";

export default function DonateBar() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(DONATION_ADDRESS);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API can be unavailable (permissions, non-secure context);
      // the address is still selectable text, so this is a soft failure
    }
  }

  return (
    <div className="panel panel-cyan p-3 flex items-center gap-3 flex-wrap text-xs">
      <span className="label text-[var(--cyan)] shrink-0">support mainnet launch</span>
      <code className="flex-1 min-w-0 truncate text-[var(--dim)]">{DONATION_ADDRESS}</code>
      <button
        onClick={copy}
        className="shrink-0 border border-[var(--cyan)] text-[var(--cyan)] px-2 py-1 rounded-sm"
      >
        {copied ? "copied" : "copy address"}
      </button>
      <span className="w-full text-[var(--dim)] leading-relaxed">
        Optional, on Solana mainnet -- helps cover deploy rent and an eventual audit. This program
        is unaudited and devnet-only right now; sending funds doesn&apos;t guarantee any specific
        outcome or timeline.
      </span>
    </div>
  );
}
