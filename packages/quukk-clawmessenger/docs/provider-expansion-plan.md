# Provider 扩展方案：从 4 家白名单到 24 家数据驱动

> 状态：待评审（本文档只做方案设计，未改任何业务代码）
> 范围：quukk-clawmessenger Go 运行时 + TS CLI + clawmessenger-server（Python）+ clawmessenger-admin-web
> 日期：2026-10-08

---

## 1. 背景与现状

### 1.1 三层架构与"只放行 4 家"的真正原因

智能体 CLI 的实际 spawn/管理在 **Go 运行时**（`server/pkg/agent/`，编译为 clawmessenger-runtime 二进制，经 npm 包 `@quukk/clawmessenger-runtime-*` 分发）。Go 侧 `agent.SupportedTypes` 早已支持 **24 种** backend，daemon 的发现层 `probeAgentCLIs`（`server/internal/daemon/agents_probe.go:91-283`）也本来就会扫描全部 24 家。

但一个 provider 从"Go 认识"到"用户可绑定"，要穿过**三个硬编码白名单（咽喉点）**，每层都写死了 4 家：opencode / openclaw / codex / hermes。

| # | 层 | 文件 | 硬编码内容 |
|---|---|---|---|
| 1 | Go 桥 | `server/internal/daemon/bridge_runtime.go:46,60-65` | `bridgeRuntimeCount = 4`；`bridgeRuntimeSpecs` 定长数组仅 4 条 spec（含能力声明） |
| 1b | Go 桥 | `server/cmd/multica/cmd_bridge.go:190-196` | startup `provider_path_overrides` 白名单 switch 只认 4 家 |
| 2 | TS CLI | `packages/quukk-clawmessenger/src/go/types.ts:6,39-49` | `BridgeProviderSchema = z.enum([4])`；`BridgeRuntimeListSchema = .length(4)` + 顺序 superRefine，多/少/换序都会 parse 失败（bridge_unavailable） |
| 2b | TS CLI | `packages/quukk-clawmessenger/src/config/schema.ts:7,114-119` | `PROVIDERS = [4]`（zod enum，全部绑定/配对逻辑引用）；`providerPathOverridesSchema` strictObject 只有 4 个字段 |
| 3 | Python 服务端 | `clawmessenger-server/pairing_service.py:27`、`device_credentials.py:27` | `_PROVIDERS = {"opencode","openclaw","codex","hermes"}` |
| 3b | Python 服务端 | `id_generator.py:11`、`node_registration_service.py:402`、`command_handler.py:1014` | `AI_NODE_TYPES=("openclaw","opencode","codex","kimi")`（kimi 为遗留，见 §4.4）、回退遍历、前缀探测 |
| 3c | admin 前端 | `clawmessenger-admin-web/src/types/index.ts:45,60` | 类型 union 与筛选项只有 4 家（+遗留 kimi） |

**核心痛点**：Go 运行时每新增/升级一个 provider，都要同步改 TS、Python、admin 三处代码并各自发版，迭代成本高且容易漏改（现状 TS `.length(4)` 连顺序都锁死）。

### 1.2 不需要改的部分（已确认解耦）

- **任务管线与 provider 解耦**：Bridge 不关心协议，`spec.capabilities` 是声明式能力位；任务分发走 `ResolveBackend(provider)`。新增 provider 在任务执行侧自动复用，无需改任务代码。
- **自定义 runtime profile（MUL-3284）不进 bridge catalog**：profile runtime 走 multica 服务器注册路径（daemon.go `appendProfileRuntimes`），与 clawmessenger bridge 无关。扩 provider 只需改 `bridgeRuntimeSpecs`。
- **multica 侧 DB CHECK 约束已覆盖 24 家**：`runtime_profile.protocol_family` 约束从 migration 120 起逐步加宽（403 zeroclaw 为最新），与 `SupportedTypes` 同步。**无需新迁移**。
- **事件模型与后端无关**：`BridgeTaskEvent` 8 型（started/text_delta/tool_started/tool_finished/status/completed/failed/cancelled）是统一协议层，新 provider 直接复用。

---

## 2. 24 Provider 全景与分档

### 2.1 协议家族归纳

