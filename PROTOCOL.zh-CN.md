[English](PROTOCOL.md) | [中文](PROTOCOL.zh-CN.md)

# Amazon Quick 聊天协议（v1.2.4660 实测）

本文档记录插件依赖的线上协议。所有字段均来自对桌面端
`app.asar`（`dist/main`、`dist/renderer`）的逆向与真实流量抓包。
敏感值（token、账号 id、tenant url）一律用占位符表示。

## 1. 拓扑

```
magpie ──OpenAI Chat Completions──▶ 插件 fetch
                                      │ spawn / connect
                                      ▼
                        quickwork-agent --outpost-only  (Python, 127.0.0.1:<port>)
                          ├─ /health                  公开
                          ├─ /auth/status             Bearer <instanceToken>
                          ├─ /auth/sncs-session       Bearer <instanceToken>
                          └─ /local/outpost-id        Bearer <instanceToken>
                                      │  id_token + ws_host
                                      ▼
              wss://<ws_host>/streaming/quickwork-chat-bidirectional-stream
              （qbs-cell…dp.appintegrations.<region>.prod.plato.ai.aws.dev）
```

instance token 契约（与 Electron `AgentBridge.pipeToken` 一致）：
主进程把 token 作为**第一行**写入子进程 stdin，子进程之后所有 `/auth/*`、`/local/*`
请求都用 `Authorization: Bearer <token>`。

## 2. outpost 启动参数

```
quickwork-agent(.exe) --outpost-only --manifest desktop --port <port>
```

环境变量（插件设置的最小集）：

| 变量 | 说明 |
|---|---|
| `QUICKWORK_BUILD_STAGE` | `prod`（默认）/ `beta` 等，决定 feature flag 通道 |
| `QUICKWORK_CLOUD_MODE` | `1` |
| `QUICKWORK_OUTPOST_PORT` | 监听端口 |
| `QUICKWORK_PROFILE_STAGE` | 同 build stage |
| `QUICKWORK_USER_DATA_DIR` | 可选；指向 app userData 以复用本地状态 |

stdout 会打印 `OUTPOST_PORT: <port>`、`LEP_PORT: <port>` 等行。
`/health` 返回 `{"status":"ok","service":"outpost"}`。

## 3. 会话接口

### `GET /auth/sncs-session`

返回（字段经脱敏）：

```json
{
  "id_token": "<JWT>",
  "actor_arn": "arn:aws:quicksight:…:user/…",
  "ws_host": "qbs-cell….dp.appintegrations.us-east-1.prod.plato.ai.aws.dev",
  "tenant_url": "https://qbs-cell…dp.appintegrations…",
  "provider": "social",
  "aws_account_id": "…",
  "embed_host": "https://quick.aws.com",
  "region": "us-east-1",
  "usable_until": 1763…,          // epoch 秒；过期需重新获取
  "ws_replay_enabled": true
}
```

### `GET /local/outpost-id`

```json
{ "outpostId": "<uuid>" }
```

设备/会话复用维度；WS URL 与 `session_connect` 都要带它。
（另有 `nook-set-outpost-id` IPC 把它推给 renderer 的 invokeAgent 路径。）

## 4. WebSocket

### 4.1 URL

```
wss://<ws_host>/streaming/quickwork-chat-bidirectional-stream
  ?surfaceType=QUICK_WORK_DESKTOP_WINDOWS
  &token=<id_token URL-encoded>
  &outpostId=<uuid>
  &workingSessionId=<uuid>          // 每条连接一个
  &channel=prod                     // app stage
  [&agentRuntimeArnOverride=…]      // enterprise 路径用，social 不需要
```

social/AIDP 路径**不需要 SigV4 签名**（那是 enterprise provider 的
`nook-sign-ws-url` IPC 才做的事）。

### 4.2 上行帧（client → server）

WS binary frame，payload 为 UTF-8 JSON：

