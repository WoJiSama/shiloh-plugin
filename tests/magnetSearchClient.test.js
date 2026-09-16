import { test } from "node:test"
import assert from "node:assert/strict"
import {
  MagnetSearchClient,
  buildMagnetFromInfoHash,
  buildMagnetSearchReportData,
  buildMagnetSearchUrl,
  formatMagnetSearchResponse,
  getMagnetSearchHelp,
  normalizeSearchLimit,
  parseBitsearchHtml
} from "../domains/media/magnetsearch/MagnetSearchClient.js"

test("buildMagnetSearchUrl encodes keyword and asks for enough rows", () => {
  assert.equal(
    buildMagnetSearchUrl("https://torrents-csv.com/service/search", { keyword: "ubuntu iso", limit: 10 }),
    "https://torrents-csv.com/service/search?q=ubuntu+iso&size=25"
  )
  assert.equal(normalizeSearchLimit(99), 20)
})

test("MagnetSearchClient queries public torrent index", async () => {
  let seenUrl = ""
  let seenHeaders = {}
  const client = new MagnetSearchClient({
    magnetSearchSystem: {
      enabled: true,
      searchUrl: "https://torrents-csv.com/service/search",
      proxyUrl: "",
      timeoutMs: 1000
    }
  }, {
    fetchImpl: async (url, options) => {
      seenUrl = url
      seenHeaders = options.headers
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ torrents: [] })
      }
    }
  })

  await client.search({ keyword: "ubuntu", limit: 5 })
  assert.equal(seenUrl, "https://torrents-csv.com/service/search?q=ubuntu&size=25")
  assert.equal(seenHeaders.Accept, "application/json")
})

test("buildMagnetFromInfoHash appends public trackers", () => {
  const magnet = buildMagnetFromInfoHash("c9bc96d23542e5430f6bf8232b402a85172ca28b", "Ubuntu Handbook")
  assert.match(magnet, /^magnet:\?xt=urn:btih:c9bc96d23542e5430f6bf8232b402a85172ca28b/i)
  assert.match(magnet, /dn=Ubuntu%20Handbook/)
  assert.match(magnet, /tracker\.opentrackr\.org/)
})

test("buildMagnetSearchReportData maps public index rows", () => {
  const report = buildMagnetSearchReportData({
    torrents: [
      {
        infohash: "c9bc96d23542e5430f6bf8232b402a85172ca28b",
        name: "Ubuntu Handbook",
        size_bytes: 11513822,
        seeders: 12,
        leechers: 1
      },
      {
        infohash: "22b8f63218f1e726ec2f1fb9b38239f95fc6a629",
        name: "Older ISO",
        size_bytes: 20501290,
        seeders: 2,
        leechers: 0
      }
    ]
  }, { keyword: "ubuntu", limit: 10 })

  assert.equal(report.kind, "magnet-search")
  assert.equal(report.title, "磁力搜索：ubuntu（Top 2）")
  assert.equal(report.rows[0].name, "Ubuntu Handbook")
  assert.equal(report.rows[0].size, "11.5 MB")
  assert.equal(report.rows[0].seeders, "12")
  assert.match(report.rows[0].magnet, /c9bc96d23542e5430f6bf8232b402a85172ca28b/)
})

test("formatMagnetSearchResponse renders empty keyword miss", () => {
  assert.equal(
    formatMagnetSearchResponse({ torrents: [] }, { keyword: "不存在" }),
    "没有找到「不存在」相关的磁力资源"
  )
})

test("help includes magnet search command", () => {
  const help = getMagnetSearchHelp()
  assert.match(help, /\.磁力 <关键词>/)
  assert.match(help, /不会自动下载/)
})

