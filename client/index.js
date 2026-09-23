// xuedinerAPI Pool HUB — settings section.
// Renders inside DSH Settings as a "xuedinerAPI 号池" section, showing every
// account in the pool (Huawei Cloud CodeArts + Tencent WorkBuddy/CodeBuddy).
// Data comes from GET /api/pool-hub (registered by lib/pool-hub.ts).
window.__ModuleLoader__.load({
	id: "dsh-xuediner-gateway",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react = require("react");
		let jsxRuntime = require("react/jsx-runtime");
		const { useState, useEffect, useCallback, useRef } = react;
		const { jsx, jsxs, Fragment } = jsxRuntime;

		const POLL_MS = 15 * 1000;
		const PATH = "/api/pool-hub";
		const isZh = typeof navigator !== "undefined" && /^(zh|zh-CN|zh-TW|zh-HK)/i.test(navigator.language || "zh");

		const I18N = {
			title: isZh ? "xuedinerAPI 号池" : "xuedinerAPI Pool",
			subtitle: isZh
				? "华为云 CodeArts 与腾讯 WorkBuddy / CodeBuddy 账号的实时状态。DeepSeek V4.1 优先走华为云，失败自动落到腾讯号池。"
				: "Live status for Huawei Cloud CodeArts and Tencent WorkBuddy / CodeBuddy accounts. DeepSeek V4.1 prefers Huawei Cloud and falls back to the Tencent pool.",
			loading: isZh ? "加载中…" : "Loading...",
			refresh: isZh ? "刷新" : "Refresh",
			renew: isZh ? "续期" : "Renew",
			renewAll: isZh ? "全部续期" : "Renew all",
			renewing: isZh ? "续期中…" : "Renewing...",
			renewOk: isZh ? "已续期" : "Renewed",
			renewFail: isZh ? "续期失败" : "Renew failed",
			addAccount: isZh ? "添加账号" : "Add account",
			addIntl: isZh ? "添加国外账号" : "Add intl account",
			addOpening: isZh ? "正在获取授权链接…" : "Opening authorization...",
			addHint: isZh ? "在浏览器完成登录后会自动加入号池" : "Finish sign-in in the browser to join the pool",
			addIntlHint: isZh ? "国外版 codebuddy.ai（Claude / GPT 上游）" : "International pool (codebuddy.ai)",
			addGpt: isZh ? "添加 GPT 账号" : "Add GPT account",
			addGptHint: isZh ? "ChatGPT 订阅（Codex 设备码登录，写入空闲的 A/B 槽）" : "ChatGPT subscription via Codex device login",
			addGptCode: isZh ? "设备码" : "Device code",
			addWaiting: isZh ? "等待浏览器登录…" : "Waiting for browser sign-in...",
			addOk: isZh ? "已加入号池" : "Added to pool",
			addFail: isZh ? "添加失败" : "Add failed",
			runTasks: isZh ? "做任务领积分" : "Run tasks",
			running: isZh ? "执行中…" : "Running...",
			tasksStarted: isZh ? "任务已开始，约 1-2 分钟完成" : "Tasks started; ~1-2 min",
			tasksFail: isZh ? "任务执行失败" : "Task run failed",
			claimed: isZh ? "已领" : "claimed",
			pending: isZh ? "待领" : "pending",
			chances: isZh ? "抽奖" : "draws",
			cancel: isZh ? "取消" : "Cancel",
			autoRefresh: isZh ? "每 15 秒自动刷新" : "Refreshes every 15s",
			codearts: isZh ? "华为云 CodeArts" : "Huawei Cloud CodeArts",
			tencent: isZh ? "腾讯 WorkBuddy / CodeBuddy" : "Tencent WorkBuddy / CodeBuddy",
			gatewayDown: isZh ? "网关未运行" : "Gateway not running",
			gatewayHint: isZh
				? "启动：F:\\DPH\\workbuddy2api-panel\\start-gateway.ps1"
				: "Start: F:\\DPH\\workbuddy2api-panel\\start-gateway.ps1",
			gatewayImpact: isZh
				? "Hy4 Preview 依赖腾讯网关；DeepSeek V4.1 仍可用华为云。"
				: "Hy4 Preview needs the Tencent gateway; DeepSeek V4.1 still works via Huawei Cloud.",
			noCodearts: isZh
				? "未配置。DeepSeek V4.1 将直接使用腾讯号池。"
				: "Not configured. DeepSeek V4.1 will use the Tencent pool directly.",
			normal: isZh ? "正常" : "OK",
			cooling: isZh ? "冷却中" : "Cooling",
			disabled: isZh ? "已禁用" : "Disabled",
			refreshable: isZh ? "可自动续期" : "auto-refresh",
			relogin: isZh ? "需重新登录" : "re-login required",
			expired: isZh ? "已过期，下次调用先续期" : "expired; will refresh on next call",
			never: isZh ? "未使用" : "never",
			credits: isZh ? "积分" : "credits",
			success: isZh ? "成功" : "ok",
			inFlight: isZh ? "在途" : "in-flight",
			lastUse: isZh ? "最近" : "last",
			token: isZh ? "Token" : "Token",
			account: isZh ? "账号" : "Account",
			state: isZh ? "状态" : "State",
			total: isZh ? "总" : "total",
			healthy: isZh ? "健康" : "healthy",
			sticky: isZh ? "粘性会话" : "sticky",
			ago: isZh ? "前" : "ago",
		};

		function ensureStyles() {
			if (typeof document === "undefined") return;
			if (document.getElementById("dsh-xuediner-pool-style")) return;
			const style = document.createElement("style");
			style.id = "dsh-xuediner-pool-style";
			style.textContent =
				"@keyframes dsh-pool-spin{to{transform:rotate(360deg)}}" +
				".dsh-pool-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;" +
				"border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;" +
				"color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}" +
				".dsh-pool-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}";
			document.head.appendChild(style);
		}

		const COLOR_OK = "var(--dsw-alias-state-success-primary)";
		const COLOR_WARN = "var(--dsw-alias-state-warning-primary, #d97706)";
		const COLOR_ERR = "var(--dsw-alias-state-error-primary)";
		const COLOR_DIM = "var(--dsw-alias-label-secondary)";

		function stateColor(state) {
			if (state === "disabled") return COLOR_ERR;
			if (state === "cooling") return COLOR_WARN;
			return COLOR_OK;
		}

		function stateLabel(state) {
			if (state === "disabled") return I18N.disabled;
			if (state === "cooling") return I18N.cooling;
			return I18N.normal;
		}

		async function fetchPool() {
			const res = await fetch(PATH, { cache: "no-store" });
			let body = null;
			try {
				body = await res.json();
			} catch {}
			if (!res.ok || !body || body.ok !== true) {
				throw new Error(body && body.message ? body.message : "HTTP " + res.status);
			}
			return body;
		}

		function sinceAgo(iso) {
			if (!iso) return I18N.never;
			const ms = Date.parse(iso);
			if (!Number.isFinite(ms)) return I18N.never;
			const diff = Date.now() - ms;
			if (diff < 0) return I18N.never;
			let n;
			if (diff < 60_000) n = Math.max(0, Math.round(diff / 1000)) + "s";
			else if (diff < 3_600_000) n = Math.round(diff / 60_000) + "m";
			else if (diff < 86_400_000) n = Math.round(diff / 3_600_000) + "h";
			else n = Math.round(diff / 86_400_000) + "d";
			return isZh ? n + " " + I18N.ago : n + " " + I18N.ago;
		}

		const card = {
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 10,
			padding: "10px 12px",
			display: "flex",
			flexDirection: "column",
			gap: 6,
		};
		const groupTitle = {
			fontSize: 12,
			fontWeight: 700,
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 8,
		};
		const rowBox = {
			display: "flex",
			flexDirection: "column",
			gap: 2,
			padding: "6px 0",
			borderTop: "1px solid var(--dsw-alias-border-l1)",
		};
		const line1 = {
			display: "flex",
			alignItems: "baseline",
			justifyContent: "space-between",
			gap: 8,
			fontSize: 12,
		};
		const metaRow = { display: "flex", gap: 10, flexWrap: "wrap", fontSize: 11, color: COLOR_DIM };
		const num = { fontVariantNumeric: "tabular-nums" };

		function SmallButton(props) {
			return jsx("button", {
				type: "button",
				className: "dsh-pool-btn",
				onClick: props.onClick,
				disabled: props.disabled,
				title: props.title,
				children: props.children,
			});
		}

		/** Renew one CodeArts account (id) or every account (no id). */
		async function renewCodeArts(id) {
			const res = await fetch("/api/pool-hub/codearts/refresh", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(id ? { id } : {}),
			});
			let body = null;
			try {
				body = await res.json();
			} catch {}
			if (!res.ok || !body) {
				throw new Error((body && body.message) || "HTTP " + res.status);
			}
			return body;
		}

		/** Ask the gateway for a fresh OAuth URL. realm: "cn" | "intl" | "gpt". */
		async function startLogin(realm) {
			const path = realm === "gpt"
				? "/api/pool-hub/login/gpt/start"
				: realm === "intl"
					? "/api/pool-hub/login/intl/start"
					: "/api/pool-hub/login/start";
			const res = await fetch(path, { method: "POST" });
			let body = null;
			try {
				body = await res.json();
			} catch {}
			if (!res.ok || !body || body.ok !== true) {
				throw new Error((body && body.message) || "HTTP " + res.status);
			}
			return body;
		}

		/** Poll until the browser sign-in completes. realm: "cn" | "intl" | "gpt". */
		async function pollLogin(realm, state) {
			const path = realm === "gpt"
				? "/api/pool-hub/login/gpt/poll"
				: realm === "intl"
					? "/api/pool-hub/login/intl/poll"
					: "/api/pool-hub/login/poll?state=" + encodeURIComponent(state);
			const res = await fetch(path, { cache: "no-store" });
			let body = null;
			try {
				body = await res.json();
			} catch {}
			if (!res.ok || !body) throw new Error((body && body.message) || "HTTP " + res.status);
			return body;
		}

		/** Run the daily task/credit routine across all accounts. */
		async function runPoolTasks() {
			const res = await fetch("/api/pool-hub/tasks/run", { method: "POST" });
			let body = null;
			try {
				body = await res.json();
			} catch {}
			if (!res.ok || !body) throw new Error((body && body.message) || "HTTP " + res.status);
			return body;
		}

		function PoolSection() {
			const [phase, setPhase] = useState("loading");
			const [snap, setSnap] = useState(null);
			const [message, setMessage] = useState("");
			const [busy, setBusy] = useState(false);
			/** Per-account renewal state: id -> "busy" | "ok" | "fail:<msg>" */
			const [renewState, setRenewState] = useState({});
			const [renewAllBusy, setRenewAllBusy] = useState(false);
			/** Account-addition flow: null | "opening" | "waiting" | "ok" | "fail:<msg>" */
			const [addState, setAddState] = useState(null);
			const [addDetail, setAddDetail] = useState("");
			/** Task run: null | "running" | "started" | "fail:<msg>" */
			const [tasksState, setTasksState] = useState(null);
			const addPoll = useRef(null);
			const mounted = useRef(true);

			const load = useCallback(async (manual) => {
				if (manual) setBusy(true);
				try {
					const body = await fetchPool();
					if (!mounted.current) return;
					setSnap(body);
					setMessage("");
					setPhase("ready");
				} catch (e) {
					if (!mounted.current) return;
					setMessage(e && e.message ? e.message : String(e));
					setPhase("error");
				} finally {
					if (manual && mounted.current) setBusy(false);
				}
			}, []);

			useEffect(() => {
				mounted.current = true;
				load(false);
				const t = setInterval(() => load(false), POLL_MS);
				return () => {
					mounted.current = false;
					clearInterval(t);
					if (addPoll.current) clearInterval(addPoll.current);
				};
			}, [load]);

			/** Stop the add-account poller. */
			const stopAddPoll = useCallback(() => {
				if (addPoll.current) {
					clearInterval(addPoll.current);
					addPoll.current = null;
				}
			}, []);

			/**
			 * Add an account: fetch the OAuth URL, open it, then poll until the
			 * gateway reports the credential landed. The gateway writes the file,
			 * hot-reloads the pool and performs the daily check-in itself.
			 * realm "cn" uses the gateway panel endpoint; "intl" drives the
			 * bundled login helper for the codebuddy.ai pool.
			 */
			const addAccount = useCallback(async (realm) => {
				stopAddPoll();
				setAddState("opening");
				setAddDetail("");
				try {
					const started = await startLogin(realm);
					if (started.url || started.verificationUrl) {
						window.open(started.url || started.verificationUrl, "_blank", "noopener");
					}
					setAddState("waiting");
					if (realm === "gpt" && started.userCode) {
						setAddDetail(I18N.addGptCode + " " + started.userCode);
					}
					const state = started.state;
					if (realm === "cn" && !state) {
						setAddState("fail:" + I18N.addFail);
						return;
					}
					// Poll for up to ~5 minutes, matching the gateway's login TTL.
					let ticks = 0;
					addPoll.current = setInterval(async () => {
						ticks += 1;
						if (ticks > 100) {
							stopAddPoll();
							if (mounted.current) setAddState("fail:" + (isZh ? "超时，请重新添加" : "timed out"));
							return;
						}
						try {
							const out = await pollLogin(realm, state);
							if (!mounted.current) return;
							if (out.done === true) {
								stopAddPoll();
								setAddState("ok");
								setAddDetail(out.nickname ? String(out.nickname) : "");
								await load(false);
								setTimeout(() => {
									if (mounted.current) setAddState(null);
								}, 6000);
							} else if (out.message) {
								setAddDetail(String(out.message));
							}
						} catch (e) {
							stopAddPoll();
							if (mounted.current) setAddState("fail:" + (e && e.message ? e.message : String(e)));
						}
					}, 3000);
				} catch (e) {
					setAddState("fail:" + (e && e.message ? e.message : String(e)));
				}
			}, [load, stopAddPoll]);

			/** Trigger the daily task routine and refresh once it settles. */
			const runTasks = useCallback(async () => {
				setTasksState("running");
				try {
					const out = await runPoolTasks();
					if (out.ok !== true) throw new Error(out.message || I18N.tasksFail);
					setTasksState("started");
					// Tasks run asynchronously upstream; give them time, then reload.
					setTimeout(async () => {
						if (!mounted.current) return;
						await load(false);
						setTasksState(null);
					}, 90_000);
				} catch (e) {
					setTasksState("fail:" + (e && e.message ? e.message : String(e)));
				}
			}, [load]);

			/** Renew a single CodeArts account and refresh the snapshot after. */
			const renewOne = useCallback(async (id) => {
				setRenewState((s) => ({ ...s, [id]: "busy" }));
				try {
					const out = await renewCodeArts(id);
					const row = (out.results || []).find((r) => r.id === id) || (out.results || [])[0];
					const ok = row && row.ok;
					setRenewState((s) => ({ ...s, [id]: ok ? "ok" : "fail:" + ((row && row.message) || I18N.renewFail) }));
					await load(false);
				} catch (e) {
					setRenewState((s) => ({ ...s, [id]: "fail:" + (e && e.message ? e.message : String(e)) }));
				}
			}, [load]);

			/** Renew every CodeArts account in one call. */
			const renewAll = useCallback(async () => {
				setRenewAllBusy(true);
				try {
					const out = await renewCodeArts();
					const rows = out.results || [];
					const next = {};
					for (const r of rows) next[r.id] = r.ok ? "ok" : "fail:" + (r.message || I18N.renewFail);
					setRenewState((s) => ({ ...s, ...next }));
					await load(false);
				} catch (e) {
					setMessage(e && e.message ? e.message : String(e));
				} finally {
					setRenewAllBusy(false);
				}
			}, [load]);

			// ---- header ----
			const header = jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: 6 },
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
						children: [
							jsx("div", {
								style: { fontSize: 14, fontWeight: 700 },
								children: I18N.title,
							}),
							jsxs("div", { style: { display: "flex", gap: 6 }, children: [
								jsx(SmallButton, {
									onClick: () => load(true),
									disabled: busy,
									title: I18N.refresh,
									children: I18N.refresh,
								}),
							] }),
						],
					}),
					jsx("div", {
						style: { fontSize: 12, color: COLOR_DIM, lineHeight: "18px" },
						children: I18N.subtitle,
					}),
				],
			});

			if (phase === "loading") {
				return jsx("div", {
					style: { display: "flex", flexDirection: "column", gap: 10, padding: "4px 0" },
					children: [header, jsx("div", { style: { fontSize: 12, color: COLOR_DIM }, children: I18N.loading })],
				});
			}

			if (phase === "error") {
				return jsx("div", {
					style: { display: "flex", flexDirection: "column", gap: 10, padding: "4px 0" },
					children: [
						header,
						jsxs("div", { style: { ...card, borderColor: COLOR_ERR }, children: [
							jsx("div", { style: { color: COLOR_ERR, fontSize: 12, fontWeight: 600 }, children: I18N.gatewayDown }),
							jsx("div", { style: { fontSize: 11, color: COLOR_DIM, wordBreak: "break-word" }, children: message }),
							jsx("div", { style: { fontSize: 11, color: COLOR_DIM }, children: I18N.gatewayHint }),
						] }),
					],
				});
			}

			const t = snap.tencent;

			// ---- Huawei Cloud CodeArts ----
			const codeartsBlock = jsxs("div", {
				style: card,
				children: [
					jsxs("div", { style: groupTitle, children: [
						jsx("span", { children: I18N.codearts }),
						jsxs("span", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
							jsx("span", { style: { ...num, color: COLOR_DIM, fontWeight: 500 }, children: String(snap.codearts.count) }),
							snap.codearts.count > 0
								? jsx(SmallButton, {
										onClick: renewAll,
										disabled: renewAllBusy,
										title: I18N.renewAll,
										children: renewAllBusy ? I18N.renewing : I18N.renewAll,
									})
								: null,
						] }),
					] }),
					snap.codearts.count === 0
						? jsx("div", { style: { fontSize: 11, color: COLOR_DIM }, children: I18N.noCodearts })
						: snap.codearts.accounts.map((a) => {
								const left = a.minutesLeft;
								const tone = left === null ? COLOR_DIM : left <= 0 ? COLOR_ERR : left < 20 ? COLOR_WARN : COLOR_OK;
								const text =
									left === null
										? I18N.never
										: left <= 0
											? I18N.expired
											: (isZh ? "剩余 " : "") + left + (isZh ? " 分钟" : "m") +
												" · " + (a.refreshable ? I18N.refreshable : I18N.relogin);
								const st = renewState[a.id];
								const stText = st === "busy" ? I18N.renewing
									: st === "ok" ? I18N.renewOk
									: typeof st === "string" && st.startsWith("fail:") ? st.slice(5)
									: "";
								const stColor = st === "ok" ? COLOR_OK
									: typeof st === "string" && st.startsWith("fail:") ? COLOR_ERR
									: COLOR_DIM;
								return jsxs("div", { style: rowBox, children: [
									jsxs("div", { style: line1, children: [
										jsx("span", { style: { ...num, fontWeight: 600 }, children: a.id }),
										jsxs("span", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
											jsx("span", { style: { ...num, color: tone, fontWeight: 600 }, children: text }),
											jsx(SmallButton, {
												onClick: () => renewOne(a.id),
												disabled: st === "busy" || !a.refreshable,
												title: a.refreshable ? I18N.renew : I18N.relogin,
												children: st === "busy" ? "…" : I18N.renew,
											}),
										] }),
									] }),
									jsxs("div", { style: metaRow, children: [
										jsx("span", { children: I18N.token }),
										jsx("span", {
											style: num,
											children: (isZh ? "今日已用 " : "Today: ") +
												(a.usageToday && typeof a.usageToday.totalTokens === "number"
													? a.usageToday.totalTokens.toLocaleString()
													: "0") +
												" / 10,000,000 (" +
												(a.usageToday?.percent ?? 0) + "%)" +
												(a.usageToday?.requests ? (isZh ? " · 成功 " : " · ") + a.usageToday.requests + (isZh ? " 次" : " reqs") : "")
										}),
									] }),
									a.usageToday && a.usageToday.percent > 0
										? jsx("div", {
												style: { height: 3, borderRadius: 99, background: "var(--dsw-alias-border-l1)", overflow: "hidden", marginTop: 3 },
												children: jsx("div", {
													style: { width: Math.min(100, Math.max(1, a.usageToday.percent)) + "%", height: "100%", background: COLOR_OK, borderRadius: 99 }
												})
											})
										: null,
									stText
										? jsx("div", { style: { fontSize: 11, color: stColor, wordBreak: "break-word" }, children: stText })
										: null,
								] }, a.id);
							}),
				],
			});

			// ---- Xiaomi MiMo quota was removed on 2026-09-22 at the user's
			// request, together with its picker entries. ----

			// ---- Tencent ----
			const addBusy = addState === "opening" || addState === "waiting";
			const addIsFail = typeof addState === "string" && addState.startsWith("fail:");
			const addStatusText =
				addState === "opening" ? I18N.addOpening
				: addState === "waiting" ? I18N.addWaiting
				: addState === "ok" ? I18N.addOk + (addDetail ? "：" + addDetail : "")
				: addIsFail ? addState.slice(5)
				: "";
			const addStatusColor = addState === "ok" ? COLOR_OK : addIsFail ? COLOR_ERR : COLOR_DIM;

			const tencentBlock = jsxs("div", {
				style: card,
				children: [
					jsxs("div", { style: groupTitle, children: [
						jsx("span", { children: I18N.tencent }),
						jsxs("span", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
							jsx("span", {
								style: { ...num, color: t.reachable ? COLOR_DIM : COLOR_WARN, fontWeight: 500 },
								children: t.reachable ? t.healthy + "/" + t.count + " " + I18N.healthy : I18N.gatewayDown,
							}),
							jsx(SmallButton, {
								onClick: () => runTasks(),
								disabled: tasksState === "running" || !t.reachable,
								title: I18N.runTasks,
								children: tasksState === "running" ? I18N.running : I18N.runTasks,
							}),
							jsx(SmallButton, {
								onClick: () => addAccount("intl"),
								disabled: addBusy,
								title: I18N.addIntlHint,
								children: I18N.addIntl,
							}),
							jsx(SmallButton, {
								onClick: () => addAccount("cn"),
								disabled: addBusy,
								title: I18N.addAccount,
								children: addBusy ? "…" : I18N.addAccount,
							}),
						] }),
					] }),
					tasksState
						? jsx("div", {
								style: {
									fontSize: 11,
									color: tasksState === "started" ? COLOR_OK
										: typeof tasksState === "string" && tasksState.startsWith("fail:") ? COLOR_ERR
										: COLOR_DIM,
									wordBreak: "break-word",
								},
								children: tasksState === "running" ? I18N.running
									: tasksState === "started" ? I18N.tasksStarted
									: tasksState.slice(5),
							})
						: null,
					addStatusText
						? jsxs("div", { style: { fontSize: 11, color: addStatusColor, wordBreak: "break-word" }, children: [
								addStatusText,
								addState === "waiting" ? jsx("span", { style: { color: COLOR_DIM, marginLeft: 6 }, children: I18N.addHint }) : null,
							] })
						: null,
					!t.reachable
						? jsxs(Fragment, { children: [
								jsx("div", { style: { fontSize: 12, color: COLOR_WARN, fontWeight: 600 }, children: I18N.gatewayDown }),
								jsx("div", { style: { fontSize: 11, color: COLOR_DIM, wordBreak: "break-word" }, children: t.error || "" }),
								jsx("div", { style: { fontSize: 11, color: COLOR_DIM }, children: I18N.gatewayHint }),
								jsx("div", { style: { fontSize: 11, color: COLOR_DIM }, children: I18N.gatewayImpact }),
							] })
						: t.accounts.map((a) =>
								jsxs("div", { style: rowBox, children: [
									jsxs("div", { style: line1, children: [
										jsxs("span", { style: { fontWeight: 600 }, children: [
											a.nickname || a.id,
											jsx("span", { style: { color: COLOR_DIM, fontWeight: 400, marginLeft: 6 }, children: a.id }),
										] }),
										jsx("span", { style: { color: stateColor(a.state), fontWeight: 700 }, children: stateLabel(a.state) }),
									] }),
									jsxs("div", { style: metaRow, children: [
										jsx("span", { style: num, children: (a.credits === null ? "—" : a.credits) + " " + I18N.credits }),
										jsx("span", { style: num, children: "✓ " + a.successCount + " " + I18N.success }),
										a.inFlight > 0
											? jsx("span", { style: { ...num, color: COLOR_OK, fontWeight: 600 }, children: I18N.inFlight + " " + a.inFlight })
											: null,
										jsx("span", { style: num, children: I18N.lastUse + " " + sinceAgo(a.lastSuccess) }),
									] }),
									a.detail ? jsx("div", { style: { fontSize: 11, color: stateColor(a.state) }, children: a.detail }) : null,
								] }, a.id),
							),
					t.reachable
						? jsxs("div", { style: { ...metaRow, borderTop: "1px solid var(--dsw-alias-border-l1)", paddingTop: 6 }, children: [
								jsx("span", { children: I18N.total + " " + t.count }),
								jsx("span", { children: I18N.cooling + " " + t.cooling }),
								jsx("span", { children: I18N.disabled + " " + t.disabled }),
								jsx("span", { children: I18N.sticky + " " + t.stickySessions }),
							] })
						: null,
				],
			});

			// ---- ZCode (Z.AI coding plan via local proxy) ----
			const z = snap.zcode || { reachable: false, models: 0 };
			const zcodeBlock = jsxs("div", {
				style: card,
				children: [
					jsxs("div", { style: groupTitle, children: [
						jsx("span", { children: isZh ? "ZCode（Z.AI 编码套餐）" : "ZCode (Z.AI plan)" }),
						jsx("span", {
							style: { ...num, color: z.reachable ? COLOR_OK : COLOR_ERR, fontWeight: 600 },
							children: z.reachable ? z.models + " " + (isZh ? "模型" : "models") : (isZh ? "代理未运行" : "proxy down"),
						}),
					] }),
					!z.reachable
						? jsxs("div", { style: { fontSize: 11, color: COLOR_WARN, wordBreak: "break-word" }, children: [
								jsx("div", { children: isZh ? "本机代理未运行（127.0.0.1:8080）。GLM-5.3-Flash 将直接走号池。" : "Local proxy not running (127.0.0.1:8080). GLM-5.3-Flash falls back to the pool." }),
								z.error ? jsx("div", { style: { color: COLOR_DIM }, children: z.error }) : null,
							] })
						: jsx("div", { style: { fontSize: 11, color: COLOR_DIM }, children: isZh ? "GLM-5.3-Flash 优先消耗 ZCode 订阅额度，用尽自动落号池。" : "GLM-5.3-Flash uses the ZCode plan first, pool fallback." }),
				],
			});

			// ---- Codex GPT account pool ----
			const codexList = (snap.codex && Array.isArray(snap.codex.accounts)) ? snap.codex.accounts : [];
			const codexAny = codexList.some((a) => a.valid);
			const codexBlock = jsxs("div", {
				style: card,
				children: [
					jsxs("div", { style: groupTitle, children: [
						jsx("span", { children: isZh ? "GPT（Codex 号池）" : "GPT (Codex pool)" }),
						jsxs("span", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
							jsx("span", {
								style: { ...num, color: codexAny ? COLOR_OK : COLOR_ERR, fontWeight: 600 },
								children: codexAny
									? codexList.filter((a) => a.valid).length + "/" + codexList.length + " " + (isZh ? "有效" : "valid")
									: (isZh ? "未登录" : "not logged in"),
							}),
							jsx(SmallButton, {
								onClick: () => addAccount("gpt"),
								disabled: addBusy,
								title: I18N.addGptHint,
								children: addBusy ? "…" : I18N.addGpt,
							}),
						] }),
					] }),
					codexList.length === 0
						? jsx("div", { style: { fontSize: 11, color: COLOR_DIM }, children: isZh ? "未发现账号（~/.codex 或 ~/.codex-pool-b 无 auth.json）" : "No accounts found" })
						: codexList.map((a) =>
								jsxs("div", { style: rowBox, children: [
									jsxs("div", { style: line1, children: [
										jsxs("span", { style: { fontWeight: 600 }, children: a.label || (isZh ? "未命名账号" : "Unnamed account") }),
										jsx("span", {
											style: { color: a.valid ? COLOR_OK : COLOR_ERR, fontWeight: 700 },
											children: a.valid ? (a.plan || "chatgpt") : (isZh ? "无凭证" : "no auth"),
										}),
									] }),
									jsxs("div", { style: metaRow, children: [
										a.subscriptionUntil
										? jsx("span", {
												style: {
													...num,
													color: Date.parse(a.subscriptionUntil) - Date.now() < 7 * 86400000 ? COLOR_WARN : COLOR_DIM,
													fontWeight: 600,
												},
												children: (isZh ? "Plus 到期 " : "Plus until ") + a.subscriptionUntil.slice(0, 10),
											})
										: null,
									a.tokenExpiresAt
											? jsx("span", { style: num, children: (isZh ? "凭证至 " : "token to ") + a.tokenExpiresAt.slice(0, 10) })
											: null,
										a.window
											? jsx("span", {
													style: { ...num, color: a.window.usedPercent >= 90 ? COLOR_ERR : a.window.usedPercent >= 70 ? COLOR_WARN : COLOR_OK, fontWeight: 600 },
													children: (isZh ? "5h 窗口 " : "5h window ") + Math.round(a.window.usedPercent * 10) / 10 + "%",
												})
											: null,
										a.window && a.window.resetsAt && !a.window.resetsAt.startsWith("1970")
											? jsx("span", { style: num, children: (isZh ? "重置 " : "resets ") + sinceAgo(a.window.resetsAt) })
											: null,
									] }),
									a.weekly
										? jsx("span", {
												style: { ...num, color: a.weekly.usedPercent >= 90 ? COLOR_ERR : a.weekly.usedPercent >= 70 ? COLOR_WARN : COLOR_OK, fontWeight: 600 },
												children: (isZh ? "周窗口 " : "weekly ") + Math.round(a.weekly.usedPercent * 10) / 10 + "%",
											})
										: null,
									a.error ? jsx("div", { style: { fontSize: 11, color: COLOR_WARN }, children: a.error }) : null,
								] }, a.key),
							),
				],
			});

			return jsx("div", {
				style: { display: "flex", flexDirection: "column", gap: 10, padding: "4px 0" },
				children: [
					header,
					codeartsBlock,
					tencentBlock,
					zcodeBlock,
					codexBlock,
					jsx("div", { style: { fontSize: 11, color: COLOR_DIM }, children: I18N.autoRefresh }),
				],
			});
		}

		const inject = ["slots"];
		function apply(ctx) {
			ensureStyles();
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{ name: "settings.section", id: "xuediner-pool", order: 88, label: () => I18N.title },
					PoolSection,
				),
			);
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