| 协议族 | Provider | 说明 |
|---|---|---|
| **ACP**（12） | hermes✅, kimi, reasonix, kiro, qoder, qoderclicn, traecli, grok, qwenpaw, dim, mcode, zeroclaw | 共享 ACP 协议层（initialize/session/resume）；qwenpaw/mcode/zeroclaw 不支持 set_model |
| **stream-json / headless**（10） | claude, codebuddy, cursor, qwen, pi(omp 同族), antigravity, deveco, copilot, openclaw✅(json), opencode✅(json，另有 opencode_acp.go) | 一次性 headless 进程 + 流式解析 |
| **特殊**（2） | codex✅(app-server stdio), dsh(`--profile multica` stdio) | 私有协议 |

✅ = 已放行（现有 4 家）。

### 2.2 分档总表

**分档原则**：
- **Tier 1（直接放行）**：已有 MinVersion 版本门、标准协议、无已知特殊适配点。预期"加 spec + 白名单透传"即可用。
- **Tier 2（需适配/验证）**：无版本门需补下限，或 resume 语义/set_model 缺失/Windows 专项/与 builtin 运行时共享文件等需要逐家验证甚至小改。
- **Tier 2.5（kimi 遗留清理）**：kimi 跨层遗留语义对齐（单独成节，见 §4.4）。
- **Tier 3（暂不放行）**：协议私有、集成面大，等产品需求明确后再评估。

| Provider | 协议族 | MinVersion 现状 | Windows 专项文件 | 特殊性 | 分档 |
|---|---|---|---|---|---|
| opencode / openclaw / codex / hermes | — | codex 0.100.0 | opencode 仅有 stdin 测试 | 已放行基线 | ✅ 现状 |
| **claude** | stream-json | 2.0.0 ✅ | 无（走通用路径） | ThinkingLevel 支持 | **Tier 1** |
| **copilot** | json | 1.0.0 ✅ | copilot_invocation_windows.go ✅ | resumeRejectionUndetectable | **Tier 1** |
| **grok** | ACP | 0.2.89 ✅ | 无 | ACP 全特性（auth/session-load/set_model/MCP） | **Tier 1** |
| **qwen** | stream-json | 0.20.0 ✅ | qwen_invocation_windows.go ✅ | ThinkingLevel 支持 | **Tier 1** |
| **dim** | ACP | 0.3.10 ✅ | 无 | 跨运行 session/load 锁释放 | **Tier 1** |
| **mcode** | ACP | 0.1.2 ✅ | 无 | ACP v1 | **Tier 1** |
| **zeroclaw** | ACP | 0.8.0 ✅ | 无 | 持久 ACP session/resume | **Tier 1** |
| **cursor** | stream-json | ❌ 无 | cursor_invocation_windows.go ✅ | resumeRejectionUndetectable | **Tier 2** |
| **pi** | json mode | ❌ 无 | pi_invocation_windows.go ✅（omp 同享） | 与 builtin omp 同族同文件，需验证共存 | **Tier 2** |
| **codebuddy** | stream-json | ❌ 无 | 无 | ThinkingLevel 支持 | **Tier 2** |
| **antigravity** | headless | ❌ 无 | 无 | `agy -p` non-interactive；resumeRejectionUndetectable | **Tier 2** |
| **deveco** | json | ❌ 无 | 无 | resumeRejectionUndetectable | **Tier 2** |
| **kimi** | ACP | ❌ 无 | 无 | **Python 侧遗留 node_type（见 §4.4）** | **Tier 2 + 2.5** |
| **reasonix** | ACP | ❌ 无 | 无 | — | **Tier 2** |
| **kiro** | ACP（kiro-cli） | ❌ 无 | 无 | — | **Tier 2** |
| **qoder** | ACP（qodercli） | ❌ 无 | 无 | — | **Tier 2** |
| **qoderclicn** | ACP | ❌ 无 | 无 | — | **Tier 2** |
| **traecli** | ACP serve | ❌ 无 | 无 | — | **Tier 2** |
| **qwenpaw** | ACP | ❌ 无 | 无 | 不支持 set_model（无 model env） | **Tier 2** |
| **dsh** | stdio profile | ❌ 无 | 无 | 需 `--profile multica --probe` JSON 握手（probeDshMulticaProfile） | **Tier 3** |
| （omp builtin） | pi 族 | — | 共享 pi 文件 | BuiltinRuntime，设计上不进 bridge catalog | 不在 24 内，维持排除 |

