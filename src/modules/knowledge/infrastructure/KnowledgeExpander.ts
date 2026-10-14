import {parseKnowledge,parseEmbeddingResponse,type KnowledgeItem,type KnowledgeConfig} from "../domain/knowledgeData.js"
import { access, appendFile, readFile } from "fs/promises"
import crypto from "crypto"
const chalk={yellow:(s:string)=>s,red:(s:string)=>s,green:(s:string)=>s,blue:(s:string)=>s}

class KnowledgeExpander {
  dbPath:string
  model:string
  apiKey:string
  apiUrl:string

  constructor({ apiKey, apiUrl, dbPath = "./knowledge-db.ndjson", model = "text-embedding-3-small" }: KnowledgeConfig) {
    this.dbPath = dbPath
    this.model = model
    this.apiKey = apiKey
    this.apiUrl = apiUrl
  }

  async getEmbedding(input: string|string[]) {
    const response = await fetch(this.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: this.model, input })
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => "")
      throw new Error(`Embedding API 请求失败：${response.status} ${errorText}`)
    }

    return parseEmbeddingResponse(await response.json())
  }

  hashText(text:string) {
    return crypto.createHash("sha256").update(String(text).trim()).digest("hex")
  }

  async fileExists(filepath:string) {
    try {
      await access(filepath)
      return true
    } catch {
      return false
    }
  }

  parseKnowledgeLine(line:string, index:number): KnowledgeItem|null {
    if (!line) return null

    try {
      return parseKnowledge(JSON.parse(line))
    } catch (error) {
      console.warn(`[KnowledgeExpander] 跳过无效的 ndjson 第 ${index + 1} 行：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  async loadKnowledgeDB() {
    if (!(await this.fileExists(this.dbPath))) {
      console.log(chalk.yellow(`[KnowledgeExpander] 未找到知识库文件：${this.dbPath}`))
      return []
    }

    const data = await readFile(this.dbPath, "utf-8")
    return data
      .split("\n")
      .map((line, index) => this.parseKnowledgeLine(line.trim(), index))
      .filter((item): item is KnowledgeItem => item !== null)
  }

  async appendKnowledgeItems(items: KnowledgeItem[]) {
    if (!items.length) return
    const lines = items.map(item => JSON.stringify(item)).join("\n") + "\n"
    await appendFile(this.dbPath, lines, "utf-8")
  }

  async expandSingle(text:string) {
    try {
      const normalizedText = String(text || "").trim()
      if (!normalizedText) return false

      const res = await this.getEmbedding(normalizedText)
      const embedding = res.data?.[0]?.embedding
      if (!Array.isArray(embedding)) return false

      await this.appendKnowledgeItems([{
        text: normalizedText,
        hash: this.hashText(normalizedText),
        embedding
      }])
      return true
    } catch (error) {
      console.error(chalk.red("[KnowledgeExpander] embedding 生成失败:"), error instanceof Error ? error.message : String(error))
      return false
    }
  }

  async expand(knowledgeTexts:string|string[]) {
    const incomingTexts = (Array.isArray(knowledgeTexts) ? knowledgeTexts : [knowledgeTexts])
      .map(text => String(text || "").trim())
      .filter(Boolean)

    if (!incomingTexts.length) {
      return { added: 0, total: 0, success: false }
    }

    const db = await this.loadKnowledgeDB()
    const existingHashes = new Set(db.map(item => item.hash || this.hashText(item.text)))
    const seenHashes = new Set(existingHashes)
    const newTexts = []

    for (const text of incomingTexts) {
      const hash = this.hashText(text)
      if (seenHashes.has(hash)) continue
      seenHashes.add(hash)
      newTexts.push(text)
    }

    if (newTexts.length === 0) {
      console.log(chalk.green("[KnowledgeExpander] 所有知识都已存在"))
      return { added: 0, total: incomingTexts.length, success: true }
    }

    console.log(chalk.blue(`[KnowledgeExpander] 正在写入 ${newTexts.length} 条知识到 ${this.dbPath}`))

    try {
      const res = await this.getEmbedding(newTexts)
      const embeddings = res.data?.map(d => d.embedding) || []
      const items = newTexts
        .map((text, index) => ({
          text,
          hash: this.hashText(text),
          embedding: embeddings[index]
        }))
        .filter((item):item is KnowledgeItem & {hash:string} => Array.isArray(item.embedding))

      await this.appendKnowledgeItems(items)

      console.log(chalk.green(`[KnowledgeExpander] 已新增 ${items.length} 条，跳过 ${incomingTexts.length - items.length} 条`))
      return {
        added: items.length,
        total: incomingTexts.length,
        success: items.length > 0
      }
    } catch (error) {
      console.error(chalk.red("[KnowledgeExpander] 批量 embedding 失败:"), error instanceof Error ? error.message : String(error))
      console.log(chalk.yellow("[KnowledgeExpander] 回退为逐条生成 embedding"))

      let successCount = 0
      for (const text of newTexts) {
        const success = await this.expandSingle(text)
        if (success) successCount++
      }

      return {
        added: successCount,
        total: incomingTexts.length,
        success: successCount > 0
      }
    }
  }
}

export default KnowledgeExpander
