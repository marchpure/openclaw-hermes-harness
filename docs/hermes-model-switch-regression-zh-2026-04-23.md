# Hermes 模式切换回归用例与预期回答（2026-04-23）

## 1. 文档目标

本文档专门用于约束以下场景在真实 OpenClaw 链路下的行为：

- 同一个 agent 在 `/model ark` 和 `/model hermes` 之间切换
- 切换到 `/model hermes` 后，session、workspace、skills、`USER.md`、`AGENTS.md` 是否仍然正确传递
- `/model hermes` 下普通问答、身份问答、技能问答、session 连续性、session 隔离是否满足预期

本文件不使用 mock 作为验收依据，所有结论都要求基于真实 OpenClaw + 已安装 Hermes 插件 + 本地 Hermes ACP bridge 验证。

## 2. 验收范围

| 维度 | 验收目标 |
|---|---|
| model 切换 | `/model ark` 与 `/model hermes` 切换后，当前 agent 不应丢失自己的 workspace 绑定 |
| workspace context | `/model hermes` 下能看到当前 agent 的 `USER.md`、`AGENTS.md`、`SOUL.md` |
| skills projection | 当前 agent workspace 下的 skills 能正确传递到 Hermes execenv |
| session continuity | 同 session 连续对话时，Hermes 保留应保留的上下文 |
| session isolation | 新 session 不继承旧 session marker |
| 基础问答 | `/model hermes` 下基础问答有稳定 final reply |
| 项目泛化 | 不应在无关问答里总是强调 `openclaw-control-ui` 或错误项目身份 |

## 3. 当前专项已验证结论

截至 2026-04-23，本轮已经完成的核心专项检查点共 8 个，结果为 `8/8 通过`：

| 用例 | 结果 | 结论 |
|---|---|---|
| `AGENT-SKILL-01` | 通过 | agent 专属 workspace skills 已投影到 Hermes |
| `AGENT-SKILL-02` | 通过 | `hostWorkspaceDir` 正确绑定到 agent workspace |
| `AGENT-SKILL-03` | 通过 | `sourcePath` 为真实 workspace 路径，不再是 `<snapshot>/...` |
| `AGENT-SKILL-04` | 通过 | skills 已真实落盘到 execenv |
| `AGENT-CTX-01` | 通过 | `USER.md` / `AGENTS.md` / skills 在 Hermes 下可见 |
| `AGENT-SES-01` | 通过 | Hermes session binding 正常生成 |
| `AGENT-LOG-01` | 通过 | 本轮无新增 `<snapshot>/... ENOENT` |
| `AGENT-LOG-02` | 通过 | 本轮无 fallback 到 embedded PI backend |

## 4. 建议新增回归用例矩阵

下面这一组用例用于补齐 `/model hermes` 模式下的长期回归护栏，尤其强调“预期回答”。

### 4.1 model 切换与上下文继承

| 用例编号 | 场景 | 操作 | `/model hermes` 预期回答 | 不通过判定 |
|---|---|---|---|---|
| `MS-HERMES-01` | ark 切到 hermes 后身份一致 | 先 `/model ark`，再 `/model hermes`，提问“你是谁？” | 回答应反映当前 agent 的真实身份，不应退化成空模板，不应说“skills 为空” | 回答成默认空身份、错误项目身份或 `skills: []` |
| `MS-HERMES-02` | ark 切到 hermes 后 USER.md 可见 | `/model hermes` 后问“请说明你能看到的 USER.md 信息” | 明确说明 USER.md 中的有效信息，至少能确认 USER.md 已加载 | 回答看不到 USER.md，或只说模板为空但实际不符 |
| `MS-HERMES-03` | ark 切到 hermes 后 AGENTS.md 可见 | `/model hermes` 后问“请说明你能看到的 AGENTS.md 规则” | 至少总结当前 agent workspace 下 AGENTS.md 的关键规则 | 看不到 AGENTS.md 或只输出 Hermes 容器全局规则 |
| `MS-HERMES-04` | ark 切到 hermes 后 skills 可见 | `/model hermes` 后问“列出你能使用的 OpenClaw skills” | 应列出当前 agent workspace skills，例如 `stock-metrics`、`stock-risk`、`stock-report` | skills 丢失、只剩空数组、或只剩 Hermes 内置 skills |

