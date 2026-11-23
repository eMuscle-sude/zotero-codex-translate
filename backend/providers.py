"""Provider settings and Windows user-bound secrets. Never serialize API keys into jobs."""
from __future__ import annotations

import asyncio
import ctypes
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import time
from urllib.parse import urlsplit, urlunsplit


class ProviderError(RuntimeError):
    pass


def normalize_url(value: str) -> str:
    try:
        parts = urlsplit(value.strip())
        host, port = parts.hostname, parts.port
    except ValueError:
        raise ValueError("API 地址格式无效。") from None
    if parts.scheme not in {"https", "http"} or not host or parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("请输入不含密钥、用户名、查询参数的 http(s) API 服务地址。")
    local = host.lower() == "localhost"
    try:
        local = local or ipaddress.ip_address(host).is_loopback
    except ValueError:
        pass
    if parts.scheme == "http" and not local:
        raise ValueError("远程 API 请使用 HTTPS；HTTP 仅支持本机服务。")
    path = parts.path.rstrip("/")
    if path.endswith("/chat/completions"):
        path = path[:-len("/chat/completions")]
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


def is_local_api(url: str) -> bool:
    host = urlsplit(url).hostname or ""
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def atomic_settings(path: Path, value: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + secrets.token_hex(6) + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        for attempt in range(10):
            try:
                os.replace(temporary, path)
                break
            except PermissionError:
                if attempt == 9:
                    raise
                time.sleep(0.05)
    finally:
        temporary.unlink(missing_ok=True)


class CredentialVault:
    """DPAPI protects secrets for the current Windows user; no plaintext fallback."""
    class Blob(ctypes.Structure):
        _fields_ = [("size", ctypes.c_uint32), ("data", ctypes.POINTER(ctypes.c_ubyte))]

    def __init__(self, state_dir: Path):
        self.directory = Path(state_dir) / "credentials"

    @classmethod
    def _crypt(cls, value: bytes, decrypt=False) -> bytes:
        if os.name != "nt":
            raise ProviderError("本版 API 密钥加密保存支持 Windows；不会回退到明文保存。")
        source = ctypes.create_string_buffer(value)
        incoming = cls.Blob(len(value), ctypes.cast(source, ctypes.POINTER(ctypes.c_ubyte)))
        outgoing = cls.Blob()
        library = ctypes.WinDLL("crypt32", use_last_error=True)
        method = library.CryptUnprotectData if decrypt else library.CryptProtectData
        method.argtypes = [ctypes.POINTER(cls.Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                           ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(cls.Blob)]
        method.restype = ctypes.c_int
        if not method(ctypes.byref(incoming), None, None, None, None, 1, ctypes.byref(outgoing)):
            raise ProviderError("无法访问当前 Windows 用户的加密凭据，请重新保存 API Key。")
        try:
            return ctypes.string_at(outgoing.data, outgoing.size)
        finally:
            free = ctypes.WinDLL("kernel32", use_last_error=True).LocalFree
            free.argtypes = [ctypes.c_void_p]
            free.restype = ctypes.c_void_p
            free(outgoing.data)

    def _path(self, reference: str) -> Path:
        if not re.fullmatch(r"[a-f0-9]{32}", reference or ""):
            raise ProviderError("API 凭据引用无效，请在模型连接中重新保存密钥。")
        return self.directory / (reference + ".bin")

    def save(self, key: str, base_url: str) -> str:
        if not key or len(key) > 8192 or any(c in key for c in "\r\n\x00"):
            raise ValueError("API Key 格式无效。")
        encrypted = self._crypt(json.dumps({"key": key, "baseUrl": normalize_url(base_url)}).encode("utf-8"))
        reference = secrets.token_hex(16)
        self.directory.mkdir(parents=True, exist_ok=True)
        self._path(reference).write_bytes(b"ZCT1" + encrypted)
        return reference

    def read(self, reference: str, base_url: str) -> str:
        try:
            content = self._path(reference).read_bytes()
        except FileNotFoundError:
            raise ProviderError("未保存 API Key，请在模型连接中填写。") from None
        if content[:4] != b"ZCT1":
            raise ProviderError("凭据文件格式无效，请重新保存 API Key。")
        value = json.loads(self._crypt(content[4:], decrypt=True))
        if value.get("baseUrl") != normalize_url(base_url):
            raise ProviderError("API 地址已改变，请为新地址重新填写密钥。")
        return value["key"]

    def delete(self, reference: str):
        self._path(reference).unlink(missing_ok=True)


CODEX_EFFORTS = ("low", "medium", "high", "xhigh")
API_EFFORTS = ("provider-default", "none", "minimal", "low", "medium", "high", "xhigh", "max")


def reasoning_effort(config: dict) -> str:
    if config.get("provider", "codex") == "api":
        value = config.get("apiReasoningEffort")
        return value if value in API_EFFORTS else "provider-default"
    value = config.get("reasoningEffort")
    return value if value in CODEX_EFFORTS else "medium"


def load_connections(state_dir: Path) -> dict:
    try:
        value = json.loads((Path(state_dir) / "connections.json").read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        value = {}
    return {"version": 1, "selected": "codex", "codexMode": "shared", "codexModel": "",
            "codexReasoningEffort": "medium", "apis": [], **value}


def config_for_connection(value: dict, state_dir: Path, codex_path="") -> dict:
    if value.get("selected", "codex") == "codex":
        result = {"provider": "codex", "providerName": "Codex", "model": value.get("codexModel", ""),
                  "codexPath": codex_path, "reasoningEffort": reasoning_effort({"reasoningEffort": value.get("codexReasoningEffort")})}
        if value.get("codexMode") == "isolated":
            result["codexHome"] = str(Path(state_dir) / "codex-auth")
        return result
    profile = next((p for p in value["apis"] if p["id"] == value["selected"]), None)
    if not profile:
        raise ProviderError("请先保存 API 连接，或选择 Codex。")
    return {"provider": "api", "providerName": profile["name"], "model": profile["model"],
            "baseUrl": profile["baseUrl"], "credentialRef": profile.get("credentialRef", ""),
            "maxOutputTokens": profile.get("maxOutputTokens", 8192), "stateDir": str(state_dir),
            "apiReasoningEffort": profile.get("reasoningEffort", "provider-default")}


def codex_environment(config: dict) -> dict:
    env = os.environ.copy()
    for key in list(env):
        if key.startswith("CODEX_THREAD") or key in {"CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "CODEX_CI"}:
            env.pop(key, None)
    if config.get("codexHome"):
        env["CODEX_HOME"] = str(config["codexHome"])
        for name in ("CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"):
            env.pop(name, None)
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def api_key_for(config: dict) -> str:
    base = normalize_url(config.get("baseUrl", ""))
    if not config.get("credentialRef") and is_local_api(base):
        return ""
    if not config.get("stateDir"):
        raise ProviderError("缺少 API 凭据目录，请重新保存连接。")
    return CredentialVault(Path(config["stateDir"])).read(config.get("credentialRef", ""), base)


async def _api_post(url, key, payload, timeout, cancelled):
    import httpx
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=not is_local_api(url)) as client:
        pending = asyncio.create_task(client.post(url, headers=headers, json=payload))
        try:
            while not pending.done():
                if cancelled():
                    raise asyncio.CancelledError()
                await asyncio.wait({pending}, timeout=0.15)
            return await pending
        finally:
            if not pending.done():
                pending.cancel()
                try:
                    await pending
                except BaseException:
                    pass


def api_completion(config: dict, prompt: str, count: int, timeout: int, cancelled) -> list[str]:
    base = normalize_url(config.get("baseUrl", ""))
    model = str(config.get("model", "")).strip()
    if not model or len(model) > 200:
        raise ProviderError("请填写 API 模型名称。")
    key = api_key_for(config)
    token_parameter = "max_completion_tokens" if re.match(r"^(?:gpt-[5-9]|o[1-9])", model, re.I) else "max_tokens"
    payload = {"model": model, "messages": [{"role": "user", "content": prompt}], "stream": False,
               token_parameter: max(1024, min(int(config.get("maxOutputTokens", 8192)), 32000))}
    effort = reasoning_effort({**config, "provider": "api"})
    if effort != "provider-default":
        payload["reasoning_effort"] = effort
    try:
        response = asyncio.run(_api_post(base + "/chat/completions", key, payload, timeout, cancelled))
    except asyncio.CancelledError:
        raise InterruptedError("用户已取消") from None
    except Exception as error:
        # HTTP libraries can include URLs or credentials in exception descriptions.
        raise ProviderError("API 连接失败或超时，请检查服务地址与网络。") from None
    if not 200 <= response.status_code < 300:
        detail = ""
        try:
            error = response.json().get("error", {})
            detail = str(error.get("message", "")) if isinstance(error, dict) else ""
        except (ValueError, AttributeError):
            pass
        if key:
            detail = detail.replace(key, "[已隐藏密钥]")
        if 300 <= response.status_code < 400:
            raise ProviderError("API 返回了重定向；为避免转发密钥，请直接填写最终服务地址。")
        if effort != "provider-default" and response.status_code in {400, 422} and "reasoning_effort" in detail.lower():
            raise ProviderError(f"模型拒绝了思考强度 {effort}。请选择模型支持的档位或「服务商默认」。{detail[:280]}")
        raise ProviderError(f"API HTTP {response.status_code}：{detail[:400] or '请求失败，请检查地址、模型、密钥与额度。'}")
    try:
        data = response.json()
        choice = data["choices"][0]
        if choice.get("finish_reason") == "length":
            raise ProviderError("API 输出被长度限制截断，请增加最大输出长度或减少批次文本量。")
        text = choice["message"]["content"]
        if isinstance(text, list):
            text = "".join(part.get("text", "") for part in text if isinstance(part, dict))
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.I)
        result = json.loads(text)
        if key and key in text:
            raise ProviderError("API 返回内容包含认证密钥，已拒绝保存，请检查服务商。")
        expected = {f"r{i}" for i in range(count)}
        if not isinstance(result, dict) or set(result) != expected or any(not isinstance(v, str) or not v.strip() for v in result.values()):
            raise ValueError()
        return [result[f"r{i}"] for i in range(count)]
    except ProviderError:
        raise
    except (KeyError, IndexError, TypeError, AttributeError, ValueError):
        raise ProviderError("API 返回的译文格式或段落数量不匹配，未写入缓存；请检查模型是否支持 JSON 指令。") from None
