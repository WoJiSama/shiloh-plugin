import jwt from "jsonwebtoken"
import {createGuobaLoginTrust} from '../dist/backend/modules/platform/infrastructure/admin/guobaLoginTrust.js'
export {resetGuobaJwtSecretCache} from '../dist/backend/modules/platform/infrastructure/admin/guobaLoginTrust.js'
export const {checkGuobaLoginToken}=createGuobaLoginTrust(()=>globalThis.redis||null,(token,secret)=>jwt.verify(token,secret))