> Windows 专项文件全量（glob 确认）：cursor / copilot / pi / qwen 四个后端有专用 invocation 文件；共享层 proc_windows.go、exec_format_windows.go、acp_terminal_status_windows.go。其余后端走通用 spawn 路径，Windows 兼容是 QA 验证项而非代码阻塞项。

### 2.3 各档验收标准

**Tier 1 放行验收（每家）**：
1. 装好对应 CLI 的机器上 `rescan` 后 runtime 状态为 `ready`（或未登录时 `needs_auth`）；
2. 版本门生效：安装低于 MinVersion 的版本 → `found_not_runnable`（非 `probe_failed`）；
3. 绑定 roundtrip：pair/enable → 服务端注册成功，capabilities 落库；
4. 任务冒烟：简单 prompt 走 `started → text_delta* → completed`，Output 非空；
5. 能力初值经冒烟确认（resume / cancel / text_events 逐项核对，见 §3.3 能力矩阵）；
6. 卸载 CLI 后 `rescan` → `not_found`，已有绑定不被误清除。

**Tier 2 放行验收（每家，在 Tier 1 基础上追加）**：
1. 补齐 `MinVersions` 条目（下限取实测可用的最低版本，不拍脑袋）；
2. resume 语义验证：能恢复则声明 `session_resume`；`resumeRejectionUndetectable` 三家（cursor/antigravity/deveco）确认 opt-in 行为符合产品预期；
3. qwenpaw：确认模型路由降级（无 set_model）后讨论功能仍可用或明确禁用路径；
4. pi：确认直接绑定 `pi` 与 builtin `omp` runtime 共存无冲突（模型发现、skills 目录）；
5. Windows 冒烟（有专用文件的四家必测；其余抽测）。

**Tier 2.5（kimi）验收**：
1. 存量 `kimi_` 前缀节点 ID 审计：确认无脏数据、无与新注册路径的语义冲突；
2. admin 前端 / stats 中 kimi 的遗留引用与新 provider 语义对齐；
3. kimi 走标准配对注册路径端到端可用。

**Tier 3（dsh）重评估条件**：出现明确产品需求（例如 dsh 用户主动要求接入讨论组）+愿意承担 profile 握手协议的维护成本时，另立方案评审。omp builtin 维持"设计上不进 bridge catalog"。

---

## 3. 数据驱动改造方案（Phase 1 核心）

目标：**provider 清单的单一声明点收敛到 Go 运行时**，TS/Python 只做结构校验 + 透传 + 可选黑名单。此后 Go 发新 runtime 包 = 新 provider 可用（个别需 TS/Python 生态位调整的除外）。

### 3.1 Go 侧

**a) 定长数组的工程判断（结论：保留定长，消除双处维护）**

`Bridge.runtimes [bridgeRuntimeCount]bridgeRuntimeRecord` 的定长数组带来两个好处：`Runtimes()` 快照拷贝语义廉价且不逃逸；spec 数与 record 数编译期绑定。改成 slice 没有收益、反而引入每次快照的分配。**不必要不改**。

消除双处维护的办法是常量派生（Go 允许对数组取 len 作为常量表达式）：

```go
// bridge_runtime.go
var bridgeRuntimeSpecs = [...]bridgeRuntimeSpec{ /* 4 → 11 → 24 条 */ }

// 由 specs 长度派生，新增 spec 后此处零维护
const bridgeRuntimeCount = len(bridgeRuntimeSpecs)
```

再加一条编译期断言防止 spec 内 provider 重复/为空（包级 `var _ = mustValidateSpecs(bridgeRuntimeSpecs)` 或在 newBridge 首行 panic-fast-fail 均可，推荐后者，与现有初始化路径一致）。

**b) 能力声明下沉到 agent 包（单一声明点）**

现状 `bridgeRuntimeSpecs` 在 daemon 侧手写能力位，`agent.Backend` 接口没有 `Capabilities()`。参照 `BuiltinRuntimes` descriptor 的成熟模式，把能力声明挪到 agent 包：

```go
// server/pkg/agent/capabilities.go（新增）
// Capabilities 返回该 backend 经验证的声明式能力位。
type CapabilitySet struct {
    SessionResume, Cancel, TextEvents, ToolEvents bool
}
var backendCapabilities = map[string]CapabilitySet{ "opencode": {...}, /* 24 家 */ }
func Capabilities(agentType string) CapabilitySet // 未知类型返回零值（fail-closed）
```

