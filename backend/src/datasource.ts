import { SourceUnavailableError, UnknownSymbolError, type Kline, type Quote } from "./domain.js";
import { fetchEastmoneyKline, fetchEastmoneyQuote } from "./eastmoney.js";
import { fetchTencentKline, fetchTencentQuote } from "./tencent.js";

/**
 * 数据源编排：东财为主、腾讯为备的自动降级。
 *
 * 降级动机：东财 push2 有 IP 级反爬，密集请求后整段断连（实测 Empty reply），
 * 单源会让页面直接不可用。两源行情数据实测一致，可安全互为备份。
 *
 * 策略：先试东财（字段最全：含成交额/振幅/换手率），失败再试腾讯；
 * 两者都失败时抛出腾讯的错误（通常更接近真实原因），由路由映射为 SOURCE_UNAVAILABLE。
 */

/** 记录降级事件，便于排查（不输出敏感信息）。 */
export type DegradeLogger = (info: { from: string; to: string; reason: string }) => void;

let onDegrade: DegradeLogger | undefined;

export function setDegradeLogger(logger: DegradeLogger | undefined): void {
  onDegrade = logger;
}

function reportDegrade(from: string, to: string, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  onDegrade?.({ from, to, reason });
}

/** 这个错误是"源不可用"（该等）还是"这条数据不存在"（该查输入）？ */
function isSourceProblem(err: unknown): boolean {
  if (err instanceof SourceUnavailableError) return true;
  // undici 在网络失败时抛 TypeError；超时抛 AbortError/TimeoutError
  if (err instanceof TypeError) return true;
  const name = err instanceof Error ? err.name : "";
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * 两个源都失败之后如何归类。
 *
 * **判据以腾讯的行情端点为准**——这是实测得出的，不是设计偏好：
 *
 * | 输入 | 东财行情 | 腾讯行情 |
 * |---|---|---|
 * | `600519`（有效） | 正常返回 | 正常返回 |
 * | `999999`（不存在） | **TypeError「fetch failed」** | 普通错误「响应字段不足」 |
 *
 * 东财对不存在的 secid **直接断连**，undici 报的是网络层 TypeError——
 * 与真正的网络故障在类型上**无法区分**。所以"两源都说是无数据才判定不存在"
 * 这种投票式判据在这里必然失效（我第一次就是这么写的，实测后推翻）。
 *
 * 腾讯的行情端点则能区分：有效代码正常返回，不存在的代码抛字段形态错误。
 * 因此：**腾讯报字段形态错误 → 代码不存在**；腾讯报源问题 → 源不可用。
 *
 * 代价说明：若某个有效代码在腾讯侧偶发坏响应、而同刻东财也正好挂了，
 * 会被判成"代码不存在"。消息里带原始代码，用户核一下就能发现。
 */
function classifyDoubleFailure(input: string, eastErr: unknown, tencentErr: unknown): Error {
  if (!isSourceProblem(tencentErr)) {
    const detail = tencentErr instanceof Error ? tencentErr.message : String(tencentErr);
    return new UnknownSymbolError(input, detail);
  }
  return tencentErr instanceof Error ? tencentErr : new SourceUnavailableError(String(tencentErr));
}

export async function fetchQuote(input: string): Promise<Quote> {
  try {
    return await fetchEastmoneyQuote(input);
  } catch (eastErr) {
    // 代码格式就无法解析时不必降级（腾讯会得到同样的结论）
    if (eastErr instanceof UnknownSymbolError && eastErr.message.includes("格式无法解析")) throw eastErr;
    reportDegrade("eastmoney", "tencent", eastErr);
    try {
      return await fetchTencentQuote(input);
    } catch (tencentErr) {
      throw classifyDoubleFailure(input, eastErr, tencentErr);
    }
  }
}

export async function fetchKline(input: string, limit = 60): Promise<Kline[]> {
  try {
    return await fetchEastmoneyKline(input, limit);
  } catch (eastErr) {
    if (eastErr instanceof UnknownSymbolError && eastErr.message.includes("格式无法解析")) throw eastErr;
    reportDegrade("eastmoney", "tencent", eastErr);
    try {
      return await fetchTencentKline(input, limit);
    } catch (tencentErr) {
      throw classifyDoubleFailure(input, eastErr, tencentErr);
    }
  }
}
