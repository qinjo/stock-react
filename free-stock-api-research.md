# 免费股票行情 / 历史数据 HTTP 接口调研笔记

> 用途：为「浏览器前端输入股票代码 → 拉取数据 → 送 LLM 分析」小型项目做选型。
> 调研方式：web_search 服务在本次会话不可用，全部 CORS / 返回格式结论改为 **curl 实测**（2026-08-30），额度类结论来自官方文档知识并标注存疑处。所有「实测」标注均为主机真实网络请求结果，比二手资料更可靠。
> 无特殊标注的 CORS 结论 = 实测；额度 = 文档知识（以官网当前页面为准）。

---

## 0. 一页总览

| 数据源 | 需要 key | 免费额度 | 浏览器直连 CORS | 数据广度 | 备注 |
|---|---|---|---|---|---|
| 东方财富 push2 / push2his | 否 | 无明示限额，有 IP 级限流 | ✅ 可用（ACAO 回显 Origin） | 实时 + 日/周/月/分钟 K 线 + 换手率/PE/PB/市值/量比/行业 | **A 股首选**，免 key 一站式 |
| 腾讯财经 qt.gtimg.cn / web.ifzq.gtimg.cn | 否 | 无明示限额 | ✅ 可用（ACAO: `*`） | 实时 + 日/周/月/分钟 K 线 + 换手/PE/市值/量比/五档 | A 股次选；实时接口为 **GBK** 编码有解码坑 |
| 新浪财经 hq.sinajs.cn / quotes.sina.cn | 否 | 无明示限额 | ❌ 拦截（无 ACAO + Referer 校验，非 sina 来源一律 403） | 实时 + 日 K（JSONP） | 浏览器直连不可行，需代理 |
| 网易财经 money.126.net | 否 | — | ❌ 接口已下线（502） | — | 2023 年股票频道关闭，**已死** |
| Yahoo Finance chart API | 否 | 无 key；有隐性限速（高频 429） | ❌ 拦截（响应无 ACAO 头） | 日/周/月/分钟 OHLCV + 复权 + 分红拆股；**meta 无 PE/市值** | 免费美股历史最佳来源，浏览器需代理转发 |
| Yahoo v7 quote / v10 quoteSummary | 否（需 crumb+cookie） | 同上 | ❌（无 ACAO）且 **401**（缺 crumb） | 有 PE/市值等基本面 | 必须后端带 cookie 代理（yfinance 原理） |
| yfinance（Python 库） | 否 | 同 Yahoo | 不适用（非 HTTP 直连） | 同上 | 只是 Yahoo 接口的 Python 封装，**浏览器不可用** |
| Alpha Vantage | 是（免费注册，<20 秒） | ⚠️ 2024-2025 调整为 **约 25 次/天**、突发约 5 次/分 | ✅ 可用（ACAO: `*`） | 日线 OHLCV + `OVERVIEW`（PE/市值/EPS 等） | 经典方案；额度紧，只适合低频演示 |
| Finnhub | 是（免费注册） | 60 次/分 | ✅ 可用（ACAO: `*`） | 实时 + 日 K + companyProfile2（市值）+ basicFinancials | 实时报价免费层好使 |
| Twelve Data | 是（免费注册） | 800 credits/天、8 credits/分 | ✅ 可用（ACAO: `*`） | 实时 + 历史 + `quote`（PE/市值） | **额度最宽**的免费 key 源 |
| Polygon.io | 是（免费注册） | 旧免费 Basic 层 5 次/分；2025 起套餐调整、新账户免费层收窄 | ✅ 可用（ACAO 回显 Origin） | 日 K + 部分参考数据（基本面免费层多收窄） | 以官网当前定价为准 |

---

## 1. 中国 A 股免费数据源

### 1.1 东方财富（推荐）—— push2 / push2his.eastmoney.com

