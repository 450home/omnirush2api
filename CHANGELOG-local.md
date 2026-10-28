# 本地改动记录（未推送）

本文件记录 fork 上所有本地修改，便于后期回溯。上游仓库：`IMROVOID/Omnirush2API`；发布仓库：`450home/omnirush2api`。

---

## 2026-10-28 · 修复 4：流式空闲超时（idle timeout）替代总时长超时

**问题现象**

2026-10-27 深夜实测，流式请求耗时 126.99s，客户端最终拿到完整回复，但日志出现：

```
[omnirush2api Pool] Account account-2 placed in cooldown for 30s:
Network error: The operation was aborted due to timeout
```

即「客户端成功、后台误罚账号」。

**根因**

`src/proxy/completion-handler.ts` 中：

```ts
const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs); // 默认 120000
```

该信号从请求发出开始计时，且覆盖整个响应体消费过程。任何超过 120s 的正常长回答都会被 `AbortError` 中止，随后落进 `markCooldown(30_000, "Network error: ...")` 分支。冷却时长 30s 是硬编码，与 120s 阈值无关。

对照组：非流式那次 81.65s 未越线，所以没有冷却。

**为什么以前没暴露**

历史上从未测到超过 120s 的请求。2026-10-27 直连测试出现过 221s 的响应，但那几次绕过了代理，没有 `AbortSignal` 约束。代理的真实能力上限一直是 120s。

**修改内容**

`src/proxy/stream-transformer.ts`

- 新增 `SSETransformOptions { idleTimeoutMs?, onIdleTimeout? }`
- 新增导出常量 `DEFAULT_IDLE_TIMEOUT_MS = 30_000`
- `createSSETransformStream(requestedModel, options?)` 增加 `start()` 中的 watchdog 定时器
- `transform()` 每次收到字节刷新 `lastByteAt`
- `flush()` 里清除定时器并置 `finished = true`
- 定时器调用 `unref()`，避免拖住 Node 进程退出
- watchdog 间隔取 `clamp(idleTimeoutMs / 6, 1s, 5s)`

`src/proxy/completion-handler.ts`

- `ProxyHandlerOptions` 新增 `idleTimeoutMs?`
- 构造函数新增 `this.idleTimeoutMs`
- `timeoutSignal` 改名 `connectSignal`，语义明确为「连接/首字节预算」
- 注释说明：不再对响应体施加墙钟时间限制
- 仍保留调用方 `signal`（客户端断开）的合并
- `createSSETransformStream` 调用处传入 `idleTimeoutMs` 与 `onIdleTimeout` 回调，超时时 `markCooldown(30_000, "Upstream idle for Ns")`

**行为变化**

| 场景 | 修改前 | 修改后 |
|---|---|---|
| 正常但慢的流（126s、221s） | 120s 中止 + 冷却 30s | 持续有字节则不中止 |
| 上游卡死无任何数据 | 等满 120s 才失败 | 30s 无字节即失败并冷却 |
| 排队中（`: queued` 心跳） | 持续 | 心跳算字节，重置计时器，不会误杀 |
| 客户端断开 | 499 | 499（不变） |

**验证**

- `npx tsc --noEmit` 无错误
- `npm test` 48/48 通过
- `npm run build` 成功，CLI 71.1 KB / Worker 44.8 KB

**注意事项**

- `TransformStream` 的 `Transformer` 接口不支持 `cancel()` 钩子（TS2353），已移除；定时器依靠 `flush()` 和 `finished` 标志清理。
- 若客户端在流中途断开，`flush()` 不一定被调用，watchdog 会靠 `unref()` 自然消亡，不会泄漏进程。

---

## 2026-10-28 · 修复 6：池级重试（多轮 + retry_after 间隔）

**问题现象**

20 次压测（间隔 45 秒）中前 4 次连续 300 秒超时，客户端什么都没收到。日志全是：

```
Account account-X placed in cooldown for 5s: Upstream SSE error: omni_queue_timeout
```

上游自己在错误体里返回 `retry_after: 15`，意思是「15 秒后再来」，但旧代码只把账号池走一遍就放弃，直接返回 429/502。

**修改内容**

`src/proxy/completion-handler.ts`