### 4.2 基础问答稳定性

| 用例编号 | 场景 | 操作 | `/model hermes` 预期回答 | 不通过判定 |
|---|---|---|---|---|
| `MS-HERMES-05` | 基础 greeting | 问“你好” | 应返回正常 greeting 和可执行帮助，不应只输出工具日志，不应卡死 | 无 final、tick-only、空回复 |
| `MS-HERMES-06` | 简单身份问答 | 问“你能帮我做什么？” | 应结合当前 agent 能力回答，可提当前 skills，但不应伪造不存在的能力 | 回答和 agent 身份严重不符 |
| `MS-HERMES-07` | 无关领域普通问答 | 问“今天天气怎么样”或“什么是 ETF” | 如果无实时工具，应明确说明限制并正常作答；不应硬绑定 `openclaw-control-ui` | 无关问题被强行拉回项目上下文 |
| `MS-HERMES-08` | 避免过度项目绑定 | 问“你好”或“你是谁” | 不应默认强调“当前正在为 openclaw-control-ui 项目服务”，除非当前 agent workspace 本来就是这个项目且与问题相关 | 无关问答仍持续强调 `openclaw-control-ui` |

### 4.3 skills 感知与预期回答

| 用例编号 | 场景 | 操作 | `/model hermes` 预期回答 | 不通过判定 |
|---|---|---|---|---|
| `MS-HERMES-09` | skills 枚举 | 问“列出你当前可见的 OpenClaw skills” | 至少列出当前 workspace skill 名称，不要求逐字一致，但要覆盖关键 skills | 少列、漏列或说没有 skills |
| `MS-HERMES-10` | skill 能力说明 | 问“`stock-metrics` 是做什么的？” | 应基于 skill 文档说明其用途 | 说不存在该 skill |
| `MS-HERMES-11` | skill 组合规划 | 问“如果分析股票，你会怎么组合使用这些 skills？” | 应能合理提到 `stock-metrics` / `stock-risk` / `stock-report` 的分工 | 看不到 skills 或回答泛化 |
| `MS-HERMES-12` | skill 存在性校验 | 问“你是否有 `stock-risk` 这个 skill，只回答 yes/no 并补一句解释” | 预期包含 `yes` 且解释来自当前 workspace skill | 回答 `no` 或解释与实际不符 |

### 4.4 session 连续性

| 用例编号 | 场景 | 操作 | `/model hermes` 预期回答 | 不通过判定 |
|---|---|---|---|---|
| `MS-HERMES-13` | 同 session 两步连续 | 第一步让它记住 marker，第二步问 marker 是什么 | 第二步应能返回同 session marker | 同 session 丢失必要上下文 |
| `MS-HERMES-14` | 同 session skills 记忆稳定 | 第一步让它列出 skills，第二步问“刚才你列出的第二个 skill 是什么” | 应能回答出同 session 中刚列出的 skill | 同 session 内上下文断裂 |
| `MS-HERMES-15` | 同 session model 已切到 hermes | `/model hermes` 后连续两问 | 两问都应由 Hermes 处理，provider 不应漂移 | 中途漂移到 PI 或其他 provider |

### 4.5 session 隔离

| 用例编号 | 场景 | 操作 | `/model hermes` 预期回答 | 不通过判定 |
|---|---|---|---|---|
| `MS-HERMES-16` | 新 session 不继承旧 marker | session A 写 marker，session B 询问该 marker | session B 应回答不知道或未见过该 marker | 新 session 泄漏旧 session 内容 |
| `MS-HERMES-17` | 新 session 不继承旧对话结论 | session A 问 skill，session B 问“刚才第二个 skill 是什么” | session B 不应知道 session A 的上下文 | session 串线 |
| `MS-HERMES-18` | 新 session 仍能重新看到 skills | session B 再问“列出当前 skills” | 即使不继承旧对话，也应重新从 workspace 正确看到 skills | 新 session 下 skills 消失 |

### 4.6 workspace 与投影一致性

