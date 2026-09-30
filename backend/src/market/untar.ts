/**
 * 极简 tar（ustar）流式读取器。
 *
 * 为什么自己解而不是调用 `tar` 命令：这份 dump 解压后是 6.1 万个文件、约 824 MB，
 * 而我们本来就要把每个成员读进数据库——流式边解边读既不落盘、也不多做一次 I/O。
 * 附带好处是整条链路可以用合成的极小 fixture 测试（见 `test/untar.test.ts`），
 * 不必依赖真实归档。
 *
 * 只处理普通文件；目录、软链等类型直接跳过（归档里本来也只有普通文件）。
 */

const BLOCK = 512;

/** 一个 tar 成员。`data` 是视图，调用方需在下一轮迭代前用完。 */
export type TarEntry = { name: string; data: Buffer };

/** 定长字段：到 NUL 或字段边界结束。 */
function readString(buf: Buffer, offset: number, length: number): string {
  const nul = buf.indexOf(0, offset);
  const stop = nul === -1 || nul > offset + length ? offset + length : nul;
  return buf.toString("utf8", offset, stop);
}

/**
 * tar 的数字字段是八进制 ASCII（允许前导空格与结尾 NUL）。
 * GNU tar 对超大成员会改写 base-256，这里不需要支持——归档里最大的成员也只有几 MB。
 */
function readOctal(buf: Buffer, offset: number, length: number): number {
  const text = readString(buf, offset, length).trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

function isZeroBlock(buf: Buffer): boolean {
  for (let i = 0; i < BLOCK; i++) if (buf[i] !== 0) return false;
  return true;
}

function roundUpToBlock(size: number): number {
  return Math.ceil(size / BLOCK) * BLOCK;
}

/**
 * 依次读出字节流里的 tar 成员。
 *
 * 输入是任意分块的字节流（真实链路里是 gunzip 的输出），因此**不假设**
 * chunk 与 512 字节块边界对齐；缓冲区不足时继续向源要数据。
 */
export async function* readTar(source: AsyncIterable<Buffer>): AsyncGenerator<TarEntry> {
  const iterator = source[Symbol.asyncIterator]();
  let pending: Buffer = Buffer.alloc(0);
  /** GNU 长文件名：type 'L' 的成员内容是紧随其后那个成员的真实名字。 */
  let longName: string | null = null;

  async function fill(target: number): Promise<boolean> {
    while (pending.length < target) {
      const next = await iterator.next();
      if (next.done) return false;
      pending = pending.length === 0 ? next.value : Buffer.concat([pending, next.value]);
    }
    return true;
  }

  for (;;) {
    if (!(await fill(BLOCK))) return; // 正常结尾：数据耗尽
    if (isZeroBlock(pending)) return; // 正常结尾：结束块

    const name = readString(pending, 0, 100);
    const prefix = readString(pending, 345, 155);
    const size = readOctal(pending, 124, 12);
    const type = String.fromCharCode(pending[156] ?? 0);
    const body = BLOCK + roundUpToBlock(size);

    if (!(await fill(body))) {
      throw new Error(`tar 成员被截断：${name}`);
    }
    const data = pending.subarray(BLOCK, BLOCK + size);
    pending = pending.subarray(body);

    if (type === "L") {
      longName = data.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (type !== "0" && type !== "\0" && type !== "") continue;

    const raw = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    yield { name: raw.replace(/^\.\//, ""), data };
  }
}

/** 把顶层目录前缀去掉（归档里的成员是 `qlib_bin/...`）。 */
export function stripTopLevelDir(name: string): string | null {
  const slash = name.indexOf("/");
  if (slash === -1) return null;
  return name.slice(slash + 1);
}
