# openclaw-plugin-hermes 代码走读

## 1. 文档目标

本文档面向准备做产品化维护、代码评审、二次开发的工程师，目标是把 `openclaw-plugin-hermes` 当前分支的实现拆开讲清楚：

- Hermes 是如何被 OpenClaw 当作 provider + harness 接入的
- 一次 `/model hermes` 或 `hermes_dispatch` 请求是怎样流经各模块的
- 为什么当前实现采用 projected execenv + ACP TCP bridge，而不是直接把 OpenClaw host tool 暴露给 Hermes
- 每个源文件、每个关键函数分别负责什么，输入输出和边界条件是什么

本文档会作为飞书走读文档的本地源稿，线上版本会补充更适合阅读的图表和分栏。

## 2. 一句话架构

这个插件的本质是一个“运行时桥接器”：

1. 在 OpenClaw 一侧，把 workspace、技能、上下文、会话状态规整成一个稳定的 task-scoped execution env。
2. 在 Hermes 一侧，通过本地 ACP TCP bridge 把任务送进容器里的 Hermes runtime。
3. 在返回路径上，把 Hermes 的 text / thinking / tool 事件转换成 OpenClaw harness 结果和 WebUI 事件流。

## 3. 顶层实现图

```text
User / WebUI
   |
   v
OpenClaw Gateway
   |
   +-- provider: hermes/<model>
   |      |
   |      v
   |   src/provider.ts
   |
   +-- agent harness attempt
          |
          v
      src/harness.ts
          |
          v
      src/harness-runtime.ts
          |
          +-- src/runtime-client.ts
          |      |
          |      +-- src/context-assembler.ts
          |      +-- src/execenv-builder.ts
          |      +-- src/runtime-paths.ts
          |
          +-- src/acp-client.ts
          |
          +-- src/webui-event-bridge.ts
          +-- src/agent-event-bridge.ts
          |
          +-- host/container workspace mirror
```

## 4. 核心设计取舍

### 4.1 为什么不是“直接把 OpenClaw 工具给 Hermes”

当前实现没有试图把 OpenClaw 的 host tool runtime 直接桥接进 Hermes。原因是：

- OpenClaw tool 运行语义与 Hermes tool / ACP session 语义并不一致
- WebUI、session、workdir、reasoning 事件都需要在 OpenClaw 一侧保持一致性
- 真正高频的问题不是“工具能不能调”，而是“Hermes 在一个稳定、可复用、可调试的 cwd 里能不能拿到正确上下文”

因此当前方案选择先做投影：

- 把上下文文件投影到 execenv
- 把可投影的 skills 复制进去
- 把 session 和 execenv 绑定
- 再让 Hermes 在这个 cwd 里工作

### 4.2 为什么要有 stable execenv

如果每次请求都创建全新的临时目录，会有三个问题：

- Hermes 无法复用前一次 turn 在 cwd 中留下的状态
- session resume 会和新的目录错位
- 很难定位“某个 session 到底运行在哪个目录里”

所以这里用 `sessionAnchor` + `bindingHash` 建立稳定目录和稳定 session 绑定。

### 4.3 为什么 workspace mirror 只同步 prompt 引用路径

最初的全量 mirror 会把整个 OpenClaw workspace 都同步到容器，真实环境中这会包含非常大的缓存目录，导致：

- 首 token 变慢
- 整体 wall time 恶化
- 写回验证成本上升

当前改为：

- 从 prompt 中提取显式出现的 workspace 绝对路径
- 只同步这些路径的父目录
- 执行完成后只回拉这些目录

这是一个明显的性能和可验证性折中。

## 5. 请求主链路详解

### 5.1 Provider 注册阶段

文件：`src/provider.ts`

职责：

- 向 OpenClaw 暴露一个合成的 `hermes` provider
- 让 `hermes/default` 或 `hermes/<custom-model>` 这种模型引用能被 OpenClaw 正常解析
- 把真正执行下沉到 harness，而不是 provider 自己直连某个上游 API

关键函数：

#### `buildHermesProvider`

