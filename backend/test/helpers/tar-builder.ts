/**
 * 测试用的 tar / Qlib 归档构造器。
 *
 * 有了它，整条 bootstrap 流水线可以用**合成的极小归档**端到端测试，
 * 不必下载 541 MB 的真实数据集，测试也不触网。
 */

export const END_BLOCKS = Buffer.alloc(1024);

/** 构造一个 ustar 头（默认普通文件）。 */
export function tarHeader(name: string, size: number, type = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
  header.write(type, 156, 1, "utf8");
  return header;
}

export function tarEntry(name: string, data: Buffer | string, type = "0"): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([tarHeader(name, body.length, type), padded]);
}

export function tarArchive(
  entries: Array<[string, Buffer | string]>,
  opts: { endBlocks?: boolean } = {},
): Buffer {
  const parts = entries.map(([name, data]) => tarEntry(name, data));
  if (opts.endBlocks !== false) parts.push(END_BLOCKS);
  return Buffer.concat(parts);
}

/** 把缓冲区切成任意大小的分块，模拟流式输入（**刻意不**对齐 512 字节）。 */
export async function* chunked(buf: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

/** 构造一个 Qlib 特征文件：元素 0 是日历起始索引，其余是数值，没有数量字段。 */
export function featureBin(startIndex: number, values: number[]): Buffer {
  const floats = [startIndex, ...values];
  const buf = Buffer.alloc(floats.length * 4);
  floats.forEach((value, i) => buf.writeFloatLE(value, i * 4));
  return buf;
}
