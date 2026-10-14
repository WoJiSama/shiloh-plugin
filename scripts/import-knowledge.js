import { runKnowledgeImportCli } from '../dist/backend/scripts/importKnowledge.js'
process.exit(await runKnowledgeImportCli(process.argv.slice(2)))