`bridgeRuntimeSpecs` 的 spec 条目改为引用 `agent.Capabilities(provider)`，daemon 不再单独维护能力位。**新 provider = agent 包一个 backend 文件 + capabilities map 一条 + specs 一条**，全部在 Go 仓库内闭环。

**c) `InteractiveUnavailableReason` 硬编码 if/else 入 spec**

`bridge_runtime.go` probeRuntime 里 hermes/opencode 覆盖 ACP 串、openclaw 覆盖 Gateway 串的三条 if/else，搬进 spec 字段（`InteractiveUnavailableReason` 作为 spec 可选字段，缺省用默认串）。

**d) cmd_bridge.go 白名单数据驱动**

L190-196 的 provider path overrides switch 改为由 specs 派生（`bridgeRuntimeSpecs` 遍历，或直接复用 agent 包导出的 provider 集合）。注意保留"未知 provider → errBridgeCommandInvalidStartup"的 fail-closed 语义。

**e) interactive probe 不用改**

`ProbeInteractiveRuntime`（interactive_probe.go）只支持 4 家，default 分支返回 "interactive protocol unsupported"。`bridge_runtime.go` 只在 probe 成功时才置 interactive 能力，失败仅保持 spec 初值——**新 provider 的 spec 把 InteractiveRounds 留 false 即可，天然降级，无报错路径**。未来若某 ACP backend 想支持讨论轮次，在 interactive_probe.go 的 switch 中加 case 并走 §2.3 验收。

### 3.2 TS 侧（packages/quukk-clawmessenger）

**a) `src/go/types.ts`**

```ts
// 现状
const BridgeProviderSchema = z.enum(['opencode','openclaw','codex','hermes']);
const BridgeRuntimeListSchema = z.array(BridgeRuntimeSchema).length(4).superRefine(顺序检查);

// 改为
const BridgeProviderSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const BridgeRuntimeListSchema = z.array(BridgeRuntimeSchema)
  .min(1).max(64)
  .superRefine(去重检查 + 无 "一个是另一个前缀" 检查);  // 顺序不再校验
```

- **顺序校验删除**，展示顺序由 TS 侧 `KNOWN_PROVIDERS`（偏好序）+ 未知 provider 追加在尾部解决；
- `.length(4)` → `.min(1)`，目录条目数完全由 Go 下发；
- 结构校验（identifier 格式）替代枚举校验，**Go 新增 provider 时 TS 零改动**；
- `KNOWN_PROVIDERS` 仅用于显示标签/排序，未知 provider 用 raw 名显示并打 warn 日志（便于灰度期发现问题）。

**b) `src/config/schema.ts`**

- `PROVIDERS` 改为从 `KNOWN_PROVIDERS` 导出的展示序数组；绑定校验从"枚举成员"改为"identifier 格式 + 运行时目录成员"（目录本身已由 parseCatalog 保证）；
- `LocalStateSchema` 的 `bindings max=PROVIDERS.length` 改为固定上限常量 `MAX_BINDINGS`（建议 8，产品可调；见 §6 风险 R4）；
- `providerPathOverridesSchema` strictObject(4 字段) → `z.record(z.string())` + key 走 identifier 校验；opencode 的 opencodePath 冲突校验逻辑保留不动。

### 3.3 能力矩阵（Tier 1 初值建议）

能力位初值从协议族 + MinVersion 注释证据推导，**放行前逐家冒烟核实**（§2.3 Tier 1 验收第 5 条）：

| Provider | SessionResume | Cancel | TextEvents | ToolEvents | 备注 |
|---|---|---|---|---|---|
| claude | ✅ | ✅ | ✅ | ✅ | stream-json 最成熟后端 |
| copilot | ❓验证 | ✅ | ✅ | ❌ | json 输出，resume 语义待核（resumeRejectionUndetectable） |
| grok | ✅ | ✅ | ✅ | ❓ | ACP session-load/set_model 齐备 |
| qwen | ✅ | ✅ | ✅ | ❓ | stream-json 验证版 0.20.0 |
| dim | ✅ | ✅ | ✅ | ❓ | 持久 session/load |
| mcode | ✅ | ✅ | ✅ | ❓ | ACP v1 |
| zeroclaw | ✅ | ✅ | ✅ | ❓ | 持久 ACP session/resume |

> ❓ = 初值保守置 false，冒烟通过后在 capabilities map 中开启。`approval_events` 恒为 false（协议层硬约束）。`interactive_rounds` 全部 false（interactive probe 仅支持现有 4 家）。

