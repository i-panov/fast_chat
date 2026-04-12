import puppeteer from 'puppeteer'

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'
const API_BASE = process.env.API_BASE || 'http://localhost:8080/api'
const TEST_EMAIL = 'admin@test.com'
const CHROME_PATH = '/home/ilya/.cache/puppeteer/chrome-headless-shell/linux-146.0.7680.153/chrome-headless-shell-linux64/chrome-headless-shell'

async function main() {
  console.log('🧪 Web Client Login Test')
  console.log(`   App: ${BASE_URL}`)
  console.log(`   API: ${API_BASE}`)

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--single-process'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })

  try {
    // Clear IndexedDB and open login page
    console.log('\n1️⃣  Opening login page...')
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle0', timeout: 15000 })
    await page.evaluate(() => indexedDB.deleteDatabase('fast-chat-db'))
    await page.reload({ waitUntil: 'networkidle0', timeout: 15000 })
    console.log('   ✅ Login page loaded')

    // Step 2: Enter email and request code
    console.log('\n2️⃣  Entering email and requesting code...')
    await page.waitForSelector('input[type="email"]', { timeout: 5000 })
    await page.type('input[type="email"]', TEST_EMAIL)
    await page.click('button')
    console.log('   ✅ Email submitted, waiting for code...')

    // Step 3: Wait for dev code to appear on screen
    console.log('\n3️⃣  Waiting for dev code to appear...')
    await page.waitForSelector('strong', { timeout: 10000 })
    const devCodeEl = await page.$('v-alert strong, .v-alert strong')
    let devCode = ''
    if (devCodeEl) {
      devCode = await devCodeEl.evaluate(el => el.textContent.trim())
    }
    if (!devCode || devCode.length !== 6) {
      // Try alternative selector
      const alertText = await page.$eval('.v-alert', el => el.textContent).catch(() => '')
      const match = alertText.match(/(\d{6})/)
      if (match) devCode = match[1]
    }
    if (!devCode) {
      console.error('   ❌ Could not find dev code on page')
      await page.screenshot({ path: '/tmp/login-failure.png' })
      process.exit(1)
    }
    console.log(`   ✅ Dev code found: ${devCode}`)

    // Step 4: Wait for code input to appear
    console.log('\n4️⃣  Waiting for code input...')
    await page.waitForSelector('input[placeholder*="digit"], input[aria-label*="digit"], .v-otp-input input', { timeout: 10000 })
    console.log('   ✅ Code input found')

    // Step 5: Enter dev code
    console.log(`\n5️⃣  Entering code: ${devCode}`)
    const digitInputs = await page.$$('input[type="text"]')
    for (let i = 0; i < devCode.length && i < digitInputs.length; i++) {
      await digitInputs[i].type(devCode[i], { delay: 30 })
    }

    // Step 6: Wait for redirect
    console.log('\n6️⃣  Waiting for result...')
    await new Promise(r => setTimeout(r, 3000))

    const url = page.url()
    const errorText = await page.$eval('.v-alert--type-error', el => el.textContent).catch(() => null)

    if (errorText) {
      console.error(`   ❌ Login failed: ${errorText}`)
      await page.screenshot({ path: '/tmp/login-failure.png' })
      process.exit(1)
    }

    if (url.includes('/chat')) {
      console.log(`   ✅ Login successful — redirected to /chat`)
    } else {
      console.error(`   ❌ No redirect — still at: ${url}`)
      await page.screenshot({ path: '/tmp/login-failure.png' })
      process.exit(1)
    }

    console.log('\n✅ All tests passed!')
  } catch (err) {
    console.error(`   ❌ Test failed: ${err.message}`)
    await page.screenshot({ path: '/tmp/login-failure.png' })
    process.exit(1)
  } finally {
    await browser.close()
  }
}

main()
