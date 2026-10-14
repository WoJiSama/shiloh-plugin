import {dependencies} from "../../dependence/dependencies.js"
import {createFileExtractor} from "../../dist/backend/modules/toolSupport/infrastructure/fileExtraction.js"
const extractor=createFileExtractor({textract:dependencies.textract,pdfParse:dependencies.require("pdf-parse"),logger:console})
export const extractFile=extractor.extractFile
