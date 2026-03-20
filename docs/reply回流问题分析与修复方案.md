# Reply 回流问题分析与修复方案

## 1. 问题背景

在 `openclaw-qq-agent-bot` 的实际运行中，曾出现如下异常现象：

1. OpenClaw / Agent 日志已经显示生成了完整回复。
2. QQ 侧只收到第一条或部分内容。
3. 对于多步回复场景，后续内容没有继续发出。

结合日志与代码排查，问题并不只是一处，而是经历了几个层次：

- **第一层问题**：reply 文件首次非空就被 bot 读取，导致 agent 若分多次写入文件，bot 只会消费第一段。
- **第二层问题**：为了支持多条消息发送，新增的 `<<QQ_MSG_SPLIT>>` 协议在实现时一度和 prompt 文案不一致，造成拆分失败或 token 直接发给用户。
- **第三层问题**：reply 文件完成判定最初依赖“文件稳定若干秒”这一猜测逻辑，对 append 写入场景并不可靠。

本次修复围绕这三个层次逐步收敛，最终目标是：

> **让 reply 回流协议明确、发送行为一致、文件完成判定可预期。**

---

## 2. 原始问题根因

### 2.1 reply 文件被过早消费

旧逻辑中，`startReplyFilePoller()` 只要发现 `qq_reply_${requestId}.txt` 非空，就会立即读取并 `resolvePendingRequest()`。

这会导致：

- agent 如果先写第一段，再补第二段；
- bot 会在第一段落盘后立刻读取；
- 后续追加内容永远不会再进入当前请求。

这也是“日志里看 agent 已经写完，但 QQ 侧只收到前半截”的直接原因。

### 2.2 多条消息拆分协议不一致

在第一次修复中，为了支持多条 QQ 消息发送，bot 新增了 `<<QQ_MSG_SPLIT>>` 显式分隔符协议。

但实现初版存在两个问题：

1. 代码实际匹配的是带换行的 `\n<<QQ_MSG_SPLIT>>\n`。
2. prompt 文案写的是裸 token `<<QQ_MSG_SPLIT>>`。

这会导致 agent 按文案输出时，bot 却无法正确拆分。

### 2.3 “稳定若干秒”不是完成协议

中间版本为了缓解 2.1，引入了“文件 `size + mtime` 连续稳定 3 秒再读取”的策略。

这个策略比“首次非空立即读取”更安全，但本质上仍然是在**猜文件是否写完**。对于以下场景，它仍可能出错：

- agent 多次 append，且两次写入间隔较长；
- 文件被多次 touch / 更新元数据；
- 写入方式不稳定，导致稳定窗口判断失真。

因此，这不是最终的可靠方案。

---

## 3. 本次最终采用的方案

本次最终采用的是一套**最小但正确**的组合修复：

### 3.1 显式多消息协议统一为裸 token

最终统一为：

```text
<<QQ_MSG_SPLIT>>
```

当 agent 需要把最终回复拆成多条 QQ 消息时，在同一个 reply 内容中使用该 token 分隔消息段。

bot 侧只在 agent final reply 出站层识别该 token，不影响：

- quick reply
- `/send` 直发
- 管理命令回复
- 错误提示与进度提示

### 3.2 拆分逻辑改为无损 split

当前实现不再对每个分段做 `trim()` 或 `filter(Boolean)` 这种有损处理，而是：

1. 先做 `CRLF -> LF` 规范化；
2. 再按 `<<QQ_MSG_SPLIT>>` 直接拆分；
3. 发送层只跳过完全空串。

这样可以避免：

- 代码块首尾换行被吞掉；
- 纯格式性空白被错误清洗；
- 协议与正文边界被 bot 擅自改写。

### 3.3 reply 文件协议升级为原子写入

这是本次最关键的长期正确方案。

当前 agent prompt 已明确要求：

1. 先把完整回复写到临时文件：

```text
qq_replies/qq_reply_${requestId}.txt.tmp
```

2. 写完后再原子重命名为：

```text
qq_replies/qq_reply_${requestId}.txt
```

3. bot 侧 poller **只消费最终 `.txt` 文件**，不再根据“稳定时间窗口”猜测写入完成与否。

这样“完成态”由文件系统语义定义，而不是由时间窗口推断。

### 3.4 保留 callback / Gateway fallback 容灾

