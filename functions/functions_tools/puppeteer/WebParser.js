import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import {executablePath} from 'puppeteer'
import {createWebParser} from '../../../dist/backend/modules/media/infrastructure/WebParser.js'
puppeteer.use(StealthPlugin())
export default createWebParser(puppeteer,executablePath)
