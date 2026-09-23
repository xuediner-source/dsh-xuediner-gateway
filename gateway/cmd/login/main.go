// login.go — WorkBuddy / CodeBuddy OAuth 登录（设备授权流程，支持 CN 与 INTL 海外版）。
//
// 两个子命令，由 login.sh 或 add-account.ps1 顺序驱动：
//
//	login url [intl|cn] → POST /v2/plugin/auth/state?platform=CLI 拿 state+authUrl，
//	                      state+realm 落临时文件，stdout 打印授权 URL
//	login poll          → 读 state，GET /v2/plugin/auth/token?state= 一次，
//	                      成功再 GET /v2/plugin/login/account?state= 拿 uid/nickname，
//	                      stdout 打印完整 token+account JSON
//
// 无 PKCE（workbuddy 设备流由服务端签发 state）。
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"os"
	"strings"
	"time"
)

// 常量定义
const (
	upstreamBaseCN   = "https://copilot.tencent.com"
	originRefererCN  = "https://www.codebuddy.cn"
	upstreamBaseIntl = "https://www.codebuddy.ai"
	originRefererIntl = "https://www.codebuddy.ai"
	clientUA         = "CLI/2.63.2 CodeBuddy/2.63.2"
)

var stateFile = os.TempDir() + "/wb2api-login-state.json"

// loginStatePath 返回指定 realm 的登录中间态文件路径。
// 国内版与国外版分开存放，避免同时登录时互相覆盖。
func loginStatePath(realm string) string {
	if realm == "intl" {
		return os.TempDir() + "/wb2api-login-state-intl.json"
	}
	return os.TempDir() + "/wb2api-login-state.json"
}

// commonHeaders 通用请求头
func commonHeaders(req *http.Request, origin string) {
	if origin == "" {
		origin = originRefererCN
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	req.Header.Set("Origin", origin)
	req.Header.Set("Referer", origin+"/")
	req.Header.Set("User-Agent", clientUA)
}

// apiEnvelope 与 main.go 一致
type apiEnvelope struct {
	Code int             `json:"code"`
	Msg  string          `json:"msg"`
	Data json.RawMessage `json:"data"`
}

// doJSON 发起请求并解析信封
func doJSON(client *http.Client, method, fullURL string, headers func(*http.Request), origin string, body io.Reader) (json.RawMessage, int, error) {
	req, err := http.NewRequest(method, fullURL, body)
	if err != nil {
		return nil, 0, err
	}
	if headers != nil {
		headers(req)
	} else {
		commonHeaders(req, origin)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, resp.StatusCode, fmt.Errorf("http_error: upstream %d", resp.StatusCode)
	}
	if resp.StatusCode >= 300 {
		return nil, resp.StatusCode, fmt.Errorf("http_error: upstream redirect %d", resp.StatusCode)
	}
	var env apiEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, resp.StatusCode, fmt.Errorf("parse failed: %w", err)
	}
	if env.Code != 0 {
		return nil, resp.StatusCode, fmt.Errorf("code=%d msg=%s", env.Code, env.Msg)
	}
	return env.Data, resp.StatusCode, nil
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "login: "+format+"\n", args...)
	os.Exit(1)
}

type loginState struct {
	State  string `json:"state"`
	Base   string `json:"base"`
	Origin string `json:"origin"`
	Realm  string `json:"realm"`
}

