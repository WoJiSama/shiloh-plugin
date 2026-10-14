import puppeteer from 'puppeteer'
import {createWebParserTool} from '../../dist/backend/modules/toolSupport/infrastructure/webParserTool.js'
import {sendLongTaskOpening} from '../../utils/longTaskFeedbackPolicy.js'
export const WebParserTool=createWebParserTool({browser:puppeteer,sendLongTaskOpening,image:bytes=>globalThis.segment.image(Buffer.from(bytes))})
