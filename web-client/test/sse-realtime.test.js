import puppeteer from 'puppeteer'

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'
const API_BASE = process.env.API_BASE || 'http://localhost:8080/api'
const CHROME_PATH = '/home/ilya/.cache/puppeteer/chrome-headless-shell/linux-146.0.7680.153/chrome-headless-shell-linux64/chrome-headless-shell'

async function login(browser, email) {
  const page = await browser.newPage()
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle0', timeout: 15000 })

  await page.waitForSelector('input[type="email"]', { timeout: 5000 })
  await page.type('input[type="email"]', email)
  await page.click('button')

  await page.waitForFunction(
    () => {
      const alert = document.querySelector('.v-alert')
      if (!alert) return false
      return /\d{6}/.test(alert.textContent)
    },
    { timeout: 10000 }
  )

  const alertText = await page.$eval('.v-alert', el => el.textContent).catch(() => '')
  const match = alertText.match(/(\d{6})/)
  if (!match) throw new Error(`No dev code found`)
  const devCode = match[1]
  console.log(`   ${email} dev code: ${devCode}`)

  await page.waitForSelector('.v-otp-input input, input[placeholder*="digit"]', { timeout: 10000 })
  const inputs = await page.$$('input[type="text"]')
  for (let i = 0; i < devCode.length && i < inputs.length; i++) {
    await inputs[i].type(devCode[i], { delay: 30 })
  }
  await new Promise(r => setTimeout(r, 3000))

  await page.waitForSelector('.v-navigation-drawer', { timeout: 10000 })
  await new Promise(r => setTimeout(r, 2000))

  return page
}

async function main() {
  console.log('🧪 SSE Real-Time Message Delivery Test')
  console.log('   (Two separate browser instances for complete isolation)')

  // Launch TWO SEPARATE browsers for complete cookie isolation
  const adminBrowser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const aliceBrowser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    // Login
    console.log('\n1️⃣  Logging in as admin...')
    const adminPage = await login(adminBrowser, 'admin@test.com')
    console.log('   ✅ Admin logged in')

    console.log('\n2️⃣  Logging in as alice...')
    const alicePage = await login(aliceBrowser, 'alice@test.com')
    console.log('   ✅ Alice logged in')

    // Admin creates chat with alice
    console.log('\n3️⃣  Admin creates chat with alice...')
    const searchInput = await adminPage.$('input[placeholder*="Search"]')
    if (searchInput) {
      await searchInput.click({ clickCount: 3 })
      await searchInput.type('alice', { delay: 50 })
      await new Promise(r => setTimeout(r, 2000))

      const userItem = await adminPage.evaluateHandle((name) => {
        const titles = Array.from(document.querySelectorAll('.v-list-item-title'))
        return titles.find(el => el.textContent.toLowerCase().includes(name.toLowerCase()))
      }, 'alice')

      if (userItem) await userItem.click()
      await new Promise(r => setTimeout(r, 2000))
    }
    console.log('   ✅ Chat created')

    // Alice waits for chat to appear
    console.log('\n4️⃣  Alice waits for chat to appear in sidebar...')
    await new Promise(r => setTimeout(r, 3000))

    const aliceChatItems = await alicePage.$$('.v-list-item')
    if (aliceChatItems.length > 0) {
      await aliceChatItems[0].click()
      await new Promise(r => setTimeout(r, 2000))
    }
    console.log('   ✅ Alice has chat open')

    // Count messages BEFORE admin sends
    const aliceMsgCountBefore = await alicePage.evaluate(() =>
      document.querySelectorAll('.text-body-2.text-break').length
    )
    console.log(`   Alice has ${aliceMsgCountBefore} messages before admin sends`)

    // Admin sends message
    console.log('\n5️⃣  Admin sends "SSE Test Message"...')
    const allInputs = await adminPage.$$('input[type="text"], textarea')
    const msgInput = allInputs[allInputs.length - 1]
    if (msgInput) {
      await msgInput.click({ clickCount: 3 })
      await msgInput.type('SSE Test Message', { delay: 30 })
      await new Promise(r => setTimeout(r, 300))
      const sendBtn = await adminPage.$('.mdi-send, [icon="mdi-send"], button[type="submit"]')
      if (sendBtn) await sendBtn.click()
    }
    await new Promise(r => setTimeout(r, 2000))
    console.log('   ✅ Message sent')

    // Check admin
    const adminMsgs = await adminPage.evaluate(() =>
      Array.from(document.querySelectorAll('.text-body-2.text-break')).map(el => el.textContent)
    )
    console.log(`   Admin sees: ${JSON.stringify(adminMsgs.slice(-3))}`)

    // THE CRITICAL TEST: alice receives WITHOUT reload
    console.log('\n6️⃣  Checking if alice received message in real-time (no reload)...')
    await new Promise(r => setTimeout(r, 3000))

    const aliceMsgsAfter = await alicePage.evaluate(() =>
      Array.from(document.querySelectorAll('.text-body-2.text-break')).map(el => el.textContent)
    )
    console.log(`   Alice now sees: ${JSON.stringify(aliceMsgsAfter.slice(-3))}`)

    const hasSseTest = aliceMsgsAfter.some(m => m.includes('SSE Test Message'))
    if (!hasSseTest) {
      console.log(`   ❌ Alice did NOT receive the message in real-time!`)
      await alicePage.screenshot({ path: '/tmp/sse-alice.png' })
      process.exit(1)
    }

    console.log(`   ✅ Alice received the message! (${aliceMsgCountBefore} → ${aliceMsgsAfter.length})`)

    console.log('\n✅ SSE Real-Time Message Delivery Test PASSED!')
  } catch (err) {
    console.error(`\n❌ Test failed: ${err.message}`)
    process.exit(1)
  } finally {
    await adminBrowser.close()
    await aliceBrowser.close()
  }
}

main()
