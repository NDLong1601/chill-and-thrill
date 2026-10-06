"""Package the supplied artwork for the web client; leave source files untouched.

Usage: python scripts/import-game-assets.py [path/to/images]
Requires Pillow. UNO artwork is deliberately excluded.
"""
from pathlib import Path
import hashlib
import json
import sys

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Downloads" / "images"
OUTPUT = ROOT / "public" / "assets" / "game"
SUITS = {"S": "chất bích.png", "H": "chất cơ.png", "D": "chất rô.png", "C": "chất chuồn.png"}
RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]


def opaque_runs(values, minimum=30):
    result, start = [], None
    for index, value in enumerate(values + [False]):
        if value and start is None:
            start = index
        elif not value and start is not None:
            if index - start > minimum:
                result.append((start, index))
            start = None
    return result


def save(image, relative, size):
    image = image.copy()
    image.thumbnail(size, Image.Resampling.LANCZOS)
    target = OUTPUT / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(target, "WEBP", lossless=True, method=6)
    if relative.parts[0] == "cards":
        image.save(target.with_suffix('.png'), "PNG", optimize=True)
    return {"url": f"/assets/game/{relative.as_posix()}", "width": image.width, "height": image.height, "bytes": target.stat().st_size}


def source_info(path):
    return {"file": path.relative_to(SOURCE).as_posix(), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def main():
    manifest = {"version": 1, "cards": {}, "icons": {}, "sources": []}
    for suit, filename in SUITS.items():
        path = SOURCE / "card" / filename
        image = Image.open(path).convert("RGBA")
        alpha = image.getchannel("A")
        rows = opaque_runs([alpha.getpixel((100, y)) > 240 for y in range(image.height)])
        if len(rows) != 2:
            raise ValueError(f"Expected two card rows: {path}")
        manifest["sources"].append(source_info(path))
        for row_index, (y1, y2) in enumerate(rows):
            scan_y = 350 if row_index == 0 else 700
            columns = opaque_runs([alpha.getpixel((x, scan_y)) > 240 for x in range(image.width)])
            if len(columns) != (7 if row_index == 0 else 6):
                raise ValueError(f"Unexpected card columns: {path}")
            for column, (x1, x2) in enumerate(columns):
                rank = RANKS[column + (0 if row_index == 0 else 7)]
                # Capture the gold border without including a neighbouring card.
                left = max(0, x1 - 6, (columns[column - 1][1] + x1) // 2 if column else 0)
                right = min(image.width, x2 + 6, (x2 + columns[column + 1][0]) // 2 if column + 1 < len(columns) else image.width)
                box = (left, y1 - 6, right, y2 + 6)
                face = image.crop(box)
                face.thumbnail((192, 280), Image.Resampling.LANCZOS)
                canvas = Image.new("RGBA", (192, 280))
                canvas.alpha_composite(face, ((192 - face.width) // 2, (280 - face.height) // 2))
                manifest["cards"][rank + suit] = {**save(canvas, Path("cards") / f"{rank}{suit}.webp", (192, 280)), "crop": box}
    back_path = SOURCE / "card" / "mặt sau.png"
    back = Image.open(back_path).convert("RGBA")
    bounds = back.getchannel("A").point(lambda value: 255 if value > 240 else 0).getbbox()
    manifest["back"] = save(back.crop(bounds), Path("cards/back.webp"), (288, 420))
    manifest["sources"].append(source_info(back_path))
    for name in ["coin", "gem", "chip", "logo"]:
        path = SOURCE / f"{name}.png"
        icon = Image.open(path).convert("RGBA")
        bounds = icon.getchannel("A").point(lambda value: 255 if value > 240 else 0).getbbox()
        # Remove transparent canvas margins; preserve the supplied colors and art.
        box = (max(0, bounds[0] - 4), max(0, bounds[1] - 4), min(icon.width, bounds[2] + 4), min(icon.height, bounds[3] + 4))
        manifest["icons"][name] = save(icon.crop(box), Path(f"{name}.webp"), (640, 400) if name == "logo" else (256, 256))
        manifest["sources"].append(source_info(path))
    assert len(manifest["cards"]) == 52
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Packaged 52 faces, 1 back and 4 icons in {OUTPUT}")


if __name__ == "__main__":
    main()
