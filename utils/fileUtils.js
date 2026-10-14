import mimeTypes from 'mime-types'
import {createFileUtils} from '../dist/backend/modules/shared/infrastructure/fileUtils.js'
import {classifyMessageSegmentMedia} from './mediaTypePolicy.js'
let common
try {common=(await import('../../../lib/common/common.js')).default}catch{}
const runtime=createFileUtils({cwd:process.cwd(),mimeTypes,classifyMessageSegmentMedia,
 logger:{debug:message=>globalThis.logger?.debug?.(message),info:message=>globalThis.logger?.info?.(message),warn:message=>globalThis.logger?.warn?.(message),error:message=>globalThis.logger?.error?.(message)},
 redis:{get:key=>globalThis.redis.get(key),set:(key,value)=>globalThis.redis.set(key,value)},
 image:path=>globalThis.segment.image(path),
 makeForwardMsg:(...args)=>common.makeForwardMsg(...args),
 callOneBotApi:(action,params)=>(globalThis.Bot?.sendApi?globalThis.Bot:globalThis.bot).sendApi(action,params)
})
export const getNapcatRKeys=runtime.getNapcatRKeys
export const isTencentImageUrlAvailable=runtime.isTencentImageUrlAvailable
export const refreshTencentImageUrl=runtime.refreshTencentImageUrl
export const normalizeImageUrls=runtime.normalizeImageUrls
export const getFileExtensionFromUrl=runtime.getFileExtensionFromUrl
export const chunk=runtime.chunk
export const downloadAndSaveFile=runtime.downloadAndSaveFile
export const get_address=runtime.get_address
export const removeDuplicates=runtime.removeDuplicates
export const PluginUploadFile=runtime.PluginUploadFile
export const getBase64Image=runtime.getBase64Image
export const getBase64File=runtime.getBase64File
export const TakeImages=runtime.TakeImages
export const getRKey=runtime.getRKey
export const extractDomain=runtime.extractDomain
export const getResponse=runtime.getResponse
export const getFileInfo=runtime.getFileInfo
export const saveUserHistory=runtime.saveUserHistory
export const downloadImage=runtime.downloadImage
export const handleImages=runtime.handleImages
export const sendLongMessage=runtime.sendLongMessage
export const loadData=runtime.loadData
export const loadUserHistory=runtime.loadUserHistory
export const saveData=runtime.saveData
