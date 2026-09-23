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

### 📋 上游一览（当前实装的全部供应商）

`src/` 下 16 个 TS 模块，其中 10 个是独立上游（`codex` / `commandcode` / `groq` / `intl-direct` / `llm7` / `nine-router` / `openrouter` / `qoder` / `zcode` / `zhipu`），另有 **CodeArts** 与 **WorkBuddy 网关** 两条上游直接实装在 `adapter.ts` 内；其余是支撑模块（`index.ts` 注册入口、`pool-hub.ts` 号池面板、`codearts-auth.ts` / `huawei-sign.ts` / `codearts-usage.ts` 为 CodeArts 的签名与用量辅助）。

合计 **12 个真实上游 + 1 个虚拟聚合（`Free`）**，全部已接进 `adapter.ts` 的分发链。下表是**当前实际存在**的供应商，无占位、无已下线条目。

| # | 上游 | 传输方式 | 登录 / 凭证 | 模型 ID（picker 里实际显示的） |
| :-: | :--- | :--- | :--- | :--- |
| 1 | **CodeArts**（华为云） | 直连 `snap-access.cn-north-4.myhuaweicloud.com`，AK/SK + DPoP 续期 | OAuth PKCE：`node scripts/login-codearts.mjs` | `deepseek-v4.1-flash` |
| 2 | **WorkBuddy / CodeBuddy 池**（腾讯） | 本机网关 `127.0.0.1:7863`（OpenAI 兼容） | 面板添加账号 / `gateway/login.sh` | `hy4-preview` |
| 3 | **CodeBuddy 国际版** | 直连 `www.codebuddy.ai` | 同上（intl 设备码，落盘 `workbuddy-intl-*.json`） | `claude-opus-5` |
| 4 | **Codex 订阅池**（ChatGPT） | 直连 `chatgpt.com/backend-api/codex/responses`（Responses 格式） | `codex login`（本机 `~/.codex`、`~/.codex-pool-b`） | `gpt-6-sol`、`gpt-6-astra`（兼容旧 `GPT/*`） |
| 5 | **Command Code Go** | 直连 `api.commandcode.ai` 的 `/alpha/generate`（自有 SSE 协议） | `commandcode` CLI 登录 → `~/.commandcode/auth.json`；或 `COMMANDCODE_API_KEY` | `cc/meta/muse-spark-1.3-contributor`、`cc/deepseek/deepseek-v4.1-flash`、`cc/xiaomi/mimo-v2.6-pro`、`cc/poolside/laguna-s-2.1-free`、`cc/inclusionai/ling-3.0-flash-sante:free` |
| 6 | **ZCode**（Z.AI / BigModel 编码套餐） | 经本机 `zcode-proxy`（`127.0.0.1:8080`） | 代理自带 key；`~/.zcode-proxy/credentials.json` | `glm-5.3-flash`（统一入口，优先 ZCode、失败转号池） |
| 7 | **Qoder** | 直连 `api3.qoder.sh`，COSY 签名（RSA+AES） | OAuth 落库（9Router DB）/ `QODER_ACCESS_TOKEN` | `qwen3.8-flash`、`qwen3.8-max` |
| 8 | **OpenRouter** | 直连 `openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | `or/<模型>`，并入 `Free` |
| 9 | **LLM7** | 直连 `api.llm7.io/v1` | `LLM7_API_KEY` | `l7/<别名>`，并入 `Free` |
| 10 | **Groq** | 直连 `api.groq.com/openai/v1` | `GROQ_API_KEY` | `groq/<模型>`，并入 `Free` |
| 11 | **智谱 BigModel** | 直连 `open.bigmodel.cn/api/paas/v4` | `ZHIPU_API_KEY` | `zp/<模型>`，并入 `Free` |
| 12 | **9Router** | 经本机 9Router（`127.0.0.1:20128/v1`），目录动态拉取 | `NINE_ROUTER_API_KEY` | `9Router`（聚合轮询）、`9r/<模型>` |
| 13 | **Free**（虚拟聚合） | 轮询 8~11 的免费档 | 上述各家 Key | `Free` |

> 模型 ID 前缀含义：`cc/` Command Code Go · `or/` OpenRouter · `l7/` LLM7 · `groq/` Groq · `zp/` 智谱 · `9r/` 9Router · `zcode/` ZCode（当前不在 picker 中单独列出，仅作 `glm-5.3-flash` 的首选通道）。

**说明**：小米 MiMo 已于 2026-09-22 按要求下线，模块已从树中移除，picker 与号池面板均不再出现（代码里只留了下线注释）。

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

### 📋 Upstreams (everything currently shipped)

**12 real upstreams + 1 virtual aggregate (`Free`)**, all wired into the `adapter.ts` dispatch chain. No placeholders, no retired entries.

| # | Upstream | Transport | Credential / login | Picker model id |
| :-: | :--- | :--- | :--- | :--- |
| 1 | **CodeArts** (Huawei Cloud) | Direct to `snap-access.cn-north-4.myhuaweicloud.com`, AK/SK + DPoP renewal | OAuth PKCE: `node scripts/login-codearts.mjs` | `deepseek-v4.1-flash` |
| 2 | **WorkBuddy / CodeBuddy pool** (Tencent) | Local gateway `127.0.0.1:7863` (OpenAI-compatible) | Panel "add account" / `gateway/login.sh` | `hy4-preview` |
| 3 | **CodeBuddy international** | Direct to `www.codebuddy.ai` | intl device code → `workbuddy-intl-*.json` | `claude-opus-5` |
| 4 | **Codex pool** (ChatGPT) | Direct to `chatgpt.com/backend-api/codex/responses` (Responses format) | `codex login` (`~/.codex`, `~/.codex-pool-b`) | `gpt-6-sol`, `gpt-6-astra` (legacy `GPT/*` still accepted) |
| 5 | **Command Code Go** | Direct to `api.commandcode.ai` `/alpha/generate` (its own SSE protocol) | `commandcode` CLI login → `~/.commandcode/auth.json`; or `COMMANDCODE_API_KEY` | `cc/meta/muse-spark-1.3-contributor`, `cc/deepseek/deepseek-v4.1-flash`, `cc/xiaomi/mimo-v2.6-pro`, `cc/poolside/laguna-s-2.1-free`, `cc/inclusionai/ling-3.0-flash-sante:free` |
| 6 | **ZCode** (Z.AI / BigModel coding plan) | Via local `zcode-proxy` (`127.0.0.1:8080`) | Proxy key; `~/.zcode-proxy/credentials.json` | `glm-5.3-flash` (ZCode first, pool fallback) |
| 7 | **Qoder** | Direct to `api3.qoder.sh`, COSY signature (RSA+AES) | 9Router DB / `QODER_ACCESS_TOKEN` | `qwen3.8-flash`, `qwen3.8-max` |
| 8 | **OpenRouter** | Direct to `openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | `or/<model>`, folded into `Free` |
| 9 | **LLM7** | Direct to `api.llm7.io/v1` | `LLM7_API_KEY` | `l7/<alias>`, folded into `Free` |
| 10 | **Groq** | Direct to `api.groq.com/openai/v1` | `GROQ_API_KEY` | `groq/<model>`, folded into `Free` |
| 11 | **Zhipu BigModel** | Direct to `open.bigmodel.cn/api/paas/v4` | `ZHIPU_API_KEY` | `zp/<model>`, folded into `Free` |
| 12 | **9Router** | Via local 9Router (`127.0.0.1:20128/v1`), live catalog | `NINE_ROUTER_API_KEY` | `9Router` (rotation), `9r/<model>` |
| 13 | **Free** (virtual) | Rotates the free tiers of 8–11 | the keys above | `Free` |

Model-id prefixes: `cc/` Command Code Go · `or/` OpenRouter · `l7/` LLM7 · `groq/` Groq · `zp/` Zhipu · `9r/` 9Router · `zcode/` ZCode (not listed in the picker; used as the `glm-5.3-flash` first-priority path).

**Note**: Xiaomi MiMo was retired on 2026-09-22 at the maintainer's request — the module is gone from the tree and no picker/panel entry remains (only retirement comments stay in the code).

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