免 key，返回 **JSON（UTF-8）**，**浏览器 CORS 实测可用**：响应头 `Access-Control-Allow-Origin: <回显你的 Origin>` + `Access-Control-Allow-Credentials: true`。所有请求是 GET + query 的「简单请求」，浏览器不会触发预检，`fetch` 直接可读。

代码规则 `secid`：沪市 `1.<code>`、深市 `0.<code>`（含创业板/北交所部分 0.8 前缀）、指数如 `1.000001`。

#### a) 实时快照（单票）—— `push2.eastmoney.com/api/qt/stock/get`

```
https://push2.eastmoney.com/api/qt/stock/get?secid=1.600519&fields=f43,f44,f45,f46,f47,f48,f49,f50,f51,f52,f57,f58,f60,f116,f117,f162,f167,f168,f170
```

实测返回（节选）：

```json
{"rc":0,"data":{"f43":129740,"f44":129789,"f45":128800,"f46":128900,"f47":16126,"f48":2086008422.0,
"f51":142153,"f52":116307,"f57":"600519","f58":"贵州茅台","f60":129230,
"f116":1621855869137.4,"f117":1621855869137.4,"f162":1822,"f167":646,"f168":13,"f170":39}}
```

常用字段（**注意缩放**：不带 `fltt=2` 时价格是 ×100 的整数，如 f43=129740 → 1297.40；加 `&fltt=2&invt=2` 即返回小数）：

| 字段 | 含义 | 单位/说明 |
|---|---|---|
| f43 | 最新价 | ×100 整数（默认） |
| f44 / f45 / f46 | 最高 / 最低 / 今开 | ×100 |
| f47 / f48 | 成交量 / 成交额 | 手 / 元 |
| f51 / f52 | 涨停价 / 跌停价 | ×100 |
| f57 / f58 | 代码 / 名称 | string |
| f60 | 昨收 | ×100 |
| f116 / f117 | 总市值 / 流通市值 | 元 |
| f162 | 市盈率（动） | 数字 |
| f167 | 市净率 PB | 数字 |
| f168 | 换手率 | % |
| f170 | 涨跌幅 | % |
| f49 | 外盘 / f50 内盘 | 手 |

#### b) 历史 K 线（日/周/月/分钟）—— `push2his.eastmoney.com/api/qt/stock/kline/get`

```
https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600519&klt=101&fqt=1
  &fields1=f1,f2,f3,f4,f5,f6
  &fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61
  &beg=20240101&end=20500101&lmt=500
```

- `klt`：101=日线、102=周线、103=月线、1/5/15/30/60=分钟线（1 分钟需 `lmt` 小批量取）
- `fqt`：0=不复权、1=前复权、2=后复权（本用例 fqt=1）
- 实测 klines 数组一行含 11 列：

```
"2024-01-02,1580.66,1550.67,1583.85,1543.76,32156,5440082548.00,2.52,-2.58,-40.99,0.26"
 └─ date, open, close, high, low, volume(手), amount(元), 振幅%, 涨跌幅%, 涨跌额, 换手率%
```

**注意**：K 线列序是 open, close, high, low（close 在第二位，不是标准 OHLC）；行数为"1 个交易日内 1 行"。

#### c) 市场列表 / 多票快照（含基本面）—— `push2.eastmoney.com/api/qt/clist/get`

```
https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=50&po=1&np=1&fltt=2&invt=2&fid=f3
  &fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23
  &fields=f2,f3,f4,f5,f6,f8,f9,f10,f12,f14,f20,f21,f23,f100
```

实测返回样例：

```json
{"data":{"total":5554,"diff":[{"f2":38.04,"f3":20.0,"f8":7.2,"f9":26.98,"f10":1.57,
"f12":"300378","f14":"鼎捷数智","f20":10169722092,"f21":10093267917,"f23":4.11,"f100":"软件开发"}]}}
```

