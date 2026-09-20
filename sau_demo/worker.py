"""Bounded subprocess adapter for the pinned social-auto-upload checkout.

Importing this module loads only the standard library. Platform dependencies and
browser work start only inside run_request, after local validation and the upload
confirmation gate. Each CLI invocation is intended to handle exactly one request.
"""

from __future__ import annotations

import argparse
import asyncio
from contextlib import asynccontextmanager, contextmanager, redirect_stderr, redirect_stdout
import importlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile

from .core import file_hash, local_path, validate_alias


OK_STATUSES = {"READY", "LOGIN_SAVED", "SUBMITTED_UNVERIFIED"}


def _result(status, message):
    # Never copy upstream messages, URLs, exceptions, cookies, or invented IDs.
    return {"status": status, "message": message, "platformId": None}


def _validate_request(request):
    if not isinstance(request, dict) or request.get("action") not in {"login", "check", "upload"}:
        return "Invalid action; expected login, check, or upload."
    try:
        validate_alias(request.get("account"))
    except ValueError:
        return "Invalid account alias; use 1-48 ASCII letters, digits, underscores, or hyphens, excluding reserved names."
    timeout = request.get("timeoutSeconds", 300)
    if type(timeout) is not int or not 1 <= timeout <= 7200:
        return "timeoutSeconds must be an integer between 1 and 7200."
    if "headless" in request and type(request["headless"]) is not bool:
        return "headless must be a boolean."
    if request["action"] != "upload":
        return None
    filename = request.get("file")
    if not isinstance(filename, str) or not Path(filename).is_absolute():
        return "Upload file must be an existing absolute file path."
    try:
        video = local_path(filename, Path.cwd())
    except ValueError:
        return "Upload file must be local; network paths, mapped network drives, and links are not accepted."
    if not video.is_file():
        return "Upload file must be an existing absolute file path."
    if "sha256" in request and (not isinstance(request["sha256"], str) or not re.fullmatch(r"[a-fA-F0-9]{64}", request["sha256"])):
        return "sha256 must be a 64-character hexadecimal fingerprint."
    if not isinstance(request.get("title"), str) or not request["title"].strip():
        return "Upload title must be a non-empty string."
    if not isinstance(request.get("description", ""), str):
        return "Upload description must be a string."
    tags = request.get("tags", [])
    if not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
        return "Upload tags must be a list of strings."
    declaration = request.get("declaration")
    if declaration is not None and (not isinstance(declaration, str) or not declaration.strip()):
        return "Declaration must be null or a non-empty exact platform label."
    return None


def _load_upstream(repo):
    sys.path.insert(0, str(repo))
    return importlib.import_module("uploader.douyin_uploader.main")


class _SilentLogger:
    def __getattr__(self, name):
        return lambda *args, **kwargs: None


class _ChromiumTracker:
    def __init__(self, chromium, browsers):
        self._chromium = chromium
        self._browsers = browsers

    def __getattr__(self, name):
        return getattr(self._chromium, name)

    async def launch(self, *args, **kwargs):
        browser = await self._chromium.launch(*args, **kwargs)
        self._browsers.append(browser)
        return browser


class _PlaywrightTracker:
    def __init__(self, playwright, browsers):
        self._playwright = playwright
        self.chromium = _ChromiumTracker(playwright.chromium, browsers)

    def __getattr__(self, name):
        return getattr(self._playwright, name)


@asynccontextmanager
async def _managed_playwright(factory):
    # Upstream closes upload browsers only on success. Closing Chromium also
    # closes its contexts; the driver is stopped by the outer context manager.
    async with factory() as playwright:
        browsers = []
        try:
            yield _PlaywrightTracker(playwright, browsers)
        finally:
            for browser in reversed(browsers):
                try:
                    await asyncio.wait_for(browser.close(), timeout=5)
                except Exception:
                    pass


@contextmanager
def _adapt_upstream(module):
    saved = {}

    def replace(name, value):
        if hasattr(module, name):
            saved[name] = getattr(module, name)
            setattr(module, name, value)

    async def manual_browser_only(code_file):
        # Shared verify_code.txt is not account-scoped. Enter verification in
        # the visible browser instead of consuming shared files or terminal OTPs.
        return ""

    replace("douyin_logger", _SilentLogger())
    replace("_read_verify_code", manual_browser_only)
    if hasattr(module, "async_playwright"):
        factory = module.async_playwright
        replace("async_playwright", lambda: _managed_playwright(factory))
    try:
        yield
    finally:
        for name, value in saved.items():
            setattr(module, name, value)


def _uploader(module, request, cookie):
    requested_declaration = request.get("declaration")

    class ExplicitDeclarationVideo(module.DouYinVideo):
        async def apply_self_declaration(self, page):
            # Upstream mutates self.declaration to its AI default before this
            # hook. Capture the request separately so null remains no selection.
            self.declaration = requested_declaration
            if requested_declaration is not None:
                if not await self.set_self_declaration(page, requested_declaration):
                    raise RuntimeError("The requested declaration could not be applied.")

    return ExplicitDeclarationVideo(
        title=request["title"], file_path=request["file"],
        tags=request.get("tags", []), publish_date=0, account_file=str(cookie),
        desc=request.get("description", ""), publish_strategy="immediate",
        debug=False, headless=request.get("headless", False),
        declaration=requested_declaration,
    )


