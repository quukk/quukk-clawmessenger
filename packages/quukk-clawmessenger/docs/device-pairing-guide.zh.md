# 设备安装与配对指南

本文说明如何在 Windows、macOS 或 Linux 设备上安装 `quukk-clawmessenger`，自动检测本地智能体平台，并通过二维码或一次性配对码把所选平台添加到 ClawMessenger 账号。

本文的配对流程用于添加普通用户设备。系统讨论主持人必须使用单独的运维授权注册流程，不能把普通用户已经绑定的节点直接设为系统主持人。

## 1. 支持范围

安装前确认设备满足以下要求：

- Node.js `22.13` 或更高版本。
- Windows x64/arm64、macOS x64/arm64，或使用 glibc 的 Linux x64/arm64。
- 可以访问 npm 和目标 ClawMessenger 服务端。
- 本机已经安装并登录至少一个受支持的智能体平台。

当前安装包会自动选择与操作系统和 CPU 架构匹配的本地运行时。安装后，Setup 页面会检测 OpenCode、OpenClaw、Codex 和 Hermes；只有状态为“可用”的平台可以加入。

ChatGPT 桌面客户端本身不等同于 Codex CLI。只安装 ChatGPT 客户端时，Codex 可能仍显示“未找到”。需要安装并登录可被命令行检测的 Codex 运行时，或在设置中填写正确的可执行文件路径。

## 2. 安装或升级

### 首次安装

```text
npm install -g quukk-clawmessenger@beta
quukk-clawmessenger --version
quukk-clawmessenger setup
```

`setup` 会启动仅监听 `127.0.0.1` 的本地服务，并尝试打开浏览器。不要把本地端口暴露到局域网或互联网。

### 升级

升级前先停止正在运行的本地服务，避免 Windows 因本地运行时文件仍被占用而出现 `EPERM` 清理警告。

```text
quukk-clawmessenger stop
npm install -g quukk-clawmessenger@beta
quukk-clawmessenger setup
```

若升级时仍出现 `EPERM`，确认所有旧的 `quukk-clawmessenger` 和 `multica` 进程已经退出，再重新执行安装。不要手工删除仍被进程占用的 npm 目录。

### Linux 升级后注意可执行权限

Linux 上全局安装或升级时，如果 npm 的 lifecycle 脚本被安全策略拦截（安装输出出现 `postinstall blocked` / `allow-scripts` 相关警告），新解包的本地运行时二进制可能没有可执行权限，导致服务无法启动。现象与处理见第 9 节「Linux 上 `status` 一直显示 `starting`，或 `start`/`setup`/`pair` 报 `unsafe_identity`」。

安装时可直接放行本包的 postinstall，避免该问题：

```bash
npm install -g --allow-scripts=quukk-clawmessenger quukk-clawmessenger@beta
```

### Windows 命令无输出时

部分 Windows、NVM 或 PATH 组合可能没有正确执行全局命令包装器。可以先解析真实脚本路径，再直接用 Node.js 启动：

```powershell
$globalRoot = npm root -g
$cli = node -e "const fs=require('fs'),path=require('path'); console.log(fs.realpathSync(path.join(process.argv[1],'quukk-clawmessenger','bin','quukk-clawmessenger.js')))" $globalRoot
node $cli --version
node $cli setup
```

## 3. 指定服务端和工作目录

工作目录必须是真实存在的项目目录，并位于授权工作根目录内。不要授权整个系统盘，也不要使用 `C:\WINDOWS\system32` 作为工作目录。

### Windows PowerShell

```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED = $null
New-Item -ItemType Directory -Force C:\AI-Workspace
quukk-clawmessenger stop
quukk-clawmessenger setup `
  --server-url "https://newsradar.dreamdt.cn/im-test" `
  --workdir "C:\AI-Workspace" `
  --authorized-work-root "C:\AI-Workspace"
```

PowerShell 的续行符是反引号，并且必须是该行最后一个字符。参数前不要添加反斜杠。复制命令时，URL 必须保持纯文本，不要包含 Markdown 链接的方括号或圆括号。

如果全局命令包装器无响应，把上面最后一条命令中的 `quukk-clawmessenger` 换成 `node $cli`。

### macOS 或 Linux

```bash
mkdir -p "$HOME/AI-Workspace"
quukk-clawmessenger stop
quukk-clawmessenger setup \
  --server-url "https://newsradar.dreamdt.cn/im-test" \
  --workdir "$HOME/AI-Workspace" \
  --authorized-work-root "$HOME/AI-Workspace"
