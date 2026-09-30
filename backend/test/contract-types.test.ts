import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 前后端响应契约守卫。
 *
 * `frontend/src/types.ts` 是后端类型的**手工镜像**——手工镜像就会漂移，
 * 而漂移的后果是静默的：界面读一个后端不保证存在的字段，
 * 或者某个取值被类型系统判定为"不可能出现"。
 *
 * 这个漂移已经真实发生过一次：事件模式的五个信号 id 漏在前端 `SignalId` 之外，
 * 而接口在事件模式下返回的正是它们。所以这里**直接从后端的源文件读出取值逐个比对**，
 * 而不是靠"记得同时改两处"。
 *
 * 放在后端测试里而不是前端：前端 tsconfig 不含 Node 类型（读文件会报错），
 * 而且由"源头"来守卫"镜像"更顺。
 */

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** 取出 `export type X = "a" | "b";` 里的字符串字面量。 */
function unionValues(source: string, typeName: string): string[] {
  const m = source.match(new RegExp(`export type ${typeName} =([^;]+);`));
  if (!m) throw new Error(`未找到类型 ${typeName}`);
  return (m[1]!.match(/"([^"]+)"/g) ?? []).map((s) => s.replace(/"/g, "")).sort();
}

/** 取出 `export type X = { ... }` 的字段名。 */
function fieldNames(source: string, typeName: string): string[] {
  const m = source.match(new RegExp(`export type ${typeName} = \\{([\\s\\S]*?)\\n\\};`));
  if (!m) throw new Error(`未找到类型 ${typeName}`);
  return (m[1]!.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:/gm) ?? [])
    .map((s) => s.replace(/[?:]/g, "").trim())
    .sort();
}

const BACKEND_TYPES = read("backend/src/screener/types.ts");
const BACKEND_RESPONSE = read("backend/src/screener/response.ts");
const BACKEND_GATE = read("backend/src/screener/market-gate.ts");
const MIRROR = read("frontend/src/types.ts");

describe("前后端类型契约（前端是手工镜像，这里守卫它不漂移）", () => {
  it("SignalId：前端覆盖后端全部取值", () => {
    expect(unionValues(MIRROR, "SignalId")).toEqual(unionValues(BACKEND_TYPES, "SignalId"));
    // 明确点出事件模式那五个：漏掉它们时这条会直接说出缺的是谁
    for (const id of ["S6", "S7", "S9", "S10", "S12"]) {
      expect(unionValues(MIRROR, "SignalId"), `缺少事件模式信号 ${id}`).toContain(id);
    }
  });

  it("StopBasis / MarketGateState：取值一致", () => {
    expect(unionValues(MIRROR, "StopBasis")).toEqual(unionValues(BACKEND_TYPES, "StopBasis"));
    expect(unionValues(MIRROR, "MarketGateState")).toEqual(unionValues(BACKEND_GATE, "MarketGateState"));
  });

  it("界面展示用到的类型，字段集与后端一致", () => {
    // 前端把 FunnelCounts 命名为 ScreenFunnel，对照关系写在这里
    const pairs: Array<[string, string, string]> = [
      ["ScreenMetrics", BACKEND_TYPES, "ScreenMetrics"],
      ["ExitPlan", BACKEND_TYPES, "ExitPlan"],
      ["SignalHit", BACKEND_TYPES, "SignalHit"],
      ["SignalSet", BACKEND_TYPES, "SignalSet"],
      ["ReferenceResistance", BACKEND_TYPES, "ReferenceResistance"],
      ["ScreenCandidate", BACKEND_RESPONSE, "ScreenCandidate"],
      ["ScreenRuleHit", BACKEND_RESPONSE, "ScreenRuleHit"],
      ["FunnelCounts", BACKEND_TYPES, "ScreenFunnel"],
      ["MarketGate", BACKEND_GATE, "MarketGate"],
    ];
    for (const [backendName, backendSource, frontendName] of pairs) {
      expect(fieldNames(MIRROR, frontendName), `${frontendName} 字段漂移`).toEqual(
        fieldNames(backendSource, backendName),
      );
    }
  });
});