字段：f2 最新价、f3 涨跌幅%、f4 涨跌额、f5 量(手)、f6 成交额、f8 换手率%、f9 PE(动)、f10 量比、f12 代码、f14 名称、f20 总市值、f21 流通市值、f23 PB、f100 所属行业板块。`fs=...` 为市场过滤（沪主板/深主板/创业板/科创板等），可只取需要的市场段。**这是一站式拿"行情 + 基本面"最省事的口子**，一次请求即可给 LLM 送当前价/PE/PB/市值/换手。

#### 实测坑：反爬限流

高频连续请求后，push2 / push2his 会直接断连（curl 实测 HTTP 000 / 502），无明确报错。结论：单用户浏览器低频使用没问题；**不要**在自家后端做全市场轮询扇出，会被封 IP。官方无 key 规则文档，一切以实测为准。

---

### 1.2 腾讯财经（次选）—— qt.gtimg.cn / web.ifzq.gtimg.cn

免 key，**CORS 实测可用**（`Access-Control-Allow-Origin: *`）。两个接口编码不同，注意：

#### a) 实时快照（单票）—— `http://qt.gtimg.cn/q=<symbol>`

```
http://qt.gtimg.cn/q=sh600519        # 沪市 sh、深市 sz、港股 hk、美股 us
```

实测返回是 **GBK 编码** 的 JS 赋值文本（Content-Type: text/html; charset=GBK）：

```
v_sh600519="1~贵州茅台~600519~1297.40~1292.30~1289.00~16126~8576~7550~...~20260828161500~5.10~0.39~1297.89~1288.00~1297.40/16126/2086008422~16126~208601~0.13~19.92~~1297.89~1288.00~0.77~16218.56~16218.56~6.46~1421.53~1163.07~0.54~...~1293.56~18.22~19.70~..."
```

浏览器 `fetch` 后不能直接 `.text()`（默认按 UTF-8 解码会乱码），需：

```js
const buf = await resp.arrayBuffer();
const txt = new TextDecoder('gbk').decode(buf); // TextDecoder 原生支持 'gbk' 标签
```

按 `~` 切分后的关键下标（A 股实测映射）：

| 下标 | 含义 | 下标 | 含义 |
|---|---|---|---|
| 1 / 2 | 名称 / 代码 | 38 | 换手率% |
| 3 / 4 / 5 | 现价 / 昨收 / 今开 | 39 | 市盈率 TTM |
| 6 | 成交量(手) | 43 | 振幅% |
| 9~28 | 买一~卖五 五档价量 | 44 / 45 | 流通市值(亿) / 总市值(亿) |
| 30 | 时间戳 | 46 | 市净率 PB |
| 31 / 32 | 涨跌额 / 涨跌幅% | 47 / 48 | 涨停价 / 跌停价 |
| 33 / 34 | 最高 / 最低 | 49 | 量比 |
| 37 | 成交额(万) | 51 / 52 / 53 | 均价 / PE(动) / PE(静) |

#### b) 历史 K 线（前/后复权）—— `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get`

```
https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,320,qfq
# param = <symbol>,day|week|month,m5|m15|m30|m60,,<天数>,qfq|hfq|(空=不复权)
```

实测返回 **UTF-8 JSON**（无需 GBK 解码），CORS `*`：

```json
{"code":0,"data":{"sh600519":{"qfqday":[
  ["2026-08-26","1300.000","1302.800","1314.450","1295.000","21731.000"],
  ["2026-08-27","1304.000","1292.300","1305.000","1288.000","24767.000"]
]}}}
```

行格式 `[date, open, close, high, low, volume(手)]` —— **没有成交额和换手率**；不复权时 key 为 `day`，前复权 `qfqday`，后复权 `hfqday`。数据深度约最近 320 根（count 参数控制）。

**小结**：腾讯＝实时派基本面（但 GBK 解码 + 无文档的字段序号）+ K 线历史（干净 UTF-8）。适合做东财的备胎与交叉校验，不适合做主力解析源（字段序号全靠社区记忆）。