```

### 无图形界面的 Linux 服务器

没有桌面会话的服务器上不存在可用的 `xdg-open`，直接执行 `setup` 会以 `browser_open_failed` 失败（退出码 5）。这类设备不需要打开网页，直接用 `pair` 在终端拿到 8 位一次性配对码：

```bash
quukk-clawmessenger pair \
  --server-url "https://newsradar.dreamdt.cn/im-test" \
  --workdir "$HOME/AI-Workspace" \
  --authorized-work-root "$HOME/AI-Workspace"
```

```text
quukk-clawmessenger: pair waiting
pairing_code=ABCDEF23
expires_at=2026-09-18T12:00:00.000Z
server=https://newsradar.dreamdt.cn/im-test
Enter the code in ClawMessenger under Remote devices > Add device.
```

- `pair` 会先确保本地服务在运行（没有就启动），不会尝试打开浏览器，也不会打印网页地址。
- 把 `pairing_code` 输入 Web 或移动端的“远程设备管理 → 添加设备 → 输入配对码”即可完成绑定，流程见第 6、7 节。
- 重复执行 `pair` **不会**作废已经打印的码：会话仍然有效时它会原样返回同一个码。需要换一批平台、或码已过期时，加 `--new` 强制重开。
- `pair --json` 输出机器可读结果；绑定进度用 `quukk-clawmessenger status --json` 查看。
- 一个受支持的平台都没有检测到时，`pair` 以 `pairing_no_candidates` 失败（退出码 2）。先执行 `quukk-clawmessenger rescan` 检查各平台是否已安装并登录。

#### 需要网页设置时的端口转发

只有在必须使用本地 Setup 页面（例如逐个查看平台能力、通过页面修改授权目录）时才需要下面这套流程。

本地 Setup 页面只监听 `127.0.0.1`，端口每次启动随机分配，地址中的启动票据有效期只有 30 秒。无头设备按以下顺序操作。

**第一步：读取本次启动的端口**

服务需要处于运行状态（`pair` 或 `setup --no-open` 都会启动它）。端口每次启动随机分配，用下面的命令读取：

```bash
quukk-clawmessenger doctor --json
```

从输出中取 `service.port`。人类可读输出等价于 `quukk-clawmessenger doctor` 里的 `port=<端口>`。

**第二步：建立 SSH 端口转发**

在你有浏览器的设备上执行。本地端口必须与服务器端口一致，因为服务端只接受 `Host: 127.0.0.1:<端口>`：

```bash
ssh -L <端口>:127.0.0.1:<端口> <用户名>@<linux-host>
```

**第三步：截取 Setup 页面地址**

在服务器上临时放一个 `xdg-open` 包装脚本，然后再次执行 `setup`。第二次执行不要带任何配置参数，否则会因为服务已在运行而报 `already_running_with_overrides`：

```bash
mkdir -p "$HOME/bin"
cat > "$HOME/bin/xdg-open" <<'EOF'
#!/bin/sh
printf '%s\n' "$1" > "$HOME/setup-url.txt"
EOF
chmod +x "$HOME/bin/xdg-open"

PATH="$HOME/bin:$PATH" quukk-clawmessenger setup
cat "$HOME/setup-url.txt"
```

**第四步：在 30 秒内打开页面**

把上一步输出的 `http://127.0.0.1:<端口>/setup#ticket=...` **原样**粘贴到第二步那台设备的浏览器里。端口和票据都不能改动，端口与转发端口不一致会被服务端拒绝。

完成后请删除 `$HOME/bin/xdg-open`，并清理 `$HOME/setup-url.txt`。

本地 Setup 页面只能从运行该服务的设备访问。远程服务器不应把 `127.0.0.1` 监听地址直接暴露出去；如果不想在无头设备上执行上述步骤，请在具备本地浏览器的受信任设备上完成 Setup。

自动启动条目在 Linux 上是 XDG `.desktop`（`$XDG_CONFIG_HOME/autostart/`），没有桌面会话时不会生效。需要长期值守的无头服务器请自行用 `systemd` 托管 `quukk-clawmessenger start --foreground --no-open`，而不要依赖该条目。

## 4. 检查智能体平台

打开 Setup 页面后，先检查“选择本地智能体”列表：

- “可用”：平台已检测到，可以参与本次配对。
- “需要登录”或类似状态：先在本机完成该平台的登录，再重新扫描。
- “未找到”：安装对应命令行运行时，或在设置中填写其可执行文件路径。

也可以从终端重新扫描：

```text
quukk-clawmessenger rescan --json
```

只选择确实需要加入 ClawMessenger 的平台。每个平台会注册为一个独立节点，用户可以分别启用、停用和管理。