- `ProxyHandlerOptions` 新增 `maxRetryRounds?`（默认 2）、`retryDelayMs?`（默认 15_000）
- 构造函数新增 `this.maxRetryRounds`、`this.retryDelayMs`
- `handleCompletion` 外层加 `for (let round = 0; round < maxRounds; round++)`，每轮前 `sleepUnlessAborted` 等待
- 内层账号遍历遇到「全部冷却」时 `break` 而不是直接返回 429，交给外层等待后重试
- 新增私有方法 `sleepUnlessAborted(ms, signal)`，客户端断开时提前返回 false
- 新增 `let lastFailure: ProxyResult | null`，全部轮次失败后返回最有信息量的结果而非笼统 502

**行为变化**

| 场景 | 修改前 | 修改后 |
|---|---|---|
| 单轮全部账号冷却 | 立即返回 429 | 等 15s 再来一轮 |
| 上游 queue_timeout | 直接失败 | 最多 2 轮，共 2 次机会 |
| 客户端中途断开 | 继续重试 | 立刻返回 499 |
| 全部失败 | 笼统 502 | 返回最后一次具体错误 |

**验证**

- `tsc --noEmit` 无错误
- `npm test` 48/48
- `npm run build` 成功，Worker 46.5 KB
- 6 次实测（间隔 30s）：5/6 成功，#1 在 400s（客户端上限）放弃，#2–#6 分别为 7.13s / 138.53s / 10.15s / 10.01s / 3.11s，全部返回「收到」
- 全程 `banned_accounts: 0`，`cooldown_accounts: 0`
- 重试日志只有 1 条 cooldown 记录，说明第 2 轮直接命中了恢复的账号

---

## 2026-10-28 · 修复 5：连接超时与传输超时真正分离（修复 4 的补完）

**问题现象**

修复 4 之后复测，仍然出现冷却：

```
[omnirush2api Pool] Account account-1 placed in cooldown for 30s:
Network error: The operation was aborted due to timeout
```

三次请求分别是 238.44s / 125.27s / 4.23s，全部拿到正确回复，但第 2 次之后 health 变成 `active: 1, cooldown: 1`。

**根因：修复 4 只改了变量名，没改实质**

`AbortSignal.timeout(120000)` 改名成 `connectSignal` 后，仍然绑定在整个 `fetch()` 生命周期上。Node 的 fetch 一旦开始读取响应体，这个信号仍在计时；到 120s 时 abort，读取 body 的流被中断，抛出 `AbortError`，落进 `markCooldown(30_000, "Network error: ...")` 分支。

238.44s 那次没被砍是因为全程有字节返回且中途换过账号；125.27s 那次则是计时器到期时客户端仍在正常接收。

**修改内容**

`src/proxy/completion-handler.ts` 的 `send()`：

```ts
const connectController = new AbortController();
const connectTimer = setTimeout(() => connectController.abort(), this.requestTimeoutMs);
connectTimer.unref?.();

if (signal) {
  if (signal.aborted) connectController.abort();
  else signal.addEventListener("abort", () => connectController.abort(), { once: true });
}

try {
  return await fetch(url, { ..., signal: connectController.signal });
} finally {
  clearTimeout(connectTimer);   // 响应头到手即解除，之后由 idle watchdog 判活
}
```

同时区分错误类型：

```ts
const isAbort = err instanceof Error && err.name === "AbortError";
this.pool.markCooldown(
  account.id,
  isAbort ? 5_000 : 30_000,
  isAbort ? `Connect timeout after ${...}s` : `Network error: ...`
);
```

连接超时只罚 5 秒（说明网络慢，不是账号坏），其他网络错误仍罚 30 秒。

**三段式保护**

| 阶段 | 机制 | 阈值 |
|---|---|---|
| 连接 + 等响应头 | `AbortController` 计时器 | 120s |
| 响应头到手 | `clearTimeout` 立即解除 | — |
| 读响应体 | idle watchdog（无字节） | 30s |

**验证**

- `tsc --noEmit` 无错误
- `npm test` 48/48
- `npm run build` 成功，CLI 71.1 KB / Worker 45.4 KB
- 短请求 4 次：56.70s / 48.16s / 11.78s / 59.36s，全部返回「收到」，health 全程 `active: 2, cooldown: 0`
- **长请求 258.79s（gpt-6-astra，12173 字，5115 chunks）成功返回，未被 120s 砍断**，health 仍 `active: 2, cooldown: 0`
- 全程唯一冷却记录：`account-2 placed in cooldown for 5s: Upstream SSE error: server_error`——这是修复 3 的 A 项在正常工作（捕获上游真实错误帧，且只罚 5 秒）

