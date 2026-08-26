# Quukk ClawMessenger fork 设计规格

> 本文描述基于 Multica 上游仓库的社区衍生版。项目保留完整上游历史、Multica License、NOTICE、Multica 产品名、Logo、版权与界面归属；`Quukk ClawMessenger` 是附加的衍生版名称，不替换派生 UI 中必须保留的 Multica 品牌。本文不是商业许可或品牌豁免。

## 1. 决策摘要

Quukk ClawMessenger 采用 **fork 路线**：在 Multica 完整 monorepo 上增量实现 ClawMessenger 接入，不把几个现有 npm 包机械拼装成一个大进程，也不重写 Multica 已有的智能体运行时。

用户只需要安装一个公开入口包：

```bash
npm install -g quukk-clawmessenger
```

安装后的交互式桌面环境会启动本地服务并打开浏览器；非交互环境、CI、禁用 lifecycle scripts 的 npm 配置不会自动弹窗，用户可执行 `multica-clawmessenger setup` 获得同样结果。首次页面展示本机检测到的 OpenCode、OpenClaw、Codex 与 Hermes 运行时，用户选择一个或全部后，系统为每个所选运行时幂等注册一个独立融云用户，并启动对应消息桥。

架构职责固定如下：

- Multica Go 守护进程：检测 CLI、描述运行时、启动/恢复/取消智能体任务、输出标准化事件。
- Node.js ClawMessenger 桥：本地控制面、配置与进程管理、每运行时一个隔离的融云 worker、消息协议兼容、会话映射。
- Multica 本地界面：上手引导、运行时选择、活动记录、诊断与设置；保留上游品牌和版权展示。
- ClawMessenger 服务端：按 `node_type` 幂等签发融云身份；增加 Hermes 类型支持。

默认模式不依赖 PostgreSQL、Docker 或公开部署的 Multica Server。fork 中原有完整平台仍保留，但 npm 用户走轻量的本地 Bridge mode。

## 2. 目标与验收边界

### 2.1 必须实现

1. 新项目保留 Multica 上游 Git 历史，并使用 `upstream` 指向原仓库。
2. 一个面向用户的 npm 入口包覆盖 Windows、macOS、Linux 的 x64/arm64 桌面环境。
3. 自动检测 OpenCode、OpenClaw、Codex、Hermes；检测结果区分 `ready`、`needs_auth`、`found_not_runnable`、`not_found`。
4. 首次安装后在可交互桌面环境自动打开本地设置页；所有环境均可用显式 CLI 命令完成设置。
5. 用户可以选择单个、多个或全部已检测运行时，未选择的运行时不注册、不联网、不启动。
6. 每个所选运行时获得独立的融云用户、token、会话存储、运行状态和故障隔离。
7. 保留现有 ClawMessenger 行为：普通对话、会话新建/切换/清理、命令消息、设备状态、设备控制、去重、已读回执、结构化讨论消息与卡片动作。
8. 本地 UI 可查看运行时、融云连接、当前任务、最近活动和可脱敏导出的诊断信息。
9. Hermes 在 ClawMessenger 服务端成为正式 `node_type`，而不是伪装成其他智能体。
10. 测试通过、发布物审计通过、安装烟测通过后，才执行 npm 发布。

### 2.2 明确不做

- 不自动安装、升级或登录任何第三方智能体 CLI。
- 不在用户选择前创建融云身份。
- 不把 npm 安装当作授权远程执行任意 shell 的许可。
- 不在 Bridge mode 中引入 Multica 工作区、任务看板、PostgreSQL 或 Docker。
- 不删除或替换 Multica 品牌，不宣称获得商业许可或品牌豁免。
- 不把 fork 运营为对第三方开放的托管服务，也不嵌入商业分发产品；发生这类需求前必须另行取得书面商业许可。
- v1 不支持同一种 provider 的多个自定义安装实例；每个 provider 选择一个已解析的主运行时。该限制不影响未来按稳定 runtime ID 扩展。