作用：

- 返回 OpenClaw 需要的 `ProviderPlugin`
- 声明 provider id、catalog、dynamic model 解析方式

关键点：

- `resolveSyntheticAuth` 返回的是占位 auth，不是真实上游 key
- 真实执行发生在 harness 中，所以 provider 更像“路由壳”

#### `buildHermesProviderCatalog`

作用：

- 返回 Hermes provider 的 model catalog
- 模型列表来源于插件配置里的 `discovery.models`
- 若未配置，回退到 `default`

#### `resolveHermesDynamicModel`

作用：

- 允许 `hermes/<任意 modelId>` 动态可路由
- 避免每次都依赖远程 discovery

### 5.2 Harness 注册阶段

文件：`src/harness.ts`

职责：

- 把 provider 路由过来的 agent attempt 变成 Hermes runtime 调用
- 负责 harness 层的 supports / runAttempt / reset

关键函数：

#### `createHermesAgentHarness`

作用：

- 构造 OpenClaw Agent Harness
- 指定哪些 provider id 由 Hermes harness 承接

关键点：

- `supports` 只认 `hermes`
- `runAttempt` 会进入 `createHermesRuntimeClient().runAttempt`
- `reset` 当前只清 session binding，不做远端 compact

#### `buildHermesAttemptResult`

作用：

- 把内部 `HermesRunResponse` 转成 OpenClaw 期望的 `AgentHarnessAttemptResult`

关键点：

- 统一 replay metadata
- 把 `toolMetas`、`messagesSnapshot`、`usage`、`itemLifecycle` 装配回 OpenClaw

### 5.3 Runtime 执行阶段

文件：`src/harness-runtime.ts`

职责：

- 这是一次真实 Hermes agent attempt 的总编排器
- 负责 prompt 清洗、session 锚定、execenv 准备、ACP 调用、事件桥接、workspace 回写

关键函数：

#### `runHermesHarnessAttempt`

作用：

- 整个运行链路的核心入口

执行步骤：

1. 清洗 prompt
2. 提取 prompt 中显式引用的 workspace 路径
3. 计算 runtime context level
4. 生成稳定 session anchor
5. 调 `prepareProjectedExecutionEnv`
6. mirror prompt 引用到的 workspace 子目录到容器
7. 启动 ACP client
8. resume 或创建 session
9. 发起 `session/prompt`
10. 把 streaming event 同步给 harness 回调和 WebUI bridge
11. 回拉 workspace 变更
12. 归并 assistant message / usage / replay metadata

#### `sanitizePromptForHermes`

作用：

- 去掉 OpenClaw WebUI 注入的 sender metadata
- 去掉 bootstrap truncation warning 等运行时噪音

目的：

- 防止 Hermes 把这些运行时元信息误当成用户意图

#### `extractWorkspacePaths`

作用：

- 从 prompt 中抽出 workspace 绝对路径

用途：

- 为增量 mirror 提供目录集合

#### `resumeOrCreateSession`

作用：

- 按 `bindingHash` 判断当前 projection 是否还能复用旧 session

策略：

- binding 匹配且 cwd 一致时 resume
- 否则新建 session 并重写 binding

#### `handleHarnessEvent`

作用：

- 处理 ACP `text / thinking / tool_progress / tool_result / done`

输出去向：

- WebUI event bridge
- harness 回调
- `toolMetas`
- assistant 累积文本

### 5.4 投影与 session 绑定阶段

文件：`src/runtime-client.ts`

职责：

- 把抽象上下文变成稳定 execenv
- 负责跨进程持久化 session binding

关键函数：

#### `resolveStableSessionAnchor`

作用：

- 从 `sessionId -> sessionFile -> sessionKey -> agentId -> workspaceDir` 这个优先级选一个稳定标识

原因：

- `sessionKey` 在某些 OpenClaw 本地场景里会复用得过粗
- `sessionId` 更能标识真实 turn 会话

#### `prepareProjectedExecutionEnv`

作用：

- 这是 projection 编排总入口