### 3.4 Python 侧（clawmessenger-server）

| 文件 | 现状 | 改法 |
|---|---|---|
| `pairing_service.py:27` / `device_credentials.py:27` | `_PROVIDERS` 集合写死 4 家 | 抽公共模块 `providers.py`：`KNOWN_PROVIDERS`（随发版同步的已知清单，用于标签/统计）+ `is_valid_provider(s)`（identifier 正则 + 非空）。校验语义从"枚举成员"改为"格式合法"，可选加服务端配置黑名单（默认空） |
| `id_generator.py:11` | `AI_NODE_TYPES` 4 元组 | `normalize_ai_node_type` / `get_ai_node_type` 改走 `providers.py`；保留 'claw'→openclaw 归一化别名；**加前缀唯一性断言**（任何类型不得是另一类型 + `_` 的前缀，现状 24 家已满足：qwen/qwenpaw、qoder/qoderclicn 在第 5/6 字符处分岔） |
| `node_registration_service.py:402` | 回退遍历 4 家 legacy 元组 | 改为从注册请求携带的 provider 字段直取（配对协议里本来就有），删除回退猜测 |
| `command_handler.py:1014` | 前缀探测含 4+kimi | 探测集合从 `providers.py` 派生 |
| admin 前端 `types/index.ts` 等 | union 4+kimi | Phase 4 统一处理（§5） |

**需确认项（Phase 1 排查）**：clawmessenger-server 数据库 `nodes.node_type` / 相关 CHECK 约束是否限制取值（本次未审计 DB schema）；若有限制需配套迁移。

---

## 4. 逐层改动文件清单（Phase 1 数据驱动）

### 4.1 Go（quukk-clawmessenger/server）

| 文件 | 改动 |
|---|---|
| `pkg/agent/capabilities.go` | 新增：CapabilitySet + backendCapabilities map + Capabilities() |
| `internal/daemon/bridge_runtime.go` | specs 改引用 agent.Capabilities；`bridgeRuntimeCount = len(specs)` 派生；InteractiveUnavailableReason 入 spec；newBridge 加 spec 校验 |
| `cmd/multica/cmd_bridge.go` | overrides 白名单 switch → 由 specs 派生 |
| `internal/daemon/bridge_runtime_test.go` | 新增：spec 唯一性/前缀唯一性/catalog 长度=specs 长度的守护测试 |

### 4.2 TS（packages/quukk-clawmessenger/src）

| 文件 | 改动 |
|---|---|
| `go/types.ts` | 枚举→identifier 校验；`.length(4)`→`.min(1).max(64)`；顺序校验→去重+前缀检查 |
| `config/schema.ts` | PROVIDERS→KNOWN_PROVIDERS 派生；bindings max→MAX_BINDINGS；overrides schema→record |
| `bindings/service.ts` | providerLabels 未知 provider 回退 raw 名；trustedRuntimeError 校验改为 identifier |
| `service.ts` | `#projectRuntimes` 展示排序用 KNOWN_PROVIDERS；enable() 上限改 MAX_BINDINGS（每 provider 单绑定独占语义不变） |
| `migration/discover.ts` | providerPathOverrides 类型放宽，opencode 冲突校验保留 |
| 单测 | types.ts 新校验的单测 + 一份 24-runtime 的 fixture catalog 测试 |

### 4.3 Python（clawmessenger-server）

见 §3.4 表。另：`pairing_service` / `device_credentials` 的 provider 相关单测从"枚举成员"改为"格式 + 黑名单"用例。

### 4.4 kimi 遗留清理（Tier 2.5，跨层）

现状 kimi 只出现在 `id_generator.py`（节点 ID 前缀）、`admin/routes/nodes.py:26`（搜索别名归一）、`stats.py:70`、admin 前端类型，不在配对白名单——历史上"认识这个名字但不让绑"。kimi 正式放行时：

1. 审计存量 `kimi_` 前缀节点 ID（预期为零或极少，确认语义一致）；
2. `admin/routes/nodes.py` 别名归一化与 stats 中的 kimi 分支保留并纳入正规 provider 集合；
3. admin 前端 kimi Tag/筛选项从"遗留类型"转为"正规 provider"展示；
4. 若 DB 有 node_type 约束，随迁移放行 kimi（与 §3.4 需确认项一并处理）。

---