---

### 1.3 新浪财经 —— 浏览器直连不可行

- 实时：`https://hq.sinajs.cn/list=sh600519`（GB18030 编码、`var hq_str_...` 全局变量形式）
- 日 K（JSONP）：`https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20x=/CN_MarketDataService.getKLineData?symbol=sh600519&scale=240&ma=no&datalen=100`

实测结论（防外链校验 + 无 CORS 双杀）：

| 请求头 | 结果 |
|---|---|
| 无 Referer | HTTP 403 |
| `Referer: http://localhost:3080/`（本地前端） | HTTP 403 |
| `Referer: https://finance.sina.com.cn`（curl 可伪造） | HTTP 200 |

且无论哪种情况响应头都没有 `Access-Control-Allow-Origin`。所以：

- `fetch` 直连 → 被 CORS 拦；
- `<script>` JSONP 方式 → 带上的 Referer 是 `http://localhost:...`，被 403 拒绝；
- 浏览器无法伪造 Referer（fetch 设 Referer 是 forbidden header）。

结论：**新浪必须经后端代理**（代理加 `Referer: https://finance.sina.com.cn` 即可破解）。既然要上代理，优先级低于能直连的东财/腾讯。

---

### 1.4 网易财经 —— 已下线

- 历史：`http://img1.money.126.net/data/hs/kline/day/history/2024/0600519.json`
- 实时：`http://api.money.126.net/data/feed/0600519`

实测两个端点均 **502**。网易 2023-02 关闭股票频道，相关接口已死，**不选**。

---

## 2. 美股 / 全球免费数据源

### 2.1 Yahoo Finance（免费美股历史之王，但 CORS 被拦）

#### chart API（无 key、无 crumb，历史行情）

```
https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1y&interval=1d
https://query1.finance.yahoo.com/v8/finance/chart/AAPL?period1=1704067200&period2=1735689600&interval=1d
https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1mo&interval=1d&events=div,splits   # 分红/拆股
```

实测：HTTP 200 + 纯 JSON，**无需 cookie/crumb**；interval 支持 1m/5m/15m/1h/1d/1wk/1mo；`indicators.quote` 给出 OHLCV，`indicators.adjclose` 给复权价，`events` 给 div/splits；`meta` 含现价、52 周高低、名称等。**但实测响应无 `Access-Control-Allow-Origin` 头**（服务器 `Vary: Origin` 却不回显），所以浏览器直连被拦。

**meta 只有这些**（实测）：

```json
{"regularMarketPrice":319.7,"regularMarketChangePercent":1.628,
 "fiftyTwoWeekHigh":344.57,"fiftyTwoWeekLow":225.95,
 "regularMarketDayHigh":322.37,"regularMarketDayLow":315.45,
 "longName":"Apple Inc.", ...}
```

→ **无 PE、无市值**。基本面要往下看 v7/v10。

#### quote / quoteSummary（基本面，需要 crumb + cookie）

```
https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL
https://query2.finance.yahoo.com/v10/finance/quoteSummary/AAPL?modules=price,summaryDetail,defaultKeyStatistics
```

实测两个都 **401**：

```json
{"finance":{"error":{"code":"Unauthorized","description":"Invalid Crumb"}}}
```

访问流程：先 GET `https://fc.yahoo.com` 拿 cookie（A1/A3），再解析页面里的 crumb，后续请求带 `crumb=` 参数 + cookie。**浏览器直连完全不可行**；后端代理实现正是 yfinance 的做法（见 2.2）。

#### CORS 破解方式

- 只要图表/历史：后端一个薄代理（例如 Vercel/CF Worker/Express 一条路由）转发 v8/chart 并回写 `Access-Control-Allow-Origin: *` 即可，**无 key、免注册**。
- 要 PE/市值：代理需维护 cookie + crumb（yfinance 同款逻辑，几十行），或干脆用下面带 key 的源补基本面。

