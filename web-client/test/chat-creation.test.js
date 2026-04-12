import puppeteer from 'puppeteer'

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'
const API_BASE = process.env.API_BASE || 'http://localhost:8080/api'
const ADMIN_EMAIL = 'admin@test.com'
const ALICE_EMAIL = 'alice@test.com'
const CHROME_PATH = '/home/ilya/.cache/puppeteer/chrome-headless-shell/linux-146.0.7680.153/chrome-headless-shell-linux64/chrome-headless-shell'

async function login(page, email) {
  const codeRes = await fetch(`${API_BASE}/auth/request-code`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  const codeData = await codeRes.json()
  const devCode = codeData.dev_code
  console.log(`   ✅ Dev code: ${devCode}`)

  await page.waitForSelector('input[type="email"]', { timeout: 5000 })
  await page.type('input[type="email"]', email)
  await page.click('button')
  console.log('   ✅ Email submitted')

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
  console.log('🧪 Chat Creation & User Search Test')

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--single-process'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })

  try {
    // Clear and login
    console.log('\n1️⃣  Clearing IndexedDB & logging in as admin...')
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle0', timeout: 15000 })
    await page.evaluate(() => indexedDB.deleteDatabase('fast-chat-db'))
    await page.reload({ waitUntil: 'networkidle0', timeout: 15000 })
    await login(page, ADMIN_EMAIL)

    // Test 1: Check for "new chat" button
    console.log('\n2️⃣  Checking for New Chat button...')
    const newChatBtn = await page.$('[title*="New"], [title*="new"], [aria-label*="New"], .mdi-plus')
    if (!newChatBtn) {
      // Check sidebar for any buttons
      const drawerBtns = await page.$$('.v-navigation-drawer .v-btn, .v-list .v-btn')
      console.log(`   Found ${drawerBtns.length} buttons in drawer`)
      for (let i = 0; i < drawerBtns.length; i++) {
        const title = await drawerBtns[i].evaluate(el => el.getAttribute('title') || el.getAttribute('aria-label'))
        console.log(`     Drawer button ${i}: ${title || '(no title)'}`)
      }
    }
    
    // Take screenshot of sidebar
    const drawerEl = await page.$('.v-navigation-drawer')
    if (drawerEl) {
      await drawerEl.screenshot({ path: '/tmp/sidebar.png' })
      console.log('   📸 Sidebar screenshot: /tmp/sidebar.png')
    }
    
    // Test 2: Click new chat button (if exists)
    if (newChatBtn) {
      console.log('   ✅ New Chat button found')
      await newChatBtn.click()
      await new Promise(r => setTimeout(r, 1000))
      
      // Check if dialog appeared
      console.log('\n3️⃣  Checking for user search dialog...')
      const dialogTitle = await page.evaluate(() => {
        const el = document.querySelector('.v-dialog .text-h6, .v-dialog .text-h5')
        return el?.textContent
      })
      console.log(`   Dialog title: "${dialogTitle}"`)
      
      // Check for search input in dialog
      const searchInput = await page.$('.v-dialog input, .v-dialog [type="text"]')
      if (searchInput) {
        console.log('   ✅ Search input found in dialog')
        // Try searching for alice
        await searchInput.type('alice', { delay: 50 })
        await new Promise(r => setTimeout(r, 1500))
        // Check if user appears
        const searchResults = await page.evaluate(() => {
          const items = document.querySelectorAll('.v-list-item .v-list-item-title')
          return Array.from(items).map(el => el.textContent)
        })
        console.log(`   Search results: ${searchResults.join(', ') || '(none)'}`)
      } else {
        console.log('   ⚠️  No search input in dialog')
      }
    } else {
      console.log('   ❌ No New Chat button found')
    }

    console.log('\n✅ Test completed')
  } catch (err) {
    console.error(`   ❌ Test failed: ${err.message}`)
    await page.screenshot({ path: '/tmp/chat-creation-test.png' })
  } finally {
    await browser.close()
  }
}

main()