执行步骤：

1. `assembleProjectedContext`
2. `classifyWorkspaceSkills`
3. 计算 runtime root
4. 计算 `sessionBindingHash`
5. `buildExecEnv`
6. 生成 bootstrap prompt

#### `readSessionBinding` / `writeSessionBinding` / `clearSessionBinding`

作用：

- 管理本地缓存的 `bindingHash -> sessionId + runtimeExecEnvPath`

存储位置：

- `${OPENCLAW_STATE_DIR:-~/.openclaw}/hermes/session-bindings.json`

### 5.5 Context 装配阶段

文件：`src/context-assembler.ts`

职责：

- 按 L0-L3 规则读取 workspace 内的上下文信息

关键函数：

#### `assembleContext`

作用：

- 生成抽象的 `ContextPayload`

层级行为：

- L0：task + model
- L1：加 toolConfig / command allowlist
- L2：加 SOUL.md / USER.md / AGENTS.md / MEMORY.md / daily memory
- L3：加完整 memory 与 skills manifest

#### `adaptiveMemorySummary`

作用：

- 当长记忆过大时，按 section 截断，仅保留较新的部分

#### `readSkillsManifest`

作用：

- 扫描 workspace skills 目录，生成技能清单

#### `assembleProjectedContext`

作用：

- 把 `ContextPayload` 再收缩成 execenv builder 真正需要的结构

### 5.6 Execenv 物化阶段

文件：`src/execenv-builder.ts`

职责：

- 在宿主机上生成稳定 execenv 目录
- 将上下文文件和 skills 写入目录
- 按配置镜像到 Hermes 容器
- 负责按 prompt 增量 mirror workspace

关键函数：

#### `buildExecEnv`

作用：

- 真正创建 `SOUL.md / USER.md / AGENT.md / TASK.md / projection.json / runtime-config.json`

设计点：

- 不删除整个 execenv，只清理 projection 自己生成的文件
- 保留 Hermes 在 cwd 里留下的状态，支持 session resume

#### `mirrorWorkspaceToContainer`

作用：

- 只同步 prompt 引用目录的父目录到容器

#### `mirrorWorkspaceFromContainer`

作用：

- 只把这些目录从容器回拉到宿主机

#### `cleanupExecEnvs`

作用：

- 控制历史 execenv 的数量

### 5.7 ACP 通信阶段

文件：`src/acp-client.ts`

职责：

- 维护 Hermes ACP TCP 连接
- 负责 initialize / session/new / session/resume / session/prompt / cancel / close

关键函数：

#### `start`

作用：

- 连接 TCP bridge
- 完成 ACP `initialize`

#### `newSession`

作用：

- 调 `session/new`

#### `resumeSession`

作用：

- 调 `session/resume`

#### `prompt`

作用：

- 发 `session/prompt`
- 收集 streaming event
- 在没有明确 terminal event 但已有输出时做 idle finalize

### 5.8 WebUI 桥接阶段

文件：`src/webui-event-bridge.ts`

职责：

- 将 ACP streaming 映射成 OpenClaw Gateway 的 `agent` / `chat` 事件

关键函数：

#### `loadScopeReader`

作用：

- 在不同 OpenClaw 安装形态下动态找到 gateway request scope

#### `emitAgent`

作用：

- 发细粒度 agent 事件，如 lifecycle / assistant / thinking / tool

#### `emitChat`

作用：

- 发适配 WebUI 聊天气泡的 `chat` 事件

#### `createWebUiEventBridge`

作用：

- 管理 assistant 文本累积、thinking 状态、delta 节流

设计点：

- agent 事件尽量细粒度
- chat 事件做轻微合并，避免 gateway 被高频字符级 delta 打满

## 6. 文件级走读清单

下面是当前仓库内建议重点阅读顺序：

1. `src/index.ts`
2. `src/provider.ts`
3. `src/harness.ts`
4. `src/harness-runtime.ts`
5. `src/runtime-client.ts`
6. `src/context-assembler.ts`
7. `src/execenv-builder.ts`
8. `src/acp-client.ts`
9. `src/webui-event-bridge.ts`
10. `src/config.ts`
11. `src/types.ts`