```json
{ "eventType": "rawInputEvent",
  "payload": { "payload": "<base64(utf8(inner JSON))>" } }
```

inner JSON 形如 `{"type": "…", "payload": {…}}`。常用类型：

**session_connect**（连接后立即发，等 `session_established`/`connected` 应答后再发消息）：

```json
{ "type": "session_connect",
  "payload": { "actor_id": "<actor_arn>", "surfaceType": "QUICK_WORK_DESKTOP_WINDOWS",
               "outpostId": "<uuid>", "appVersion": "1.2.4660" } }
```

**user_message**：

```json
{ "type": "user_message",
  "payload": {
    "thread_id": "<client-chosen id, e.g. uuid>",
    "text": "<整条用户输入>",
    "system_prompt": "<逐轮人设覆盖；内容读不到，见 §5>",
    "custom_prompt": "<可选的逐轮指令>",                // 已实测生效
    "message_id": "<uuid>",
    "agent_mode": "fast|balanced|smart|advanced",
    "user_timezone": "UTC",
    "user_locale": "en-US",
    "thinking_effort": "off|low|medium|high|max",   // 可选
    "chat_agent_id": "…",                            // 可选
    "project_context": {…}, "attachments": […],     // 可选；内联图片，见 §4.7
    "web_search_enabled": true, …                   // 可选
  } }
```

**ping**（建议 25s 间隔）：

```json
{ "type": "ping", "payload": { "timestamp": <ms> } }
```

### 4.3 下行帧（server → client）

AWS event-stream 消息（12B prelude + headers + payload + 4B CRC；
headers 里 `:message-type=event`、`:event-type=rawOutputEvent`、
`:content-type=application/json`）。body 是 JSON：

```json
{ "payload": "<base64(utf8(inner JSON))>" }
```

inner JSON 顶层字段：`type`、`payload`、`message_id`、`thread_id`、
`scope`（`chat`/`task_lifecycle`…）、`timestamp`、`turn_message_id`。

观察到的事件类型（节选）：

| type | 说明 |
|---|---|
| `session_established` | `session_connect` 应答（含 `workingSessionId`、`trace_id`） |
| `connected` | 会话就绪；`payload.user`/`runtime` 带账号与预热信息（**含 PII，勿落日志**） |
| `status` | 杂项状态，如 `{"status":"pong"}`、`unknown_message_type` |
| `message_start` | 一条 assistant 消息开始（`payload.role:"assistant"`） |
| `text_delta` | `payload.delta` 文本增量（`kernel_thread_id` 在 payload 内） |
| `thinking_delta` / `thinking_complete` | 推理过程增量 |
| `tool_start`/`tool_arguments`/`tool_progress`/`tool_result`/`tool_error` | agent 工具过程（服务端执行，客户端只观测） |
| `turn_usage` | `payload`：`input_tokens`/`output_tokens`/`cache_read_tokens`/`cache_write_tokens`/`total_tokens`/`model`/`resolved_model_id`/`served_model_id`/`cost_usd`/`context_window` |
| `text_complete` | `payload.text` 本消息全文 |
| `message_complete` | `payload`：`text`、`tool_calls[]`、`kernel_thread_id`、`initiator`、`continuation_expected?` |
| `message_split` | 长回复拆分 |
| `title_generated` | 会话标题 |
| `runs_updated` / `task_list_update` | run/任务状态噪声（顶层 `thread_id` 为空，`payload.thread_id` 才有值） |
| `keepalive` | `{"type":"keepalive","ts":…}` |
| `error` / `guardrail_blocked` / `stream_truncated` / `turn_aborted` | 异常 |

### 4.4 Turn 结束判定（实测）

**没有 `turn_completed` 下行事件**（那是 REST session-store 里的持久化事件类型）。
一个 user turn 结束的判据与桌面渲染端一致：

- `message_complete` 且 `payload.continuation_expected !== true` → 该 turn 最后一条消息完成；
  agentic 多步 turn 会发多个 `message_start…message_complete` 循环，前面几轮带
  `continuation_expected:true`；
