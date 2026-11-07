"""Build the local plugin ZIP for MyGo Music."""
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent
manifest = json.loads((root / "plugin.json").read_text(encoding="utf-8"))
dist_dir = root / "dist"
dist_dir.mkdir(exist_ok=True)
destination = dist_dir / f"{manifest['id']}-{manifest['version']}.zip"

files_to_pack = ["plugin.json", "index.js", "README.md", "LICENSE", "icon.png"]

with ZipFile(destination, "w", compression=ZIP_DEFLATED) as archive:
    for name in files_to_pack:
        file_path = root / name
        if file_path.exists():
            archive.write(file_path, name)

print(f"Packaged successfully: {destination}")