## 7. 逐文件与函数讲解

这一节按源码文件展开，尽量覆盖每个导出函数和主要内部函数。

### 7.1 `src/index.ts`

角色：

- 插件注册入口
- 同时注册 tool、provider、agent harness

关键函数：

#### `resolveConfig`

- 边界层配置归一化
- 目的是让内部运行时都只消费已经标准化的配置对象

#### `plugin.register`

- 注册 `provider`
- 注册 `agent harness`
- 注册 `hermes_dispatch`
- 注册 `hermes_status`
- 注册 `hermes_strategy`
- 启动 `cleanupExecEnvs`

阅读重点：

- 这里能看出插件同时支持“旧 tool 路径”和“新 provider+harness 路径”
- 当前产品化重点其实是 harness 主路径，tool 更多是兼容层

### 7.2 `src/config.ts`

角色：

- 解析插件配置
- 兼容 OpenClaw config 中的字符串/布尔/数值输入

关键函数：

#### `readHermesPluginConfig`

- 读取宽松输入
- 同时兼顾 `discovery.models`

#### `resolveHermesAcpConfig`

- 在 `DEFAULT_CONFIG` 上覆盖用户配置
- 是内部最常用的配置入口

#### `readHermesAcpPartialConfig`

- 逐字段读取 Hermes 插件配置
- 对 transport、port、timeout、skillProjection.hostBackedDenylist、cleanup 等做类型保护

#### `readTransport`

- 明确只接受 `tcp`
- 表明当前版本已经不再保留旧 runtime transport 兼容层

### 7.3 `src/types.ts`

角色：

- 整个仓库的协议字典

重点类型：

#### `ContextLevel`

- L0-L3
- 描述 Hermes 可见上下文的深度

#### `CredentialScope`

- none / specified / all

#### `WritebackLevel`

- W0-W3

#### `HermesPluginConfig`

- 当前分支最重要的运行时配置
- 里面同时包含：
  - ACP 桥接配置
  - projection 配置
  - skill projection 配置
  - execenv cleanup 配置

#### `DEFAULT_CONFIG`

- 所有默认行为的真实来源

### 7.4 `src/provider.ts`

角色：

- 向 OpenClaw 暴露 Hermes provider 外壳

关键函数：

#### `buildHermesProvider`

- 返回 `ProviderPlugin`
- 定义 provider id、catalog、dynamic model 解析

#### `buildHermesProviderCatalog`

- 生成 catalog 中的模型列表
- 主要目的是让 OpenClaw 知道 `hermes/default` 是可选模型

#### `resolveHermesDynamicModel`

- 允许动态模型 id 解析

#### `buildModelDefinition`

- 生成模型元数据，声明 reasoning / image / contextWindow / maxTokens

### 7.5 `src/harness.ts`

角色：

- OpenClaw agent harness 适配层

关键函数：

#### `createHermesAgentHarness`

- 生成 harness 对象
- `supports` 决定是否接管该 provider
- `runAttempt` 进入 `harness-runtime`
- `reset` 清理 session binding

#### `buildUnsupportedCompactResult`

- 当前 Hermes runtime 不支持 OpenClaw compact 语义
- 明确对外返回 unsupported

#### `buildHermesAttemptResult`

- 把 Hermes 内部运行结果转换回 OpenClaw harness 结果

### 7.6 `src/harness-runtime.ts`

角色：

- Hermes harness 主执行器

关键函数：

#### `resolveRuntimeContextLevel`

- 保证实际发送给 Hermes 的 context level 不低于 `runtimeMinContextLevel`

#### `sanitizePromptForHermes`

- 去掉 UI metadata 和 bootstrap warning 噪音

#### `extractWorkspacePaths`

- 找出 prompt 中出现的 workspace 绝对路径

#### `createHermesRuntimeClient`

- 给 harness 提供统一的 runtime client 对象

#### `clearHermesHarnessBinding`

