from html.parser import HTMLParser
from pathlib import Path
import sys
from urllib.parse import unquote, urljoin, urlsplit


class Page(HTMLParser):
    def __init__(self, path):
        super().__init__(convert_charrefs=True)
        self.ids = set()
        self.links = []
        self.path = path
        self.lang = None
        self.feed(path.read_text())
        self.close()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "html":
            self.lang = attrs.get("lang")
        if "id" in attrs:
            if attrs["id"] in self.ids:
                raise ValueError(f"{self.path}: duplicate id {attrs['id']}")
            self.ids.add(attrs["id"])
        for name in ("href", "src"):
            if name in attrs:
                self.links.append(attrs[name])


root = Path(sys.argv[1]).resolve()
pages = {p: Page(p) for p in root.rglob("*.html")}
for path, page in pages.items():
    source = "/" + path.relative_to(root).as_posix()
    if page.lang != ("zh-CN" if source.startswith("/zh/") else "en"):
        raise ValueError(f"{source}: wrong page language")
    for href in page.links:
        dest = urlsplit(urljoin("http://local.test" + source, href))
        if dest.netloc != "local.test":
            continue
        target = root / unquote(dest.path).lstrip("/")
        target = target / "index.html" if target.is_dir() else target
        if not target.is_file() or not target.resolve().is_relative_to(root):
            raise ValueError(f"{source}: broken link {href}")
        if dest.fragment and target in pages and unquote(dest.fragment) not in pages[target].ids:
            raise ValueError(f"{source}: missing anchor {href}")
for path in pages:
    route = path.relative_to(root).as_posix()
    if route.startswith(("docs/", "changelog/")) and root / "zh" / route not in pages:
        raise ValueError(f"No Chinese counterpart for {route}")
print(f"Verified {len(pages)} pages and their local links, anchors and assets.")
