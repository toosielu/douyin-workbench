"""Offline contract tests for the subprocess bridge; no platform calls."""

import asyncio
import contextlib
import importlib.util
import io
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SPEC = importlib.util.find_spec("sau_demo.worker")
if SPEC is not None:
    from sau_demo import worker
else:
    worker = None


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.assertIsNotNone(worker, "the worker bridge must exist")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / "checkout"
        self.repo.mkdir()
        (self.repo / "cookies").mkdir()
        self.cookie = self.repo / "cookies" / "douyin_account_A.json"
        self.cookie.write_text('{"cookies": [], "origins": []}', encoding="utf-8")
        self.video = self.repo / "clip.mp4"
        self.video.write_bytes(b"offline test video")
        self.request = {
            "action": "upload", "account": "account_A", "file": str(self.video),
            "title": "Test title", "description": "Test description",
            "tags": ["topic"], "declaration": None, "headless": True,
            "timeoutSeconds": 2,
        }
        self.events = []
        events = self.events

        async def cookie_auth(account_file):
            events.append(("check", account_file))
            return True

        async def douyin_setup(account_file, **kwargs):
            events.append(("login", account_file, kwargs))
            return {"success": True, "message": "sessionid=secret-cookie"}

        class FakeUploader:
            def __init__(self, **kwargs):
                events.append(("construct", kwargs))
                self.declaration = kwargs["declaration"]
                self.file_path = kwargs["file_path"]

            async def set_self_declaration(self, page, declaration):
                events.append(("declaration", declaration))
                return True

            async def apply_self_declaration(self, page):
                if self.declaration:
                    await self.set_self_declaration(page, self.declaration)

            async def douyin_upload_video(self):
                events.append(("upload",))
                # Reproduce upstream's mutation immediately before the hook.
                if not self.declaration:
                    self.declaration = "内容由AI生成"
                await self.apply_self_declaration(object())

        self.module = SimpleNamespace(
            DouYinVideo=FakeUploader, cookie_auth=cookie_auth,
            douyin_setup=douyin_setup, douyin_logger=SimpleNamespace(),
        )

    async def run_request(self, **kwargs):
        return await worker.run_request(self.request, self.repo, confirmed=True,
                                        module=self.module, **kwargs)

    async def test_upload_requires_confirmation_before_dependency_load(self):
        with patch.object(worker, "_load_upstream", side_effect=AssertionError("loaded")):
            result = await worker.run_request(self.request, self.repo)
        self.assertEqual(result["status"], "FAILED_BEFORE_SUBMIT")
        self.assertIn("confirmation", result["message"].lower())
        self.assertEqual(self.events, [])

    async def test_upload_confirmation_precedes_all_path_metadata_access(self):
        self.request["file"] = r"\\internal\share\clip.mp4"
        with patch.object(Path, "is_file") as metadata, patch.object(Path, "resolve") as resolve:
            result = await worker.run_request(self.request, r"\\internal\repo")
        metadata.assert_not_called()
        resolve.assert_not_called()
        self.assertEqual(result["status"], "FAILED_BEFORE_SUBMIT")
        self.assertIn("confirmation", result["message"].lower())

    async def test_unc_video_rejected_before_filesystem_or_dependencies(self):
        self.request["file"] = r"\\internal\share\clip.mp4"
        with patch.object(Path, "is_file") as metadata, patch.object(Path, "is_symlink") as symlink:
            with patch.object(worker, "_load_upstream") as loader:
                result = await worker.run_request(self.request, self.repo, confirmed=True)
        metadata.assert_not_called()
        symlink.assert_not_called()
        loader.assert_not_called()
        self.assertEqual(result["status"], "FAILED_BEFORE_SUBMIT")

    async def test_unc_repo_rejected_before_filesystem_or_dependencies(self):
        request = {"action": "check", "account": "account_A"}
        with patch.object(Path, "resolve") as resolve, patch.object(Path, "is_dir") as metadata:
            with patch.object(worker, "_load_upstream") as loader:
                result = await worker.run_request(request, r"\\internal\repo")
        resolve.assert_not_called()
        metadata.assert_not_called()
        loader.assert_not_called()
        self.assertEqual(result["status"], "FAILED_BEFORE_SUBMIT")

    async def test_reserved_account_alias_rejected_before_dependencies(self):
        self.request["account"] = "CON"
        result = await self.run_request()
        self.assertEqual(result["status"], "FAILED_BEFORE_SUBMIT")
        self.assertIn("alias", result["message"].lower())
        self.assertEqual(self.events, [])

    async def test_sha256_rechecked_after_cookie_validation_before_upload(self):
        self.request["sha256"] = hashlib.sha256(self.video.read_bytes()).hexdigest()
        async def mutate_video(account_file):
            self.video.write_bytes(b"changed after check")
            return True
        self.module.cookie_auth = mutate_video
        result = await self.run_request()
        self.assertEqual(result["status"], "FAILED_BEFORE_SUBMIT")
        self.assertIn("changed", result["message"].lower())
        self.assertEqual(self.events, [])

    async def test_matching_sha256_allows_submission(self):
        self.request["sha256"] = hashlib.sha256(self.video.read_bytes()).hexdigest()
        result = await self.run_request()
        self.assertEqual(result["status"], "SUBMITTED_UNVERIFIED")

    async def test_upload_uses_verified_snapshot_and_removes_it_on_completion(self):
        original = self.video.read_bytes()
        self.request["sha256"] = hashlib.sha256(original).hexdigest()
        snapshots = []
        async def inspect_snapshot(uploader):
            self.video.write_bytes(b"edited during browser startup")
            snapshot = Path(uploader.file_path)
            snapshots.append(snapshot)
            self.assertNotEqual(snapshot, self.video)
            self.assertEqual(snapshot.suffix, self.video.suffix)
            self.assertEqual(snapshot.read_bytes(), original)
        self.module.DouYinVideo.douyin_upload_video = inspect_snapshot
        result = await self.run_request()
        self.assertEqual(result["status"], "SUBMITTED_UNVERIFIED")
        self.assertEqual(len(snapshots), 1)
        self.assertFalse(snapshots[0].exists())

    async def test_missing_cookie_blocks_before_dependency_load(self):
        self.cookie.unlink()
        with patch.object(worker, "_load_upstream", side_effect=AssertionError("loaded")):
            result = await worker.run_request(self.request, self.repo, confirmed=True)
        self.assertEqual(result["status"], "FAILED_BEFORE_SUBMIT")
        self.assertIn("cookie", result["message"].lower())

    async def test_invalid_cookie_does_not_construct_or_upload(self):
        async def invalid_cookie(account_file):
            return False
        self.module.cookie_auth = invalid_cookie
        result = await self.run_request()
        self.assertEqual(result["status"], "FAILED_BEFORE_SUBMIT")
        self.assertEqual(self.events, [])

    async def test_null_declaration_prevents_upstream_default_ai(self):
        result = await self.run_request()
        self.assertEqual(result["status"], "SUBMITTED_UNVERIFIED")
        self.assertIsNone(result["platformId"])
        self.assertFalse(any(event[0] == "declaration" for event in self.events))
        constructor = next(event[1] for event in self.events if event[0] == "construct")
        self.assertEqual(constructor["account_file"], str(self.cookie))
        self.assertNotEqual(constructor["file_path"], str(self.video))
        self.assertEqual(Path(constructor["file_path"]).suffix, self.video.suffix)
        self.assertEqual(constructor["desc"], "Test description")
        self.assertEqual(constructor["tags"], ["topic"])
        self.assertFalse(constructor["debug"])

    async def test_explicit_declaration_is_forwarded_exactly(self):
        self.request["declaration"] = "内容为个人观点或见解"
        await self.run_request()
        self.assertIn(("declaration", "内容为个人观点或见解"), self.events)

    async def test_exception_after_entering_upload_is_unknown_and_sanitized(self):
        async def fail(uploader):
            print("sms=123456 sessionid=secret-cookie")
            self.module.douyin_logger.info("sms=123456 sessionid=secret-cookie")
            raise RuntimeError("sms=123456 sessionid=secret-cookie")
        self.module.DouYinVideo.douyin_upload_video = fail
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            result = await self.run_request()
        self.assertEqual(result["status"], "UNKNOWN")
        combined = json.dumps(result) + output.getvalue() + errors.getvalue()
        self.assertNotIn("123456", combined)
        self.assertNotIn("secret-cookie", combined)

    async def test_cookie_check_exception_is_before_submit(self):
        async def fail(account_file):
            raise RuntimeError("sessionid=secret-cookie")
        self.module.cookie_auth = fail
        result = await self.run_request()
        self.assertEqual(result["status"], "FAILED_BEFORE_SUBMIT")
        self.assertNotIn("secret-cookie", json.dumps(result))

    async def test_timeout_cancels_upload_and_returns_unknown(self):
        cancelled = []
        async def wait_forever(uploader):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.append(True)
        self.module.DouYinVideo.douyin_upload_video = wait_forever
        self.request["timeoutSeconds"] = 1
        result = await self.run_request()
        self.assertEqual(result["status"], "UNKNOWN")
        self.assertEqual(cancelled, [True])
        self.assertIn("timeout", result["message"].lower())
        snapshot = next(event[1]["file_path"] for event in self.events if event[0] == "construct")
        self.assertFalse(Path(snapshot).exists())

    async def test_check_ready_does_not_upload(self):
        self.request = {"action": "check", "account": "account_A", "timeoutSeconds": 2}
        result = await worker.run_request(self.request, self.repo, module=self.module)
        self.assertEqual(result["status"], "READY")
        self.assertEqual(self.events, [("check", str(self.cookie))])

    async def test_login_saved_is_sanitized_and_uses_visible_browser(self):
        self.request = {"action": "login", "account": "account_A", "timeoutSeconds": 2}
        result = await worker.run_request(self.request, self.repo, module=self.module)
        self.assertEqual(result["status"], "LOGIN_SAVED")
        self.assertNotIn("secret-cookie", json.dumps(result))
        login_args = self.events[0][2]
        self.assertTrue(login_args["handle"])
        self.assertTrue(login_args["return_detail"])
        self.assertFalse(login_args["headless"])

    async def test_login_false_is_before_submit(self):
        async def login_fail(*args, **kwargs):
            return {"success": False, "message": "secret-cookie"}
        self.module.douyin_setup = login_fail
        self.request["action"] = "login"
        result = await self.run_request()
        self.assertEqual(result["status"], "FAILED_BEFORE_SUBMIT")
        self.assertNotIn("secret-cookie", json.dumps(result))

    async def test_invalid_requests_are_rejected_before_dependency_load(self):
        invalid_fields = [
            ("action", "publish"), ("account", "../escape"), ("account", "中文"),
            ("account", "A" * 49), ("timeoutSeconds", True), ("timeoutSeconds", 0),
            ("headless", "false"), ("file", "relative.mp4"), ("title", " "),
            ("description", {}), ("tags", "topic"), ("tags", [4]),
            ("declaration", False), ("declaration", ""),
            ("sha256", "invalid"),
        ]
        original = self.request.copy()
        for key, value in invalid_fields:
            with self.subTest(key=key, value=value):
                request = {**original, key: value}
                with patch.object(worker, "_load_upstream", side_effect=AssertionError("loaded")) as loader:
                    result = await worker.run_request(request, self.repo, confirmed=True)
                loader.assert_not_called()
                self.assertEqual(result["status"], "FAILED_BEFORE_SUBMIT")
        self.assertEqual(self.events, [])

    async def test_browser_launched_by_upstream_is_closed_after_upload_failure(self):
        lifecycle = []

        class Browser:
            async def close(self):
                lifecycle.append("browser_close")

        class Chromium:
            async def launch(self, **kwargs):
                lifecycle.append("launch")
                return Browser()

        class PlaywrightContext:
            async def __aenter__(self):
                return SimpleNamespace(chromium=Chromium())

            async def __aexit__(self, *args):
                lifecycle.append("playwright_exit")

        factory = PlaywrightContext
        self.module.async_playwright = factory
        async def fail(uploader):
            async with self.module.async_playwright() as playwright:
                await playwright.chromium.launch(headless=True)
                raise RuntimeError("private browser details")
        self.module.DouYinVideo.douyin_upload_video = fail
        result = await self.run_request()
        self.assertEqual(result["status"], "UNKNOWN")
        self.assertEqual(lifecycle, ["launch", "browser_close", "playwright_exit"])
        self.assertIs(self.module.async_playwright, factory)

    async def test_shared_sms_file_reader_is_disabled_and_restored(self):
        async def original_reader(path):
            raise AssertionError("must not consume shared OTP")
        self.module._read_verify_code = original_reader
        async def inspect_reader(uploader):
            self.assertEqual(await self.module._read_verify_code("verify_code.txt"), "")
        self.module.DouYinVideo.douyin_upload_video = inspect_reader
        result = await self.run_request()
        self.assertEqual(result["status"], "SUBMITTED_UNVERIFIED")
        self.assertIs(self.module._read_verify_code, original_reader)

    def test_cli_without_confirmation_writes_atomic_utf8_result(self):
        request_path = self.repo / "request.json"
        result_path = self.repo / "result.json"
        request_path.write_text(json.dumps(self.request), encoding="utf-8")
        run = subprocess.run([
            sys.executable, "-m", "sau_demo.worker", "--repo", str(self.repo),
            "--request", str(request_path), "--result", str(result_path),
        ], capture_output=True, timeout=10)
        self.assertNotEqual(run.returncode, 0)
        content = result_path.read_bytes()
        self.assertFalse(content.startswith(b"\xef\xbb\xbf"))
        self.assertEqual(json.loads(content)["status"], "FAILED_BEFORE_SUBMIT")
        self.assertEqual(list(self.repo.glob("*.tmp")), [])

    def test_cli_rejects_network_paths_before_opening_files(self):
        normal = {"--repo": str(self.repo), "--request": str(self.repo / "request.json"),
                  "--result": str(self.repo / "result.json")}
        for key in normal:
            args = {**normal, key: r"\\internal\share\private.json"}
            argv = [item for pair in args.items() for item in pair]
            with self.subTest(key=key), patch("builtins.open") as opening:
                with patch.object(worker, "_write_result") as writer:
                    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        status = worker.main(argv)
            opening.assert_not_called()
            writer.assert_not_called()
            self.assertNotEqual(status, 0)

    def test_cli_escaping_failure_after_confirmed_upload_is_unknown(self):
        request_path = self.repo / "request.json"
        request_path.write_text(json.dumps(self.request), encoding="utf-8")
        for error in (RuntimeError("private"), KeyboardInterrupt()):
            def fail(coroutine):
                coroutine.close()
                raise error
            with self.subTest(error=type(error).__name__), patch.object(worker.asyncio, "run", side_effect=fail):
                with patch.object(worker, "_write_result") as writer, contextlib.redirect_stdout(io.StringIO()):
                    status = worker.main([
                        "--repo", str(self.repo), "--request", str(request_path),
                        "--result", str(self.repo / "result.json"), "--confirm-remote-write",
                    ])
            self.assertEqual(writer.call_args.args[1]["status"], "UNKNOWN")
            self.assertNotEqual(status, 0)


if __name__ == "__main__":
    unittest.main()