## 5. 分阶段 PR 计划

| 阶段 | 内容 | 交付物 | 回滚 |
|---|---|---|---|
| **Phase 0 测试基线** | 为现状补守护测试：Go（catalog=4 条 spec 的 golden 测试）、TS（.length(4)+顺序校验的 fixture 测试）、Python（白名单校验测试）。**本方案文档落盘时已跑 `go build ./...` + `go test ./internal/daemon/ -run TestBridgeRuntime -count=1` 确认基线绿** | 三层守护测试 | 纯测试，无回滚风险 |
| **Phase 1 数据驱动** | §3/§4 全部改动，**provider 集合保持 4 家不变**（行为零变化） | Go/TS/Python 三侧 PR + 全量测试绿 + 手工回归（rescan/绑定/配对/讨论） | 常规 revert |
| **Phase 2 Tier 1 放行（7 家）** | Go：capabilities map + specs 各加 7 条（claude/copilot/grok/qwen/dim/mcode/zeroclaw）；TS/Python **零代码改动**（Phase 1 红利）；发新 runtime npm 包 + CLI 版本；按 §2.3 Tier 1 验收逐家过 | 新 runtime 包 + 验收记录 | 不装对应 CLI 的机器 catalog 自然 not_found；服务端可配置黑名单一键禁用 |
| **Phase 3 Tier 2 适配（12 家，可拆 2-3 批）** | 逐家补 MinVersions、验证 resume/Windows/qwenpaw 模型降级/pi-omp 共存；每批独立 PR + 验收 | 分批放行 | 同 Phase 2 |
| **Phase 4 收尾** | kimi 遗留清理（§4.4）、admin 前端类型/筛选/Tag 全量扩展、设备配对文档与运维手册更新 | admin 前端 PR + 文档 | 常规 revert |

依赖关系：Phase 1 是硬前置；Phase 2/3/4 在 Phase 1 后可并行推进。

---

## 6. 风险与决策点

| # | 风险/决策 | 说明 | 建议 |
|---|---|---|---|
| R1 | TS/Python 放宽为格式校验后失去枚举类型安全 | 未知 provider 静默通过的代价是标签缺失/统计归"其他" | 接受。灰度期 TS warn 日志 + 服务端黑名单兜底；identifier 正则限死小写字母数字下划线 |
| R2 | Python 侧 DB node_type 约束未审计 | 若存在 CHECK/ENUM 限制，注册新 provider 会失败 | Phase 1 第一件事排查；有则配套迁移 |
| R3 | 能力位初值不准 | 高估→运行时失败；低估→功能浪费 | 初值保守（❓ 全 false），冒烟后再开（§3.3） |
| R4 | 绑定上限从 4 放宽到多少 | 现有 `enable()` 限制 ≤4 且每 provider 独占 | `MAX_BINDINGS=8` 起步，产品侧可再调；单 provider 独占语义不变 |
| R5 | Windows 兼容长尾 | 仅 4 后端有专用 invocation 文件 | 状态机天然兜底（exec format error → found_not_runnable 带修复指引）；Windows 冒烟列入 QA 矩阵 |
| R6 | 安全面 | 新 provider = 本机再执行一个 CLI 二进制，信任模型与现有 4 家一致；path overrides 每 provider 一个绝对路径，维持 opt-in | 不新增攻击面；overrides 白名单数据驱动后仍 fail-closed |
| R7 | 多 provider 并发资源 | 用户同时绑 8 家同跑任务，本机负载上升 | 沿用 bridge 现有并发控制；运维手册标注建议绑定数 |

---

## 7. 验证记录

### 7.1 Phase 0 基线（2026-10-08，方案落盘时）

- `go build ./...`（workdir: `quukk-clawmessenger/server`）—— **通过，无输出（零错误）**
- `go test ./internal/daemon/ -run TestBridgeRuntime -count=1` —— **ok，2.352s**

### 7.2 Phase 1+2 实施验证（2026-10-08）

- `go build ./...` —— **通过，零错误**（新增 `pkg/agent/capabilities.go`；修改 `bridge_runtime.go` / `bridge.go` / `cmd_bridge.go` 及两测试文件）
- `go test ./internal/daemon/ -run 'TestBridge' -count=1` —— **ok，2.560s**
- `go test ./cmd/multica/ -run 'TestBridgeCommand' -count=1` —— **ok，1.553s**
- `go vet ./internal/daemon/ ./pkg/agent/ ./cmd/multica/` —— **无告警**
- 全量套件（`go test ./...`）存在大量失败：已用 `git stash` 在未改动基线复跑同样失败，确认全部为**预存在的 Windows 环境问题**（symlink 权限、git filename-too-long、测试读到真实用户目录 MCP 配置、profile 目录互相污染、JSON 反序列化路径差异），与本轮改动无关。