## 5. 生成二维码和一次性配对码

在 Setup 页面完成以下操作：

1. 确认授权工作根目录和默认工作目录正确。
2. 勾选权限确认框。
3. 点击“生成配对二维码”。
4. 页面会同时显示二维码和格式化的 8 位一次性配对码。
5. 保持页面打开，直到另一端完成绑定。

二维码和配对码表示同一个一次性会话。它有较短的有效期，只能由一个登录账号完成；过期、取消或中断后，需要点击“生成新的二维码”。

## 6. Web 端添加设备

使用需要拥有该设备的用户账号登录 ClawMessenger Web，然后打开“远程设备管理”。

1. 点击添加设备。
2. 选择“输入配对码”。
3. 输入电脑 Setup 页面显示的 8 位配对码。可以带或不带分隔符。
4. 页面显示检测到的平台后，勾选需要添加的平台。
5. 点击“确认添加”。
6. 返回设备列表，确认新节点在线，并显示正确的平台名称和版本。

Web 端与 Setup 页面位于同一台电脑时，直接输入配对码通常比扫描屏幕二维码更方便。

## 7. 移动端或 UniApp 添加设备

使用同一个 ClawMessenger 用户账号登录移动端，然后进入“我的 → 远程设备管理”。

可以使用任一种方式：

- 扫码：点击添加设备，使用相机扫描电脑上的二维码。
- 相册：选择已经保存的二维码图片。二维码仍须在有效期内。
- 手动输入：输入电脑页面显示的 8 位配对码。

解析成功后，选择需要添加的平台并确认。绑定完成后，检查设备列表中的在线状态，再发起一个只读或低风险任务验证消息链路。

## 8. 配对后验证

在安装设备上执行：

```text
quukk-clawmessenger status --json
quukk-clawmessenger doctor --json
quukk-clawmessenger rescan --json
```

期望结果：

- `status` 的状态为 `ready`。
- `doctor` 能显示服务版本、进程和端口。
- `rescan` 至少有一个平台为 `ready`。
- Web 或移动端的设备列表中出现所选平台，并显示在线。

建议先提交一个限定在授权工作目录内的简单任务，例如读取项目说明文件。不要用删除文件、发布版本或修改生产环境作为首次验证任务。

## 9. 常见问题

### Setup 页面显示 `session_required`

浏览器中的本地会话已经失效，或者打开的是旧端口页面。关闭旧页面，重新执行 `quukk-clawmessenger setup`，并使用新打开的地址。不要复用旧的 `#ticket` 地址或复制其他设备的本地地址。

### 点击生成配对码后显示服务端接口不可用

如果显示 `pairing_api_unavailable` 或“服务端尚未部署新版配对接口”，客户端和服务端版本不匹配。请先确认目标环境已经部署配对 v2 接口，再重新启动本地服务。

默认服务端地址跟随发行渠道：版本号带预发布后缀的包（如 `1.2.3-beta.1`）默认使用测试环境 `https://newsradar.dreamdt.cn/im-test`，正式版（如 `1.2.3`）默认使用 `https://newsradar.dreamdt.cn/im`。如果 `config.json` 里存的恰好是另一个渠道的默认地址，会被当作当前渠道的默认地址读取，文件本身不会被改写；手工填写的其它地址保持不变。需要跨渠道连接时，用 `--server-url` 显式指定。

### 显示 `operation_unavailable`

常见原因是服务端地址错误、网络不可达、服务端仍在迁移或缺少必要配置。依次检查：

1. `--server-url` 是否为纯文本且环境正确。
2. 设备能否通过 HTTPS 访问该地址。
3. 服务端健康检查和配对接口是否已经部署。
4. 服务端日志中是否有数据库迁移、签名密钥或上游通信错误。

不要通过设置 `NODE_TLS_REJECT_UNAUTHORIZED=0` 绕过证书校验。若以前设置过，在 PowerShell 中执行：

```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED = $null
```

### 显示 `pairing_transport` 或 `pairing_timeout`

检查 DNS、代理、防火墙、证书和服务端响应时间。确认同一设备可以访问目标环境，并在网络恢复后生成新的配对码。

### 显示 `pairing_unauthorized`

本地 Setup 会话或配对授权已失效。重新运行 `setup`，不要继续使用旧页面。

### 显示 `pairing_response_invalid`

客户端收到的响应不符合当前协议，通常是客户端与服务端版本不匹配。升级 `quukk-clawmessenger`，确认服务端已更新，再重新配对。

### 显示设备属于其他账号