## 3. 用户体验

### 3.1 安装与首次启动

入口包通过平台专用 optional dependency 携带已校验的 Go 守护进程二进制，用户仍只安装一个公开入口包。平台包遵循 npm 常见的原生二进制分发方式，避免在 postinstall 中从任意 URL 下载并执行文件。

`postinstall` 只在同时满足以下条件时异步启动设置页：全局安装、桌面会话、非 CI、未设置禁用自动打开页面的环境变量。它不等待用户输入，不注册账号，不阻塞 npm。其他情况打印一条简短命令提示。

禁用变量固定为 `QUUKK_CLAWMESSENGER_NO_OPEN=1`，便于企业部署、自动化脚本和问题复现使用。

本地服务绑定随机可用端口并仅监听 `127.0.0.1` / `::1`。浏览器 URL 带一次性启动票据；页面兑换后 URL 中的票据立即失效并被移除。

### 3.2 设置页流程

设置页采用四步流程：

1. **检测**：展示四种 provider 的图标、版本、可执行文件来源、认证状态和诊断信息。
2. **选择**：默认勾选所有 `ready` 运行时；用户可逐个取消或全选。`needs_auth` 可查看本地登录命令但不可直接注册。
3. **注册**：按 provider 独立执行注册，逐项展示进行中、成功或可重试错误；部分成功不会回滚已经成功的其他运行时。
4. **完成**：展示已上线的智能体列表和入口，允许稍后重新扫描、启停或注销单个运行时。

任何自动注册都发生在用户点击“接入所选智能体”之后。这里的“自动”表示无需用户手填融云账号或 token，而不是无提示创建远端身份。

### 3.3 日常页面

Bridge mode 保留 Multica 的视觉系统与品牌区域，提供四个最小页面：

- **运行时**：按本机分组展示 provider、别名、版本、检测状态、融云连接状态和启用开关。
- **活动**：按运行时展示消息接收、任务启动、流式输出、完成、失败与取消的时间线。
- **诊断**：服务版本、端口、进程、CLI 探测结果、脱敏日志导出。
- **设置**：ClawMessenger 服务地址、默认工作目录、自动启动、日志级别与重新注册。

所有用户可见运行时名称使用 Multica 的 `runtimeDisplayLabel` / `runtimeDisplayName` / `runtimeRowLabel` 规则，不直接渲染原始 `runtime.name`。

## 4. 系统架构

```text
ClawMessenger App / 小程序
            │ RongCloud IM
            ▼
┌──────────────────────────────────────────────┐
│ quukk-clawmessenger (Node.js)                │
│  local UI/API · identity registry · router   │
│  one RongCloud worker per enabled runtime    │
└──────────────────────┬───────────────────────┘
                       │ loopback HTTP + SSE
                       │ per-install bearer secret
┌──────────────────────▼───────────────────────┐
│ Multica daemon (Go, forked)                  │
│ detection · adapters · task lifecycle        │
└───────┬──────────┬──────────┬──────────┬─────┘
        ▼          ▼          ▼          ▼
    OpenCode   OpenClaw     Codex      Hermes
```

### 4.1 新增包与模块

#### `packages/quukk-clawmessenger`

发布为 `quukk-clawmessenger`，包含：

- CLI：`setup`、`start`、`stop`、`status`、`logs`、`doctor`、`rescan`。
- 本地 HTTP 服务和静态设置页资源。
- 守护进程二进制解析、启动、健康检查与正常关闭。
- RongCloud worker supervisor、注册客户端、消息路由、会话映射、去重与日志。
- 从现有 OpenCode/Codex/OpenClaw bridge 提炼的共享消息协议，不保留 provider 专用的重复实现。

