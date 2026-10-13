import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { serveFrontend } from "../console/lib/frontendStatic.js"

function response() {
  return { status: 0, headers: {}, body: undefined, writeHead(status, headers = {}) { this.status = status; this.headers = headers }, end(body) { this.body = body } }
}

test("frontend static server serves index without cache and immutable assets with MIME", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-static-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, "assets"))
  fs.writeFileSync(path.join(root, "index.html"), "<html>fixture</html>")
  fs.writeFileSync(path.join(root, "assets", "app-hash.js"), "fixture()")
  const index = response()
  assert.equal(serveFrontend({ method: "GET" }, index, "/", root), true)
  assert.equal(index.status, 200)
  assert.equal(index.headers["cache-control"], "no-store")
  const asset = response()
  serveFrontend({ method: "GET" }, asset, "/assets/app-hash.js", root)
  assert.equal(asset.headers["content-type"], "text/javascript; charset=utf-8")
  assert.match(asset.headers["cache-control"], /immutable/)
  const head = response()
  serveFrontend({ method: "HEAD" }, head, "/assets/app-hash.js", root)
  assert.equal(head.status, 200)
  assert.equal(head.body, undefined)
  const unrelated = response()
  assert.equal(serveFrontend({ method: "GET" }, unrelated, "/api/config/pipeline", root), false)
})

test("frontend static server rejects encoded traversal and symlink escape", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-static-safe-"))
  const dist = path.join(root, "dist")
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true })
  fs.writeFileSync(path.join(root, "secret.txt"), "fixture-secret")
  fs.symlinkSync(path.join(root, "secret.txt"), path.join(dist, "assets", "escape.txt"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const pathname of ["/assets/../../secret.txt", "/assets/%2e%2e/%2e%2e/secret.txt", "/assets/escape.txt"]) {
    const result = response()
    serveFrontend({ method: "GET" }, result, pathname, dist)
    assert.equal(result.status, 404)
    assert.equal(String(result.body).includes("fixture-secret"), false)
  }
})

test("missing frontend build yields actionable 503 and malformed paths yield 400", () => {
  const missing = response()
  serveFrontend({ method: "GET" }, missing, "/", "/nonexistent/console-build-fixture")
  assert.equal(missing.status, 503)
  assert.match(missing.body, /npm --prefix console\/frontend run build/)
  const malformed = response()
  serveFrontend({ method: "GET" }, malformed, "/assets/%zz", "/nonexistent/console-build-fixture")
  assert.equal(malformed.status, 400)
})
