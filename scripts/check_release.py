"""Inspect built archives; never read the user's credential store."""
import json
from pathlib import Path, PurePosixPath
import re
import zipfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "plugin/manifest.json").read_text(encoding="utf-8"))["version"]
source_roots = {"backend", "plugin", "scripts", "tests"}
source_files = {"README.md", "ACCEPTANCE.md", "SECURITY.md", "LICENSE", "requirements.txt", "requirements-lock.txt", "setup.ps1", ".gitignore"}
blocked_parts = {"credentials", "codex-auth", "control", "connection-tests", "text-translations", "jobs", "tmp", "output", ".venv", ".git", "__pycache__"}
blocked_names = {"auth.json", "config.json", "connections.json", "request.json", "status.json", "endpoint.json"}
patterns = [re.compile(rb"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}"),
            re.compile(rb"\bgh[pousr]_[A-Za-z0-9]{30,}"),
            re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")]

windows_files = {f"zotero-codex-translate-{version}.xpi", "setup.ps1", "requirements.txt", "requirements-lock.txt", "README.md", "ACCEPTANCE.md", "SECURITY.md", "LICENSE"}
for name, kind in ((f"zotero-codex-translate-{version}.xpi", "xpi"), ("zotero-codex-translate-source.zip", "source"), (f"zotero-codex-translate-{version}-windows.zip", "windows")):
    path = root / "dist" / name
    with zipfile.ZipFile(path) as archive:
        entries = archive.namelist()
        if len(entries) != len(set(entries)):
            raise SystemExit(f"Duplicate entries: {name}")
        for entry in entries:
            relative = PurePosixPath(entry)
            parts = set(relative.parts)
            if relative.is_absolute() or ".." in parts or "\\" in entry or parts & blocked_parts:
                raise SystemExit(f"Unexpected path: {name}: {entry}")
            if relative.name in blocked_names or relative.name.startswith(".env") or relative.suffix.lower() in {".pdf", ".bin", ".log", ".pyc"} or ".sqlite" in relative.name:
                raise SystemExit(f"Runtime data forbidden: {name}: {entry}")
            if kind == "source":
                permitted = entry in source_files or len(relative.parts) > 1 and relative.parts[0] in source_roots and relative.suffix in {".py", ".js", ".mjs", ".xhtml", ".json", ".ftl", ".css"}
            elif kind == "windows":
                permitted = entry in windows_files
            else:
                permitted = entry in {"bootstrap.js", "manifest.json", "LICENSE"} or len(relative.parts) > 1 and relative.parts[0] in {"backend", "content", "locale"} and relative.suffix in {".py", ".js", ".xhtml", ".ftl", ".css"}
            if not permitted:
                raise SystemExit(f"Not allowlisted: {name}: {entry}")
            content = archive.read(entry)
            if relative.suffix == ".xpi" and content != (root / "dist" / relative.name).read_bytes():
                raise SystemExit(f"Bundled XPI mismatch: {name}")
            if any(pattern.search(content) for pattern in patterns):
                raise SystemExit(f"Possible credential: {name}: {entry}")
        required = windows_files if kind == "windows" else {"README.md", "ACCEPTANCE.md", "SECURITY.md", "backend/providers.py", "backend/connections.py", "backend/text.py", "plugin/content/metadata.js"} if kind == "source" else {"manifest.json", "backend/providers.py", "backend/connections.py", "backend/text.py", "content/metadata.js", "content/connection-client.js", "content/preferences.xhtml"}
        if not required.issubset(entries):
            raise SystemExit(f"Missing required files: {name}")
        print(f"OK {name}: {len(entries)} files, {path.stat().st_size} bytes")
