import puppeteer from 'puppeteer'
import {createSharedBrowser} from '../dist/backend/modules/shared/infrastructure/sharedBrowser.js'
const runtime=createSharedBrowser(()=>puppeteer.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']}))
export const getSharedBrowser=runtime.getSharedBrowser
export const scheduleSharedBrowserClose=runtime.scheduleSharedBrowserClose
