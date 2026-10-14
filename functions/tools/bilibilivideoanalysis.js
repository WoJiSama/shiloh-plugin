import fetch from 'node-fetch'
import {BilibiliParser as Parser,bilibiliParser as parse} from '../../dist/backend/modules/media/infrastructure/bilibilivideoanalysis.js'
export class BilibiliParser extends Parser {constructor(){super(fetch)}}
export const bilibiliParser=urls=>parse(urls,fetch)
