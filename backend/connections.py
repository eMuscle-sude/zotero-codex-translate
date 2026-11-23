"""Authenticated loopback controller for model selection and user-initiated sign-in."""
from __future__ import annotations

import argparse
import copy
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from providers import (API_EFFORTS, CODEX_EFFORTS, CredentialVault, ProviderError, atomic_settings,
                       codex_environment, config_for_connection, is_local_api, load_connections, normalize_url)
from worker import CREATE_NO_WINDOW, VERSION, Status, doctor, resolve_codex, stop_process
from text import TextTranslations


class Connections:
    def __init__(self, state_dir: Path, codex_path=""):
        self.state_dir = Path(state_dir)
        self.codex_path = codex_path
        self.value = load_connections(self.state_dir)
        self.vault = CredentialVault(self.state_dir)
        self.lock = threading.RLock()
        self.accounts = {mode: {"available": False, "loggedIn": False, "checking": True} for mode in ("shared", "isolated")}
        self.login = {"state": "idle"}
        self.login_process = None
        self.login_cancel = threading.Event()
        self.refreshing = False
        self.test = {"state": "idle"}
        self.test_status = None
        self.text = TextTranslations(self.state_dir, self.text_config)

    def text_config(self):
        with self.lock:
            return config_for_connection(self.value, self.state_dir, self.codex_path)

    def save(self):
        atomic_settings(self.state_dir / "connections.json", self.value)

    def public_state(self):
        with self.lock:
            settings = copy.deepcopy(self.value)
            for profile in settings["apis"]:
                profile["hasKey"] = bool(profile.get("credentialRef"))
                profile.pop("credentialRefs", None)
            return {"connections": settings, "codex": copy.deepcopy(self.accounts),
                    "login": copy.deepcopy(self.login), "test": copy.deepcopy(self.test)}

    def probe_account(self, mode, timeout=20):
        try:
            executable = resolve_codex(self.codex_path)
            config = {"codexHome": str(self.state_dir / "codex-auth")} if mode == "isolated" else {}
            if mode == "isolated" and not (self.state_dir / "codex-auth").exists():
                return {"available": True, "loggedIn": False, "checking": False, "kind": "none"}
            args = [executable, "login", "status"] + (["-c", 'cli_auth_credentials_store="file"'] if mode == "isolated" else [])
            result = subprocess.run(args, capture_output=True, encoding="utf-8",
                errors="replace", timeout=timeout, creationflags=CREATE_NO_WINDOW, env=codex_environment(config))
            text = result.stdout + result.stderr
            return {"available": True, "loggedIn": result.returncode == 0, "checking": False,
                    "kind": "chatgpt" if "ChatGPT" in text else "api-key" if "API key" in text else "none"}
        except FileNotFoundError:
            return {"available": False, "loggedIn": False, "checking": False, "message": "未找到 Codex CLI，请安装或填写路径；也可直接选择 API 接入。"}
        except (OSError, subprocess.TimeoutExpired):
            return {"available": True, "loggedIn": False, "checking": False, "message": "登录状态检查超时，请刷新重试。"}

    def refresh(self):
        with self.lock:
            if self.refreshing:
                return
            self.refreshing = True
        def run():
            try:
                for mode in ("shared", "isolated"):
                    account = self.probe_account(mode)
                    with self.lock:
                        self.accounts[mode] = account
            finally:
                self.refreshing = False
        threading.Thread(target=run, daemon=True).start()

    def select(self, identifier):
        with self.lock:
            if identifier != "codex" and not any(p["id"] == identifier for p in self.value["apis"]):
                raise ValueError("请先保存 API 连接。")
            self.value["selected"] = identifier
            self.save()

    def save_api(self, data):
        base = normalize_url(str(data.get("baseUrl", "")))
        name = str(data.get("name", "自定义 API")).strip()[:80] or "自定义 API"
        model = str(data.get("model", "")).strip()
        max_output = max(1024, min(int(data.get("maxOutputTokens", 8192)), 32000))
        if not model or len(model) > 200 or any(c in model for c in "\r\n\x00"):
            raise ValueError("请填写有效的模型名称。")
        with self.lock:
            old = next((p for p in self.value["apis"] if p["id"] == data.get("id")), None)
            profile = dict(old or {"id": "api-" + secrets.token_hex(8)})
            effort = data.get("reasoningEffort", profile.get("reasoningEffort", "provider-default"))
            if effort not in API_EFFORTS:
                raise ValueError("请选择有效的 API 思考强度。")
            key = str(data.get("apiKey", "")).strip()
            if key:
                reference = self.vault.save(key, base)
                profile["credentialRefs"] = list(dict.fromkeys(profile.get("credentialRefs", []) + [profile.get("credentialRef", ""), reference]))
                profile["credentialRefs"] = [ref for ref in profile["credentialRefs"] if ref]
                profile["credentialRef"] = reference
            elif profile.get("baseUrl") != base:
                profile["credentialRef"] = ""
            if not profile.get("credentialRef") and not is_local_api(base):
                raise ValueError("请填写此服务的 API Key；本机服务允许留空。")
            profile.update(name=name, model=model, baseUrl=base, maxOutputTokens=max_output, reasoningEffort=effort)
            self.value["apis"] = [profile if p["id"] == profile["id"] else p for p in self.value["apis"]]
            if not old:
                self.value["apis"].append(profile)
            self.value["selected"] = profile["id"]
            self.save()

    def remove_api(self, identifier):
        with self.lock:
            profile = next((p for p in self.value["apis"] if p["id"] == identifier), None)
            if not profile:
                raise ValueError("未找到此连接。")
            for reference in set(profile.get("credentialRefs", []) + [profile.get("credentialRef", "")]):
                if reference:
                    self.vault.delete(reference)
            self.value["apis"] = [p for p in self.value["apis"] if p["id"] != identifier]
            if self.value["selected"] == identifier:
                self.value["selected"] = "codex"
            self.save()

    def use_shared(self):
        self.use_codex("shared")

    def use_codex(self, mode):
        account = self.probe_account(mode)
        self.accounts[mode] = account
        if not account["loggedIn"]:
            raise ValueError(account.get("message", "此方式尚未登录，请点击“浏览器登录”。"))
        with self.lock:
            self.value.update(selected="codex", codexMode=mode)
            self.save()

    def login_with_secret(self, mode, secret):
        flag = {"token": "--with-access-token", "key": "--with-api-key"}.get(mode)
        if not flag:
            raise ValueError("请选择凭据类型。")
        if not isinstance(secret, str) or not 0 < len(secret.strip()) <= 12000 or any(char.isspace() for char in secret.strip()):
            raise ValueError("请填写一行有效的登录凭据。")
        executable = resolve_codex(self.codex_path)
        home = self.state_dir / "codex-auth"
        home.mkdir(parents=True, exist_ok=True)
        with self.lock:
            if self.login.get("state") in {"starting", "waiting"}:
                raise ValueError("已有 Codex 登录正在进行。")
            self.login = {"state": "starting", "message": "正在验证 Codex 凭据…"}
            self.login_cancel = threading.Event()
        failure = "Codex 未接受此凭据。请检查凭据类型、有效期和 CLI 版本。"
        try:
            # Credentials are passed through stdin only. Do not record the CLI output.
            with self.lock:
                if self.login_cancel.is_set():
                    raise ProviderError("已取消登录。")
                process = subprocess.Popen([executable, "login", "-c", 'cli_auth_credentials_store="file"', flag],
                    stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    env=codex_environment({"codexHome": str(home)}), creationflags=CREATE_NO_WINDOW)
                self.login_process = process
            try:
                process.communicate(input=(secret.strip() + "\n").encode("utf-8"), timeout=22)
            except subprocess.TimeoutExpired:
                stop_process(process)
                raise ProviderError("验证凭据超时，请检查网络后重试。") from None
            if self.login_cancel.is_set():
                raise ProviderError("已取消登录。")
            if process.returncode:
                raise ProviderError(failure)
            account = self.probe_account("isolated", timeout=6)
            if not account["loggedIn"]:
                raise ProviderError(failure)
            with self.lock:
                if self.login_cancel.is_set():
                    raise ProviderError("已取消登录。")
                self.accounts["isolated"] = account
                self.value.update(selected="codex", codexMode="isolated")
                self.save()
                self.login = {"state": "succeeded", "message": "Codex 已登录，可使用此插件独立连接。"}
        except (OSError, ProviderError) as error:
            message = str(error) if isinstance(error, ProviderError) else failure
            with self.lock:
                self.login = {"state": "cancelled" if self.login_cancel.is_set() else "failed", "message": message}
            raise ProviderError(message) from None
        finally:
            self.login_process = None

    def list_api_models(self, data):
        import httpx

        base = normalize_url(str(data.get("baseUrl", "")))
        key = str(data.get("apiKey", "")).strip()
        if key and (len(key) > 8192 or any(char.isspace() for char in key)):
            raise ValueError("API Key 格式无效。")
        if not key:
            with self.lock:
                profile = next((p for p in self.value["apis"] if p["id"] == data.get("id")), None)
                if profile and profile["baseUrl"] == base and profile.get("credentialRef"):
                    key = self.vault.read(profile["credentialRef"], base)
        local = is_local_api(base)
        if not key and not local:
            raise ValueError("请先填写 API Key，再获取此账号的模型列表。")
        try:
            headers = {"Authorization": "Bearer " + key} if key else {}
            with httpx.Client(timeout=12, follow_redirects=False, trust_env=not local) as client:
                with client.stream("GET", base + "/models", headers=headers) as response:
                    if response.status_code != 200:
                        raise ProviderError(f"模型列表请求失败（HTTP {response.status_code}）。可手动填写模型 ID。")
                    body = bytearray()
                    for chunk in response.iter_bytes():
                        body.extend(chunk)
                        if len(body) > 2_000_000:
                            raise ProviderError("模型列表太大，请手动填写模型 ID。")
            records = json.loads(body).get("data", [])
            models = {row["id"] for row in records if isinstance(row, dict) and isinstance(row.get("id"), str)
                and 0 < len(row["id"]) <= 200 and (not key or key not in row["id"]) and not any(ord(c) < 32 for c in row["id"])}
        except (httpx.HTTPError, ValueError, TypeError, AttributeError):
            raise ProviderError("无法获取模型列表，请检查连接或手动填写模型 ID。") from None
        if not models:
            raise ProviderError("此接口没有返回模型，请手动填写模型 ID。")
        return {"models": sorted(models)[:2000]}

    def cancel_login(self):
        self.login_cancel.set()
        if self.login_process and self.login_process.poll() is None:
            stop_process(self.login_process)

    def start_login(self, device=False):
        with self.lock:
            if self.login.get("state") in {"starting", "waiting"}:
                return
            executable = resolve_codex(self.codex_path)
            self.login_cancel = threading.Event()
            self.login = {"state": "starting", "message": "正在启动 Codex 官方授权…", "device": bool(device)}
            selected_before_login = self.value["selected"]
        def run():
            home = self.state_dir / "codex-auth"
            home.mkdir(parents=True, exist_ok=True)
            try:
                command = [executable, "login", "-c", 'cli_auth_credentials_store="file"'] + (["--device-auth"] if device else [])
                process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    env=codex_environment({"codexHome": str(home)}), creationflags=CREATE_NO_WINDOW)
                self.login_process = process
                self.login.update(state="waiting", message="请在浏览器中完成 Codex 登录，完成后会自动更新状态。")
                def read():
                    for raw in process.stdout:
                        line = re.sub(r"\x1b\[[0-9;]*m", "", raw.decode("utf-8", errors="replace"))
                        for url in re.findall(r"https://[^\s\x1b<>\"']+", line):
                            if (urlsplit(url).hostname or "").lower() in {"auth.openai.com", "auth0.openai.com", "chatgpt.com"}:
                                self.login["url"] = url
                        code = re.search(r"\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b", line)
                        if device and code:
                            self.login["code"] = code.group()
                reader = threading.Thread(target=read, daemon=True)
                reader.start()
                deadline = time.monotonic() + 900
                while process.poll() is None:
                    if self.login_cancel.wait(0.2) or time.monotonic() > deadline:
                        stop_process(process)
                        self.login = {"state": "cancelled", "message": "已取消登录，可重新发起。"}
                        return
                reader.join(timeout=1)
                account = self.probe_account("isolated")
                self.accounts["isolated"] = account
                if process.returncode or not account["loggedIn"]:
                    self.login = {"state": "failed", "message": "Codex 授权未完成。可重试浏览器登录，或改用设备码登录。"}
                    return
                with self.lock:
                    self.value["codexMode"] = "isolated"
                    if self.value["selected"] == selected_before_login:
                        self.value["selected"] = "codex"
                    self.save()
                    self.login = {"state": "succeeded", "message": "Codex 登录成功，已供本插件使用。"}
            except Exception:
                self.login = {"state": "failed", "message": "无法启动 Codex 授权，请检查 CLI 路径或使用本机已登录账号。"}
        threading.Thread(target=run, daemon=True).start()

    def logout(self):
        self.cancel_login()
        executable = resolve_codex(self.codex_path)
        result = subprocess.run([executable, "logout", "-c", 'cli_auth_credentials_store="file"'], capture_output=True, timeout=20,
            env=codex_environment({"codexHome": str(self.state_dir / "codex-auth")}), creationflags=CREATE_NO_WINDOW)
        if result.returncode:
            raise ProviderError("退出插件登录失败，请刷新状态后重试。")
        self.accounts["isolated"] = self.probe_account("isolated")
        self.login = {"state": "idle", "message": "插件独立登录已退出。本机其他 Codex 登录未改变。"}

    def start_test(self):
        with self.lock:
            if self.test["state"] == "running":
                return
            config = config_for_connection(self.value, self.state_dir, self.codex_path)
            label = config.get("providerName", "API") + " / " + (config.get("model") or "CLI 默认模型")
            self.test = {"state": "running", "message": "正在测试 " + label + "…"}
            folder = self.state_dir / "connection-tests" / secrets.token_hex(8)
            folder.mkdir(parents=True)
            self.test_status = Status(folder)
        def run():
            try:
                result = doctor(config, folder, online=True, status=self.test_status)
                self.test = {"state": "succeeded", "message": label + " 连接成功，测试译文：" + result.get("translation", "")}
            except Exception as error:
                self.test = {"state": "failed", "message": label + "：" + str(error)[:600]}
        threading.Thread(target=run, daemon=True).start()

    def action(self, route, data):
        if route == "/api/models": return self.list_api_models(data)
        if route == "/text/start": return self.text.start(data)
        if route == "/text/status": return self.text.state(data.get("id"))
        if route == "/text/cancel": return self.text.cancel(data.get("id"))
        if route == "/refresh": self.refresh()
        elif route == "/select": self.select(data.get("id", "codex"))
        elif route == "/api/save": self.save_api(data)
        elif route == "/api/remove": self.remove_api(data.get("id"))
        elif route == "/codex/shared": self.use_shared()
        elif route == "/codex/isolated": self.use_codex("isolated")
        elif route == "/codex/secret": self.login_with_secret(data.get("mode"), data.get("secret"))
        elif route == "/codex/login": self.start_login(bool(data.get("device")))
        elif route == "/codex/cancel": self.cancel_login()
        elif route == "/codex/logout": self.logout()
        elif route == "/codex/model":
            with self.lock:
                effort = data.get("reasoningEffort", self.value["codexReasoningEffort"])
                if effort not in CODEX_EFFORTS:
                    raise ValueError("请选择有效的 Codex 思考强度。")
                self.value.update(codexModel=str(data.get("model", "")).strip()[:200], codexReasoningEffort=effort)
                self.save()
        elif route == "/test": self.start_test()
        elif route == "/test/cancel":
            if self.test_status: self.test_status.stop_event.set()
        else: raise ValueError("未知连接操作。")
        return self.public_state()

    def close(self):
        self.text.close()
        self.cancel_login()
        if self.test_status:
            self.test_status.stop_event.set()


