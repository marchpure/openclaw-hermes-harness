# Hermes Runtime 真实优化对比报告（2026-04-23）

## 1. 验证约束

- 验证入口：真实本地 `openclaw agent --local`
- Runtime：`pi-bench` vs `hermes-bench`
- 严格禁止 mock
- 所有结果均来自本机 OpenClaw + 已安装 Hermes 插件 + 本地 Hermes ACP bridge

## 2. 关键根因

### 根因 A：Hermes session anchor 过宽，导致不同 benchmark case 复用同一 ACP session / execenv

影响：
- prompt token 膨胀
- 时延恶化
- case 间上下文污染

修复：
- `resolveStableSessionAnchor()` 优先使用 `sessionId`

### 根因 B：安装态插件缺失 workspace mirror，导致 Hermes 工具写入只落在容器内，不回写宿主机

影响：
- `FS-01-write-file` 假成功
- `FS-02-read-rule` 易受容器私有状态污染

修复：
- 在安装态插件中补齐 workspace mirror
- 已在真实 OpenClaw 链路验证宿主机写文件恢复

### 根因 C：workspace mirror 采用全量同步，错误把整个 `/root/.openclaw/workspace`（约 1.5G）每轮复制到容器

影响：
- Hermes `CHAT-01` 从几十秒膨胀到 `117s`
- Hermes `FS-01` 膨胀到 `133s`

根因定位：
- `/root/.openclaw/workspace` 总体量约 `1.5G`
- 其中 `.meta/env` 约 `1.4G`
- 全量 mirror 会把与当前 case 无关的大缓存目录一起复制

修复：
- 将 workspace mirror 改为“按 prompt 中实际引用到的 workspace 路径父目录做按需同步”
- 保留真实文件一致性，同时去掉全量同步的时延灾难

## 3. 用例集合

- `CHAT-01-basic`
- `FS-01-write-file`
- `FS-02-read-rule`
- `CTX-01-user-skill-awareness`

## 4. 优化前 vs 优化后

### 4.1 Hermes 优化前

- `CHAT-01-basic`: 38.3s，成功
- `FS-01-write-file`: 47.0s，失败，宿主机文件不存在
- `FS-02-read-rule`: 227.5s，失败，超时/回退污染
- `CTX-01-user-skill-awareness`: 42.9s，成功
- 成功率：`2/4`

### 4.2 Hermes 修复 workspace mirror 后但未做按需同步

- `CHAT-01-basic`: 117.2s，成功
- `FS-01-write-file`: 133.4s，成功

结论：
- 功能修回了，但全量 mirror 造成严重时延回退，不可接受

### 4.3 Hermes 当前优化后（按需同步）

- `CHAT-01-basic`: 36.4s，成功
- `FS-01-write-file`: 43.9s，成功
- `FS-02-read-rule`: 42.2s，成功
- `CTX-01-user-skill-awareness`: 38.5s，成功
- 成功率：`4/4`

## 5. 与 Pi 当前真实基线对比

Pi 本轮真实 wall time：
- `CHAT-01-basic`: 46.3s，成功
- `FS-01-write-file`: 44.2s，成功
- `FS-02-read-rule`: 45.8s，成功
- `CTX-01-user-skill-awareness`: 42.1s，失败（NO_USER_MD）
- 成功率：`3/4`

Hermes 当前 vs Pi：
- `CHAT-01-basic`: Hermes 快约 `10.0s`
- `FS-01-write-file`: Hermes 快约 `0.3s`
- `FS-02-read-rule`: Hermes 快约 `3.6s`
- `CTX-01-user-skill-awareness`: Hermes 快约 `3.6s`，且 Hermes 成功、Pi 失败

## 6. 结论

当前这组真实本地 OpenClaw 数据下：

- Hermes 已从“功能不完整、存在假成功”修复到 `4/4` 成功
- Hermes 已从全量 workspace mirror 造成的 `100s+` 回退恢复到与 Pi 同量级
- 在当前 4 个核心用例上，Hermes 相比 Pi：
  - 成功率更高
  - wall time 不劣于 Pi，且 4 个 case 全部更快
  - `CTX-01` 用户感知能力明显优于 Pi

## 7. 仍需继续优化的项

虽然当前 Hermes 已经优于 Pi，但还有两个系统级问题需要继续盯：

1. OpenClaw 端到端 wall time 仍显著大于 `meta.durationMs`
   - 说明公共插件层初始化和外围链路仍然重
2. `memory-lancedb-ultra` 的 `local embeddings` 仍会偶发 3 秒超时重试
   - 这会污染 Pi 和 Hermes 的端到端用户感知时延

这两个问题不再是 Hermes 单边劣化，但会继续影响绝对时延，需要单独列为基础设施优化项。
