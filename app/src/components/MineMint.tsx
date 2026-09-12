"use client";

import { useEffect, useRef, useState } from "react";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { useConnection } from "@solana/wallet-adapter-react";
import { useHashpandasProgram } from "@/lib/useProgram";
import { fetchConfig, type ConfigAccount } from "@/lib/config";
import { fetchRecentAnchor } from "@/lib/slotHashes";
import { mineInBrowser, mineOnGpu, isWebGpuAvailable, type Attempt } from "@/lib/mining";
import { leadingZeroBits } from "@/lib/keccak";
import { renderSeedToCanvas } from "@/lib/render";
import { MPL_CORE_PROGRAM_ID } from "@/lib/constants";
import { configPda, pandaPda, treasuryPda, vaultPda } from "@/lib/pda";

type Phase = "idle" | "preparing" | "mining" | "submitting" | "done" | "error";
type Machine = "cpu" | "gpu";

const STATUS_STYLE: Record<Phase, string> = {
  idle: "text-[var(--dim)] border-[var(--border)]",
  preparing: "text-[var(--cyan)] border-[#17505c]",
  mining: "text-[var(--green)] border-[var(--green-dim)] animate-pulse",
  submitting: "text-[var(--cyan)] border-[#17505c]",
  done: "text-[var(--green)] border-[var(--green-dim)]",
  error: "text-red-400 border-red-900",
};

const MAX_ATTEMPTS_SHOWN = 8;

