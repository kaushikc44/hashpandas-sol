/**
 * WebGPU compute driver. Dispatches a batch of nonces to `keccak.wgsl` and
 * reads back one "depth" (leading-zero-bit count) per nonce -- never a
 * hash. See cpu_keccak.ts and index.ts for why that distinction matters.
 *
 * This module has not been run against a real GPU in this environment (no
 * WebGPU device is available in this sandbox); it is written to the
 * WebGPU/WGSL spec as carefully as the CPU implementation, but treat it as
 * unverified until it's been run once against a real adapter. That's an
 * acceptable risk only because of the CPU re-check in index.ts: a bug here
 * can waste search time or miss solutions, but per the design it can never
 * cause an invalid hash to reach a transaction.
 */

export interface MinerBatchParams {
  miner: Uint8Array; // 32 bytes
  lastWinningHash: Uint8Array; // 32 bytes
  anchorHash: Uint8Array; // 32 bytes
  baseNonce: bigint; // u64: nonces tried are [baseNonce, baseNonce + batchSize)
  batchSize: number;
}

export interface MinerBatchResult {
  /** depths[i] is the leading-zero-bit count for nonce `baseNonce + i`. */
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

export class GpuMiner {
  private readonly device: GPUDevice;
  private readonly pipeline: GPUComputePipeline;

  private constructor(device: GPUDevice, pipeline: GPUComputePipeline) {
    this.device = device;
    this.pipeline = pipeline;
  }

  static async create(wgslSource: string): Promise<GpuMiner> {
    const gpu = (globalThis as { navigator?: { gpu?: GPU } }).navigator?.gpu;
    if (!gpu) {
      throw new Error(
        "WebGPU is not available in this environment; fall back to a CPU-only search loop",
      );
    }
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error("no WebGPU adapter available");
    const device = await adapter.requestDevice();
    const module = device.createShaderModule({ code: wgslSource });
    const pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    return new GpuMiner(device, pipeline);
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