- 对外暴露 reset 所需的 binding 清理能力

#### `runHermesHarnessAttempt`

- 真实 attempt 入口
- 本仓库最值得精读的函数之一

#### `resumeOrCreateSession`

- session 复用策略

#### `handleHarnessEvent`

- ACP event 到 OpenClaw event / WebUI event 的中枢映射点

#### `buildUserMessage`

- 生成 messagesSnapshot 中的 user message

#### `buildAssistantMessage`

- 生成 messagesSnapshot 中的 assistant message

#### `normalizeAcpUsage`

- 把 ACP usage 形状转成 OpenClaw normalized usage

### 7.7 `src/runtime-client.ts`

角色：

- projection orchestration + session binding persistence

关键函数：

#### `resolveOpenClawStateDir`

- 确定 `.openclaw` 状态目录

#### `resolveSessionBindingsStorePath`

- 给 session binding JSON 文件定路径

#### `loadPersistedBindings`

- 启动时恢复绑定缓存

#### `persistBindings`

- 把内存 binding map 刷回磁盘

#### `computeSessionBindingHash`

- 生成 session 可复用判断的核心哈希

#### `buildRuntimeRoot`

- 决定 execenv runtime 根目录

#### `sanitizeSessionAnchor`

- 把任意输入规整成可落盘的目录片段

#### `resolveStableSessionAnchor`

- 从 sessionId / sessionFile / sessionKey 等候选值里确定稳定锚点

#### `prepareProjectedExecutionEnv`

- projection 主编排函数

#### `readSessionBinding`

- 查 binding

#### `writeSessionBinding`

- 写 binding

#### `clearSessionBinding`

- 清 binding

### 7.8 `src/context-assembler.ts`

角色：

- 读取 workspace 内容并构造成投影上下文

关键函数：

#### `readFileIfExists`

- 安静读取存在的文件

#### `readJsonIfExists`

- 安静读取 JSON

#### `estimateTokens`

- 用字符数估算 token

#### `adaptiveMemorySummary`

- 长记忆裁剪

#### `assembleContext`

- L0-L3 上下文装配主函数

#### `readSkillsManifest`

- 扫描 skills 目录

#### `assembleProjectedContext`

- 生成 execenv 物化所需的投影结构

#### `formatProjectedSkill`

- 把 skill 格式化成 prompt 中可读文本

#### `serializeContextForPrompt`

- 把通用 ContextPayload 序列化成 prompt 文本

#### `serializeProjectedContextForPrompt`

- 把 projected context + skills + runtime cwd 序列化成 Hermes bootstrap prompt

### 7.9 `src/execenv-builder.ts`

角色：

- 物化并同步 execenv

关键函数：

#### `hashText`

- 生成哈希

#### `copyProjectedSkill`

- 把 skill 复制进 execenv

#### `buildManifest`

- 生成 `projection.json`

#### `runCommand`

- 执行 docker / shell 命令

#### `streamDirectoryToContainer`

- 用 tar pipe 把目录流式同步到容器

#### `streamDirectoryFromContainer`

- 从容器回拉目录

#### `mirrorExecEnvToContainer`

- 把 execenv 整体同步进 Hermes 容器

#### `uniqueSortedPaths`

- 路径去重排序

#### `mirrorDirectoryToContainer`

- 同步单目录到容器

#### `mirrorDirectoryFromContainer`

- 从容器拉单目录

#### `mirrorWorkspaceToContainer`

- 增量同步 prompt 引用目录

#### `mirrorWorkspaceFromContainer`

- 增量回拉 prompt 引用目录

#### `buildExecEnv`

- 核心 execenv 物化函数

#### `cleanupExecEnvs`

- 清理历史 execenv

### 7.10 `src/acp-client.ts`

角色：

- JSON-RPC over NDJSON 的 Hermes ACP client

关键函数：

#### `start`

- 建立 TCP 连接并 initialize

#### `startTcp`

- 建 socket、readline、错误处理、关闭处理

#### `newSession`

- 新建 ACP session