async def run_request(request, repo, confirmed=False, module=None):
    """Execute one request, optionally injecting an offline upstream stand-in.

    A returned SUBMITTED_UNVERIFIED only means the upstream routine returned.
    It is not verification of publication, review status, or a platform ID.
    Module adaptation is process-scoped: do not run requests concurrently in one
    Python process. The outer queue supplies an additional process watchdog.
    """
    entered_upload = False
    try:
        if isinstance(request, dict) and request.get("action") == "upload" and confirmed is not True:
            return _result("FAILED_BEFORE_SUBMIT", "Upload requires explicit remote-write confirmation.")
        error = _validate_request(request)
        if error:
            return _result("FAILED_BEFORE_SUBMIT", error)
        action = request["action"]
        repo = local_path(str(repo), Path.cwd())
        if not repo.is_dir():
            return _result("FAILED_BEFORE_SUBMIT", "Upstream repository directory does not exist.")
        cookie = local_path(str(repo / "cookies" / ("douyin_" + request["account"] + ".json")), Path.cwd())
        if action != "login" and not cookie.is_file():
            return _result("FAILED_BEFORE_SUBMIT", "Account cookie is missing; run manual login first.")

        # Upstream may print QR payloads and exception details. Its dedicated
        # logger is also replaced because it writes SMS plaintext to log files.
        with open(os.devnull, "w", encoding="utf-8") as sink:
            with redirect_stdout(sink), redirect_stderr(sink):
                if module is None:
                    module = _load_upstream(repo)
                with _adapt_upstream(module):
                    async def execute():
                        nonlocal entered_upload
                        if action == "login":
                            cookie.parent.mkdir(parents=True, exist_ok=True)
                            outcome = await module.douyin_setup(
                                str(cookie), handle=True, return_detail=True,
                                headless=request.get("headless", False),
                            )
                            if isinstance(outcome, dict) and outcome.get("success") is True and cookie.is_file():
                                return _result("LOGIN_SAVED", "Manual login completed and account cookie saved.")
                            return _result("FAILED_BEFORE_SUBMIT", "Manual login did not save a usable account session.")
                        if not await module.cookie_auth(str(cookie)):
                            return _result("FAILED_BEFORE_SUBMIT", "Account cookie is invalid; run manual login again.")
                        if action == "check":
                            return _result("READY", "Account session check passed.")
                        source = local_path(request["file"], Path.cwd())
                        actual_hash = file_hash(source)
                        expected_hash = request.get("sha256") or actual_hash
                        if actual_hash != expected_hash.lower():
                            return _result("FAILED_BEFORE_SUBMIT", "Video changed after preview; review it before uploading.")
                        cache = local_path(str(repo.parent / ".sau-demo-cache" / "upload-staging"), Path.cwd())
                        cache.mkdir(parents=True, exist_ok=True)
                        with tempfile.TemporaryDirectory(prefix="upload-", dir=cache) as staging:
                            snapshot = Path(staging) / ("video" + source.suffix)
                            shutil.copyfile(source, snapshot)
                            if file_hash(snapshot) != expected_hash.lower():
                                return _result("FAILED_BEFORE_SUBMIT", "Video changed while staging; review it before uploading.")
                            video = _uploader(module, {**request, "file": str(snapshot)}, cookie)
                            entered_upload = True
                            await video.douyin_upload_video()
                            return _result(
                                "SUBMITTED_UNVERIFIED",
                                "Upstream submission routine returned; verify the post in Douyin before retrying.",
                            )

                    return await asyncio.wait_for(execute(), timeout=request.get("timeoutSeconds", 300))
    except (asyncio.TimeoutError, asyncio.CancelledError):
        if entered_upload:
            return _result("UNKNOWN", "Upload timeout or interruption; verify the post in Douyin before retrying.")
        return _result("FAILED_BEFORE_SUBMIT", "Operation timeout or interruption before upload started.")
    except Exception:
        if entered_upload:
            return _result("UNKNOWN", "Upload interrupted; verify the post in Douyin before retrying.")
        return _result(
            "FAILED_BEFORE_SUBMIT",
            "Operation failed before upload; check local dependencies, browser installation, and account login.",
        )


def _write_result(path, result):
    path = Path(path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", newline="\n", dir=path.parent,
            prefix=path.name + ".", suffix=".tmp", delete=False,
        ) as output:
            temporary = Path(output.name)
            json.dump(result, output, ensure_ascii=False, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--request", required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument("--confirm-remote-write", action="store_true")
    args = parser.parse_args(argv)
    try:
        # Validate every CLI path before opening a request or writing a receipt.
        repo = local_path(args.repo, Path.cwd())
        request_path = local_path(args.request, Path.cwd())
        result_path = local_path(args.result, Path.cwd())
    except (ValueError, OSError):
        print("Worker paths must use local files without network drives or links.", file=sys.stderr)
        return 2
    uncertain_upload = False
    try:
        with open(request_path, encoding="utf-8") as source:
            request = json.load(source)
        uncertain_upload = args.confirm_remote_write and isinstance(request, dict) and request.get("action") == "upload"
        result = asyncio.run(run_request(request, repo, args.confirm_remote_write))
    except (Exception, KeyboardInterrupt):
        if uncertain_upload:
            result = _result("UNKNOWN", "Worker interrupted; verify the post in Douyin before retrying.")
        else:
            result = _result("FAILED_BEFORE_SUBMIT", "Unable to read or execute the local worker request.")
    try:
        _write_result(result_path, result)
    except Exception:
        print("Worker could not save its result; inspect the platform before retrying.", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["status"] in OK_STATUSES else 1


if __name__ == "__main__":
    raise SystemExit(main())