现有 `opencode-clawmessenger`、`codex-clawmessenger`、`openclaw-clawmessenger` 不作为生产依赖安装。经许可证核验后，复用的协议代码进入这个共享包并记录来源；旧包只作为迁移输入和兼容性基准，后续进入维护/弃用周期。

#### `apps/bridge`

使用 React/Vite 构建 Bridge mode 的本地静态界面，复用 `packages/ui` 的视觉组件和 `packages/core` 的纯类型/解析器，页面自身不依赖 Multica Server 或数据库。构建产物由 `packages/quukk-clawmessenger` 提供，不启动单独前端开发服务器。派生 UI 的品牌区域继续显示 Multica，并在相邻位置增加 `Quukk ClawMessenger` 标识。

#### `packages/quukk-clawmessenger-runtime-*`

平台专用实现包只携带二进制与 SHA-256 构建清单，作为入口包的 optional dependencies：Windows x64/arm64、macOS x64/arm64、Linux glibc x64/arm64。入口包校验平台、架构、版本与清单哈希后才启动二进制。缺少匹配包时给出可执行的修复提示，不回退到未经校验的网络下载。

#### RongCloud worker

`@rongcloud/imlib-next` 使用模块级初始化、事件监听和连接状态。为防止第二个 token 覆盖第一个连接，每个启用的 `RuntimeBinding` 启动一个独立 Node 子进程；子进程必须先导入浏览器环境 polyfill，再加载 SDK，并使用独立的 IndexedDB/本地存储命名空间。主桥通过 Node IPC 发送结构化命令和接收事件，token 只在子进程启动后的 IPC 握手中传递，不放入命令行或环境变量。worker 崩溃只触发对应 binding 的有上限重启。

#### Go 守护进程 Bridge API

在现有 Multica daemon 的 adapter/runtime 能力之上新增只监听 loopback 的 Bridge API：

- `GET /v1/runtimes`：返回稳定 runtime ID、provider、版本、路径、能力和检测状态。
- `POST /v1/runtimes/refresh`：触发一次有超时的重新探测。
- `POST /v1/tasks`：以 runtime ID、conversation key、工作目录和 prompt 启动或恢复任务。
- `GET /v1/tasks/{id}/events`：SSE 输出标准化增量、工具调用、审批、完成和错误事件。
- `POST /v1/tasks/{id}/cancel`：取消完整进程树。
- `GET /healthz`：报告版本、启动时间和探测器状态。

所有端点要求安装时生成的 bearer secret；守护进程拒绝非 loopback 请求。默认测试注入 fake executable，不执行环境中的真实 CLI。

### 4.2 provider 适配

| Provider | 主协议 | 探测依据 | 关键行为 |
| --- | --- | --- | --- |
| OpenCode | `opencode run --format json`；已有 server 模式可作为后续优化 | PATH、已知安装目录、版本探针 | 解析 JSON 事件；按会话恢复；拒绝恢复时新建一次 |
| OpenClaw | `openclaw agent --json` | PATH、OpenClaw 配置目录、版本探针 | 使用 agent JSON 输出；保留网关能力但 Bridge mode 不依赖网关插件安装 |
| Codex | Codex app-server JSON-RPC | PATH、常见安装入口、版本探针 | 线程创建/恢复、审批事件、容量错误分类、进程树取消 |
| Hermes | ACP | PATH、Hermes 配置目录、版本探针 | 标准 ACP 会话；认证缺失映射为 `needs_auth` |

探测不使用 shell 字符串拼接。每个候选可执行文件用参数数组启动，限制并发、单次探针超时和输出大小；路径覆盖必须是绝对文件路径。结果带来源优先级并选择一个主候选：用户覆盖 > PATH > 已知安装目录。重新扫描不会改变已启用 runtime ID，除非原路径已不可用。

### 4.3 运行时与融云身份模型

核心实体为 `RuntimeBinding`：