#### `resumeSession`

- 恢复 ACP session

#### `prompt`

- 发 prompt 并监听 streaming event

#### `cancel`

- 取消 session

#### `close`

- 关闭 client

#### `sendRequest`

- 发 JSON-RPC request 并管理 pendingRequests

#### `handleLine`

- 解析 NDJSON 响应行

#### `handleResponse`

- 处理 JSON-RPC response

#### `handleNotification`

- 处理服务端推送事件

#### `rejectAllPending`

- 连接断开时批量失败所有 pending request

#### `extractAcpText`

- 从 ACP content 结构中提取文本

#### `stringifyAcpToolOutput`

- 把 tool 输出转成字符串

#### `isTerminalStopReason`

- 判断 stop reason 是否属于结束态

### 7.11 `src/webui-event-bridge.ts`

角色：

- OpenClaw WebUI 事件桥

关键函数：

#### `loadScopeReader`

- 动态装载 gateway request scope reader

#### `findBundledGatewayRequestScopeModules`

- 在安装版 dist 中查找 hashed shard

#### `nextSeq`

- 维护每个 runId 的事件序号

#### `resolveScope`

- 判断当前调用是否运行在真实 gateway turn 里

#### `emitAgent`

- 发 agent 流事件

#### `emitChat`

- 发 chat 流事件

#### `createWebUiEventBridge`

- 封装 lifecycle / assistant / thinking / tool 的发送接口

### 7.12 `src/agent-event-bridge.ts`

角色：

- 兼容 OpenClaw 内部 agent event emitter

关键函数：

#### `publishHermesHarnessAgentEvent`

- 同时发内部 emitter 和 harness 回调

#### `emitHermesHarnessAgentEvent`

- 异步 best-effort 发送

#### `setHermesHarnessAgentEventEmitterForTest`

- 测试注入 emitter

#### `loadOpenClawAgentEventEmitter`

- 惰性加载 emitter

#### `resolveOpenClawAgentEventEmitter`

- 在多种 OpenClaw 安装布局里寻找 emitter 模块

#### `findBundledAgentEventModules`

- 扫描 hashed bundle

#### `tryLoadEmitter`

- 尝试从模块里提取命名或混淆后的 emitter 导出

#### `readNonEmptyString`

- 安全读取字符串

### 7.13 `src/strategy-engine.ts`

角色：

- 旧分层协议 L/C/W 的自动推断器

关键函数：

#### `matchesAny`

- 正则集合匹配

#### `inferContextLevel`

- 推断 L0-L3

#### `inferCredentialScope`

- 推断 C0-C2

#### `inferWritebackLevel`

- 推断 W0-W3

#### `inferStrategy`

- 综合生成 `StrategyTriple`

#### `formatStrategy`

- 格式化为可展示文本

### 7.14 `src/dispatcher.ts`

角色：

- 旧 `hermes_dispatch` 工具体系的主调度器

说明：

- 这条路径仍然可用，但不是当前 WebUI / provider / harness 主路径
- 基线化阶段保留它，避免破坏兼容性

关键函数：

#### `resumeOrCreateSession`

- tool 路径下的 session 复用

#### `dispatchToHermes`

- tool 调度主入口

#### `makeErrorResult`

- 构造失败结果

#### `makeTimeoutResult`

- 构造超时结果

#### `dispatchDirectly`

- 在关闭 layered protocol 时直接发送原始任务

### 7.15 `src/credential-injector.ts`

角色：

- 旧工具链路下的 credential scope 处理

关键函数：

#### `injectCredentials`

- 基于 scope 构造 envVars 和审计日志

#### `buildDockerEnvFlags`

- 生成 docker `-e` 参数列表

#### `resolveCredentialKeys`

- 把逻辑服务名映射到真实环境变量键

#### `maskValue`

- 审计日志脱敏

### 7.16 `src/result-processor.ts`

角色：

- 旧工具链路下的 writeback 实现

关键函数：

#### `processResult`

- 按 W0-W3 处理结果

#### `applyWriteback`

