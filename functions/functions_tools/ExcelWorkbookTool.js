import {createExcelWorkbookTool} from '../../dist/backend/modules/content/infrastructure/ExcelWorkbookTool.js'
export const {ExcelWorkbookTool}=createExcelWorkbookTool({logger:globalThis.logger})
