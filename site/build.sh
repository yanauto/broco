#!/usr/bin/env sh
set -eu
cd -- "$(dirname -- "$0")"
mkdir -p dist
stage=$(mktemp -d "$PWD/dist/build.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
mkdir -p "$stage/public/assets/fonts"
expected="$stage/expected.list"
actual="$stage/actual.list"
cat > "$expected" <<'EOF'
public/assets/broco-favicon-192.png
public/assets/broco-favicon-32.png
public/assets/broco-favicon-64.png
public/assets/broco-foreman-256.png
public/assets/broco-social-preview-1280x640.png
public/assets/fonts/instrument-sans-latin.woff2
public/assets/fonts/jetbrains-mono-latin.woff2
public/favicon.ico
public/index.html
public/page.js
public/style.css
EOF
LC_ALL=C sort "$expected" -o "$expected"
find public ! -type d -print | LC_ALL=C sort > "$actual"
diff -u "$expected" "$actual"
while IFS= read -r rel; do
  file=${rel#public/}
  test -f "public/$file"
  test ! -L "public/$file"
  test -s "public/$file"
  cp "public/$file" "$stage/public/$file"
done < "$expected"
node ../docs-site/build.mjs "$stage/public"
node --check "$stage/public/page.js"
node --check "$stage/public/guide-assets/guide.js"
python3 check-links.py "$stage/public"
COPYFILE_DISABLE=1 tar -C "$stage" --no-xattrs -czf "$stage/site.tgz" public 2>/dev/null || COPYFILE_DISABLE=1 tar -C "$stage" -czf "$stage/site.tgz" public
rm -rf dist/public
mv "$stage/public" dist/public
mv "$stage/site.tgz" dist/site.tgz
echo 'Built site/dist/public and site/dist/site.tgz'
