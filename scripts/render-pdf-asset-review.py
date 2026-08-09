import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


candidate_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "eval-data/expansion-candidates").resolve()
output_dir = Path(sys.argv[2] if len(sys.argv) > 2 else "eval-data/rendered/expansion-review").resolve()
output_dir.mkdir(parents=True, exist_ok=True)
font = ImageFont.load_default(size=18)

for annotation_path in sorted(candidate_dir.glob("*.json")):
    annotation = json.loads(annotation_path.read_text(encoding="utf-8"))
    pdf_path = (annotation_path.parent / annotation["pdfPath"]).resolve()
    pages = []
    with tempfile.TemporaryDirectory(prefix="paper-agent-review-") as temporary:
        for page_number in annotation["annotatedPages"]:
            prefix = Path(temporary) / f"page-{page_number}"
            subprocess.run(
                [
                    os.environ.get("PDFTOPPM_BIN", "pdftoppm"),
                    "-f",
                    str(page_number),
                    "-l",
                    str(page_number),
                    "-r",
                    "144",
                    "-png",
                    "-singlefile",
                    str(pdf_path),
                    str(prefix),
                ],
                check=True,
                stdout=subprocess.DEVNULL,
            )
            image = Image.open(str(prefix) + ".png").convert("RGB")
            draw = ImageDraw.Draw(image)
            for index, asset in enumerate(annotation["assets"], start=1):
                if asset["page"] != page_number:
                    continue
                region = asset["region"]
                box = tuple(round(value * 2) for value in (
                    region["x"],
                    region["y"],
                    region["x"] + region["width"],
                    region["y"] + region["height"],
                ))
                color = (220, 20, 60) if asset["type"] == "figure" else (0, 90, 220)
                draw.rectangle(box, outline=color, width=5)
                label = f"{index}: {asset['type']} {asset['identifier']}"
                label_box = draw.textbbox((box[0], max(0, box[1] - 24)), label, font=font, stroke_width=2)
                draw.rectangle(label_box, fill=(255, 255, 255))
                draw.text(
                    (box[0], max(0, box[1] - 24)),
                    label,
                    fill=color,
                    font=font,
                    stroke_width=1,
                    stroke_fill=(255, 255, 255),
                )
            header = Image.new("RGB", (image.width, 38), "white")
            ImageDraw.Draw(header).text(
                (8, 8),
                f"{annotation_path.stem} — physical page {page_number}",
                fill="black",
                font=font,
            )
            page = Image.new("RGB", (image.width, image.height + header.height), "white")
            page.paste(header, (0, 0))
            page.paste(image, (0, header.height))
            pages.append(page)
    width = max(page.width for page in pages)
    height = sum(page.height for page in pages)
    sheet = Image.new("RGB", (width, height), "white")
    top = 0
    for page in pages:
        sheet.paste(page, (0, top))
        top += page.height
    destination = output_dir / f"{annotation_path.stem}.jpg"
    sheet.save(destination, quality=88, optimize=True)
    print(destination)