| 用例编号 | 场景 | 操作 | `/model hermes` 预期回答 | 不通过判定 |
|---|---|---|---|---|
| `MS-HERMES-19` | workspace 路径正确 | 问“你当前看到的 workspace 线索来自哪里” | 应反映当前 agent workspace，而不是错误的全局 workspace | 错绑全局 workspace |
| `MS-HERMES-20` | projection 与回答一致 | 先检查 projection.json，再问“你能看到哪些 skills” | 回答中的 skills 集合应与 projection.json 一致 | projection 与回答不一致 |
| `MS-HERMES-21` | USER/AGENTS 与回答一致 | 先检查 workspace 文件，再问相关问题 | Hermes 回答应与当前文件内容一致 | 回答与文件事实不符 |

### 4.7 model 切换往返稳定性

| 用例编号 | 场景 | 操作 | `/model hermes` 预期回答 | 不通过判定 |
|---|---|---|---|---|
| `MS-HERMES-22` | ark -> hermes -> ark -> hermes 往返稳定 | 连续切换 4 次后再问“你有哪些 skills？” | 最终切回 Hermes 后仍能稳定列出当前 workspace skills | 多次切换后 skills 丢失 |
| `MS-HERMES-23` | hermes 切回 ark 不污染 | 先 `/model hermes` 问 skills，再切 `/model ark` 问基础能力，再切回 `/model hermes` | 再次切回 Hermes 后仍回到 Hermes 语义，不应残留 ark 回答风格导致 skills 消失 | 来回切换后语义错乱 |
| `MS-HERMES-24` | 同 agent 多轮切换不丢 session 语义 | 同一 session 内多次切换 model，再问前序明确保留的信息 | 在应该连续的同 session 场景下，仍保留必要上下文 | model 切换导致 session 意外重置 |

### 4.8 任务执行类

| 用例编号 | 场景 | 操作 | `/model hermes` 预期回答 | 不通过判定 |
|---|---|---|---|---|
| `MS-HERMES-25` | skills 驱动的任务规划 | 问“请基于你当前 skills 给出一份股票分析执行计划” | 应明确拆成指标、风险、报告三个阶段，且能映射到 skills | 看不到 skills 或计划与当前 agent 不符 |
| `MS-HERMES-26` | 受限条件下的任务说明 | 问“如果让我给你一只股票代码，你会怎么分析？” | 应说明输入要求、分析步骤、限制条件 | 直接胡乱承诺不存在的数据能力 |
| `MS-HERMES-27` | skill-aware 回答 | 问“你更适合做实时行情，还是做结构化分析？” | 如果无实时数据技能，应明确说更适合结构化分析 | 错把无实时工具说成有实时行情能力 |
| `MS-HERMES-28` | 多 skill 输出整合 | 问“请用你当前 skills 的思路，给一个股票分析报告骨架” | 应自然融合 `metrics`、`risk`、`report` 三部分 | 输出与 skills 结构无关 |

### 4.9 文件与 workspace 可见性

| 用例编号 | 场景 | 操作 | `/model hermes` 预期回答 | 不通过判定 |
|---|---|---|---|---|
| `MS-HERMES-29` | workspace 文件感知 | 问“你能看到哪些关键 workspace 文件？” | 至少提到 `USER.md`、`AGENTS.md`、`SOUL.md`，如果有 skills 目录也应提到 | 看不到关键文件 |
| `MS-HERMES-30` | skill 文件存在性 | 问“`stock-report` 的 skill 文件是否存在？” | 应回答存在，并说明来自当前 workspace | 说不存在或来源错误 |
| `MS-HERMES-31` | 错误 workspace 防御 | 问“你是不是来自 main workspace？” | 如果当前是 agent workspace，应明确否认并说明当前 agent workspace | 错认成全局 main workspace |

### 4.10 回答质量与风格

| 用例编号 | 场景 | 操作 | `/model hermes` 预期回答 | 不通过判定 |
|---|---|---|---|---|
| `MS-HERMES-32` | 基础中文质量 | 用中文问“你是谁？” | 应以自然中文回答，不应莫名切英语 | 中英文混乱或过度工具化 |
| `MS-HERMES-33` | 简洁遵循 | 问“请只用一句话回答你有哪些 skills” | 应尽量遵守格式与长度约束 | 大段跑题 |
| `MS-HERMES-34` | 枚举准确性 | 问“只输出 skill 名称，不要解释” | 应只输出 skill 名称列表 | 带无关长解释 |
| `MS-HERMES-35` | 反问能力 | 问“请先说明限制，再回答你能否做股票分析” | 应先说限制，再说可做的部分 | 顺序错误或漏掉限制 |

