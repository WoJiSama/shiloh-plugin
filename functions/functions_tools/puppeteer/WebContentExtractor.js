import puppeteer from 'puppeteer'
import {createPuppeteerToText} from '../../../dist/backend/modules/media/infrastructure/WebContentExtractor.js'
export const PuppeteerToText=createPuppeteerToText(puppeteer)