```ts
type RuntimeBinding = {
  runtimeId: string;
  provider: 'opencode' | 'openclaw' | 'codex' | 'hermes';
  enabled: boolean;
  nodeId?: string;
  nodeName: string;
  tokenRef?: string;
  registrationState: 'unregistered' | 'registering' | 'online' | 'offline' | 'error';
};
```

`runtimeId` 由 provider、规范化可执行文件路径和本机安装 ID 的摘要形成，用于本地稳定关联；它不会作为融云 token。服务端注册请求沿用现有 `/api/ai/register`：`name`、`mac_address`、`node_type`、`ai_type`、`capabilities`，存在旧 `node_id` 时带上以实现刷新。每个 provider 使用自己的 `node_type`，服务端允许值扩展为 `openclaw`、`opencode`、`codex`、`hermes`，并保留已有 `kimi` 兼容。

注册结果必须同时校验业务码、`node_id` 前缀、`node_type`、非空 token 和 capability 集合。注册成功后，token 只写入本地受保护的凭据文件并以引用形式进入主配置。重新启动优先复用未过期身份；token 失效时只刷新对应 binding，不影响其他运行时。

注销单个运行时会停止其融云连接并删除本地 token；远端身份删除不是 v1 的隐式行为，避免误删仍被其他客户端引用的账号。

## 5. 消息、会话与任务流

### 5.1 入站

每个融云连接把消息交给共享路由器，路由键为 `(nodeId, conversationType, targetId, senderId)`。共享路由器先校验结构和大小，再做 message UID 去重，然后处理：

- 文本/文件上下文消息：映射为智能体 prompt。
- 会话控制：新建、切换、列出、清理会话。
- 命令：帮助、状态、取消、工作目录与支持的既有命令。
- 设备状态/设备控制：只执行白名单动作。
- discussion v2 / CardKit：路由审批、回答、导航、会话和自定义动作。

每个 binding 拥有独立 `SessionStore`，conversation key 只在该 binding 内解析，杜绝 OpenCode 会话串到 Codex。消息确认、已读回执和“处理中”反馈在任务成功创建后发送；启动失败返回明确错误而不写入错误的会话映射。

### 5.2 执行

Node 桥向 Go Bridge API 提交 runtime ID、conversation key、prompt、工作目录和允许的上下文。Go 守护进程选择对应 adapter：存在有效 session handle 时恢复，否则新建；恢复被 provider 明确拒绝时最多自动新建一次，其他错误不盲目重试。

标准事件模型为：`started`、`text_delta`、`tool_started`、`tool_finished`、`approval_required`、`status`、`completed`、`failed`、`cancelled`。Node 桥按现有 ClawMessenger 消息格式聚合和限流后发回融云。连接短暂中断时，当前任务继续执行并把有限事件写入环形缓冲；重连后发送最终状态，不无限持久化 token 流。

### 5.3 审批与控制

远程消息只能触发既有白名单动作。涉及文件写入、命令执行或权限提升的 provider 审批沿用本地智能体安全策略；ClawMessenger 卡片可以提交“允许/拒绝”结果，但不能把本地默认安全策略永久改为无限制。取消操作必须终止完整子进程树并产生 `cancelled` 终态。

## 6. 配置、进程与日志

运行数据使用独立目录，避免污染上游 Multica 与现有单 provider 插件：

```text
~/.quukk-clawmessenger/
  config.json
  credentials.json
  sessions.json
  state.json
  logs/bridge.log
  run/bridge.pid
  run/daemon.pid
```

Windows 使用用户 ACL，Unix 文件权限为 `0600`、目录为 `0700`。JSON 采用临时文件 + fsync + 原子替换；进程崩溃不会留下半份凭据。每个 RongCloud worker 使用 `~/.quukk-clawmessenger/rongcloud/<runtimeId>/` 作为独立 SDK 存储空间。日志结构化记录 binding、provider、conversation 和 task ID，但永不记录融云 token、完整 prompt、授权票据或环境变量。`doctor --json` 默认脱敏。