### 4.11 异常与保护性回答

| 用例编号 | 场景 | 操作 | `/model hermes` 预期回答 | 不通过判定 |
|---|---|---|---|---|
| `MS-HERMES-36` | 不存在 skill | 问“你有 `foo-bar-skill` 吗？” | 应明确说没有，不应编造存在 | 幻觉 skill |
| `MS-HERMES-37` | 无实时能力保护 | 问“给我今天最新股价并直接下判断” | 如果无实时行情工具，应明确说无法保证最新数据 | 假装实时 |
| `MS-HERMES-38` | 无浏览器保护 | 问“你现在立刻去网上查一下” | 如果当前不可用，应明确说明限制和替代方案 | 假装已联网检索 |
| `MS-HERMES-39` | 无权文件保护 | 问 workspace 外无关路径内容 | 应遵守当前可见范围，不应编造已看到 | 幻觉读取成功 |

### 4.12 发布阻断类

| 用例编号 | 场景 | 操作 | `/model hermes` 预期回答 | 不通过判定 |
|---|---|---|---|---|
| `MS-HERMES-40` | skills 为空阻断 | 问“你有哪些 skills？” | 不允许返回空技能结论，前提是 workspace 实际有 skills | 出现 `skills 为空` |
| `MS-HERMES-41` | 默认项目绑死阻断 | 问“你好” | 不允许默认提 `openclaw-control-ui` | 无关 greeting 被绑项目 |
| `MS-HERMES-42` | 无 final reply 阻断 | 任意基础问答 | 必须有自然语言 final reply | 只有 tool log / tick / thinking |
| `MS-HERMES-43` | fallback 阻断 | 运行真实问答后查日志 | 不允许出现 fallback to PI backend | 任一 fallback 视为阻断 |
| `MS-HERMES-44` | snapshot 伪路径阻断 | 运行真实问答后查日志 | 不允许出现 `<snapshot>/... ENOENT` | 任一伪路径报错视为阻断 |

## 5. `/model hermes` 下建议固定预期回答模板

下面不是要求逐字一致，而是要求回答语义满足验收点。

### 5.1 身份与上下文类

| 问题 | 预期回答语义 |
|---|---|
| 你是谁？ | 说明当前 agent 身份，基于当前 workspace 的 SOUL/USER/AGENTS；不应退化成空模板 |
| 你能看到的 USER.md 是什么？ | 明确说明 USER.md 已加载，并总结关键内容 |
| 你能看到的 AGENTS.md 规则是什么？ | 总结 workspace AGENTS 里的关键规则，不只说 Hermes 自己的开发规范 |
| 你有哪些 OpenClaw skills？ | 列出当前 workspace skills，至少覆盖关键 skill 名称 |

### 5.2 股票分析师 agent 类

如果当前 agent 是股票分析师，`/model hermes` 下建议期望回答应满足：

| 问题 | 预期回答语义 |
|---|---|
| 你可以分析股票吗？ | 应回答可以，并说明会基于当前股票分析师身份和 skills 协助分析 |
| 你有哪些和股票分析相关的能力？ | 应提到指标分析、风险分析、报告生成等，最好能映射到 `stock-metrics` / `stock-risk` / `stock-report` |
| 你有哪些技能？ | 至少包含 `stock-metrics`、`stock-risk`、`stock-report` |

不应出现的回答：

- “skills 为空”
- “当前项目没有提供 OpenClaw 技能”
- “我无法直接访问该项目的特定功能或代码库内容”

前提：当前 agent workspace 的确配置了这些 skills。

### 5.3 基础 greeting 类

| 问题 | 预期回答语义 |
|---|---|
| 你好 | 正常 greeting，不应只出现项目名绑定，也不应空回复 |
| 你能帮我做什么？ | 正常说明当前 agent 能力和约束，不应退化成纯系统提示 |

### 5.4 技能与任务规划类

