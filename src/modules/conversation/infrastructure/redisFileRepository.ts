import fs from 'fs';
import path from 'path';

export function createRedisFileRepository(ports:{store():{get(key:string):Promise<unknown>;set(key:string,value:string):Promise<unknown>};log(message:string):void;error(message:string):void}) {
/**
 * 从 Redis 加载数据，如果失败则从本地文件读取
 * @param {string} redisKey - Redis 的键
 * @param {string} filePath - 本地文件路径
 * @returns {Promise<Array>} 加载的数据
 */
async function loadData(redisKey:string, filePath:string|null) {
  try {
    const data = await ports.store().get(redisKey);
    if (typeof data === "string" && data) {
      ports.log(`从 Redis 加载数据成功: ${redisKey}`);
      return JSON.parse(data);
    } else {
      ports.log(`Redis 中没有数据，尝试从本地文件加载: ${filePath}`);
      if (filePath && fs.existsSync(filePath)) {
        const fileData = await fs.promises.readFile(filePath, 'utf-8');
        const parsedData = JSON.parse(fileData);
        try {
          // 将本地数据缓存到 Redis
          await ports.store().set(redisKey, JSON.stringify(parsedData));
          ports.log(`将本地数据缓存到 Redis 成功: ${redisKey}`);
        } catch (err) {
          ports.error(`将本地数据缓存到 Redis 失败: ${err}`);
        }
        return parsedData;
      } else {
        ports.log(`本地文件不存在: ${filePath}`);
        return [];
      }
    }
  } catch (err) {
    ports.error(`从 Redis 加载数据失败: ${err}，尝试从本地文件加载`);
    try {
      if (filePath && fs.existsSync(filePath)) {
        const fileData = await fs.promises.readFile(filePath, 'utf-8');
        return JSON.parse(fileData);
      } else {
        ports.log(`本地文件不存在: ${filePath}`);
        return [];
      }
    } catch (fileErr) {
      ports.error(`从本地文件加载数据失败: ${fileErr}`);
      return [];
    }
  }
}

/**
 * 将数据保存到 Redis，如果失败则保存到本地文件
 * @param {string} redisKey - Redis 的键
 * @param {string} filePath - 本地文件路径
 * @param {Array} data - 要保存的数据
 */
async function saveData(redisKey:string, filePath:string, data:unknown) {
  try {
    await ports.store().set(redisKey, JSON.stringify(data));
    ports.log(`数据已保存到 Redis: ${redisKey}`);
  } catch (err) {
    ports.error(`保存数据到 Redis 失败: ${err}，尝试保存到本地文件`);
    try {
      // 确保目录存在
      const dirPath = path.dirname(filePath);
      if (!fs.existsSync(dirPath)) {
        await fs.promises.mkdir(dirPath, { recursive: true });
      }
      await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
      ports.log(`数据已保存到本地文件: ${filePath}`);
    } catch (fileErr) {
      ports.error(`保存数据到本地文件失败: ${fileErr}`);
    }
  }
}
return {loadData,saveData}
}
