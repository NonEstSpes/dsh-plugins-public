"""Validate distributed SVG documents without rendering or launching a browser."""
import json
from pathlib import Path
from xml.etree import ElementTree as ET

root = Path(__file__).resolve().parents[1]
icons = json.loads((root / "verification" / "icon-documents.json").read_text(encoding="utf-8"))
icons["package-icon"] = (root / "icon.svg").read_text(encoding="utf-8")
for name, markup in icons.items():
    node = ET.fromstring(markup)
    assert node.tag == "{http://www.w3.org/2000/svg}svg", name
    assert len(node.attrib["viewBox"].split()) == 4, name
    for child in node.iter():
        assert child.tag not in ("{http://www.w3.org/2000/svg}script", "{http://www.w3.org/2000/svg}style"), name
        if "id" in child.attrib:
            assert child.attrib["id"].startswith(name + "-"), name
print(f"Validated {len(icons)} SVG documents; no rasterization performed.")
