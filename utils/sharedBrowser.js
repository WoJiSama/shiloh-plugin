import puppeteer from "puppeteer"

const SHARED_BROWSER_IDLE_MS = 10 * 60_000
const PUPPETEER_LAUNCH_OPTIONS = {
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu"
  ]
}

let sharedBrowserPromise = null
let sharedBrowserIdleTimer = null

function clearSharedBrowserIdleTimer() {
  if (!sharedBrowserIdleTimer) return
  clearTimeout(sharedBrowserIdleTimer)
  sharedBrowserIdleTimer = null
}

export async function getSharedBrowser() {
  clearSharedBrowserIdleTimer()
  if (!sharedBrowserPromise) {
    sharedBrowserPromise = puppeteer.launch(PUPPETEER_LAUNCH_OPTIONS)
      .then(browser => {
        browser.on?.("disconnected", () => {
          if (sharedBrowserPromise) sharedBrowserPromise = null
        })
        return browser
      })
      .catch(error => {
        sharedBrowserPromise = null
        throw error
      })
  }

  const browser = await sharedBrowserPromise
  if (!browser?.isConnected?.()) {
    sharedBrowserPromise = null
    return await getSharedBrowser()
  }
  return browser
}

export function scheduleSharedBrowserClose() {
  clearSharedBrowserIdleTimer()
  sharedBrowserIdleTimer = setTimeout(async () => {
    const browserPromise = sharedBrowserPromise
    sharedBrowserPromise = null
    sharedBrowserIdleTimer = null
    try {
      const browser = await browserPromise
      if (browser?.isConnected?.()) await browser.close()
    } catch {}
  }, SHARED_BROWSER_IDLE_MS)
  sharedBrowserIdleTimer.unref?.()
}