`owned_by_other_account` 表示该节点已经归属于另一个用户。不要反复生成配对码。请使用原账号管理或解绑节点；若原账号不可用，由管理员按照正式的节点撤销流程处理。

### ChatGPT 已安装，但 Codex 未被识别

ChatGPT 桌面客户端和 Codex CLI 是不同的运行时。安装并登录受支持的 Codex CLI，然后执行 `quukk-clawmessenger rescan --json`。如果仍未找到，在 Setup 的设置页指定 Codex 可执行文件的绝对路径。

### 命令行 `logs` 返回 `operation_unavailable`

可以直接查看本地日志：

- Windows：`%USERPROFILE%\.quukk-clawmessenger\logs\bridge.log`
- macOS/Linux：`$HOME/.quukk-clawmessenger/logs/bridge.log`

Windows PowerShell 示例：

```powershell
Get-Content "$env:USERPROFILE\.quukk-clawmessenger\logs\bridge.log" -Tail 100
```

### Linux 上 `status` 一直显示 `starting`，或 `start`/`setup`/`pair` 报 `unsafe_identity`

最常见原因：npm 安装或升级时 lifecycle 脚本被拦截（如 `allow-scripts`），本地 Go 运行时二进制丢失可执行权限。daemon 每次启动即崩溃，进程身份残留在 `starting` 态，后续所有命令报 `unsafe_identity` 或 `operation_timeout`。

按以下顺序修复：

```bash
# 1. 给运行时二进制补可执行权限（路径中的 node_modules 全局根可用 npm root -g 查询）
chmod +x "$(npm root -g)/quukk-clawmessenger/node_modules/@quukk/clawmessenger-runtime-linux-x64/clawmessenger-runtime"

# 2. 清掉残留的进程身份目录（内容仅为身份/恢复产物，重启自动重建）
rm -rf "$HOME/.quukk-clawmessenger/run/"

# 3. 重新启动并验证
quukk-clawmessenger start --no-open
quukk-clawmessenger status    # 期望 ready
```

如需确认根因，可前台启动查看真实报错：

```bash
rm -rf "$HOME/.quukk-clawmessenger/run/"
quukk-clawmessenger start --foreground --no-open
```

输出 `Error: spawn ... clawmessenger-runtime EACCES` 即为权限问题。arm64 机器把路径中的 `linux-x64` 换成 `linux-arm64`。

### 日志反复出现 `binding_capability_sync_failed`（`runtime_identity_changed`）

`state.json` 中保存的绑定记录了注册时的运行时 ID 和可执行文件路径。当智能体 CLI 重装、路径变化（例如 `/root/.opencode/bin/opencode` 与 `/usr/bin/opencode` 并存，或记录里残留了错误平台的路径）时，本地探测到的新运行时与旧绑定对不上，每次启动都无法重新注册，Web 端capabilities 不更新、节点离线。

处理方法：清除旧绑定后重新配对。

```bash
quukk-clawmessenger stop
cp "$HOME/.quukk-clawmessenger/state.json" "$HOME/.quukk-clawmessenger/state.json.bak"
cp "$HOME/.quukk-clawmessenger/credentials.json" "$HOME/.quukk-clawmessenger/credentials.json.bak"

# 最干净的方式：删除状态与凭证文件（daemon 会自动重建全新空状态）
rm -f "$HOME/.quukk-clawmessenger/state.json" "$HOME/.quukk-clawmessenger/credentials.json"
rm -rf "$HOME/.quukk-clawmessenger/run/"

quukk-clawmessenger setup
quukk-clawmessenger start --no-open
quukk-clawmessenger pair    # 重新拿配对码，在 Web 端重新绑定
```

服务端会按 MAC + 平台复用原有节点记录，重新配对后节点名称与能力自动刷新。用 `quukk-clawmessenger rescan --json` 可确认当前探测到的运行时 ID 与 `interactiveRounds` 能力。

## 10. 数据位置与安全要求

本地状态默认保存在：

- Windows：`%USERPROFILE%\.quukk-clawmessenger\`
- macOS/Linux：`$HOME/.quukk-clawmessenger/`

请遵守以下要求：

- 不要把二维码、配对码、启动票据、节点令牌或本地状态文件发送给其他人。
- 不要在设备之间复制整个状态目录，也不要手工编辑认证信息。
- 只授权必要的工作目录，并定期检查授权范围。
- 二维码泄露、设备丢失或账号异常时，立即取消当前配对，并从 ClawMessenger 中停用或移除相关节点。
- 卸载 npm 包不会自动删除本地状态，也不会自动撤销远端节点。需要退役设备时，应先在账号或管理端完成节点撤销，再清理本地数据。