### 2.2 yfinance —— 浏览器不可用

yfinance 是 **Python 库**（pip 安装），不是 HTTP API：它在库内部完成 Yahoo 的 cookie/crumb 流程并解析 JSON。结论：**不能也不需要在浏览器用**；它适合放在后端当"现成方案"（等价于 2.1 的代理 + crumb 处理，且已写好）。若前端项目坚持零后端，请直接看 2.3~2.6 的带 key 源。

### 2.3 Alpha Vantage —— 浏览器可用，但额度紧

```
https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=IBM&apikey=YOUR_KEY&outputsize=compact
https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=IBM&apikey=YOUR_KEY
https://www.alphavantage.co/query?function=OVERVIEW&symbol=IBM&apikey=YOUR_KEY   # PE/市值/EPS/ROE 等
```

- CORS：实测 GET 响应头 `Access-Control-Allow-Origin: *` → **浏览器直连可用**（key 放在 query 参数，属简单请求，无预检）。
- 免费额度：**已从曾经的 500 次/天下调为约 25 次/天**（2024–2025 政策变动，突发约 5 次/分），多个新端点（如新闻情绪）已转付费；请以官网当前说明为准。25 次/天对"输入代码→拉数据"的交互项目几乎一天就耗尽，**只适合演示/原型**。
- 字段广度：`TIME_SERIES_DAILY` 仅 OHLCV + 成交量；基本面在 `OVERVIEW`（含 PE、市值、EPS、毛利率等），一次一个 key 可用。

### 2.4 Finnhub —— 浏览器可用，60 次/分

```
https://finnhub.io/api/v1/quote?symbol=AAPL&token=YOUR_KEY            # 实时 c/h/l/o/pc
https://finnhub.io/api/v1/stock/candle?symbol=AAPL&resolution=D&from=1704067200&to=1735689600&token=YOUR_KEY
https://finnhub.io/api/v1/stock/profile2?symbol=AAPL&token=YOUR_KEY   # 市值/行业/IPO 等
https://finnhub.io/api/v1/stock/metrics?symbol=AAPL&metric=all&token=YOUR_KEY  # PE/EPS 等
```

- CORS：实测预检（OPTIONS）返回 `Access-Control-Allow-Origin: *` + `Allow-Credentials: true` → **浏览器直连可用**。
- 免费层：**60 calls/min**（全部端点统一计数，无每日总量限制）——按"每只股票 2~3 个请求"算，交互式项目日耗只受分钟级限制，比较宽。
- 字段广度：实时 quote（c=现价 h/l/o/pc）、candle 历史 OHLCV、profile2 含市值，metrics 含 PE。免费层大多数端点可用。

### 2.5 Twelve Data —— 浏览器可用，额度最宽

```
https://api.twelvedata.com/time_series?symbol=AAPL&interval=1day&outputsize=100&apikey=YOUR_KEY
https://api.twelvedata.com/quote?symbol=AAPL&apikey=YOUR_KEY          # 含 PE/市值/52周高低
https://api.twelvedata.com/price?symbol=AAPL&apikey=YOUR_KEY
```

- CORS：实测预检返回 204 + `Access-Control-Allow-Origin: *` → **浏览器直连可用**。
- 免费层：**800 credits/天，8 credits/分**；权限按"请求 + 字段数/资产数"记（日常 `time_series` 单标的 ≈ 1 credit / 请求）。交互式项目一天 800 次足够；注意 8/分 的突发限制。
- 字段广度：历史 OHLCV 覆盖全球市场，`quote` 带 PE/市值/52 周等；免费层覆盖度好。

### 2.6 Polygon.io —— 浏览器可用，但免费层在收窄

```
https://api.polygon.io/v2/aggs/ticker/AAPL/range/1/day/2024-01-01/2024-01-31?apiKey=YOUR_KEY
https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/AAPL?apiKey=YOUR_KEY
```

