import fs from 'node:fs'
import path from 'node:path'
import {createBaseModel} from '../dist/backend/modules/rendering/infrastructure/base.js'
const packageJson=JSON.parse(fs.readFileSync(path.join('./plugins','shiloh-plugin','package.json'),'utf8'))
export default createBaseModel(packageJson.name)
