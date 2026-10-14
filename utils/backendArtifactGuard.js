import {existsSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
const entry=new URL('../dist/backend/modules/platform/infrastructure/admin/backendArtifactGuard.js',import.meta.url)
if(!existsSync(entry))throw new Error('Backend artifacts are missing. Run npm run backend:build or install a verified release.')
const {createBackendArtifactGuard}=await import(entry.href)
export const {ensureBackendArtifacts}=createBackendArtifactGuard(fileURLToPath(new URL('../',import.meta.url)))
