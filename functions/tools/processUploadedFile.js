import {extractFile} from './textract.js'
import {getBufferFile} from './UploadFile.js'
import {TotalTokens} from './CalculateToken.js'
import {dependencies} from '../../dependence/dependencies.js'
import {createUploadedFileProcessor} from '../../dist/backend/modules/toolSupport/infrastructure/processUploadedFile.js'
export const processUploadedFile=createUploadedFileProcessor({extractFile,getBufferFile,TotalTokens,lookup:name=>dependencies.mimeTypes.lookup(name),logger:console})
