import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import ModrinthCard from '../model/ModrinthCard.js'
import {createModrinthCardRenderer} from '../dist/backend/modules/media/infrastructure/ModrinthCardRenderer.js'
export const {prewarmModrinthCardRenderer,renderModrinthCard}=createModrinthCardRenderer(puppeteer,ModrinthCard)