| 问题 | 预期回答语义 |
|---|---|
| 你有哪些 OpenClaw skills？ | 以清晰列表回答，至少覆盖当前 workspace 核心 skills |
| `stock-metrics` 是做什么的？ | 简要说明该 skill 的职责，不编造无关能力 |
| 如果分析股票，你会怎么组合这些 skills？ | 明确说明 metrics / risk / report 的分工 |
| 请给一个股票分析报告骨架 | 报告结构应能映射到当前 skills |

### 5.5 session 连续性类

| 问题 | 预期回答语义 |
|---|---|
| 我刚才让你记住的 marker 是什么？ | 同 session 下应能返回前序 marker |
| 刚才你列出的第二个 skill 是什么？ | 同 session 下应能依据前一轮回答继续 |

### 5.6 session 隔离类

| 问题 | 预期回答语义 |
|---|---|
| 另一个 session 里的 marker 是什么？ | 新 session 下应回答不知道或无法得知 |
| 刚才那个 session 列出的第二个 skill 是什么？ | 新 session 不应继承旧 session 的对话内容 |

不应出现的回答：

- “我注意到您的标签是 openclaw-control-ui”
- 无关情况下反复强调某个项目名
- 只有工具调用痕迹，没有自然语言 final answer

### 5.7 明确反例集合

以下回答在 `/model hermes` 模式下应视为高风险反例：

- “skills: []”
- “当前项目没有提供 OpenClaw 技能”
- “我无法直接访问该项目的特定功能或代码库内容”
- “我注意到您的标签是 openclaw-control-ui”
- 与当前 agent 无关的默认项目身份说明
- 只有工具执行痕迹，没有自然语言 final answer
- 无实时工具时却声称拿到了“今天最新”实时股价

## 6. 推荐执行顺序

建议把这套回归按下面顺序执行：

1. `/model hermes` 基础 greeting 与 final reply
2. `USER.md` / `AGENTS.md` / skills 可见性
3. 同 session 连续性
4. 新 session 隔离
5. projection.json 与回答一致性
6. ark/hermes 来回切换稳定性
7. 任务规划与 skill-aware 回答
8. 异常与保护性回答
9. 发布阻断日志检查

## 7. 发布门槛建议

以下任一不满足，都不应发布：

- `/model hermes` 下基础问答无 final reply
- 当前 agent workspace skills 在 Hermes 下消失
- Hermes 回答看不到 `USER.md` / `AGENTS.md`
- 出现 `<snapshot>/... ENOENT`
- 出现 `falling back to embedded PI backend`
- 无关问答持续错误强调 `openclaw-control-ui`
- 新 session 泄漏旧 session marker
- `/model hermes` 下对不存在 skill 产生幻觉
- 无实时工具时谎称已获取最新实时行情

## 8. 推荐优先级

| 优先级 | 用例范围 | 用途 |
|---|---|---|
| P0 | `MS-HERMES-01` 到 `MS-HERMES-08`，`MS-HERMES-40` 到 `MS-HERMES-44` | 发布阻断 |
| P1 | `MS-HERMES-09` 到 `MS-HERMES-21` | skills / session / projection 核心稳定性 |

## 9. 2026-04-23 软链接 skills 专项根因定位与修复

### 9.1 问题现象

用户在真实 OpenClaw 环境中反馈：

- agent 实际 workspace 下已经存在 `skills/`
- 这些 `skills/<name>` 是软链接，指向共享技能库
- `/model ark` 下 agent 身份与技能正常
- `/model hermes` 下却出现 “skills 为空” / “当前项目没有提供 OpenClaw 技能”

该现象必须以真实 agent、真实 Hermes 链路复现，不接受 mock。

### 9.2 真实复现场景

本轮使用真实 agent `ms-symlink-a` 进行复现，workspace 为：

- `/root/.openclaw/.arkclaw-team/projects/project-1/workspaces/ms-symlink-a`

其中 `skills/` 为软链接结构：

- `stock-metrics -> /root/.openclaw/.arkclaw-team/projects/project-1/shared-skill-bank/stock-metrics`
- `stock-risk -> /root/.openclaw/.arkclaw-team/projects/project-1/shared-skill-bank/stock-risk`
- `stock-report -> /root/.openclaw/.arkclaw-team/projects/project-1/shared-skill-bank/stock-report`

并且 3 个软链接下都实际存在 `SKILL.md`。

### 9.3 根因

根因已定位到 Hermes 插件的 skills manifest 扫描逻辑。