- CORS：实测预检回显 `Access-Control-Allow-Origin: <Origin>` → **浏览器直连可用**。
- 免费层：旧「Basic」为 **5 calls/min**；⚠️ 2025 年起 Polygon 对**新账户**的免费层明显收窄（改按量付费导向），免费额度情况以官网/控制台当前显示为准。历史数据「分笔/分钟」粒度免费层受限，多为日线可用。
- 字段：aggs 为 OHLCV + 成交量/成交额；参考数据（基本面）多数端点已不在免费层。

---

## 3. CORS 关键结论

### 3.1 浏览器直连可行（无需后端）✅

| 源 | 端点 | 注意点 |
|---|---|---|
| 东财 | `push2.eastmoney.com/api/qt/stock/get`（实时）<br>`push2his.eastmoney.com/api/qt/stock/kline/get`（K 线）<br>`push2.eastmoney.com/api/qt/clist/get`（列表+基本面） | 免 key；字段数字缩放（`fltt=2`）、`secid` 代码规则；有 IP 级限流 |
| 腾讯 | `qt.gtimg.cn/q=`（实时）<br>`web.ifzq.gtimg.cn/appstock/app/fqkline/get`（K 线） | 实时为 **GBK** 需 `TextDecoder('gbk')`；K 线历史 UTF-8 干净 |
| Alpha Vantage | `www.alphavantage.co/query` | 免注册 key；25 次/天；key 暴露在前端 |
| Finnhub | `finnhub.io/api/v1/*` | 免费 key；60 次/分 |
| Twelve Data | `api.twelvedata.com/*` | 免费 key；800 credits/天 |
| Polygon | `api.polygon.io/*` | 免费 key；5 次/分，政策在变 |

⚠️ 带 key 的源把 key 放前端 = 泄露风险（会被盗刷额度）。个人/学习项目可接受；正式项目应把 key 放后端。免 key 的东财/腾讯没有这个问题。

### 3.2 浏览器直连被拦，必须经后端代理

| 源 | 原因 | 破解方式 |
|---|---|---|
| 新浪全套 | 无 ACAO + 防外链 Referer 校验（localhost 来源 403） | 代理转发并伪造 `Referer: https://finance.sina.com.cn` |
| Yahoo v8/chart | 无 ACAO（但不用 crumb） | 代理转发 + 回写 CORS 头即可（最简） |
| Yahoo v7/v10（基本面） | 无 ACAO + 401（必须 crumb+cookie） | 代理维护 A1/A3 cookie + crumb（yfinance 同款逻辑） |
| 网易 | 接口已死 | 不选 |

### 3.3 一句话

- **A 股**：东财、腾讯两大免 key 口子在浏览器直连均可用——**不存在"必须上后端"的障碍**。
- **美股**：免 key 的 Yahoo 必须上代理；带免费 key 的 Twelve Data / Finnhub / AlphaVantage 浏览器直连可用，代价是 key 管理 + 额度。

---

## 4. 推荐组合

### A 股：东方财富为主，腾讯为备

- **主力**：东财 `stock/get`（实时 + 市值/PE/PB/换手/涨停跌停）＋ `kline/get`（前复权日线，klt=101）＋ `clist/get`（多票列表含基本面，喂 LLM 对比非常合适）。
- **交叉校验/备胎**：腾讯 `web.ifzq.gtimg.cn` 的复权日 K（UTF-8 干净）与实时快照（记得 GBK 解码）。两家数据偶尔有复权基准差异，K 线列序/单位（东财 volume 为"手"、腾讯同为"手"但不含成交额）需归一化后再送 LLM。
- 不选新浪（Referer 403）、网易（已死）。

### 美股：Yahoo 代理为主 + Twelve Data 兜底补基本面

