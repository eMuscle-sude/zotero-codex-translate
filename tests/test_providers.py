import concurrent.futures
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
import urllib.request
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
import providers
import connections
import worker


@contextlib.contextmanager
def api_fixture():
    state = {"requests": [], "mode": "ok"}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            state["requests"].append({"path": self.path, "authorization": self.headers.get("Authorization")})
            if state["mode"] == "redirect":
                self.send_response(302); self.send_header("Location", state["base"] + "/other"); self.end_headers(); return
            raw = json.dumps({"data": [{"id": "z-model"}, {"id": "a-model"}, {"id": "z-model"},
                                       {"id": self.headers.get("Authorization")}, None]}).encode()
            self.send_response(200); self.send_header("Content-Length", str(len(raw))); self.end_headers()
            self.wfile.write(raw)
        def do_POST(self):
            data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            state["requests"].append({"path": self.path, "authorization": self.headers.get("Authorization"), "payload": data})
            mode = state["mode"]
            if mode == "slow": time.sleep(2)
            if mode == "redirect":
                self.send_response(302);self.send_header("Location", state["base"] + "/stolen");self.end_headers();return
            if mode == "error":
                status, body = 401, {"error": {"message": "Invalid token " + self.headers.get("Authorization", "")}}
            else:
                prompt = data["messages"][0]["content"]
                tasks = json.loads(prompt.split("UNTRUSTED_REQUESTS_JSON:\n", 1)[1])
                result = {k: "译文 " + v[-1]["content"] for k,v in tasks.items()}
                if mode == "echo-key": result = {k: self.headers["Authorization"] for k in result}
                text = "not json" if mode == "malformed" else json.dumps(result, ensure_ascii=False)
                status, body = 200, {"choices": [{"message": {"content": text}, "finish_reason": "length" if mode == "truncated" else "stop"}]}
            raw = json.dumps(body,ensure_ascii=False).encode()
            self.send_response(status);self.send_header("Content-Type","application/json");self.send_header("Content-Length",str(len(raw)));self.end_headers()
            try:self.wfile.write(raw)
            except (BrokenPipeError,ConnectionError):pass
    server = ThreadingHTTPServer(("127.0.0.1",0),Handler);server.daemon_threads=True
    state["base"] = f"http://127.0.0.1:{server.server_port}/v1"
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:yield state
    finally:server.shutdown();server.server_close();thread.join()


