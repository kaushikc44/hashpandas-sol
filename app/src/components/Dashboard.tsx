"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  fetchConfig,
  entryPriceLamports,
  nextEntryPriceLamports,
  epochStartSupply,
  type ConfigAccount,
} from "@/lib/config";

function lamportsToSol(lamports: bigint): string {
  return (Number(lamports) / 1_000_000_000).toFixed(6);
}

function nextEpochSupply(epoch: number): bigint {
  return epochStartSupply(epoch + 1);
}

export default function Dashboard() {
  const { connection } = useConnection();
  const [config, setConfig] = useState<ConfigAccount | null | "loading" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const c = await fetchConfig(connection);
        if (!cancelled) setConfig(c);
      } catch {
        if (!cancelled) setConfig("error");
      }
    }
    load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [connection]);

  return (
    <div className="panel panel-cyan p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold tracking-wide text-[var(--cyan)]">NETWORK</h2>
      </div>

      {config === "loading" && <p className="text-xs text-[var(--dim)]">reading chain…</p>}
      {config === "error" && <p className="text-xs text-red-400">failed to reach devnet RPC</p>}
      {config === null && (
        <p className="text-xs text-amber-400">program not initialized yet on devnet</p>
      )}

      {config && config !== "loading" && config !== "error" && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
            <Stat label="Supply" value={config.supply.toString()} />
            <Stat label="Epoch" value={config.epoch.toString()} />
            <Stat label="Entry price" value={`${lamportsToSol(entryPriceLamports(config))} SOL`} accent="green" />
            <Stat label="Difficulty" value={`${config.baseDifficulty} bits`} />
            <Stat label="Streak" value={`+${config.streak}`} />
            <Stat label="Target" value={`${config.baseDifficulty + config.streak} bits`} />
            <Stat label="Living" value={config.eligibleLiving.toString()} />
            <Stat label="Burned" value={config.eligibleBurned.toString()} />
            <Stat
              label="Collection"
              value={`${config.collection.slice(0, 4)}…${config.collection.slice(-4)}`}
            />
          </div>

          <NextPrice config={config} />
          <EpochProgress config={config} />
        </>
      )}
    </div>
  );
}

function NextPrice({ config }: { config: ConfigAccount }) {
  const current = entryPriceLamports(config);
  const next = nextEntryPriceLamports(config);
  const remaining = epochStartSupply(config.epoch + 1) - config.supply;
  const direction = next > current ? "up" : next < current ? "down" : "flat";

  return (
    <div className="bar-track px-3 py-2 flex items-center justify-between gap-3 flex-wrap text-sm">
      <span className="label">
        price at epoch {config.epoch + 1} ({remaining.toString()} mint{remaining === 1n ? "" : "s"} away)
      </span>
      <span className="flex items-center gap-2">
        <span className="text-[var(--dim)]">{lamportsToSol(current)} SOL</span>
        <span
          className={
            direction === "up"
              ? "text-[var(--green)]"
              : direction === "down"
                ? "text-red-400"
                : "text-[var(--dim)]"
          }
        >
          {direction === "up" ? "↑" : direction === "down" ? "↓" : "→"}
        </span>
        <span className="font-bold">{lamportsToSol(next)} SOL</span>
      </span>
    </div>
  );
}

function EpochProgress({ config }: { config: ConfigAccount }) {
  const start = 8n * ((1n << BigInt(config.epoch)) - 1n);
  const end = nextEpochSupply(config.epoch);
  const span = end - start;
  const progress = span > 0n ? Number(config.supply - start) / Number(span) : 0;
  const pct = Math.max(0, Math.min(1, progress)) * 100;

  return (
    <div>
      <div className="label flex justify-between mb-1">
        <span>epoch {config.epoch} → {config.epoch + 1}</span>
        <span>
          {config.supply.toString()} / {end.toString()}
        </span>
      </div>
      <div className="bar-track h-2 w-full">
        <div className="bar-fill-cyan h-full" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: "green" | "cyan" }) {
  const color = accent === "green" ? "text-[var(--green)]" : accent === "cyan" ? "text-[var(--cyan)]" : "";
  return (
    <div>
      <div className="label">{label}</div>
      <div className={`mt-0.5 ${color}`}>{value}</div>
    </div>
  );
}
