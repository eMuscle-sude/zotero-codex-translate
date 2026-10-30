"""Build a clean Zotero XPI without shipping virtualenvs, credentials or test data."""
import json
import hashlib
from pathlib import Path
import shutil
import zipfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "plugin/manifest.json").read_text(encoding="utf-8"))["version"]
dist = root / "dist"
dist.mkdir(exist_ok=True)
path = dist / f"zotero-codex-translate-{version}.xpi"
with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
    for file in sorted((root / "plugin").rglob("*")):
        if file.is_file() and "backend" not in file.relative_to(root / "plugin").parts:
            archive.write(file, file.relative_to(root / "plugin").as_posix())
    for file in sorted((root / "backend").glob("*.py")):
        archive.write(file, "backend/" + file.name)
    archive.write(root / "LICENSE", "LICENSE")
for name in ("setup.ps1", "requirements.txt", "requirements-lock.txt", "README.md", "ACCEPTANCE.md", "SECURITY.md"):
    if (root / name).exists():
        shutil.copyfile(root / name, dist / name)
print(path)
source_path = dist / "zotero-codex-translate-source.zip"
source_files = [root / name for name in ("README.md", "ACCEPTANCE.md", "SECURITY.md", "LICENSE", "requirements.txt", "requirements-lock.txt", "setup.ps1", ".gitignore")]
for directory in ("backend", "plugin", "scripts", "tests"):
    source_files.extend(file for file in (root / directory).rglob("*")
                        if file.is_file() and "__pycache__" not in file.parts and file.suffix != ".pyc")
with zipfile.ZipFile(source_path, "w", zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(source_files):
        archive.write(file, file.relative_to(root).as_posix())
print(source_path)
windows_path = dist / f"zotero-codex-translate-{version}-windows.zip"
with zipfile.ZipFile(windows_path, "w", zipfile.ZIP_DEFLATED) as archive:
    archive.write(path, path.name)
    for name in ("setup.ps1", "requirements.txt", "requirements-lock.txt", "README.md", "ACCEPTANCE.md", "SECURITY.md", "LICENSE"):
        archive.write(root / name, name)
print(windows_path)
checksums = "".join(f"{hashlib.sha256(file.read_bytes()).hexdigest()}  {file.name}\n" for file in (path, source_path, windows_path))
(dist / "SHA256SUMS.txt").write_text(checksums, encoding="ascii")