func main() {
	if len(os.Args) < 2 {
		fatal("usage: login <url [intl|cn]|poll>")
	}
	// 每个流程独立 cookie jar（oauth.go:22-29：多账号登录互不串会话）
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Timeout: 30 * time.Second, Jar: jar}

	switch os.Args[1] {
	case "url":
		base := upstreamBaseCN
		origin := originRefererCN
		realm := "cn"
		if (len(os.Args) >= 3 && (os.Args[2] == "intl" || os.Args[2] == "oversea" || os.Args[2] == "ai")) || os.Getenv("WB_REALM") == "intl" {
			base = upstreamBaseIntl
			origin = originRefererIntl
			realm = "intl"
		}
		// 国内版与国外版使用独立 state 文件，避免并发登录互相覆盖。
		stateFile = loginStatePath(realm)

		endpointAuthState := base + "/v2/plugin/auth/state?platform=CLI"
		data, _, err := doJSON(client, http.MethodPost, endpointAuthState, nil, origin, bytes.NewReader([]byte("{}")))
		if err != nil {
			fatal("auth state failed (%s): %v", realm, err)
		}
		var st struct {
			State   string `json:"state"`
			AuthURL string `json:"authUrl"`
		}
		if err := json.Unmarshal(data, &st); err != nil || st.State == "" || st.AuthURL == "" {
			fatal("auth state: missing state or authUrl")
		}
		raw, _ := json.Marshal(loginState{State: st.State, Base: base, Origin: origin, Realm: realm})
		if err := os.WriteFile(stateFile, raw, 0o600); err != nil {
			fatal("write state: %v", err)
		}
		fmt.Println(st.AuthURL)

	case "poll":
		// realm 作为可选第二参数，用于选择对应的 state 文件。
		realm := "cn"
		if len(os.Args) >= 3 && (os.Args[2] == "intl" || os.Args[2] == "oversea" || os.Args[2] == "ai") {
			realm = "intl"
		}
		stateFile = loginStatePath(realm)
		raw, err := os.ReadFile(stateFile)
		if err != nil {
			fatal("read state: %v (先跑 login url %s)", err, realm)
		}
		var ls loginState
		if err := json.Unmarshal(raw, &ls); err != nil {
			fatal("parse state: %v", err)
		}
		base := ls.Base
		if base == "" {
			base = upstreamBaseCN
		}
		origin := ls.Origin
		if origin == "" {
			origin = originRefererCN
		}

		endpointAuthToken := base + "/v2/plugin/auth/token?state="
		endpointLoginAcct := base + "/v2/plugin/login/account?state="

		// handlePollLogin: auth/token 是权威登录状态端点，
		// pending 时业务 code 非 0（"login ing"），完成时 code=0 + token bundle
		tokRaw, status, errTok := doJSON(client, http.MethodGet, endpointAuthToken+ls.State, nil, origin, nil)
		if errTok != nil {
			if status == 0 || status >= 500 {
				fatal("token endpoint error: %v", errTok)
			}
			fatal("登录未完成（waiting for login）。请确认已在浏览器完成登录再按回车")
		}
		var tok struct {
			AccessToken  string `json:"accessToken"`
			RefreshToken string `json:"refreshToken"`
			ExpiresIn    int64  `json:"expiresIn"`
			Domain       string `json:"domain"`
		}
		if err := json.Unmarshal(tokRaw, &tok); err != nil || tok.AccessToken == "" {
			fatal("登录未完成（waiting for login）。请确认已在浏览器完成登录再按回车")
		}
		// login/account 拿 uid/nickname（带 Bearer）
		var acct struct {
			UID          string `json:"uid"`
			EnterpriseID string `json:"enterpriseId"`
			Nickname     string `json:"nickname"`
		}
		acctHeaders := func(r *http.Request) {
			commonHeaders(r, origin)
			r.Header.Set("Authorization", "Bearer "+tok.AccessToken)
		}
		if acctRaw, _, errAcct := doJSON(client, http.MethodGet, endpointLoginAcct+ls.State, acctHeaders, origin, nil); errAcct == nil {
			_ = json.Unmarshal(acctRaw, &acct)
		}

		domain := tok.Domain
		if domain == "" {
			if strings.Contains(base, "codebuddy.ai") {
				domain = "www.codebuddy.ai"
			} else {
				domain = "www.codebuddy.cn"
			}
		}

		out := map[string]any{
			"access_token":  tok.AccessToken,
			"refresh_token": tok.RefreshToken,
			"expires_in":    tok.ExpiresIn,
			"domain":        domain,
			"uid":           acct.UID,
			"enterprise_id": acct.EnterpriseID,
			"nickname":      acct.Nickname,
			"realm":         ls.Realm,
		}
		oraw, _ := json.Marshal(out)
		fmt.Println(string(oraw))
		os.Remove(stateFile)

	default:
		fatal("unknown subcommand %q (want url|poll)", os.Args[1])
	}
}
