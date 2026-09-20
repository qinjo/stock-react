import type { Kline, Quote } from "./domain.js";
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

export async function fetchQuote(input: string): Promise<Quote> {
  try {
    return await fetchEastmoneyQuote(input);
  } catch (err) {
    // 输入非法不该降级重试（腾讯会得到同样的结论）
    if (err instanceof Error && err.message.startsWith("无法识别")) throw err;
    reportDegrade("eastmoney", "tencent", err);
    return fetchTencentQuote(input);
  }
}

export async function fetchKline(input: string, limit = 60): Promise<Kline[]> {
  try {
    return await fetchEastmoneyKline(input, limit);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("无法识别")) throw err;
    reportDegrade("eastmoney", "tencent", err);
    return fetchTencentKline(input, limit);
  }
}
