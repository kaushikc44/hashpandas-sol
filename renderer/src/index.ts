import { PassThrough } from "node:stream";
import * as pureimage from "pureimage";
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchPanda, derivePandaAddress } from "./chain.ts";
import { renderSeed } from "./render.ts";

/** Renders a bitmap to PNG bytes, buffered fully in memory -- these images
 * are small (512x512) so streaming to disk isn't necessary here. */
export async function toPngBytes(img: Awaited<ReturnType<typeof renderSeed>>): Promise<Buffer> {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  await pureimage.encodePNGToStream(img, stream);
  return Buffer.concat(chunks);
}

/** Fetches a panda by its Core asset address and renders it to PNG bytes.
 * This is the "reproducible by anyone" path: given only an RPC endpoint,
 * the program id, and the asset address, two independent callers get
 * byte-identical PNGs. */
export async function renderPandaByAsset(
  connection: Connection,
  programId: PublicKey,
  asset: PublicKey,
): Promise<Buffer> {
  const pandaAddress = derivePandaAddress(programId, asset);
  const panda = await fetchPanda(connection, pandaAddress);
  const img = renderSeed(panda.seed);
  return toPngBytes(img);
}

export { renderSeed, renderTraits } from "./render.ts";
export { deriveTraits, type PandaTraits } from "./traits.ts";
export { fetchPanda, decodePanda, derivePandaAddress, type PandaAccount } from "./chain.ts";
