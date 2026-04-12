import puppeteer from 'puppeteer'
const CHROME_PATH = '/home/ilya/.cache/puppeteer/chrome-headless-shell/linux-146.0.7680.153/chrome-headless-shell-linux64/chrome-headless-shell'

const browser = await puppeteer.launch({ headless: true, executablePath: CHROME_PATH, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu','--single-process'] })
const page = await browser.newPage()
page.on('console', msg => console.log('PAGE:', msg.text()))
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0', timeout: 15000 })
await page.evaluate(() => indexedDB.deleteDatabase('fast-chat-db'))
await page.reload({ waitUntil: 'networkidle0', timeout: 15000 })

await page.waitForSelector('input[type="email"]', { timeout: 5000 })
await page.type('input[type="email"]', 'admin@test.com')
await page.click('button')

// Get dev code from page
await page.waitForFunction(() => document.querySelector('.v-alert strong') || document.querySelector('.v-otp-input input'), { timeout: 10000 })
const alertText = await page.$eval('.v-alert', el => el.textContent).catch(() => '')
const match = alertText.match(/(\d{6})/)
const devCode = match ? match[1] : ''
console.log('Dev code:', devCode)

await page.waitForSelector('.v-otp-input input', { timeout: 5000 })
const inputs = await page.$$('input[type="text"]')
for (let i = 0; i < devCode.length && i < inputs.length; i++) await inputs[i].type(devCode[i], {delay:30})
await new Promise(r => setTimeout(r, 3000))
console.log('URL:', page.url())

// Search for alice
console.log('--- Searching for alice ---')
const searchInput = await page.$('input[placeholder*="Search"]')
if (searchInput) {
  await searchInput.click({ clickCount: 3 })
  await searchInput.type('alice', { delay: 80 })
  await new Promise(r => setTimeout(r, 3000))
  const titles = await page.evaluate(() => Array.from(document.querySelectorAll('.v-list-item-title')).map(el => el.textContent))
  console.log('Titles:', titles)
  const subheaders = await page.evaluate(() => Array.from(document.querySelectorAll('.v-list-subheader')).map(el => el.textContent))
  console.log('Subheaders:', subheaders)
}

await browser.close()