- 把 writeback 落到文件系统

#### `processMemoryWriteback`

- 解析 memory 更新

#### `applyMemoryUpdate`

- 落地 daily / MEMORY.md

#### `processFullWriteback`

- 检测 skill / cron 创建

#### `extractTaskSummary`

- 提取任务摘要

#### `containsSignificantLearning`

- 判断是否值得写入长期记忆

#### `extractLearning`

- 抽学习结论

#### `parseSkillCreationEvent`

- 从事件里识别 skill 创建结果

### 7.17 `src/runtime-paths.ts`

角色：

- 统一 host / runtime 的 execenv 路径计算

关键函数：

#### `resolveExecEnvHostRoot`

- 宿主机 execenv 根目录

#### `resolveExecEnvRuntimeRoot`

- Hermes 容器可见 execenv 根目录

#### `resolveExecEnvHostPath`

- 宿主机单任务路径

#### `resolveExecEnvRuntimePath`

- 容器单任务路径

### 7.18 `src/health.ts`

角色：

- 检查 Hermes 容器与 ACP bridge 是否可用

关键函数：

#### `buildHermesExecArgs`

- 构造容器内 hermes 命令

#### `checkHealth`

- 主健康检查流程

#### `checkContainerRunning`

- 检查容器是否在运行

#### `getContainerStats`

- 读取 CPU / 内存

#### `getHermesVersion`

- 读取容器内 Hermes 版本

#### `checkAcpResponsive`

- 检查 ACP 命令可用性

#### `formatHealthReport`

- 格式化结果

### 7.19 `test-e2e.ts` 与 `scripts/`

角色：

- 回归测试与安装版验证

重点文件：

#### `test-e2e.ts`

- 当前仓库主 E2E 回归脚本

#### `scripts/test-runtime-regression.ts`

- runtime 回归集合

#### `scripts/test-gateway-attempt-full.ts`

- 网关完整 attempt 覆盖

#### `scripts/test-projection.ts`

- projection 行为验证

#### `scripts/test-plugin-registration-static.ts`

- 静态注册面验证

#### `scripts/test-installed-openclaw-resolution.mjs`

- 安装版 OpenClaw 路径解析验证

#### `scripts/run-pi-hermes-bench-v2.mjs`

- Pi 与 Hermes 对比基准脚本

## 8. 关键时序图

### 8.1 `/model hermes` 请求时序

```text
WebUI
  -> OpenClaw Gateway
  -> Hermes provider resolve
  -> Hermes harness runAttempt
  -> prepareProjectedExecutionEnv
  -> buildExecEnv
  -> mirrorWorkspaceToContainer
  -> ACP initialize
  -> session/resume or session/new
  -> session/prompt
  -> ACP streaming events
  -> WebUI bridge(agent/chat)
  -> mirrorWorkspaceFromContainer
  -> AgentHarnessAttemptResult
  -> WebUI render
```

### 8.2 session binding 状态图

```text
task/session arrives
  -> compute bindingHash
  -> existing binding?
      -> no  -> newSession -> persist binding
      -> yes -> resumeSession succeeds -> refresh binding
      -> yes -> resumeSession fails -> clear binding -> newSession -> persist binding
```

### 8.3 workspace mirror 图

```text
prompt text
  -> extract absolute workspace paths
  -> dirname(path)
  -> unique/sort
  -> sync only these dirs to container
  -> Hermes writes files
  -> sync only these dirs back to host
```

## 9. 后续飞书版本要补充的图

飞书版会补以下图：

- 总体架构图
- 请求时序图
- execenv 投影图
- session binding 状态图
- WebUI 事件桥接图
- 文件到函数映射表

## 10. 适合继续产品化的方向

- 把 `docs/hermes-code-walkthrough-zh.md` 拆成“架构篇 / Runtime 篇 / WebUI 篇 / 测试篇”
- 为每个关键函数补输入输出表
- 增加真实回归脚本与文档的双向链接
- 进一步压缩 dispatcher 遗留的旧分层协议描述，突出当前 harness 主路径