虽然 file poll 协议升级了，但本次没有推翻现有多路回流设计。

当前仍保留三路回流：

1. HTTP `/reply`
2. reply 文件轮询
3. Gateway 文本流 fallback

它们最终依然通过 `pendingRequests` / `resolvePendingRequest()` 单次收口。

这样可以在 agent 未正确写文件时继续保有容灾能力。

---

## 4. 实际代码修改点

本次修改集中在：

```text
openclaw-qq-agent-bot/src/qq_bot.mjs
```

### 4.1 多消息分隔符相关

- `QQ_MESSAGE_SPLIT_TOKEN` 统一为裸 token
- `splitAgentReplyMessages()` 改为无损拆分
- `sendAgentReply()` 作为 agent final reply 的统一发送出口

### 4.2 reply 文件轮询相关

- 删除基于 `REPLY_FILE_STABLE_MS` 的稳定窗口判定
- `startReplyFilePoller()` 改为只检查最终 `.txt` 文件
- 日志文案改为 `via final reply file`

### 4.3 agent prompt / runtimeInstructions

- 明确要求 agent：先写 `.txt.tmp`
- 再原子 rename 为 `.txt`
- 同时保留 `<<QQ_MSG_SPLIT>>` 多条消息协议说明

---

## 5. 为什么没有继续增加“.tmp 共存保护”

曾考虑再加一层 bot 端保护：

> 如果检测到 `.txt` 存在，同时同名 `.txt.tmp` 也存在，则暂缓消费 `.txt`。

最终没有采用，原因是：

1. 主协议已经明确要求 `.tmp -> rename`，正确性应主要由协议保证。
2. callback / Gateway fallback 已经提供了容灾路径。
3. 如果 bot 再额外依赖“.tmp 不存在”作为条件，一旦出现脏 `.tmp` 残留，可能导致 file poller 长期跳过最终文件。

因此本次选择保持 file poller 逻辑简单，把协议正确性压在：

- agent 按 prompt 正确执行
- callback / WS fallback 提供补偿

---

## 6. 已完成验证

### 6.1 静态验证

已执行：

```bash
node --check src/qq_bot.mjs
```

结果：通过。

同时已复查：

- `QQ_MESSAGE_SPLIT_TOKEN` 只有一处定义
- 不再存在 `REPLY_FILE_STABLE_MS`、`stableSince`、`lastSignature`、`stablePath` 等旧判定逻辑残留
- 3 个 agent 最终发送出口仍统一走 `sendAgentReply()`

### 6.2 分隔符边界验证

已用最小可执行脚本验证以下 case：

- 单条文本
- 裸 token
- 独占一行 token
- 三段拆分
- 中间空段
- 保留换行边界
- CRLF 输入
- 代码块 + 分隔符

结论：当前拆分行为符合设计预期。

### 6.3 原子文件协议验证

已用本地最小文件流验证：

1. 仅存在 `.tmp` 时，最终 `.txt` 不存在
2. 执行原子 rename 后，仅存在最终 `.txt`
3. 这与 poller “只消费最终文件”的设计完全一致

---

## 7. 当前剩余风险

本次代码修改在本地静态检查和最小可执行验证层面未发现新的明显 bug。

当前剩余的唯一核心风险，不是本地代码本身，而是：

> **真实运行时，agent 是否稳定遵守“.txt.tmp -> rename -> .txt”协议。**

这需要通过真实 OpenClaw + qq-agent-bot 联调来最终确认。

建议联调时重点观察：

1. reply 目录里是否先出现 `.txt.tmp`
2. 是否随后 rename 成 `.txt`
3. 日志中是否出现：

```text
[FilePoll] Resolved requestId=... via final reply file ...
```

4. 带 `<<QQ_MSG_SPLIT>>` 的回复是否按多条消息发回 QQ

---

## 8. 最终结论

本次修复不是简单“调一个时间窗口”，而是把 reply 回流协议从**概率猜测**升级成了**明确协议**：

- 多消息用 `<<QQ_MSG_SPLIT>>`
- 完整回复先写 `.txt.tmp`
- 写完后 rename 成 `.txt`
- bot 只消费最终文件
- callback / Gateway fallback 继续保留为容灾

从代码一致性、协议清晰度和当前项目架构适配性来看，这是本次问题的最佳修复方案。