- `stream_ended`、`turn_aborted` → 直接终止；
- `error`/`guardrail_blocked`/`stream_truncated` → 失败。

`message_complete`/`text_complete` 的 `payload.text` 是全文兜底；正常情况下
`text_delta` 已给出全部内容。

### 4.5 thread 复用

服务端按 `thread_id` 持久化会话历史（已实测：同一 thread 第二轮能记住第一轮内容）。
客户端自选 `thread_id`（插件用 UUID）。复用判定见 README「会话复用怎么判定」。

### 4.6 客户端工具调用（约定模拟）

协议里**没有**客户端工具通道：`tool_start`/`tool_arguments`/`tool_result` 是
Quick 自有 agent 工具的服务端执行过程，`message_complete.tool_calls` 恒为空。
渲染端的工具审批/结果回传（`tool_approval`、`{"type":"tool_result",…}`）只服务于
它自己的工具循环，外部 `user_message` 无法注入一个"待执行的客户端工具调用"。

可行的桥接（插件采用，已实测跑通）：

1. 把 OpenAI `tools[]` + `tool_choice` 渲染成一段 `[Tool-use convention]` 指令，
   拼进 `user_message.payload.text`（协议没有 system-prompt 通道，只能走正文）。
   同时置 `web_search_enabled:false`，减少模型调用自带联网工具"抢答"。
2. 模型把调用输出为纯文本 `<tool_call>{"name":…,"arguments":{…}}</tool_call>`
   （tag 可能跨 `text_delta` 切分，插件做了 holdback 解析，见 `lib/tools.mjs`）。
3. 解析结果映射为 OpenAI `tool_calls`；`finish_reason:"tool_calls"`。
4. 客户端回传 `role:"tool"` 结果 → 渲染为 `[tool_result <name> <id>] <content>`
   续接同一 thread（delta 里只含新增 tool/user 内容）。

局限：依赖模型遵守约定（`tool_choice:'required'` 实测稳定）；模型也可能无视约定
直接用自带工具作答（表现为普通文本）；Quick 自带工具的执行结果不映射为
OpenAI `tool_calls`。

### 4.7 图片附件（已实测）

`user_message.payload.attachments` 有两种形态。小图以内联格式
`{type:'image', name, size, mimeType, data}` 发送，`data` 为纯 base64——
它和 `text` 算在同一个 ~64KB 帧里，所以只有大约 ≤40KB 的图能直接发。

更大的图（已在无设备会话上用 337KB PNG 实测）走 Quick 自己的云端附件
流程，不需要桌面端/设备：

1. `POST {base}upload-attachment?name=<n>&contentType=<mime>&contentLength=<bytes>`
   （Bearer id_token，`x-amzn-qs-internal-trace-id`，`Content-Type:
   application/octet-stream`，body 为图片原始字节）→ `{attachmentId}`。
2. 轮询 `GET {base}attachment-dlp-status?attachmentId=<id>`，直到
   `dlpJobStatus` ∈ {COMPLETED, SKIPPED, NOT_APPLICABLE}——此时
   `policyAction` 必须是 `ALLOW`——或 ∈ {FAILED, ERROR}（失败）。
3. `POST {base}qbs-event`，请求体 `{"eventType":"invokeAgent","eventBody":
   {"invokeAgent":{"path":"files/upload/<threadId>","queryParams":
   {"_method":"POST"},"body":{"attachmentId":…},"workingSessionId":<uuid>,
   "outpostId":<uuid>}}}`。`outpostId` 必须是非空 UUID（传空 → HTTP
   500 校验错误），但**不需要**和 WebSocket 的 outpostId 一致（插件传的是
   账号的设备 ID，取不到时才用随机值）；`workingSessionId` 可以是任意新 UUID。响应里
   `eventResponse.invokeAgentResponse` 可能是对象或 JSON 字符串；有
   `.api_response` 就再解一层，`status`（存在时）须为 2xx，`.body` 也
   可能是对象或 JSON 字符串——文件路径取 `body.path ||
   body.files[0].path`，是云端工作区路径，形如
   `/data/s3files/users/…/sessions/<thread>/workspace/attached_files/<name>`。
