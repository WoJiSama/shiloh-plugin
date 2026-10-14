import net from "node:net"

export type RedisValue = string | number | null | Error | RedisValue[]
export function parseRedisReply(buffer:Buffer, offset = 0):{used:number;value:RedisValue}|null {
  if (offset >= buffer.length) return null
  const end = buffer.indexOf("\r\n", offset)
  if (end < 0) return null
  const type = String.fromCharCode(buffer[offset]!)
  const payload = buffer.subarray(offset + 1, end).toString()
  const headerBytes = end + 2 - offset
  if (type === "+") return { used: headerBytes, value: payload }
  if (type === "-") return { used: headerBytes, value: new Error(payload) }
  if (type === ":") return { used: headerBytes, value: Number(payload) }
  if (type === "$") {
    const length = Number(payload)
    if (length < 0) return { used: headerBytes, value: null }
    if (buffer.length - offset < headerBytes + length + 2) return null
    return { used: headerBytes + length + 2, value: buffer.subarray(end + 2, end + 2 + length).toString() }
  }
  if (type === "*") {
    const count = Number(payload)
    if (count < 0) return { used: headerBytes, value: null }
    let used = headerBytes
    const value = []
    for (let index = 0; index < count; index++) {
      const item = parseRedisReply(buffer, offset + used)
      if (!item) return null
      used += item.used
      value.push(item.value)
    }
    return { used, value }
  }
  throw new Error("Redis 返回不支持的协议数据")
}

export function encodeRedisCommand(args:readonly (string|number)[]) {
  return Buffer.concat([
    Buffer.from(`*${args.length}\r\n`),
    ...args.flatMap(arg => {
      const body = Buffer.from(String(arg))
      return [Buffer.from(`$${body.length}\r\n`), body, Buffer.from("\r\n")]
    })
  ])
}

export class MiniRedis {
  host:string
  port:number
  timeoutMs:number
  queue:{resolve(value:RedisValue):void;reject(error:unknown):void}[]
  buffer:Buffer
  socket:net.Socket|null
  constructor({ host = "127.0.0.1", port = 6379, timeoutMs = 3000 } = {}) {
    this.host = host
    this.port = port
    this.timeoutMs = timeoutMs
    this.queue = []
    this.buffer = Buffer.alloc(0)
    this.socket = null
  }
  connect() {
    return new Promise<this>((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port })
      this.socket = socket
      const fail = (error:Error) => {
        this.socket = null
        reject(error)
        for (const item of this.queue.splice(0)) item.reject(error)
      }
      socket.setNoDelay(true)
      socket.setTimeout(this.timeoutMs)
      socket.on("timeout", () => socket.destroy(new Error("Redis 查询超时")))
      socket.on("error", fail)
      socket.on("close", () => fail(new Error("Redis 连接已关闭")))
      socket.once("connect", () => resolve(this))
      socket.on("data", chunk => {
        this.buffer = Buffer.concat([this.buffer, chunk])
        try {
          while (this.queue.length) {
            const parsed = parseRedisReply(this.buffer)
            if (!parsed) break
            this.buffer = this.buffer.subarray(parsed.used)
            const entry = this.queue.shift()!
            if (parsed.value instanceof Error) entry.reject(parsed.value)
            else entry.resolve(parsed.value)
          }
        } catch (error) { socket.destroy(error instanceof Error?error:new Error(String(error))) }
      })
    })
  }
  cmd(...args:(string|number)[]):Promise<RedisValue> {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error("Redis 未连接"))
    return new Promise<RedisValue>((resolve, reject) => {
      this.queue.push({ resolve, reject })
      this.socket!.write(encodeRedisCommand(args))
    })
  }
  async hgetall(key:string) {
    const flat = await this.cmd("HGETALL", key)
    if(!Array.isArray(flat)||flat.length%2!==0||!flat.every(value=>typeof value==="string"))throw new Error("Redis HGETALL 返回无效")
    const hash:Record<string,string> = {}
    for (let index = 0; index + 1 < flat.length; index += 2) hash[String(flat[index])] = String(flat[index + 1])
    return hash
  }
  close() { this.socket?.end() }
}
