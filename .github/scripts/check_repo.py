"""Static checks (no Cloudflare, no network).

* worker/worker.js is syntactically valid JavaScript (node --check)
* worker/schema.sql parses (D1 is SQLite)
* wrangler.toml loads and holds no secret value (secrets are set with `wrangler secret put`)
* every endpoint named in the README (GET /x, POST /x) is handled in worker.js
* README links that point into this repository lead to existing files
"""
import re
import shutil
import subprocess
import sys
import tomllib
import urllib.parse

import sqlglot
from sqlglot.errors import ParseError, TokenError

problems = []
tracked = [t.strip('"') for t in subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True, encoding="utf-8").stdout.splitlines()]

if shutil.which("node"):
    r = subprocess.run(["node", "--check", "worker/worker.js"], capture_output=True, text=True)
    if r.returncode:
        problems.append("worker/worker.js: " + r.stderr.strip().splitlines()[0][:150])
else:
    problems.append("node is not installed: cannot check worker/worker.js")

with open("worker/schema.sql", encoding="utf-8") as fh:
    try:
        sqlglot.parse(fh.read(), read="sqlite")
    except (ParseError, TokenError) as exc:
        problems.append(f"worker/schema.sql: parse error: {str(exc).splitlines()[0][:120]}")

with open("worker/wrangler.toml", "rb") as fh:
    toml = tomllib.load(fh)
text = open("worker/wrangler.toml", encoding="utf-8").read()
if re.search(r"(?i)(api[_-]?key|secret|token|password)\s*=\s*[\"'][^\"']{8,}[\"']", text) or "sk-ant" in text:
    problems.append("worker/wrangler.toml: a secret value is written in the file")
if not toml.get("name") or not toml.get("main"):
    problems.append("worker/wrangler.toml: name or main is missing")

worker = open("worker/worker.js", encoding="utf-8").read()
readme = open("README.md", encoding="utf-8").read()
endpoints = sorted(set(re.findall(r"`(/(?:remember|recall|stats|admin/clear))`", readme)))
if not endpoints:
    problems.append("no endpoint found in the README")
for ep in endpoints:
    if f'"{ep}"' not in worker and f"'{ep}'" not in worker:
        problems.append(f"README names the endpoint {ep}, but worker.js does not handle it")
# figures quoted in the README must equal the constants in the code
const = lambda name: float(re.search(rf"const {name}\s*=\s*([0-9.]+)", worker).group(1))
m = re.search(r"(\d+)/day per IP, (\d+)/day global", readme)
if not m or (int(m.group(1)), int(m.group(2))) != (const("IP_DAILY_LIMIT"), const("GLOBAL_DAILY_LIMIT")):
    problems.append(f"README rate limits {m.groups() if m else None} differ from IP_DAILY_LIMIT / GLOBAL_DAILY_LIMIT in worker.js")
m = re.search(r"floor \(([0-9.]+)\)", readme)
if not m or float(m.group(1)) != const("RECENCY_FLOOR"):
    problems.append("README recency floor differs from RECENCY_FLOOR in worker.js")
n_links = 0
for target in re.findall(r"\]\(((?:[^()\s]|\([^)]*\))+)\)", readme):
    if re.match(r"^(https?:|#|mailto:)", target):
        continue
    n_links += 1
    if urllib.parse.unquote(target.split("#")[0]) not in tracked:
        problems.append(f"README: link to a missing file: {target}")

print(f"Checked worker.js syntax, schema.sql, wrangler.toml, {len(endpoints)} README endpoints {endpoints}, {n_links} links; {len(problems)} problem(s)")
for p in problems:
    print("FAIL ", p)
sys.exit(1 if problems else 0)