4. `user_message.attachments` 里的条目为 `{type:'image', name, size,
   mimeType, path, attachmentId, contentSha256}`——让模型看到图的是
   `path`（不是 `attachmentId`，也不是 `data`）。

`{base}` = `{tenant_url}/integration/quick-work/`，`tenant_url` 取自会话；
为空时从 `ws_host` 推导（`ws://`→`http://`、`wss://`→`https://`、裸主机
→ `https://`）。

### 4.8 账号用量（已实测）

`POST {tenant_url}/integration/quick-work/qbs-event`，请求体
`{"eventType":"getAvailableEntitlementUnits","eventBody":{"getAvailableEntitlementUnits":{"awsAccountId":"…"}}}`
（Bearer id_token；请求体不能为空），返回
`entitlements[{unitType, numMinsAvailable, numMinsProvisioned, overageAllowed, rateLimitStatus, …}]`
和 `subscriptionMetadata{subscriptionType, freeTrialMetadata{status, expiryDate}}`。

## 5. agent_mode → 实际模型

| agent_mode | 观测 resolved_model_id |
|---|---|
| `fast` | `us.anthropic.claude-haiku-5-5` |
| `smart` | `us.anthropic.claude-opus-5-5` |
| `balanced`/`advanced` | 服务端路由；`advanced` 可能归一到 `smart`（渲染端有 feature flag 逻辑） |

`turn_usage.model` 回显请求的 mode，`resolved_model_id`/`served_model_id` 是真实模型。
注意 Quick 的系统提示很大：实测 `input_tokens≈67k`、`cache_read_tokens≈67k`
（命中 prompt cache），`context_window=1000000`。

`system_prompt` **不会**替换这份内置提示词：它只换掉其中约 6.8k token 的
人设/surface 片段（带一个极短的 `system_prompt` 时总 prompt 约 69k → 62k）；
约 62k 的核心部分（内置工具定义等）始终存在。会加载更小工具集的其它
`surfaceType`（`INBOUND_MCP`、`WEB`、`TEAMS`）用桌面端 token 握手时会被拒绝。

本地 outpost 实测使用 Smart 时，指令长度为 124 字节和 40 KiB 两种情况下，
模型都未能从 `system_prompt` 复述测试标签，改用 `custom_prompt` 后均能复述
开头和末尾的两个标签。在直连（OAuth）会话上用两个账号、Smart 和 Fast 复测：
放在 `system_prompt` 里的标签 8 次都没读到，放在 `custom_prompt` 里 8 次全对。
适配器使用后者传入调用方的指令，并保留简短的人设覆盖。
权限审核要求完整策略和待审记录能放进同一帧。

## 6. 已知坑

- `session_connect` 后要等 `session_established`/`connected` 再发 `user_message`，
  否则消息可能被丢弃（实测表现为永远无响应）。
- `user_message` 必须等 outpost 完成首次 agent 同步后云端才回话；
  outpost 首启有 ~30-60s 的 feature flag/agent reconcile，属正常。
- sandbox 端口 8768、LEP 端口被占用时 outpost 降级继续运行（只影响本地工具/MCP sandbox，
  聊天 WS 不受影响）。
- `connected.payload.user` 含邮箱/姓名/账号 id——**不要打印原始事件**。
- 整个 `user_message` 帧有 64KB 上限（超限服务端拒发 `FrameTooLarge`；
  已实测 `text` 与 `system_prompt` 共享该预算），插件在
  `lib/handler.mjs`/`lib/translate.mjs`/`lib/tools.mjs` 里做了尺寸预算；
  渲染文本始终 <60KB。
