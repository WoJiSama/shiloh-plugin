import {createQQApi} from '../dist/backend/modules/platform/infrastructure/QQApi.js'
import request from './request.js'
export const QQApi=createQQApi({bot:()=>globalThis.Bot||{},request})