export default function MineMint() {
  const { connection } = useConnection();
  const program = useHashpandasProgram();
  const [phase, setPhase] = useState<Phase>("idle");
  const [machine, setMachine] = useState<Machine>("cpu");
  const [gpuAvailable, setGpuAvailable] = useState<boolean | null>(null);
  const [hashesTried, setHashesTried] = useState(0n);
  const [hashRate, setHashRate] = useState(0);
  const [dropped, setDropped] = useState(0);
  const [message, setMessage] = useState<string>("");
  const [config, setConfig] = useState<ConfigAccount | null>(null);
  const [foundHash, setFoundHash] = useState<Uint8Array | null>(null);
  const [foundBits, setFoundBits] = useState(0);
  const [mintedAsset, setMintedAsset] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const rateRef = useRef<{ t: number; n: bigint } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    fetchConfig(connection).then(setConfig).catch(() => {});
  }, [connection]);

  useEffect(() => {
    setGpuAvailable(isWebGpuAvailable());
  }, []);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx && foundHash) renderSeedToCanvas(ctx, foundHash);
  }, [foundHash]);

  const targetBits = config ? config.baseDifficulty + config.streak : null;

  async function start() {
    if (!program) return;
    setPhase("preparing");
    setMessage("reading program state…");
    setMintedAsset(null);
    setFoundHash(null);
    setHashesTried(0n);
    setHashRate(0);
    setDropped(0);
    setAttempts([]);
    rateRef.current = null;

    try {
      const cfg = await fetchConfig(connection);
      if (!cfg) throw new Error("program is not initialized yet");
      setConfig(cfg);

      const anchor = await fetchRecentAnchor(connection);
      const bits = cfg.baseDifficulty + cfg.streak;
      const miningTarget = {
        miner: program.provider.publicKey!.toBytes(),
        lastWinningHash: cfg.lastWinningHash,
        anchorHash: anchor.hash,
        targetBits: bits,
      };

      setPhase("mining");
      setMessage(`searching for >= ${bits} leading zero bits on ${machine.toUpperCase()}…`);
      const controller = new AbortController();
      abortRef.current = controller;

      const onProgress = (n: bigint) => {
        setHashesTried(n);
        const now = performance.now();
        if (rateRef.current) {
          const dt = (now - rateRef.current.t) / 1000;
          const dn = n - rateRef.current.n;
          if (dt > 0) setHashRate(Number(dn) / dt);
        }
        rateRef.current = { t: now, n };
      };
      const onAttempt = (a: Attempt) => {
        setAttempts((prev) => [a, ...prev].slice(0, MAX_ATTEMPTS_SHOWN));
      };

      const { nonce, hash } =
        machine === "gpu"
          ? await mineOnGpu(miningTarget, {
              signal: controller.signal,
              onProgress,
              onAttempt,
              onDroppedCandidate: () => setDropped((d) => d + 1),
            })
          : await mineInBrowser(miningTarget, {
              signal: controller.signal,
              onProgress,
              onAttempt,
            });

      setFoundHash(hash);
      setFoundBits(leadingZeroBits(hash));

      setPhase("submitting");
      setMessage(`found nonce ${nonce}. submitting mint tx…`);

      const asset = Keypair.generate();
      const [config_] = configPda();
      const [vault] = vaultPda();
      const [treasury] = treasuryPda();
      const [panda] = pandaPda(asset.publicKey);

      const sig = await program.methods
        .mint({
          nonce: new BN(nonce.toString()),
          anchorSlot: new BN(anchor.slot.toString()),
          anchorHash: Array.from(anchor.hash),
          uri: "https://hashpandas.example/metadata/pending.json",
        })
        .accountsStrict({
          miner: program.provider.publicKey!,
          config: config_,
          vault,
          treasury,
          collection: cfg.collection,
          asset: asset.publicKey,
          panda,
          mplCoreProgram: MPL_CORE_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([asset])
        .rpc();

      setPhase("done");
      setMintedAsset(asset.publicKey.toBase58());
      setMessage(`minted. tx ${sig.slice(0, 12)}…`);
    } catch (err) {
      setPhase("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  function cancel() {
    abortRef.current?.abort();
    setPhase("idle");
    setMessage("cancelled");
  }

  const running = phase === "mining" || phase === "submitting" || phase === "preparing";
  const barPct = targetBits ? Math.min(100, (foundBits / targetBits) * 100) : 0;

  return (
    <div className="panel panel-green p-4 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-bold tracking-wide text-[var(--green)]">MINER</h2>
        <span className={`label border px-2 py-0.5 ${STATUS_STYLE[phase]}`}>
          {phase === "idle" ? "IDLE" : phase.toUpperCase()}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-6">
        <div className="bar-track aspect-square flex items-center justify-center overflow-hidden">
          {foundHash ? (
            <canvas ref={canvasRef} width={512} height={512} className="w-full h-full" />
          ) : (
            <span className="text-4xl opacity-30">🐼</span>
          )}
        </div>

        <div className="space-y-4">
          <div>
            <div className="label mb-1">last hash found</div>
            <div className="text-xs break-all text-[var(--dim)] min-h-[1.5em]">
              {foundHash ? hex(foundHash) : "—"}
            </div>
            <div className="label flex justify-between mt-2 mb-1">
              <span>bit strength</span>
              <span>
                {foundBits}/{targetBits ?? "—"} BITS
              </span>
            </div>
            <div className="bar-track h-2 w-full">
              <div className="bar-fill-green h-full" style={{ width: `${barPct}%` }} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 text-sm">
            <Stat label="Speed" value={`${formatRate(hashRate)} H/s`} />
            <Stat label="Tried" value={hashesTried.toString()} />
            <Stat label="Target" value={targetBits ? `${targetBits} bits` : "—"} />
          </div>

          <div>
            <div className="label mb-1">machine</div>
            <div className="flex gap-2">
              <MachineButton
                label="CPU"
                active={machine === "cpu"}
                disabled={running}
                onClick={() => setMachine("cpu")}
              />
              <MachineButton
                label="GPU"
                active={machine === "gpu"}
                disabled={running || gpuAvailable === false}
                onClick={() => setMachine("gpu")}
                hint={
                  gpuAvailable === false
                    ? "WebGPU not available in this browser"
                    : "faster: thousands of hashes in parallel"
                }
              />
            </div>
            {dropped > 0 && (
              <p className="text-xs text-[var(--dim)] mt-1">
                {dropped} GPU candidate{dropped === 1 ? "" : "s"} failed CPU re-check and were dropped
              </p>
            )}
          </div>

          <div className="flex gap-2 items-center pt-2">
            {!program ? (
              <span className="text-xs text-[var(--dim)]">connect a wallet to mine</span>
            ) : (
              <>
                <button
                  onClick={start}
                  disabled={running}
                  className="btn-primary px-5 py-2 text-xs rounded-sm disabled:cursor-not-allowed"
                >
                  {phase === "idle" || phase === "done" || phase === "error"
                    ? "Mine a panda"
                    : "Mining…"}
                </button>
                {phase === "mining" && (
                  <button
                    onClick={cancel}
                    className="px-4 py-2 text-xs border border-[var(--border)] rounded-sm"
                  >
                    Cancel
                  </button>
                )}
              </>
            )}
          </div>

          {message && (
            <p className={`text-xs break-all ${phase === "error" ? "text-red-400" : "text-[var(--dim)]"}`}>
              {message}
            </p>
          )}
          {mintedAsset && (
            <p className="text-xs text-[var(--dim)]">asset: {mintedAsset}</p>
          )}
        </div>
      </div>

      {attempts.length > 0 && (
        <div className="mt-4 pt-4 hr-dashed">
          <div className="label mb-2">recent attempts</div>
          <div className="space-y-1 font-mono text-xs">
            {attempts.map((a) => (
              <div key={a.nonce.toString()} className="flex gap-3 text-[var(--dim)]">
                <span className="w-16 shrink-0">#{a.nonce.toString()}</span>
                <span className="flex-1 truncate">{hex(a.hash)}</span>
                <span className="w-16 shrink-0 text-right text-[var(--fg)]">{a.bits}b</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MachineButton({
  label,
  active,
  disabled,
  onClick,
  hint,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  hint?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={hint}
      className={`label px-3 py-1.5 border rounded-sm disabled:opacity-30 disabled:cursor-not-allowed ${
        active
          ? "border-[var(--green)] text-[var(--green)] bg-[var(--border)]"
          : "border-[var(--border)] text-[var(--dim)]"
      }`}
    >
      {label}
    </button>
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

function hex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function formatRate(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toFixed(0);
}
