# dsh-xuediner-gateway

[English](#english) | [中文说明](#中文说明)

---

## 中文说明

DeepSeek Harness 统一网关插件：把**多个订阅/账号体系**收敛为 DSH 模型选择器里的同一个 provider —— **xuedinerAPI**，**无需手动配置 API Key**（除纯 Key 型上游外）。

### 🌟 特性

- **统一 provider**：一个 `xuedinerAPI` 入口，按模型 ID 自动路由到正确的上游。
- **账号池与容灾**：多账号轮转、冷却 / 熔断、会话粘性；网关不可用时自动降级到直连或下一账号。
- **OAuth 登录**：CodeArts（PKCE + DPoP）、WorkBuddy/CodeBuddy（设备码）、Codex（`codex login` 复用本机凭据）均走浏览器/官方 CLI，不在插件里存明文密码。
- **安全原子存储**：凭证只落在**你本机**（`auths/`、`.codex*`、`~/.dsh/.credentials.yaml`），本仓库**不包含任何账号凭证**，只描述路径与获取方法。
- **可观测**：`/pool` 命令 + Settings 号池面板 + `node scripts/pool-report.mjs`。

### 📋 上游一览

| 上游 | 登录方式 | 前置条件 | 模型 ID 示例 |
| :--- | :--- | :--- | :--- |
| **CodeArts**（华为云） | OAuth PKCE（`node scripts/login-codearts.mjs`） | 华为云账号 | `deepseek-v4.1-flash`、`glm-5.3-flash` |
| **WorkBuddy/CodeBuddy 池**（网关） | 面板添加账号 / `gateway/login.sh` | 腾讯 CodeBuddy 账号 | `hy4-preview`、网关透出的模型 |
| **ZCode**（本地 zcode-proxy） | 本地代理鉴权 | 自行部署 zcode-proxy | `glm-5.3-flash`（统一入口，优先走 Z.AI 计划额度） |
| **Qoder**（直连） | OAuth 落库 / 手工 Key | Qoder 账号 | `qwen3.8-flash`、`qwen3.8-max` |
| **GPT**（Codex 订阅池） | `codex login`（本机 `~/.codex` / `~/.codex-pool-b`） | ChatGPT Plus / Pro | `GPT/gpt-6-sol`、`GPT/gpt-6-astra` |
| **OpenRouter / LLM7 / Groq / 智谱 / 9Router** | 纯 Key（`~/.dsh/.credentials.yaml`） | 各家账号 | 见各模块注释 |

### 🗂️ 仓库结构

```
dsh-xuediner-gateway/
├── src/                 # DSH 插件源码（TS，构建产物在 lib/，不入库）
│   ├── index.ts         # provider 注册入口
│   ├── adapter.ts       # 统一路由：按模型 ID 分发各上游
│   ├── pool-hub.ts      # /api/pool-hub + /pool 号池快照
│   ├── codearts-auth.ts # CodeArts DPoP 续期
│   ├── intl-direct.ts   # codebuddy.ai 直连
│   ├── codex.ts         # Codex 订阅池（读本机 ~/.codex*）
│   ├── zcode.ts         # 本地 zcode-proxy 桥接
│   ├── qoder.ts         # Qoder 直连
│   └── ...
├── client/index.js      # Settings 号池面板（Web 注入）
├── scripts/             # 本地运维脚本（登录/号池报告）
│   ├── login-codearts.mjs
│   └── pool-report.mjs
├── gateway/             # Go 网关（OpenAI 兼容 + Web 面板 + 定时任务）
│   ├── cmd/             # server / login / signin / credit
│   ├── internal/        # 账号池 / 上游 / 调度 / 面板
│   ├── scripts/         # 任务脚本（事件上报方法）
│   ├── config.example.json
│   └── README.md        # 网关详细文档
├── cordis.patch.yml
├── package.json
└── tsconfig.json
```

### 🚀 安装与使用

```sh
dsh plugin --profile desktop add github:xuediner-source/dsh-xuediner-gateway
```

1. **网关（可选，但 WorkBuddy 池需要它）**：
   ```sh
   cd gateway
   cp config.example.json config.json   # 按需改 api_key
   go build -o xuediner-gateway ./cmd/server
   ./xuediner-gateway --config config.json
   # 或 Docker：docker compose up -d --build
   ```
   启动后：API `http://localhost:7863/v1/chat/completions`，面板 `http://localhost:7863/`。
2. **登录账号**（凭证只存本机，绝不进仓库）：
   - CodeArts：`node scripts/login-codearts.mjs` → 浏览器完成授权 → 落盘到网关 `auths/codearts-*.json`。
   - WorkBuddy 国内版：`cd gateway && ./login.sh` → 落盘 `auths/workbuddy-<uid>.json`。
   - WorkBuddy 海外版：`cd gateway && ./login.sh` 按提示选 intl，或面板添加 → 落盘 `auths/workbuddy-intl-<uid>.json`。
   - Codex：本机 `codex login`（A 号 `~/.codex`，B 号 `CODEX_HOME=~/.codex-pool-b codex login`）。
   - 纯 Key 上游：写入 `~/.dsh/.credentials.yaml`（`OPENROUTER_API_KEY`、`LLM7_API_KEY`、`GROQ_API_KEY`、`ZHIPU_API_KEY`、`QODER_ACCESS_TOKEN` 等）。
3. **插件指向网关**（默认就是 `http://127.0.0.1:7863/v1` + `wb2api-dsh-key`，与 `gateway/config.example.json` 一致；改了网关 key 才需要改）：
   ```sh
   XUEDINER_GATEWAY_URL=http://127.0.0.1:7863 XUEDINER_API_KEY=你的key
   ```
   或 `XUEDINER_GATEWAY_DIR=/path/to/gateway-checkout` 让插件自动找到 `auths/`。
4. 重启 DSH，在模型选择器里选 `xuedinerAPI`，`/pool` 查看号池状态。

### 🛡️ 安全性与隐私说明

- 本仓库**零凭证**：`auths/`、`data/`、`config.json`、`*.key/*.pem/.env`、本机 `~/.codex*`、`~/.dsh/.credentials.yaml` 全部被 `.gitignore` 拦截，只进 `config.example.json` 这类模板。
- 上传前可用 `git status --short` + `git ls-files | grep -Ei 'auth|credential|token|\.key$|\.pem$'` 自查（见 `test/`）。
- 网关默认只监听本地回环；公网暴露前务必把 `api_key` 换成强随机值。

### 🔨 本地构建与测试

```sh
pnpm install
pnpm run typecheck          # TS 类型检查
pnpm run build              # 产物输出到 lib/（不入库）
cd gateway && go build ./... && go test ./...
node test/run-all.mjs       # 防泄漏 + 契约测试
```

---

<a name="english"></a>
## English

DeepSeek Harness unified gateway plugin: many subscription/account systems, one provider in the DSH model picker — **xuedinerAPI** — **without hand-configured API keys** (except pure key-based upstreams).

### 🌟 Highlights

- **One provider**: a single `xuedinerAPI` entry routes by model id to the right upstream.
- **Pools & failover**: multi-account rotation, cooldown/breaker, session stickiness; graceful fallback when the gateway is down.
- **OAuth logins**: CodeArts (PKCE + DPoP), WorkBuddy/CodeBuddy (device code), Codex (reuses the local `~/.codex*` CLI logins) — no plaintext passwords inside the plugin.
- **Zero credentials in repo**: secrets live only on **your machine** (`auths/`, `.codex*`, `~/.dsh/.credentials.yaml`). This repo documents paths and methods only.
- **Observable**: `/pool` command, Settings pool panel, `node scripts/pool-report.mjs`.

### 🚀 Install & use

```sh
dsh plugin --profile desktop add github:xuediner-source/dsh-xuediner-gateway
```

1. **Gateway** (needed for the WorkBuddy pool):
   ```sh
   cd gateway
   cp config.example.json config.json
   go build -o xuediner-gateway ./cmd/server
   ./xuediner-gateway --config config.json
   ```
   API at `http://localhost:7863/v1/chat/completions`, panel at `http://localhost:7863/`.
2. **Log in** (local only, never committed): CodeArts via `node scripts/login-codearts.mjs`; WorkBuddy via `gateway/login.sh`; Codex via `codex login`; pure keys via `~/.dsh/.credentials.yaml`.
3. Restart DSH, pick `xuedinerAPI`, run `/pool` to inspect the pool.

### 🛡️ Security

Zero credentials in this repo: `auths/`, `data/`, `config.json`, keys, and local CLI logins are all git-ignored; only templates like `config.example.json` are tracked. The gateway binds loopback by default; set a strong `api_key` before exposing it.

### 🔨 Build & test

```sh
pnpm install
pnpm run typecheck
pnpm run build
cd gateway && go build ./... && go test ./...
node test/run-all.mjs
```