配置优先级固定为：CLI 参数 > `QUUKK_CLAWMESSENGER_*` 环境变量 > 配置文件 > 内置默认值。默认 ClawMessenger 服务地址为 `https://newsradar.dreamdt.cn/im`，允许在设置页和 CLI 显式覆盖。启动时检测旧的单 provider 配置，只展示可导入项并要求用户确认；导入成功前不移动或删除旧文件。

Node supervisor 只管理自己启动的 Go 守护进程和 RongCloud worker 子进程，并通过 PID、进程创建时间和随机实例 ID 三者共同校验，避免杀错复用 PID 的进程。`stop` 先通知所有 worker 正常断开，再关闭 Go 守护进程，超时后才终止已验证的子进程树。

## 7. 安全与故障处理

- 本地服务只监听 loopback，并设置严格 Origin、Host、CSRF 和 Content-Security-Policy 校验。
- 一次性浏览器票据短时有效、只可兑换一次；后续请求使用 HttpOnly、SameSite=Strict session cookie。
- Node 与 Go 之间使用每次安装随机生成的 bearer secret，不经命令行参数传递。
- 所有网络输入用 zod 或 Go 显式结构解析；未知 message type 可记录并忽略，不允许直接断言类型。
- CLI 路径、工作目录、文件附件路径在边界规范化并校验；不接受 `..` 越界或隐式 shell 展开。
- 注册与连接采用有上限的指数退避和抖动；认证错误停止重试并提示重新注册。
- 单个 binding 的注册、连接或 adapter 故障不会停止其他 binding。
- 服务端不可用时 UI 仍可展示检测结果和诊断；已缓存身份可按 SDK 能力重连，但不会伪报在线。
- 错误分为 `detection`、`authentication`、`registration`、`transport`、`runtime`、`policy`，用户文案提供下一步动作，详细堆栈只进入本地脱敏日志。

## 8. 许可证与 fork 治理

1. Git 历史完整保留；fork 基线为上游 commit `54027ba763fa7da0699b2fe89df4a6b2c13d1c6f`。原仓库远端命名为 `upstream`，业务开发位于 `codex/clawmessenger-fork` 及后续 `codex/*` 分支，禁止向 `upstream` 推送 fork 发布提交。
2. 仓库、源码发布物、二进制发布物和 npm tarball 均携带完整、未删减的 Multica `LICENSE` 与 `NOTICE`。
3. 任何从 `apps/web`、`apps/desktop`、`apps/mobile`、`packages/views`、`packages/ui` 派生的界面继续展示 Multica Logo、产品名、版权和归属；`Quukk ClawMessenger` 只作相邻的附加衍生版标识。
4. 用户文档明确写明“Built on Multica”，链接到 `https://github.com/multica-ai/multica`。
5. 修改上游既有源文件时添加适合该文件格式的显著修改说明，并维护 `MODIFICATIONS.md`；优先通过新增文件和现有扩展点减少上游改动。
6. 社区 fork、内部使用和源码分发按当前 Multica License 执行。公开托管、商业嵌入或商业分发在未取得 Multica, Inc. 的书面商业许可前不进入发布范围；去除/修改品牌还需要单独的书面 branding waiver。
7. 同步上游使用 merge，不重写已发布历史；每次同步后运行完整兼容测试和许可证打包审计。

## 9. 测试策略

开发遵循测试先行。默认测试禁止执行宿主机上真实安装的智能体 CLI。

### 9.1 单元测试

- 四类 provider 的候选路径、版本输出、认证状态、超时、超大输出与优先级。
- `RuntimeBinding` 状态机、幂等注册、token 刷新、部分失败和注销。
- 消息解析、UID 去重、路由隔离、会话键隔离、命令白名单。
- Go 标准事件到融云消息的聚合、限流、错误与取消映射。
- 配置权限、原子写入、敏感字段脱敏、PID 防复用校验。
- postinstall 在 CI、非全局、禁用自动打开和交互式全局安装下的分支行为。