def make_server(manager, token, stopped):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def reply(self, code, value):
            body = json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try: self.wfile.write(body)
            except (BrokenPipeError, ConnectionError): pass
        def authorized(self):
            return not self.headers.get("Origin") and hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token)
        def do_GET(self):
            if not self.authorized(): return self.reply(403, {"error": "拒绝未授权的本地请求。"})
            self.server.last_seen = time.monotonic()
            if self.path == "/health": return self.reply(200, {"ok": True, "version": VERSION})
            if self.path != "/state": return self.reply(404, {"error": "未知操作。"})
            self.reply(200, manager.public_state())
        def do_POST(self):
            if not self.authorized(): return self.reply(403, {"error": "拒绝未授权的本地请求。"})
            self.server.last_seen = time.monotonic()
            try:
                size = int(self.headers.get("Content-Length", 0))
                if not 0 < size <= 32000: raise ValueError("请求长度无效。")
                data = json.loads(self.rfile.read(size))
                if not isinstance(data, dict): raise ValueError("请求格式无效。")
                if self.path == "/shutdown":
                    stopped.set()
                    return self.reply(200, {"ok": True})
                self.reply(200, manager.action(self.path, data))
            except (ValueError, ProviderError, FileNotFoundError) as error:
                self.reply(400, {"error": str(error)})
            except Exception:
                self.reply(500, {"error": "连接操作失败，请检查设置后重试。"})
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    server.timeout = 1
    server.last_seen = time.monotonic()
    return server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True, type=Path)
    request = parser.parse_args().request
    data = json.loads(request.read_text(encoding="utf-8-sig"))
    manager = Connections(Path(data["stateDir"]), data.get("codexPath", ""))
    stopped = threading.Event()
    server = make_server(manager, data["token"], stopped)
    descriptor = request.parent / "endpoint.json"
    atomic_settings(descriptor, {"port": server.server_port, "pid": os.getpid(), "version": VERSION})
    manager.refresh()
    try:
        while not stopped.is_set() and time.monotonic() - server.last_seen < 300:
            server.handle_request()
    finally:
        manager.close()
        server.server_close()
        descriptor.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