class ProviderTest(unittest.TestCase):
    def test_api_model_discovery_lists_ids_without_saving_or_forwarding_the_key(self):
        with tempfile.TemporaryDirectory() as directory, api_fixture() as server:
            manager = connections.Connections(Path(directory))
            values = {"baseUrl": server["base"], "apiKey": "mock-model-key"}
            self.assertEqual(manager.action("/api/models", values), {"models": ["a-model", "z-model"]})
            self.assertEqual(server["requests"], [{"path": "/v1/models", "authorization": "Bearer mock-model-key"}])
            self.assertEqual(list(Path(directory).iterdir()), [])
            server["mode"] = "redirect"
            with self.assertRaisesRegex(providers.ProviderError, "HTTP 302"):
                manager.action("/api/models", values)
            self.assertEqual(len(server["requests"]), 2)

    def test_codex_access_token_is_sent_to_isolated_cli_stdin_only(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = connections.Connections(Path(directory), "codex.exe")
            account = {"available": True, "loggedIn": True, "kind": "chatgpt"}
            with patch.object(connections, "resolve_codex", return_value="codex.exe"), \
                 patch.object(connections.subprocess, "Popen") as launch, \
                 patch.object(manager, "probe_account", return_value=account) as probe:
                process = launch.return_value
                process.returncode = 0
                result = manager.action("/codex/secret", {"mode": "token", "secret": "mock-access-token"})
                self.assertIn("--with-access-token", launch.call_args.args[0])
                self.assertNotIn("mock-access-token", launch.call_args.args[0])
                self.assertEqual(launch.call_args.kwargs["env"]["CODEX_HOME"], str(Path(directory) / "codex-auth"))
                self.assertEqual(process.communicate.call_args.kwargs["input"], b"mock-access-token\n")
                probe.assert_called_once_with("isolated", timeout=6)
                self.assertEqual(result["connections"]["codexMode"], "isolated")
                self.assertNotIn("mock-access-token", json.dumps(result))
                self.assertNotIn("mock-access-token", (Path(directory) / "connections.json").read_text(encoding="utf-8"))

    def test_url_validation_and_no_credential_in_url(self):
        self.assertEqual(providers.normalize_url(" https://example.org/v1/chat/completions/ "), "https://example.org/v1")
        for url in ("http://example.org/v1", "https://user:secret@example.org/v1", "https://example.org/v1?key=secret", "file:///x", "https://example.org:bad"):
            with self.subTest(url=url), self.assertRaises(ValueError):providers.normalize_url(url)
        self.assertEqual(providers.normalize_url("http://localhost:11434/v1"), "http://localhost:11434/v1")

    @unittest.skipUnless(os.name=="nt","Windows user encryption")
    def test_credentials_are_encrypted_and_bound_to_the_service_address(self):
        with tempfile.TemporaryDirectory() as directory:
            vault=providers.CredentialVault(Path(directory));key="unit-test-credential-not-a-real-token"
            reference=vault.save(key,"https://example.org/v1")
            self.assertEqual(vault.read(reference,"https://example.org/v1"),key)
            self.assertNotIn(key.encode(),(vault.directory/(reference+".bin")).read_bytes())
            with self.assertRaises(providers.ProviderError):vault.read(reference,"https://different.example/v1")
            with self.assertRaises(providers.ProviderError):vault.read("../outside","https://example.org/v1")
            vault.delete(reference)
            with self.assertRaises(providers.ProviderError):vault.read(reference,"https://example.org/v1")

    @unittest.skipUnless(os.name=="nt","Windows user encryption")
    def test_api_profiles_preserve_keys_without_exposing_them_and_delete_all_rotations(self):
        with tempfile.TemporaryDirectory() as directory:
            manager=connections.Connections(Path(directory))
            manager.save_api({"name":"Test","baseUrl":"https://example.org/v1","model":"unit-model","apiKey":"unit-secret-first"})
            identifier=manager.value["selected"];first=manager.value["apis"][0]["credentialRef"]
            manager.save_api({"id":identifier,"name":"Test","baseUrl":"https://example.org/v1","model":"updated-model","apiKey":""})
            self.assertEqual(manager.value["apis"][0]["credentialRef"],first)
            with self.assertRaises(ValueError):manager.save_api({"id":identifier,"baseUrl":"https://other.example/v1","model":"model","apiKey":""})
            manager.save_api({"id":identifier,"baseUrl":"https://example.org/v1","model":"model","apiKey":"unit-secret-second"})
            state=json.dumps(manager.public_state());disk=(Path(directory)/"connections.json").read_text(encoding="utf-8")
            for key in ("unit-secret-first","unit-secret-second"):
                self.assertNotIn(key,state);self.assertNotIn(key,disk)
            restored=connections.Connections(Path(directory))
            self.assertEqual(restored.value["selected"],identifier)
            refs=manager.value["apis"][0]["credentialRefs"]
            self.assertEqual(len(refs),2)
            manager.remove_api(identifier)
            self.assertEqual(manager.value["selected"],"codex")
            self.assertFalse(any((Path(directory)/"credentials"/(ref+".bin")).exists() for ref in refs))

    def test_local_api_can_be_configured_without_codex_or_a_key(self):
        with tempfile.TemporaryDirectory() as directory:
            manager=connections.Connections(Path(directory))
            manager.save_api({"name":"Local","baseUrl":"http://127.0.0.1:12345/v1","model":"local-model"})
            config=providers.config_for_connection(manager.value,Path(directory))
            self.assertEqual(config["provider"],"api")
            self.assertEqual(providers.api_key_for(config),"")

    def test_selected_effort_persists_and_api_defaults_preserve_legacy_requests(self):
        with tempfile.TemporaryDirectory() as directory, api_fixture() as remote:
            root = Path(directory)
            manager = connections.Connections(root)
            self.assertEqual(providers.config_for_connection(manager.value, root)["reasoningEffort"], "medium")
            manager.action("/codex/model", {"model": "codex-test", "reasoningEffort": "high"})
            self.assertEqual(providers.config_for_connection(connections.Connections(root).value, root)["reasoningEffort"], "high")
            with self.assertRaises(ValueError):
                manager.action("/codex/model", {"reasoningEffort": "invalid"})
            manager.save_api({"baseUrl": remote["base"], "model": "api-test", "reasoningEffort": "low"})
            config = providers.config_for_connection(connections.Connections(root).value, root)
            prompt = worker.translation_prompt([{"messages": [{"role": "user", "content": "test"}]}])
            providers.api_completion(config, prompt, 1, 3, lambda: False)
            self.assertEqual(remote["requests"][-1]["payload"]["reasoning_effort"], "low")
            config.pop("apiReasoningEffort")
            config["reasoningEffort"] = "medium"  # Legacy API job inherited this Codex-only field.
            providers.api_completion(config, prompt, 1, 3, lambda: False)
            self.assertNotIn("reasoning_effort", remote["requests"][-1]["payload"])

    @unittest.skipUnless(os.name=="nt","Windows user encryption")
    def test_api_transport_preserves_mapping_and_never_serializes_keys(self):
        with tempfile.TemporaryDirectory() as directory,api_fixture() as remote:
            root=Path(directory);key="unit-only-credential-for-test"
            reference=providers.CredentialVault(root).save(key,remote["base"])
            config={"provider":"api","stateDir":directory,"credentialRef":reference,"baseUrl":remote["base"],"model":"unit-model"}
            status=worker.Status(root)
            tasks=[{"messages":[{"role":"user","content":"formula {{v1}} and 3.2 nm"}]},{"messages":[{"role":"user","content":"<b>title</b>"}]}]
            result=worker.run_api(tasks,root/"batch",config,status,3)
            self.assertEqual(result,["译文 formula {{v1}} and 3.2 nm","译文 <b>title</b>"])
            captured=remote["requests"][0]
            self.assertEqual(captured["authorization"],"Bearer "+key)
            self.assertNotIn(key,json.dumps(captured["payload"]))
            self.assertNotIn(key,(root/"batch/answer.json").read_text(encoding="utf-8"))
            for mode in ("error","echo-key"):
                remote["mode"]=mode
                with self.assertRaises(providers.ProviderError) as error:worker.run_api(tasks,root/"bad",config,status,3)
                self.assertNotIn(key,str(error.exception))
                self.assertFalse((root/"bad/answer.json").exists())

    def test_redirects_truncated_and_malformed_results_are_not_accepted(self):
        with api_fixture() as remote:
            config={"baseUrl":remote["base"],"model":"unit-model"}
            prompt=worker.translation_prompt([{"messages":[{"role":"user","content":"data"}]}])
            for mode in ("redirect","truncated","malformed"):
                remote["mode"]=mode
                before=len(remote["requests"])
                with self.assertRaises(providers.ProviderError):providers.api_completion(config,prompt,1,3,lambda:False)
                self.assertEqual(len(remote["requests"]),before+1)

    def test_cancelling_api_test_closes_the_request_promptly(self):
        with api_fixture() as remote:
            remote["mode"]="slow";stop=threading.Event()
            prompt=worker.translation_prompt([{"messages":[{"role":"user","content":"data"}]}])
            with concurrent.futures.ThreadPoolExecutor(1) as pool:
                future=pool.submit(providers.api_completion,{"baseUrl":remote["base"],"model":"unit-model"},prompt,1,5,stop.is_set)
                deadline=time.monotonic()+2
                while not remote["requests"] and time.monotonic()<deadline:time.sleep(0.01)
                start=time.monotonic();stop.set()
                with self.assertRaises(InterruptedError):future.result(timeout=1)
                self.assertLess(time.monotonic()-start,1)

    def test_isolated_codex_login_does_not_inherit_key_overrides_or_logout_shared_account(self):
        with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{"CODEX_API_KEY":"unit-env-value"}):
            manager=connections.Connections(Path(directory),"codex.exe")
            with patch.object(connections,"resolve_codex",return_value="codex.exe"),patch.object(connections.subprocess,"run",return_value=subprocess.CompletedProcess([],0)) as run,patch.object(manager,"probe_account",return_value={"loggedIn":False}):
                manager.logout()
                command=run.call_args.args[0];env=run.call_args.kwargs["env"]
                self.assertIn('cli_auth_credentials_store="file"',command)
                self.assertEqual(env["CODEX_HOME"],str(Path(directory)/"codex-auth"))
                self.assertNotIn("CODEX_API_KEY",env)
                self.assertEqual(os.environ["CODEX_API_KEY"],"unit-env-value")

    def test_browser_login_uses_official_cli_and_stores_only_connection_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            manager=connections.Connections(Path(directory),"codex.exe")
            class Process:
                stdout=io.BytesIO(b"Continue at https://auth.openai.com/oauth/authorize?test=true\n")
                returncode=0
                def poll(self):return 0
            with patch.object(connections,"resolve_codex",return_value="codex.exe"),patch.object(connections.subprocess,"Popen",return_value=Process()) as launch,patch.object(manager,"probe_account",return_value={"available":True,"loggedIn":True,"checking":False,"kind":"chatgpt"}):
                manager.start_login()
                deadline=time.monotonic()+2
                while manager.login["state"] in {"starting","waiting"} and time.monotonic()<deadline:time.sleep(0.01)
                self.assertEqual(manager.login["state"],"succeeded")
                self.assertEqual(manager.value["codexMode"],"isolated")
                self.assertEqual(launch.call_args.args[0][:2],["codex.exe","login"])
                self.assertNotIn("--with-api-key",launch.call_args.args[0])
                disk=(Path(directory)/"connections.json").read_text()
                self.assertNotIn("access_token",disk);self.assertNotIn("refresh_token",disk)

    def test_controller_rejects_wrong_tokens_and_browser_origins(self):
        with tempfile.TemporaryDirectory() as directory:
            manager=connections.Connections(Path(directory));stop=threading.Event();server=connections.make_server(manager,"unit-controller-token",stop)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            url=f"http://127.0.0.1:{server.server_port}/state"
            try:
                for headers in ({},{"Authorization":"Bearer wrong"},{"Authorization":"Bearer unit-controller-token","Origin":"https://untrusted.example"}):
                    with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(urllib.request.Request(url,headers=headers))
                    self.assertEqual(error.exception.code,403)
                response=json.load(urllib.request.urlopen(urllib.request.Request(url,headers={"Authorization":"Bearer unit-controller-token"})))
                self.assertEqual(response["connections"]["selected"],"codex")
            finally:server.shutdown();server.server_close();thread.join()

    def test_api_cache_is_partitioned_by_endpoint_and_does_not_require_codex(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);task={"messages":[{"role":"user","content":"same input"}]}
            with patch.object(worker,"resolve_codex") as resolve,patch.object(worker,"run_api",return_value=["译文"]) as call:
                for endpoint in ("https://one.example/v1","https://one.example/v1","https://two.example/v1"):
                    bridge=worker.TranslationBridge(root,root/"cache",{"provider":"api","baseUrl":endpoint,"model":"same-model","batchWindow":0.01},worker.Status(root))
                    try:self.assertEqual(bridge.translate(task),"译文")
                    finally:bridge.close()
                self.assertEqual(call.call_count,2);resolve.assert_not_called()


if __name__=="__main__":unittest.main()
