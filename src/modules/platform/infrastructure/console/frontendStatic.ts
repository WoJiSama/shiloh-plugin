import fs from "node:fs"
import path from "node:path"

const MIME:Record<string,string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".map": "application/json; charset=utf-8"
}

export function serveFrontend(req:import("node:http").IncomingMessage, res:import("node:http").ServerResponse, pathname:string, distDirectory:string) {
  if (pathname !== "/" && !pathname.startsWith("/assets/")) return false
  if (!["GET", "HEAD"].includes(req.method || "")) {
    res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" })
    res.end("method not allowed")
    return true
  }
  let relative
  try { relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).slice(1) }
  catch { res.writeHead(400); res.end("invalid path"); return true }
  const root = path.resolve(distDirectory)
  const requested = path.resolve(root, relative)
  if (!requested.startsWith(`${root}${path.sep}`) || relative.includes("\0")) {
    res.writeHead(404); res.end("not found"); return true
  }
  try {
    // Check real paths as well: a symlink inside assets cannot expose files outside dist.
    const realRoot = fs.realpathSync(root)
    const realFile = fs.realpathSync(requested)
    if (!realFile.startsWith(`${realRoot}${path.sep}`) || !fs.statSync(realFile).isFile()) throw new Error("not found")
    const content = fs.readFileSync(realFile)
    res.writeHead(200, {
      "content-type": MIME[path.extname(realFile).toLowerCase()] || "application/octet-stream",
      "content-length": content.length,
      "x-content-type-options": "nosniff",
      "cache-control": pathname === "/" ? "no-store" : "public, max-age=31536000, immutable"
    })
    res.end(req.method === "HEAD" ? undefined : content)
  } catch {
    const missingBuild = pathname === "/"
    res.writeHead(missingBuild ? 503 : 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
    res.end(missingBuild ? "控制台前端尚未构建。请在插件目录运行 npm --prefix console/frontend ci && npm --prefix console/frontend run build，然后重新加载页面。" : "not found")
  }
  return true
}
