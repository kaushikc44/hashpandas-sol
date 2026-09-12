"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { fetchAllPandas, type PandaAccount } from "@/lib/panda";
import { renderSeedToCanvas } from "@/lib/render";
import { leadingZeroBits } from "@/lib/keccak";

export default function LatestMints() {
  const { connection } = useConnection();
  const [pandas, setPandas] = useState<PandaAccount[]>([]);

  const refresh = useCallback(async () => {
    try {
      const all = await fetchAllPandas(connection);
      all.sort((a, b) => (b.index > a.index ? 1 : b.index < a.index ? -1 : 0));
      setPandas(all.slice(0, 16));
    } catch {
      // decorative section; ignore transient RPC hiccups
    }
  }, [connection]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 8000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <div className="panel panel-green p-4">
      <h2 className="text-sm font-bold tracking-wide text-[var(--green)] mb-3">LATEST MINTS</h2>
      {pandas.length === 0 ? (
        <p className="text-xs text-[var(--dim)]">nothing mined yet</p>
      ) : (
        <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2">
          {pandas.map((p) => (
            <MintThumb key={p.address.toBase58()} panda={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function MintThumb({ panda }: { panda: PandaAccount }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (ctx) renderSeedToCanvas(ctx, panda.seed);
  }, [panda.seed]);
  const bits = leadingZeroBits(panda.workHash);
  return (
    <div className="bar-track overflow-hidden">
      <canvas ref={ref} width={512} height={512} className="w-full aspect-square" />
      <div className="label flex justify-between px-1 py-0.5 text-[0.6rem]">
        <span>#{panda.index.toString()}</span>
        <span>{bits}b</span>
      </div>
    </div>
  );
}