test("Guoba schema exposes magnet search config", async () => {
  const { default: magnetSearchSchema } = await import("../models/Guoba/schemas/magnetSearch.js")
  const fields = magnetSearchSchema.map(item => item.field).filter(Boolean)
  assert.ok(fields.includes("magnetSearchSystem.enabled"))
  assert.ok(fields.includes("magnetSearchSystem.searchUrl"))
  assert.ok(fields.includes("magnetSearchSystem.timeoutMs"))
})

test("MagnetSearchClient reports disabled config clearly", async () => {
  const client = new MagnetSearchClient({ magnetSearchSystem: { enabled: false } })
  await assert.rejects(() => client.search({ keyword: "ubuntu" }), /未启用/)
})

test("parseBitsearchHtml extracts encoded magnet cards", () => {
  const html = `
    <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <a href="/torrent/abc">ubuntu-19.04-desktop-amd64.iso</a>
      <span>1.95 GB</span>
      <span class="font-medium">28</span>
      <span>seeders</span>
      <span class="font-medium">41</span>
      <span>leechers</span>
      <a href="/download/torrent/D540FC48EB12F2833163EED6421D449DD8F1CE1F?title=ubuntu"></a>
      <a href="magnet:?xt&#x3D;urn:btih:D540FC48EB12F2833163EED6421D449DD8F1CE1F&amp;dn&#x3D;ubuntu"></a>
    </div>
  `
  const items = parseBitsearchHtml(html)
  assert.equal(items.length, 1)
  assert.equal(items[0].name, "ubuntu-19.04-desktop-amd64.iso")
  assert.equal(items[0].infohash, "D540FC48EB12F2833163EED6421D449DD8F1CE1F")
  assert.equal(items[0].seeders, 28)
  assert.match(items[0].magnet, /^magnet:\?xt=urn:btih:D540FC48EB12F2833163EED6421D449DD8F1CE1F/i)
})

test("MagnetSearchClient uses proxy only for blocked sources", async () => {
  const seenDirect = []
  const seenProxy = []
  const client = new MagnetSearchClient({
    magnetSearchSystem: {
      enabled: true,
      searchUrl: "https://torrents-csv.com/service/search",
      proxyUrl: "http://127.0.0.1:7890",
      timeoutMs: 1000,
      proxyTimeoutMs: 1000
    }
  }, {
    fetchImpl: async (url) => {
      seenDirect.push(url)
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          torrents: [{ infohash: "c9bc96d23542e5430f6bf8232b402a85172ca28b", name: "CSV Ubuntu", size_bytes: 1000, seeders: 3, leechers: 0 }]
        })
      }
    },
    proxyFetchImpl: async (url) => {
      seenProxy.push(url)
      if (String(url).includes("bitsearch")) {
        return {
          ok: true,
          status: 200,
          text: async () => `<div class="bg-white rounded-lg shadow-sm border"><a href="/torrent/x">VPN Ubuntu</a><span>2.0 GB</span><span class="font-medium">9</span><span>seeders</span><span class="font-medium">1</span><span>leechers</span><a href="/download/torrent/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"></a><a href="magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&dn=vpn"></a></div>`
        }
      }
      throw new Error("TLS connect error")
    }
  })

  const result = await client.search({ keyword: "ubuntu", limit: 10 })
  assert.equal(seenDirect.length, 1)
  assert.match(seenDirect[0], /torrents-csv\.com/)
  assert.ok(seenProxy.some(url => String(url).includes("bitsearch.eu")))
  assert.ok(seenProxy.some(url => String(url).includes("solidtorrents.to")))
  assert.equal(result.torrents.length, 2)
  assert.equal(result.torrents[0].name, "VPN Ubuntu")
  assert.equal(result.torrents[1].name, "CSV Ubuntu")
})

test("Guoba schema exposes magnet search proxy config", async () => {
  const { default: magnetSearchSchema } = await import("../models/Guoba/schemas/magnetSearch.js")
  const fields = magnetSearchSchema.map(item => item.field).filter(Boolean)
  assert.ok(fields.includes("magnetSearchSystem.proxyUrl"))
})
