#!/usr/bin/env node
import { ensureBackendArtifacts } from "../utils/backendArtifactGuard.js"
await ensureBackendArtifacts()
const { createConsoleServer } = await import("../dist/backend/modules/platform/infrastructure/console/consoleServer.js")
const { buildTurnTraceReport } = await import("../dist/backend/scripts/turnTraceReport.js")
const pluginRoot = process.env.CONSOLE_PLUGIN_ROOT || new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const app = createConsoleServer({ pluginRoot, buildTurnTraceReport })
app.listen()
