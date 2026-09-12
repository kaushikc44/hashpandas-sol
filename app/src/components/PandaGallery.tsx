"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { useHashpandasProgram } from "@/lib/useProgram";
import { fetchConfig, claimableLamports, type ConfigAccount } from "@/lib/config";
import { fetchPandasOwnedBy, type PandaAccount } from "@/lib/panda";
import { renderSeedToCanvas } from "@/lib/render";
import { associatedTokenAddress, configPda, pandaPda, vaultPda } from "@/lib/pda";
import { MPL_CORE_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@/lib/constants";

function lamportsToSol(lamports: bigint): string {
  return (Number(lamports) / 1_000_000_000).toFixed(6);
}

export default function PandaGallery() {
  const { connection } = useConnection();
  const program = useHashpandasProgram();
  const [config, setConfig] = useState<ConfigAccount | null>(null);
  const [pandas, setPandas] = useState<PandaAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyAsset, setBusyAsset] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!program) return;
    setLoading(true);
    setError(null);
    try {
      const [c, owned] = await Promise.all([
        fetchConfig(connection),
        fetchPandasOwnedBy(connection, program.provider.publicKey!),
      ]);
      setConfig(c);
      setPandas(owned);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [connection, program]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function claim(panda: PandaAccount) {
    if (!program) return;
    setBusyAsset(panda.asset.toBase58());
    setError(null);
    try {
      const [config_] = configPda();
      const [vault] = vaultPda();
      await program.methods
        .claim()
        .accountsStrict({
          claimant: program.provider.publicKey!,
          config: config_,
          vault,
          panda: panda.address,
          asset: panda.asset,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAsset(null);
    }
  }

  async function burn(panda: PandaAccount) {
    if (!program || !config) return;
    if (!window.confirm("Burn this panda permanently for $PANDA? This cannot be undone.")) return;
    setBusyAsset(panda.asset.toBase58());
    setError(null);
    try {
      const [config_] = configPda();
      const [vault] = vaultPda();
      const pandaMint = new PublicKey(config.pandaMint);
      const collection = new PublicKey(config.collection);
      const rewardTokenAccount = associatedTokenAddress(program.provider.publicKey!, pandaMint);
      await program.methods
        .burn()
        .accountsStrict({
          owner: program.provider.publicKey!,
          config: config_,
          vault,
          panda: panda.address,
          asset: panda.asset,
          collection,
          pandaMint,
          rewardTokenAccount,
          mplCoreProgram: MPL_CORE_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAsset(null);
    }
  }

  if (!program) {
    return (
      <div className="panel panel-cyan p-4">
        <h2 className="text-sm font-bold tracking-wide text-[var(--cyan)] mb-2">YOUR PANDAS</h2>
        <p className="text-xs text-[var(--dim)]">connect a wallet to see your pandas</p>
      </div>
    );
  }

  return (
    <div className="panel panel-cyan p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold tracking-wide text-[var(--cyan)]">YOUR PANDAS</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={refresh}
            disabled={loading}
            className="label border border-[var(--border)] px-2 py-1 disabled:opacity-50"
          >
            {loading ? "loading…" : "refresh"}
          </button>
          {error && <span className="text-xs text-red-400">{error}</span>}
        </div>
      </div>

      {pandas.length === 0 && !loading && (
        <p className="text-xs text-[var(--dim)]">no pandas yet -- mine one above</p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
        {pandas.map((panda) => {
          const claimable = config ? claimableLamports(config, panda.mintEpoch, panda.claimedScaled) : 0n;
          const busy = busyAsset === panda.asset.toBase58();
          return (
            <div key={panda.address.toBase58()} className="bar-track overflow-hidden">
              <PandaCanvas seed={panda.seed} />
              <div className="p-2 space-y-1">
                <div className="label">#{panda.index.toString()}</div>
                {panda.burned ? (
                  <div className="text-xs text-red-400">burned</div>
                ) : (
                  <>
                    <div className="text-xs">claimable: {lamportsToSol(claimable)} SOL</div>
                    <div className="flex gap-1">
                      <button
                        onClick={() => claim(panda)}
                        disabled={busy || claimable === 0n}
                        className="flex-1 border border-[var(--cyan)] text-[var(--cyan)] text-xs py-1 disabled:opacity-40"
                      >
                        Claim
                      </button>
                      <button
                        onClick={() => burn(panda)}
                        disabled={busy}
                        className="flex-1 border border-[var(--border)] text-[var(--dim)] text-xs py-1 disabled:opacity-40"
                      >
                        Burn
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PandaCanvas({ seed }: { seed: Uint8Array }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (ctx) renderSeedToCanvas(ctx, seed);
  }, [seed]);
  return <canvas ref={ref} width={512} height={512} className="w-full aspect-square" />;
}
