import {fetchDownloadToFile as download} from '../dist/backend/modules/shared/infrastructure/parallelDownload.js'
export const fetchDownloadToFile=(url,filePath,options={})=>download(url,filePath,{logger:globalThis.logger,...options})
