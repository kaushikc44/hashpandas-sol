"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { fetchConfig, entryPriceLamports, type ConfigAccount } from "@/lib/config";

function lamportsToSol(lamports: bigint): string {
  return (Number(lamports) / 1_000_000_000).toFixed(6);
}

function nextEpochSupply(epoch: number): bigint {
  return 8n * ((1n << BigInt(epoch + 1)) - 1n);
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
            <Stat label="Entry price" value={`${lamportsToSol(entryPriceLamports(config))} SOL`} />
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

          <EpochProgress config={config} />
        </>
      )}
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="mt-0.5">{value}</div>
    </div>
  );
}
