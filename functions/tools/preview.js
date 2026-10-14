import puppeteer from 'puppeteer'
import {createPreviewRenderer} from '../../dist/backend/modules/rendering/infrastructure/preview.js'
const runtime=createPreviewRenderer({launch:options=>puppeteer.launch(options)})
export const extractAndRender=runtime.extractAndRender
export const extractCodeBlocks=runtime.extractCodeBlocks