---

## 2026-10-28 · 修复 3：流式数据处理三处缺陷（A/B/C）

### A. peek 循环被心跳提前打断

`src/proxy/completion-handler.ts`

```diff
- while (peekedBytes.length === 0 || !peeked.includes("\n\n")) {
+ while (!peeked.includes("data: ") && !peeked.includes("event: ")) {
-   if (peeked.length > 8192) break;
+   if (peeked.length > 32768) break;
```

上游每条 keep-alive `: queued position=N eta=N` 都自带 `\r\n\r\n`，旧条件第一次心跳就退出，导致后方的 `event: error` 帧永远检测不到，错误被当作正常流转发给客户端。

阈值同时从 8KB 提到 32KB，因为错误帧前面可能已排了一串心跳。

### B. 兜底分支无差别收流

`src/proxy/stream-transformer.ts`

```diff
- if (typeof upstream["delta"] === "string") {
+ if (eventType.endsWith(".output_text.delta") && typeof upstream["delta"] === "string") {
```

旧兜底把 `response.refusal.delta`、`response.function_call_arguments.delta` 也塞进 `content`，造成正文串味。

### C. flush 静默丢弃残缺行

`src/proxy/stream-transformer.ts`

新增导出函数 `rescueTruncatedDelta(raw: string): string | null`，约 50 行。当流在某一行中间被切断时，残留 `buffer` 是非法 JSON，`parseSSELine` 返回 `null`，旧代码直接丢弃。新逻辑逐字符提取 `"delta"` 字段已累积的内容，并处理 `\n` `\t` `\r` `\b` `\f` `\"` `\\` `\/` `\uXXXX` 转义；遇到被截断的转义序列则安全停止。

`flush()` 中 `parsed === null` 分支调用该函数，抢救出的文本以独立 chunk 下发。

**验证**

- `npm test` 48/48
- 端到端非流式 81.65s、流式 126.99s（23 chunk），均返回完整代码块

---

## 2026-10-22 · 修复 2：Docker 权限与版本号

- `OFFICIAL_VERSION` 改为 `"2.7.1"`（上游返回 426 `update_required`，minimum 2.7.1）
- `Dockerfile`：`ENV HOME=/home/node` + `mkdir -p /home/node/.omnirush2api` + `VOLUME /home/node/.omnirush2api`
  - 原因：`USER node` 对 `/root/.omnirush2api` 无写权限，token 轮换无法落盘，重启后 401
- `docker-compose.yml` 同步卷路径为 `/home/node/.omnirush2api`，`ports` 与 healthcheck 跟随 `${PORT:-20129}`
- `Dockerfile` 去掉 `# syntax=docker/dockerfile:1`；build 阶段显式清 `NPM_CONFIG_GLOBAL` / `NPM_CONFIG_PREFIX`
- `HEALTHCHECK` 与 `CMD` 均跟随 `process.env.PORT`，`CMD` 不再硬编码 `--port`
- `README.md` / `.env.example` 改为通用「On Blitz / a Docker platform」表述，标注唯一必填项

---

## 2026-10-21 · 修复 1：基础部署适配

- `.env.example` 标注 `OMNIRUSH_REFRESH_TOKEN` 为唯一必填
- `HOST=0.0.0.0` 说明补全
- 分支策略：`master` 保持上游原样（`e0df9e5`），`my` 承载全部修改

---

## 待办 / 已知未修

| 项目 | 说明 |
|---|---|
| `expiresIn` 硬编码 3600 | 上游实际 `expires_in: 3599`，相差 1 秒，可能造成临界刷新 |
| refresh 失败即 60s 冷却 | `pool-manager.ts:347`，上游抖动会让双账号同时冷却，存在雪崩风险 |
| 排队心跳未计入 TTFB 统计 | `: queued` 算字节会重置 idle 计时器，长时间排队不会超时——这是有意为之，但需观察是否符合预期 |
| commit author | 仍为 `IMROVOID`，是否 rebase 改 GitHub noreply 邮箱待定 |

---

## 测试账号与 token 位置

- token 文件：`/root/.omnirush2api/tokens.json`（**不得改名、不得提交**）
- 备份目录：`/root/.omnirush-token-archive/`
- 测试用 API_KEY：本地实例 `sk-dual`（仅测试，不入库）
