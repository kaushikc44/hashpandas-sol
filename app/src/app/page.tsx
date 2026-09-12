import NavBar from "@/components/NavBar";
import Dashboard from "@/components/Dashboard";
import MineMint from "@/components/MineMint";
import LatestMints from "@/components/LatestMints";
import PandaGallery from "@/components/PandaGallery";
import DonateBar from "@/components/DonateBar";

export default function Home() {
  return (
    <div className="flex-1 flex flex-col">
      <NavBar />
      <main className="mx-auto max-w-5xl w-full px-4 sm:px-6 py-8 space-y-6">
        <div>
          <h1 className="text-xl font-bold">Pandas are not sold.</h1>
          <p className="text-sm text-[var(--dim)] mt-1 max-w-2xl">
            The only way one comes into existence is a keccak256 hash below the current target,
            paid for at the current epoch&apos;s entry price. Everyone who mines earlier pandas
            earns rent from every mint after them.
          </p>
        </div>

        <MineMint />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Dashboard />
          <PandaGallery />
        </div>

        <LatestMints />

        <DonateBar />
      </main>

      <footer className="hr-dashed mt-auto px-4 sm:px-6 py-6 text-xs text-[var(--dim)] flex flex-wrap gap-6 justify-between">
        <span>hashpandas-sol -- devnet</span>
        <span>proof-of-work NFTs on Solana</span>
        <span>not audited, not mainnet</span>
      </footer>
    </div>
  );
}
