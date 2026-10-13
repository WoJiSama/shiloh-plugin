// Runtime fetch stays at the legacy composition boundary (late-bound for tests).
import { createProviderProbe } from '../dist/backend/modules/models/application/aiProviderProbe.js'
const probe = createProviderProbe((url, options) => globalThis.fetch(url, options))

export const classifyConfigKind = probe.classifyConfigKind
export const maskSecrets = probe.maskSecrets
export const probeProvider = probe.probeProvider
export const probeProviders = probe.probeProviders
export const summarizeProbes = probe.summarizeProbes