Phase 1+2 已按 §3.1/§4.1 落盘：bridge catalog 现为 11 家（原 4 家 + Tier 1 七家），能力矩阵下沉 `pkg/agent/capabilities.go` 单一声明点，`cmd_bridge.go` 白名单改由 `daemon.BridgeRuntimeProviders()` 派生。**发版提醒：旧 CLI 的 `BridgeRuntimeListSchema` 仍硬编码 `.length(4)`，Go 报 11 家会使旧 CLI `parseCatalog` 失败——runtime npm 包发布必须与 TS 侧放宽（§3.2）同步或先于。**

### 7.3 Phase 3 TS 侧实施验证（2026-10-08）

改动面（workdir: `packages/quukk-clawmessenger`，14 文件修改 + 新增 `src/config/schema.test.ts`）：
- `config/schema.ts`：`PROVIDERS` 枚举 → `KNOWN_PROVIDERS`（展示序）+ `PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/` + `MAX_BINDINGS = 8`；`providerPathOverridesSchema` strictObject → `z.record`
- `go/types.ts`：`BridgeProviderSchema` 枚举 → 正则；`BridgeRuntimeListSchema` `.length(4)`+固定顺序 → `.min(1).max(64)`+去重
- `bindings/service.ts`、`pairing/service.ts`：providerLabels 改 Partial+回退 raw 名；身份校验 `PROVIDERS.includes` → `ProviderSchema.safeParse`
- `http/routes.ts`、`registration/client.ts`、`migration/discover.ts`、`cli.ts`、`logging/logger.ts`、`service.ts`、`config/store.ts`：引用点同步（MAX_BINDINGS/格式校验/record/Object.entries）

验证结果：
- `npx tsc --noEmit` —— **通过**
- **全量 vitest：47 文件 / 1498 测试全部通过**（含新增 `config/schema.test.ts` 守护测试 6 项：KNOWN_PROVIDERS 格式/去重/别名同引用/新 provider 可扩展/非法 id 拒绝/MAX_BINDINGS 边界）
- 3 处测试用例按 §3.2 语义变化适配：`service.test.ts`（上限用例 5→9 个 ID 超 MAX_BINDINGS）、`pairing/schema.test.ts` 与 `config/store.test.ts`（`unknown`/`kimi` 等格式合法的未知 provider 现在被放行——数据驱动预期，Go 侧 `cmd_bridge` 白名单兜底拒真未知 provider；拒绝断言改用非法格式 key）
- 首次全量时 `rongcloud/worker.integration.test.ts` beforeAll 导入超时 10s——经 git stash 基线单跑通过 + stash pop 后单跑通过 + 二次全量通过，确认为负载抖动，非代码问题

### 7.4 Phase 3 Python 侧实施验证（2026-10-08）

改动面（workdir: `clawmessenger-server`，6 文件修改 + 新增 `providers.py`/`tests/test_providers.py`）：
- 新增 `providers.py`：`PROVIDER_ID_PATTERN`（与 TS 对齐）、`KNOWN_PROVIDERS` 24 家元组（Go SupportedTypes 展示序）、`is_valid_provider()`、`BLOCKED_PROVIDERS` 预留、`known_provider_order()` 长度降序（防 qwen/qwenpaw、qoder/qoderclicn 前缀遮蔽）
- `id_generator.py`：`AI_NODE_TYPES = providers.KNOWN_PROVIDERS`（kimi 自动纳入）+ 模块级前缀唯一性断言
- `pairing_service.py` / `device_credentials.py`：枚举校验 → `providers.is_valid_provider()` 格式校验
- `node_registration_service.py`：`_legacy_node_type` 回退元组 → `providers.known_provider_order()`
- `rongcloud/command_handler.py`：`_discussion_role_candidate` 前缀探测 → `providers.known_provider_order()`

