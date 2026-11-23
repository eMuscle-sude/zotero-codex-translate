import concurrent.futures
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import sys
import time
import unittest
from unittest.mock import patch
import urllib.request
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
spec = importlib.util.spec_from_file_location("worker", Path(__file__).resolve().parents[1] / "backend/worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerTest(unittest.TestCase):
    def test_progress_uses_engine_weighting_is_monotonic_and_reserves_import_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            status = worker.Status(Path(directory))
            worker.apply_engine_progress(status, {"stage": "Translate Paragraphs", "overall_progress": 63.4,
                                                  "stage_current": 20, "stage_total": 40})
            self.assertEqual(status.data["progress"], 63.4)
            self.assertEqual(status.data["stageCurrent"], 20)
            worker.apply_engine_progress(status, {"stage": "Translate Paragraphs", "overall_progress": 55})
            self.assertEqual(status.data["progress"], 63.4)
            worker.apply_engine_progress(status, {"stage": "Save PDF", "overall_progress": 100})
            self.assertEqual(status.data["progress"], 99)
            worker.apply_engine_progress(status, {"overall_progress": float("nan")})
            self.assertEqual(status.data["progress"], 99)

    def test_gui_worker_uses_console_interpreter_only_for_redirected_children(self):
        with patch.object(worker.sys, "executable", "C:/runtime/Scripts/pythonw.exe"):
            self.assertEqual(Path(worker.console_python()).name, "python.exe")

    def test_status_replace_retries_transient_windows_reader_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "status.json"
            original = worker.os.replace
            calls = []
            def replace(source, destination):
                calls.append(1)
                if len(calls) == 1:
                    raise PermissionError("sharing violation")
                return original(source, destination)
            with patch.object(worker.os, "replace", side_effect=replace):
                worker.atomic_json(target, {"state": "running"})
            self.assertEqual(len(calls), 2)
            self.assertEqual(json.loads(target.read_text())["state"], "running")

    def test_validation_and_formula_data_never_become_shell_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'paper & echo bad.pdf'
            source.write_bytes(b"%PDF-1.7")
            self.assertEqual(worker.validate_request({"inputPath": str(source), "pages": "1-3,5"}), source)
            for pages in ("1; bad", "-1", "1, 3"):
                with self.assertRaises(ValueError):
                    worker.validate_request({"inputPath": str(source), "pages": pages})
            command = worker.codex_command("codex.exe", Path(directory), Path("schema"), Path("answer"), "")
            self.assertIn("read-only", command)
            self.assertIn("--ignore-user-config", command)
            self.assertIn('model_reasoning_effort="medium"', command)
            self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", command)
            command = worker.codex_command("codex.exe", Path(directory), Path("schema"), Path("answer"),
                                           "test-model", {"reasoningEffort": "high"})
            self.assertIn('model_reasoning_effort="high"', command)
            self.assertNotIn('model_reasoning_effort="medium"', command)

    def test_proxy_auth_batching_cache_and_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            status = worker.Status(root)
            captured = []

            def fake_run(tasks, *args):
                captured.append(tasks)
                return ["译文 " + t["messages"][0]["content"] for t in tasks]

            with patch.object(worker, "resolve_codex", return_value="codex.exe"), patch.object(worker, "run_codex", side_effect=fake_run):
                bridge = worker.TranslationBridge(root, root / "cache", {"batchWindow": 0.15}, status)
                try:
                    def post(number, token=None):
                        task = {"messages": [{"role": "user", "content": str(number)}]}
                        request = urllib.request.Request(bridge.base_url + "/chat/completions",
                            data=json.dumps(task).encode(), headers={"Content-Type": "application/json",
                            "Authorization": "Bearer " + (token or bridge.token)})
                        return json.load(urllib.request.urlopen(request, timeout=5))
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        post(1, "wrong")
                    self.assertEqual(error.exception.code, 401)
                    with concurrent.futures.ThreadPoolExecutor(4) as executor:
                        results = list(executor.map(post, range(4)))
                    self.assertEqual(len(captured), 1)
                    self.assertEqual(len(captured[0]), 4)
                    self.assertEqual(results[2]["choices"][0]["message"]["content"], "译文 2")
                    post(2)
                    self.assertEqual(len(captured), 1)
                    bridge.fatal = RuntimeError("No quota")
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        post(7)
                    self.assertEqual(error.exception.code, 503)
                    self.assertEqual(len(captured), 1)
                finally:
                    bridge.close()

    def test_cancel_prevents_requests(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            status = worker.Status(root)
            (root / "cancel").touch()
            with patch.object(worker, "resolve_codex", return_value="codex.exe"), patch.object(worker, "run_codex", side_effect=worker.Cancelled("cancelled")):
                bridge = worker.TranslationBridge(root, root / "cache", {"batchWindow": 0.01}, status)
                try:
                    with self.assertRaises(worker.Cancelled):
                        bridge.translate({"messages": [{"role": "user", "content": "text"}]})
                finally:
                    bridge.close()

    def test_two_batches_run_concurrently_and_results_keep_their_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            status = worker.Status(root)
            lock = threading.Lock()
            active = peak = 0
            calls = []
            def run(tasks, batch, *args):
                nonlocal active, peak
                with lock:
                    active += 1
                    peak = max(peak, active)
                    calls.append((batch, len(tasks)))
                # Different durations force out-of-order completion.
                time.sleep(0.07 if tasks[0]["messages"][0]["content"] == "0" else 0.025)
                with lock:
                    active -= 1
                return ["译文" + task["messages"][0]["content"] for task in tasks]
            with patch.object(worker, "resolve_codex", return_value="codex.exe"), patch.object(worker, "run_codex", side_effect=run):
                bridge = worker.TranslationBridge(root, root / "cache", {"batchSize": 2, "batchWindow": 0.02}, status)
                try:
                    def translate(n):
                        return bridge.translate({"messages": [{"role": "user", "content": str(n)}]})
                    with concurrent.futures.ThreadPoolExecutor(10) as pool:
                        results = list(pool.map(translate, range(10)))
                    self.assertEqual(results, ["译文" + str(n) for n in range(10)])
                    self.assertEqual(peak, 2)
                    self.assertTrue(all(count <= 2 for _, count in calls))
                    # Wait for accounting after futures are fulfilled.
                    deadline = time.monotonic() + 1
                    while status.data["completedBatches"] < 5 and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertEqual(status.data["requests"], 10)
                    self.assertEqual(status.data["completedBatches"], 5)
                finally:
                    bridge.close()

    def test_duplicate_inflight_requests_share_one_translation_and_survive_restart_in_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task = {"messages": [{"role": "user", "content": "same formula {{v1}}"}]}
            calls = []
            def run(tasks, *args):
                calls.append(len(tasks))
                time.sleep(0.06)
                return ["同一公式 {{v1}}"]
            with patch.object(worker, "resolve_codex", return_value="codex.exe"), patch.object(worker, "run_codex", side_effect=run):
                bridge = worker.TranslationBridge(root, root / "cache", {"batchWindow": 0.01}, worker.Status(root))
                try:
                    with concurrent.futures.ThreadPoolExecutor(12) as pool:
                        results = list(pool.map(lambda _: bridge.translate(task), range(12)))
                    self.assertEqual(results, ["同一公式 {{v1}}"] * 12)
                    self.assertEqual(calls, [1])
                finally:
                    bridge.close()
                resumed = worker.TranslationBridge(root, root / "cache", {}, worker.Status(root))
                try:
                    self.assertEqual(resumed.translate(task), "同一公式 {{v1}}")
                    self.assertEqual(calls, [1])
                finally:
                    resumed.close()

    def test_transient_batch_failure_retries_with_separate_attempt_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            calls = []
            def run(tasks, path, *args):
                calls.append(path.name)
                if len(calls) == 1:
                    raise RuntimeError("workspace routing discovery failed")
                return ["成功"]
            with patch.object(worker, "resolve_codex", return_value="codex.exe"), patch.object(worker, "run_codex", side_effect=run):
                bridge = worker.TranslationBridge(root, root / "cache", {"batchWindow": 0.01, "retryBaseDelay": 0.01}, worker.Status(root))
                try:
                    self.assertEqual(bridge.translate({"messages": [{"role": "user", "content": "text"}]}), "成功")
                    self.assertEqual(calls, ["attempt-01", "attempt-02"])
                    self.assertIsNone(bridge.fatal)
                    self.assertEqual(bridge.status.data["retryAt"], 0)
                finally:
                    bridge.close()

    def test_permanent_errors_are_not_retried_and_retries_are_bounded(self):
        for message, expected in (("insufficient_quota HTTP 429", 1), ("workspace routing discovery failed", 3)):
            with self.subTest(message=message), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                with patch.object(worker, "resolve_codex", return_value="codex.exe"), patch.object(worker, "run_codex", side_effect=RuntimeError(message)) as run:
                    bridge = worker.TranslationBridge(root, root / "cache", {"batchWindow": 0.01, "retryBaseDelay": 0.001}, worker.Status(root))
                    try:
                        with self.assertRaises(RuntimeError):
                            bridge.translate({"messages": [{"role": "user", "content": "text"}]})
                        self.assertEqual(run.call_count, expected)
                    finally:
                        bridge.close()

    def test_cancelling_a_retry_wait_stops_further_model_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            status = worker.Status(root)
            with patch.object(worker, "resolve_codex", return_value="codex.exe"), patch.object(worker, "run_codex", side_effect=RuntimeError("connection timed out")) as run:
                bridge = worker.TranslationBridge(root, root / "cache", {"batchWindow": 0.01, "retryBaseDelay": 5}, status)
                try:
                    with concurrent.futures.ThreadPoolExecutor(1) as pool:
                        future = pool.submit(bridge.translate, {"messages": [{"role": "user", "content": "text"}]})
                        deadline = time.monotonic() + 2
                        while not status.data["retryAt"] and time.monotonic() < deadline:
                            time.sleep(0.01)
                        self.assertGreater(status.data["retryAt"], time.time())
                        (root / "cancel").touch()
                        with self.assertRaises(worker.Cancelled):
                            future.result(timeout=2)
                    self.assertEqual(run.call_count, 1)
                finally:
                    bridge.close()

    def test_worker_lease_prevents_two_process_owners(self):
        with tempfile.TemporaryDirectory() as directory:
            with worker.worker_lease(Path(directory)) as first:
                self.assertTrue(first)
                with worker.worker_lease(Path(directory)) as second:
                    self.assertFalse(second)
            with worker.worker_lease(Path(directory)) as after_release:
                self.assertTrue(after_release)


class CodexDiscoveryTest(unittest.TestCase):
    def test_removed_versioned_path_falls_back_to_current_cli(self):
        with patch.object(worker.shutil, "which", return_value="current-codex.exe"):
            self.assertEqual(worker.resolve_codex("C:/removed-version/codex.exe"), "current-codex.exe")

    def test_existing_custom_binary_is_preserved_and_desktop_upgrade_is_discovered(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            custom = root / "custom-codex.exe"; custom.touch()
            current = root / "OpenAI/Codex/bin/new-version/codex.exe"
            current.parent.mkdir(parents=True); current.touch()
            with patch.object(worker.shutil, "which", return_value=None), patch.dict(worker.os.environ, {"LOCALAPPDATA": directory}):
                self.assertEqual(worker.resolve_codex(str(custom)), str(custom.resolve()))
                self.assertEqual(worker.resolve_codex(str(root / "removed-codex.exe")), str(current))


if __name__ == "__main__":
    unittest.main()
