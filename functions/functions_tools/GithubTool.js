import {createGitHubRepoTool} from '../../dist/backend/modules/knowledge/infrastructure/GithubTool.js'
import {getSharedConfig} from '../../core/runtime/sharedRuntime.js'
export const GitHubRepoTool=createGitHubRepoTool({githubToken:getSharedConfig()?.githubToken||'',fetch:(...args)=>globalThis.fetch(...args),logger:{info:message=>globalThis.logger?.info?.(message)}})