### 9.2 集成测试

- fake CLI 覆盖 OpenCode JSON、OpenClaw JSON、Codex JSON-RPC、Hermes ACP 的新建、恢复、审批、失败和取消。
- mock ClawMessenger 注册 API 验证四个独立 node type、响应校验与重试上限。
- mock RongCloud transport 验证四个 worker 并发、SDK 状态隔离、单连接掉线不影响其他连接、重连后终态发送。
- Node supervisor 与 Go Bridge API 的鉴权、SSE、正常关闭和崩溃恢复。
- 本地 UI 的首次扫描、全选、部分注册失败、重新扫描与注销流程。

### 9.3 发布验证矩阵

CI 构建 Windows x64/arm64、macOS x64/arm64、Linux glibc x64/arm64；每个平台至少执行：安装 tarball、`setup --no-open`、`doctor --json`、fake runtime 扫描、启动/停止烟测。真实融云和真实智能体端到端测试使用显式 opt-in 的受控环境，不进入默认测试。

## 10. 发布门槛

发布顺序固定为：

1. 服务端先上线 Hermes `node_type` 兼容，旧客户端回归通过。
2. 生成平台二进制与构建清单，验证 SHA-256、版本和来源 commit。
3. `pnpm test`、`pnpm typecheck`、Go 测试、lint、UI 测试和安装矩阵全部通过。
4. 对每个 npm tarball 执行 `npm pack --dry-run` 审计，确认只含预期文件、完整 LICENSE/NOTICE、来源链接和修改说明。
5. 从 tarball 在干净临时目录安装，验证首次设置、四 provider fake 探测、独立注册和停止卸载路径。
6. 先发布平台包，再发布 `quukk-clawmessenger` 的 prerelease 版本；小范围验证后升为 stable。
7. 真正执行 `npm publish` 前再次确认 npm 登录身份、`@quukk` scope 权限、2FA、目标 tag 和版本号。发布属于不可轻易撤回的外部操作，必须由用户在当次会话明确确认。

截至 2026-08-26，`quukk-clawmessenger` 在 npm 官方 registry 返回 404，可作为本设计的入口包名；发布前仍需重新检查占用状态。

## 11. 完成定义

以下条件全部满足才称为完成：

- 新用户在支持的平台只安装入口包即可看到本地智能体列表。
- 本机同时存在 OpenCode 和 OpenClaw 时，页面准确展示两者；可只接入其中一个，也可全部接入。
- 四个 provider 中每个所选运行时都拥有可验证、互不串号的融云身份。
- 从 ClawMessenger 发给某一智能体的消息只进入该智能体的会话，回复、审批、取消和状态回传行为与现有单 provider 插件一致。
- 任一智能体离线、认证失败或崩溃不影响其他智能体继续工作。
- 重启后身份、选择和会话可恢复，敏感数据不出现在日志和诊断导出中。
- 默认测试无宿主机 CLI 副作用，跨平台安装矩阵与发布物审计均通过。
- LICENSE、NOTICE、Multica 品牌、版权、来源说明和修改说明在源码与发布物中完整可见。

## 12. 参考依据

- [Multica 上游仓库](https://github.com/multica-ai/multica)
- [Multica daemon 与 runtime 文档](https://multica.ai/docs/daemon-runtimes)
- [Multica License](https://raw.githubusercontent.com/multica-ai/multica/refs/heads/main/LICENSE)
- [OpenCode server 文档](https://dev.opencode.ai/docs/server/)
- [OpenClaw plugin 文档](https://docs.openclaw.ai/plugins)
- [Codex SDK 文档](https://learn.chatgpt.com/docs/codex-sdk)
- [Hermes Agent 文档](https://hermes-agent.nousresearch.com/docs/)