- **历史 + 实时现价（欧元/美元通用）**：Yahoo v8/chart —— 免费、免注册、无 key，但必须配一个小后端代理（Cloudflare Worker / Vercel Edge Function / Express 一条路由都行，转发 + 加 CORS 头，约 20 行）。
- **基本面（PE/市值/52 周）**：Yahoo v10 需要 crumb 代理，成本略高；更省事的做法是用 **Twelve Data `quote`**（800 credits/天，浏览器直连，免费 key）或 Finnhub `profile2`/`metrics`（60 次/分）补 PE、市值。
- **演示/原型**：嫌代理麻烦可全用 Twelve Data（浏览器直连），一天 800 次对个人交互绰绰有余；Alpha Vantage 25 次/天平局最酸爽，不推荐做主力。

### 取舍小结

| 组合 | 成本 | 免注册度 | 额度风险 | 复杂度 |
|---|---|---|---|---|
| A 股东财 + 腾讯（纯前端） | 0 | 完全免注册 | 低（有反爬，注意低频） | 低（字段缩放/编码坑） |
| 美股 Yahoo 代理 + Twelve Data | 0（Twelve Data key 免费） | 需注册一个 key | 中（Twelve Data 按天） | 中（一个薄代理） |
| 美股纯前端 Twelve Data | key 免费 | 需注册 | 中 | 最低 |
| 美股纯前端 Alpha Vantage | key 免费 | 需注册 | **高（25/天）** | 最低 |

---

## 附：本次实测命令与关键响应（2026-08-30）

```bash
# 腾讯实时（GBK，ACAO:*）—— 200
curl -H "Origin: http://localhost:3080" "http://qt.gtimg.cn/q=sh600519"

# 腾讯复权日K（UTF-8 JSON，ACAO:*）—— 200
curl -H "Origin: http://localhost:3080" \
  "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,3,qfq"

# 东财实时 —— 200，Access-Control-Allow-Origin: http://localhost:3080（回显）
curl -H "Origin: http://localhost:3080" \
  "https://push2.eastmoney.com/api/qt/stock/get?secid=1.600519&fields=f43,f57,f58,f116,f117,f162,f167,f168"

# 东财日K —— 200，ACAO 回显；连续高频后变 HTTP 000/502（反爬）
curl -H "Origin: http://localhost:3080" \
  "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600519&klt=101&fqt=1&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&beg=20240101&end=20500101&lmt=3"

# 新浪实时：无 Referer → 403；Referer=localhost → 403；Referer=finance.sina.com.cn → 200 且无 ACAO
curl -H "Referer: https://finance.sina.com.cn" "https://hq.sinajs.cn/list=sh600519"

# Yahoo chart —— 200 无 ACAO（CORS 拦）；v7 quote / v10 quoteSummary —— 401 Invalid Crumb
curl -A "Mozilla/5.0" "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=5d&interval=1d"
curl -A "Mozilla/5.0" "https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL"

# Alpha Vantage —— 200，Access-Control-Allow-Origin: *
curl -H "Origin: http://localhost:3080" "https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=IBM&apikey=demo"

# 预检（CORS 权威测试）：
# Finnhub    OPTIONS https://finnhub.io/api/v1/quote?symbol=AAPL        → 200 ACAO:*
# Twelve Data OPTIONS https://api.twelvedata.com/time_series?...        → 204 ACAO:*
# Polygon    OPTIONS https://api.polygon.io/v2/aggs/ticker/AAPL/range/1/day/2024-01-01/2024-01-02?apiKey=x → 204 ACAO 回显

# 网易（已死）：http://img1.money.126.net/data/hs/kline/day/history/2024/0600519.json → 502
#             http://api.money.126.net/data/feed/0600519               → 502
```

> 注：评测中东方财富在一次密集测试后被 IP 限流，周线/分钟线参数（klt=102/5/15/30/60）未能在本机复验；值为业界通行文档（klt=101 日 / 102 周 / 103 月 / 1/5/15/30/60 分钟），仅供参考，接入时请用日线已验证的同一参数模板小批量试取。