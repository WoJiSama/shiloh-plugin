import axios from 'axios'
import {dependencies} from '../../dependence/dependencies.js'
import {getFileInfo} from '../../utils/fileUtils.js'
import {createFileDownload,createTakeFiles} from '../../dist/backend/modules/toolSupport/infrastructure/UploadFile.js'
export {takeSourceMsg} from '../../dist/backend/modules/toolSupport/infrastructure/UploadFile.js'
const download=createFileDownload({get:url=>axios.get(url,{responseType:'arraybuffer',validateStatus:status=>status>=200&&status<=500}),lookup:name=>dependencies.mimeTypes.lookup(name),logger:console})
export const getBufferFile=download.getBufferFile
export const TakeFiles=createTakeFiles(getFileInfo)
