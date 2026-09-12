/// <reference types="@webgpu/types" />
/**
 * Browser port of miner/gpu_miner.ts. Dispatches a batch of nonces to
 * /keccak.wgsl and reads back one "depth" (leading-zero-bit count) per
 * nonce -- never a hash. See mining.ts for why that distinction matters:
 * every GPU-reported candidate gets re-hashed on the CPU before it's
 * trusted, so a bug here can waste search time but can never produce an
 * invalid mint.
 *
 * Not exercised end-to-end in this project's own test/dev environment --
 * there was no WebGPU-capable browser available to run it against here.
 * The permutation tables are identical to (generated from) the
 * independently-tested keccak.ts, so the hashing math is verified even
 * though this dispatch plumbing itself isn't.
 */

export interface MinerBatchParams {
  miner: Uint8Array;
  lastWinningHash: Uint8Array;
  anchorHash: Uint8Array;
  baseNonce: bigint;
  batchSize: number;
}

export interface MinerBatchResult {
  depths: Uint32Array;
}

function bytesToU32Words(bytes: Uint8Array): Uint32Array {
  if (bytes.length !== 32) throw new Error("expected exactly 32 bytes");
  const out = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] =
      bytes[i * 4] |
      (bytes[i * 4 + 1] << 8) |
      (bytes[i * 4 + 2] << 16) |
      (bytes[i * 4 + 3] << 24);
  }
  return out;
}

const WORKGROUP_SIZE = 64;

export function isWebGpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

export interface GpuAdapterInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}

/** Which physical GPU WebGPU actually picked -- the on-page proof that
 * "GPU" mode isn't secretly falling back to something else. Safe to call
 * before starting a mining session. */
export async function getGpuAdapterInfo(): Promise<GpuAdapterInfo | null> {
  if (!isWebGpuAvailable()) return null;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  // `adapter.info` is the current spec; `requestAdapterInfo()` is the
  // older API some browsers still only expose.
  const info =
    "info" in adapter
      ? (adapter as GPUAdapter & { info: GPUAdapterInfo }).info
      : await (adapter as unknown as { requestAdapterInfo(): Promise<GpuAdapterInfo> }).requestAdapterInfo();
  return {
    vendor: info.vendor || "unknown",
    architecture: info.architecture || "unknown",
    device: info.device || "unknown",
    description: info.description || "",
  };
}

export class GpuMiner {
  private readonly device: GPUDevice;
  private readonly pipeline: GPUComputePipeline;
  readonly adapterInfo: GpuAdapterInfo | null;

  private constructor(device: GPUDevice, pipeline: GPUComputePipeline, adapterInfo: GpuAdapterInfo | null) {
    this.device = device;
    this.pipeline = pipeline;
    this.adapterInfo = adapterInfo;
  }

  static async create(): Promise<GpuMiner> {
    if (!isWebGpuAvailable()) {
      throw new Error("WebGPU is not available in this browser");
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("no WebGPU adapter available");
    const device = await adapter.requestDevice();
    const adapterInfo = await getGpuAdapterInfo();

    const wgslSource = await fetch("/keccak.wgsl").then((r) => r.text());
    const module = device.createShaderModule({ code: wgslSource });
    const pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    return new GpuMiner(device, pipeline, adapterInfo);
  }

  async runBatch(params: MinerBatchParams): Promise<MinerBatchResult> {
    const { device, pipeline } = this;

    const paramsData = new Uint32Array(8 + 8 + 8 + 2);
    paramsData.set(bytesToU32Words(params.miner), 0);
    paramsData.set(bytesToU32Words(params.lastWinningHash), 8);
    paramsData.set(bytesToU32Words(params.anchorHash), 16);
    paramsData[24] = Number(params.baseNonce & 0xffffffffn);
    paramsData[25] = Number((params.baseNonce >> 32n) & 0xffffffffn);

    const paramsBuffer = device.createBuffer({
      size: paramsData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(paramsBuffer, 0, paramsData);

    const depthsByteLength = params.batchSize * 4;
    const depthsBuffer = device.createBuffer({
      size: depthsByteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readBuffer = device.createBuffer({
      size: depthsByteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramsBuffer } },
        { binding: 1, resource: { buffer: depthsBuffer } },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(params.batchSize / WORKGROUP_SIZE));
    pass.end();
    encoder.copyBufferToBuffer(depthsBuffer, 0, readBuffer, 0, depthsByteLength);
    device.queue.submit([encoder.finish()]);

    await readBuffer.mapAsync(GPUMapMode.READ);
    const depths = new Uint32Array(readBuffer.getMappedRange().slice(0));
    readBuffer.unmap();

    paramsBuffer.destroy();
    depthsBuffer.destroy();
    readBuffer.destroy();

    return { depths };
  }
}