旧逻辑只接受：

- `entry.isDirectory() === true`

这意味着：

- 当 `skills/<name>` 是真实目录时，可以被识别
- 当 `skills/<name>` 是“指向目录的符号链接”时，会被直接跳过

因此 Hermes 在构建 `projection.json` 时把这些软链接 skill 全部漏掉，最终表现为：

- `projection.json` 中 `"skills": []`
- `/model hermes` 回答中声称没有 skills

### 9.4 代码修复

修复文件：

- [context-assembler.ts](/root/openclaw-hermes-harness/src/context-assembler.ts#L212)

修复要点：

- 允许 `Dirent.isDirectory()` 或 `Dirent.isSymbolicLink()`
- 对 `skills/<name>/SKILL.md` 再做一次 `stat()`
- 仅当最终 materialize 成真实可读文件时才纳入 manifest

当前关键代码语义为：

- 非目录且非软链接：跳过
- 目录或软链接：继续检查其下 `SKILL.md`
- `SKILL.md` 不存在或不是文件：跳过
- `SKILL.md` 可读：纳入 Hermes skills manifest

这次修复也已同步到已安装插件源码并重新编译：

- `/root/.openclaw/extensions/hermes/src/context-assembler.ts`
- `/root/.openclaw/extensions/hermes/dist/context-assembler.js`

随后执行了：

```bash
openclaw gateway restart
```

确保真实 OpenClaw runtime 加载的是修复后代码。

### 9.5 修复前证据

修复前的真实 Hermes 投影文件：

- `/var/cache/hermes-agent/execenv/c9c902be5812793f7b797a916e004bcc8d2482d8576b539df705d19815bf683c/projection.json`

关键现象：

- `hostWorkspaceDir` 已经正确指向 `ms-symlink-a`
- 但 `"skills": []`

这说明问题不在 workspace 绑定本身，而在 skills 枚举阶段。

### 9.6 修复后投影验证

修复后再次使用真实 `ms-symlink-a` 触发 Hermes 会话，得到新的真实投影文件：

- `/var/cache/hermes-agent/execenv/84325ab3e1c6236290218e081da1548117d06201dce6ea9e22b4373464b9c8a5/projection.json`

其中 `skills` 已正确包含：

| skill | sourcePath |
|---|---|
| `stock-metrics` | `/root/.openclaw/.arkclaw-team/projects/project-1/workspaces/ms-symlink-a/skills/stock-metrics/SKILL.md` |
| `stock-report` | `/root/.openclaw/.arkclaw-team/projects/project-1/workspaces/ms-symlink-a/skills/stock-report/SKILL.md` |
| `stock-risk` | `/root/.openclaw/.arkclaw-team/projects/project-1/workspaces/ms-symlink-a/skills/stock-risk/SKILL.md` |

结论：

- Hermes 现在已经能正确投影软链接形式的 workspace skills
- `sourcePath`、`path`、`projectedPath` 都已经形成闭环

### 9.7 修复后真实问答验证

本轮全部基于真实命令：

```bash
openclaw agent --local --agent ms-symlink-a --session-id <id> --message <text> --json
```

并从真实 `openclaw` 日志核验 `provider=hermes`、`fallbackUsed=false`。

#### SYMLINK-01

问题：

- `你是否有 stock-risk 这个 skill？请先回答 yes/no，再补一句解释。`

真实结果：

- `yes`
- `该技能为OpenClaw共享技能库提供的可用能力，支持输出股票风险拆解分析内容。`

日志判定：

- `winnerProvider = hermes`
- `fallbackUsed = false`

#### SYMLINK-02

问题：

- `你是谁？请说明你能看到的 USER.md 或技能线索。`

真实结果要点：

- 明确回答自己是搭载 OpenClaw 共享股票分析技能库的股票分析助手
- 明确说明已加载 3 个股票分析定向技能
- 正确列出：
  - `stock-metrics`
  - `stock-risk`
  - `stock-report`
- 明确说明“技能目录子项为软链接时也可正常识别调用”

日志判定：

- `winnerProvider = hermes`
- `fallbackUsed = false`

### 9.8 新增专项回归结论

本轮新增软链接专项回归结论如下：

| 用例 | 结果 | 说明 |
|---|---|---|
| `MS-HERMES-SYMLINK-01` | 通过 | 软链接 skill 可进入 `projection.json` |
| `MS-HERMES-SYMLINK-02` | 通过 | Hermes 能识别 `stock-risk` 存在 |
| `MS-HERMES-SYMLINK-03` | 通过 | Hermes 身份回答可列出 3 个软链接技能 |
| `MS-HERMES-SYMLINK-04` | 通过 | 真实执行链路为 Hermes，`fallbackUsed=false` |

### 9.9 回归门槛补充

后续发布必须新增以下阻断项：

- 若 agent workspace `skills/` 下存在软链接技能目录，Hermes 不得把它们扫描成空数组
- 若 `projection.json` 中 `hostWorkspaceDir` 正确但 `skills` 为空，视为 P0 阻断
- `/model hermes` 下对 skill 存在性的问答必须与 `projection.json` 一致
- 真实日志若显示 `provider != hermes` 或 `fallbackUsed=true`，该专项验证无效
| P2 | `MS-HERMES-22` 到 `MS-HERMES-39` | 长链路、风格和异常保护增强验证 |

## 9. 真实 OpenClaw Agent 专项验证进展

### 9.1 本轮真实创建的 agent

本轮验证严格使用真实 OpenClaw agent，而不是 mock。已创建并注册以下 agent：

| agent id | workspace | model | 用途 |
|---|---|---|---|
| `ms-stock-a` | `/root/.openclaw/.arkclaw-team/projects/project-1/workspaces/ms-stock-a` | `hermes/default` | 股票分析师主验证 agent，包含 `stock-metrics` / `stock-risk` / `stock-report` |
| `ms-stock-b` | `/root/.openclaw/.arkclaw-team/projects/project-1/workspaces/ms-stock-b` | `hermes/default` | 股票分析师限制性验证 agent，强调“无实时能力时要明确限制” |
| `ms-general-a` | `/root/.openclaw/.arkclaw-team/projects/project-1/workspaces/ms-general-a` | `hermes/default` | 通用问答 agent，用于验证不应无关绑定 `openclaw-control-ui` |

### 9.2 已开始执行的真实验证集

当前已启动一轮基于真实 `openclaw agent --local --agent <id>` 的专项验证，目标覆盖：

- 身份与上下文继承
- `USER.md` / `AGENTS.md` / skills 可见性
- 基础 greeting
- 无关项目绑定抑制
- session 连续性
- session 隔离
- 无实时能力保护
- 不存在 skill 的保护性回答

执行产物目录：

- `/root/openclaw-hermes-harness/artifacts/hermes-model-switch-real-validation-2026-04-23`

### 9.3 已完成的真实结果

截至当前，至少已有以下真实用例完成并验证通过：

| 用例 | agent | 结果 | 关键证据 |
|---|---|---|---|
| `MS-HERMES-01` | `ms-stock-a` | 通过 | `provider=hermes`、`model=default`、`fallbackUsed=false` |

`MS-HERMES-01` 实际回答摘要：

| 验收点 | 实际结果 |
|---|---|
| 身份 | 明确说明自己是“A股的结构化专业股票分析助理” |
| USER.md 线索 | 明确提到“中文回答”“先结论后展开”“关注A股” |
| skills 线索 | 明确列出 `stock-metrics`、`stock-risk`、`stock-report` |
| 限制说明 | 明确说明“无实时行情/实时基本面数据源” |

该结果满足：

- `MS-HERMES-01`
- `MS-HERMES-02` 的部分预期
- `MS-HERMES-04` 的部分预期
- `MS-HERMES-27` 的部分预期

### 9.4 当前执行状态说明

当前剩余用例仍在真实 OpenClaw 链路上顺序执行，后续应继续把结果追加回本文档。若中途需要人工中断，也应保留以下事实：

- 真实 agent 已创建成功
- 至少一条关键 P0 用例已在真实环境中通过
- 当前 `stderr` 才是 `openclaw agent --json` 的结构化输出来源，后续采集脚本需按此适配

## 10. 本文档用途

本文档可直接作为：

- `/model hermes` 切换专项回归基线
- 人工测试 checklist
- 后续自动化脚本与飞书测试文档的模板
- 代码改动后的回归门槛说明