验证结果：
- `pytest tests/test_providers.py tests/test_pairing_service.py tests/test_device_credentials.py` —— **73/73 通过**（含新增 test_providers.py 9 用例）
- `pytest tests/test_pairing_api.py tests/test_device_credential_routes.py tests/test_connection_sessions.py tests/test_ai_node_ids.py` —— 86 中 83 过，3 失败为**预存在问题**（git stash 基线复跑同样失败：progress 结果新增 `nodeName` 字段但旧断言未同步）
- `pytest tests/test_discussion_commands.py tests/test_admin_node_owner.py tests/test_pairing_service_v2.py` —— 31/31；`test_server_regressions.py` + `test_discussion_node_requests.py` —— 79 过 1 skip
- **全量 `pytest tests/`：1332 通过 / 6 失败 / 116 跳过**——6 个失败（3 pairing_api + 2 admin_routes + 1 system_host）经 stash 基线复跑**全部同样失败**，确认为预存在的断言漂移（`nodeName`/payload 形状），与本轮改动无关
- 测试环境补装 `python-dotenv` + `requirements.txt` 全量依赖后，app 相关套件可跑（此前因缺依赖从未在本机执行过）

### 7.5 Phase 4 实施验证（2026-10-08）

改动面（kimi 遗留清理已由 Phase 3 `providers.py` 统一覆盖；本阶段为 admin 后端数据驱动 + admin 前端全量扩展）：

**服务端（workdir: `clawmessenger-server`）**
- `admin/routes/nodes.py`：`_node_type_sql` 的 IN 列表从 4+kimi 硬编码 → `providers.KNOWN_PROVIDERS`（24 家）派生；保留 claw→openclaw 别名 / 名称含 opencode 模糊归一 / ELSE 'openclaw' 兜底。`users.py`（ai_type）与 `stats.py` 引用同一函数自动适配
- `admin/routes/stats.py`：新增 `provider_nodes: {type: count}`（`_node_type_sql` GROUP BY 聚合）；保留旧 4 个 `*_nodes` 字段向后兼容
- 测试同步：`tests/test_admin_routes.py`（期望 dict 加 `provider_nodes`，5 节点 fixture → 4 类各计数）、`tests/test_admin_postgres_integration.py`（同样加字段）
- 无需改动（已确认）：`account_types.py`（OPERATION_ACCOUNT_SQL 从 `AI_NODE_PREFIXES` 派生，Phase 3 自动覆盖 24 家前缀）、`database.py` 历史回填 CASE（仅处理历史行）

**admin 前端（workdir: `clawmessenger-admin-web`）**
- 新增 `src/utils/providers.ts`：`KNOWN_PROVIDERS`（24 家展示序，偏好序非白名单）+ `PROVIDER_LABELS` 全量中英文标签 + `providerLabel()`（未知回退 raw id）+ `providerOrder()` + `providerTagColor()`（既有 4 家配色保留，其余已知 geekblue，未知 default）
- `src/types/index.ts`：`UserItem.ai_type` / `NodeItem.node_type` union → `string`；`DashboardStats` 加 `provider_nodes?: Record<string, number>`
- `src/pages/Nodes/index.tsx` / `src/pages/Users/index.tsx`：Tag 颜色与文本数据驱动；筛选 options 从 `KNOWN_PROVIDERS` 派生（24 项）；未知 provider 正常显示
- `src/pages/Dashboard.tsx`：4 张静态 provider 卡片 → 按 `provider_nodes` 动态渲染（过滤 count>0、按展示序排序）；旧后端无该字段时自动退化为 3 张基础卡

验证结果：
- 服务端 `pytest tests/test_admin_routes.py tests/test_admin_account_types.py` —— **95/97 通过**，2 个失败（user_relationship_payloads / node_list_detail_shape）经 git stash 基线复跑**同样失败**，为 §7.4 已确认的预存断言漂移，与本轮改动无关；本轮新增的 `provider_nodes` stats 断言全部通过
- `pytest tests/test_admin_postgres_integration.py` —— 16 skipped（本机无真实 PG，预期内；改动逻辑已由 test_admin_routes 的同构断言覆盖）
- admin 前端 `npx tsc --noEmit` 通过（修复一处编辑失误：Dashboard 误删的 `MessageOutlined` import 恢复）
- admin 前端 `npx vitest run` —— **7 文件 37/37 通过**；`npm run test:backend-contract` —— **4/4 通过**
- `docs/device-pairing-guide.zh.md` 经全文核查：面向用户的通用配对指南，无 provider 白名单硬编码，无需更新
