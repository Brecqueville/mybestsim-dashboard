import json

from esim_dashboard.__main__ import main
from esim_dashboard.render import script_json


def test_build_writes_the_site(small_catalog, tmp_path):
    out = tmp_path / "site"
    assert main(["--data", str(small_catalog), "--out", str(out)]) == 0
    html = (out / "index.html").read_text(encoding="utf-8")
    assert "Vue d'ensemble du catalogue" in html
    assert (out / "assets" / "dashboard.js").exists()
    stats = json.loads((out / "stats.json").read_text(encoding="utf-8"))
    assert stats["stats"]["overview"]["kpis"]["products"] == 5
    assert (out / "catalogue-consolide.csv").read_bytes().startswith(b"\xef\xbb\xbf")  # BOM pour Excel


def test_embedded_json_cannot_close_the_script_tag():
    text = str(script_json({"name": "</script><img src=x onerror=alert(1)>"}))
    assert "</script>" not in text
    assert "<" not in text
    assert json.loads(text)["name"].startswith("</script>")
