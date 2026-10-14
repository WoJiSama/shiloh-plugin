import {QQApi} from '../../utils/QQApi.js'
import {createQQZoneTool} from '../../dist/backend/modules/qqTools/infrastructure/QQZoneTool.js'
export const QQZoneTool=createQQZoneTool(event=>new QQApi(event))
