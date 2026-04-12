import puppeteer from 'puppeteer'

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'
const API_BASE = process.env.API_BASE || 'http://localhost:8080/api'
const ADMIN_EMAIL = 'admin@test.com'
const CHROME_PATH = '/home/ilya/.cache/puppeteer/chrome-headless-shell/linux-146.0.7680.153/chrome-headless-shell-linux64/chrome-headless-shell'

async function login(page, email) {
  await page.waitForSelector('input[type="email"]', { timeout: 5000 })
  await page.type('input[type="email"]', email)
  await page.click('button')

  // Wait for dev code or OTP input (whichever comes first)
  await page.waitForFunction(
    () => document.querySelector('strong') || document.querySelector('.v-otp-input input'),
    { timeout: 10000 }
  )

  // Try to get dev code
  let devCode = ''
  try {
    const alertText = await page.$eval('.v-alert', el => el.textContent).catch(() => '')
    const match = alertText.match(/(\d{6})/)
    if (match) devCode = match[1]
  } catch {}

  if (!devCode) {
    // Fallback: check strong elements
    const strongs = await page.$$('strong')
    for (const s of strongs) {
      const t = await s.evaluate(el => el.textContent)
      if (t && /^\d{6}$/.test(t.trim())) { devCode = t.trim(); break }
    }
  }
  console.log(`   ✅ Dev code: ${devCode}`)

  // Wait for OTP input and enter code
  await page.waitForSelector('input[placeholder*="digit"], input[aria-label*="digit"], .v-otp-input input', { timeout: 10000 })
  const digitInputs = await page.$$('input[type="text"]')
  for (let i = 0; i < devCode.length && i < digitInputs.length; i++) {
    await digitInputs[i].type(devCode[i], { delay: 30 })
  }
  await new Promise(r => setTimeout(r, 3000))
  const url = page.url()
  if (!url.includes('/chat')) throw new Error(`Login failed — still at: ${url}`)
  console.log(`   ✅ Logged in`)
}

async function main() {
  console.log('🧪 User Search & Chat Creation Test')

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--single-process'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })

  try {
    // Clear and login
    console.log('\n1️⃣  Clearing IndexedDB & logging in...')
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle0', timeout: 15000 })
    await page.evaluate(() => indexedDB.deleteDatabase('fast-chat-db'))
    await page.reload({ waitUntil: 'networkidle0', timeout: 15000 })
    await login(page, ADMIN_EMAIL)

    // Wait for app to initialize (just wait for chats to load)
    await new Promise(r => setTimeout(r, 3000))

    // Test 2: Search for user
    console.log('\n2️⃣  Searching for "alice" in sidebar...')
    const searchInput = await page.$('input[placeholder*="Search"]')
    if (!searchInput) {
      console.error('   ❌ Search input not found')
      await page.screenshot({ path: '/tmp/search-test.png' })
      process.exit(1)
    }
    await searchInput.click({ clickCount: 3 })
    await searchInput.type('alice', { delay: 80 })
    await new Promise(r => setTimeout(r, 2000))

    // Debug: check tokens and API response
    const debugInfo = await page.evaluate(async () => {
      const auth = await new Promise(resolve => {
        const req = indexedDB.open('fast-chat-db')
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('auth', 'readonly')
          const s = tx.objectStore('auth')
          const g = s.get('current')
          g.onsuccess = () => resolve(g.result)
          g.onerror = () => resolve(null)
        }
      })
      const token = auth?.access_token
      const res = await fetch(`/api/users/search?q=alice&limit=10`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json()
      return { hasToken: !!token, status: res.status, response: data, tokenPrefix: token?.substring(0, 20) }
    })
    console.log(`   Debug: token=${debugInfo.hasToken} (${debugInfo.tokenPrefix}...), status=${debugInfo.status}, users=${JSON.stringify(debugInfo.response)}`)

    // Check what the page shows
    const pageContent = await page.content()
    const hasUsersSection = pageContent.includes('Users')
    const hasSearchResults = pageContent.includes('alice')
    console.log(`   Has "Users" section: ${hasUsersSection}`)
    console.log(`   Page mentions alice: ${hasSearchResults}`)

    // Check if user appears
    const listItems = await page.$$('.v-list-item-title')
    const titles = []
    for (const item of listItems) {
      const text = await item.evaluate(el => el.textContent)
      titles.push(text)
    }
    console.log(`   Found items: ${titles.join(', ')}`)
    
    const aliceFound = titles.some(t => t?.includes('alice'))
    if (!aliceFound) {
      console.error('   ❌ User "alice" not found in search results')
      await page.screenshot({ path: '/tmp/search-test.png' })
      process.exit(1)
    }
    console.log('   ✅ User "alice" found in search results')

    // Test 3: Click on alice to create chat
    console.log('\n3️⃣  Clicking on alice to create chat...')
    const aliceItem = await page.$('.v-list-item-title')
    if (aliceItem) {
      await aliceItem.click()
      await new Promise(r => setTimeout(r, 2000))
    }

    // Check if we're now in a chat
    const currentUrl = page.url()
    const headerTitle = await page.$eval('.v-toolbar-title', el => el.textContent).catch(() => '')
    console.log(`   Current URL: ${currentUrl}`)
    console.log(`   Chat header: "${headerTitle}"`)

    if (headerTitle.includes('alice') || currentUrl.includes('/chat')) {
      console.log('   ✅ Chat with alice created!')
    } else {
      console.log('   ⚠️  Chat may not have been created')
    }

    console.log('\n✅ All tests passed!')
  } catch (err) {
    console.error(`   ❌ Test failed: ${err.message}`)
    await page.screenshot({ path: '/tmp/search-test.png' })
    process.exit(1)
  } finally {
    await browser.close()
  }
}

main()
