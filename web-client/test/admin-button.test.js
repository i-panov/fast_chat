import puppeteer from 'puppeteer'

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'
const API_BASE = process.env.API_BASE || 'http://localhost:8080/api'
const TEST_EMAIL = 'admin@test.com'
const CHROME_PATH = '/home/ilya/.cache/puppeteer/chrome-headless-shell/linux-146.0.7680.153/chrome-headless-shell-linux64/chrome-headless-shell'

async function login(page, email) {
  // Request code
  const codeRes = await fetch(`${API_BASE}/auth/request-code`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  const codeData = await codeRes.json()
  const devCode = codeData.dev_code
  console.log(`   ✅ Dev code: ${devCode}`)

  // Enter email
  await page.waitForSelector('input[type="email"]', { timeout: 5000 })
  await page.type('input[type="email"]', email)
  await page.click('button')
  console.log('   ✅ Email submitted')

  // Wait for code input
  await page.waitForSelector('input[placeholder*="digit"], input[aria-label*="digit"], .v-otp-input input', { timeout: 10000 })

  // Enter code
  const digitInputs = await page.$$('input[type="text"]')
  for (let i = 0; i < devCode.length && i < digitInputs.length; i++) {
    await digitInputs[i].type(devCode[i], { delay: 30 })
  }

  // Wait for redirect
  await new Promise(r => setTimeout(r, 3000))
  const url = page.url()
  if (!url.includes('/chat')) {
    throw new Error(`Login failed — still at: ${url}`)
  }
  console.log(`   ✅ Logged in, redirected to /chat`)
}

async function main() {
  console.log('🧪 Admin Panel Button + Chat Creation Test')

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--single-process'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })

  try {
    // Clear DB
    console.log('\n1️⃣  Clearing IndexedDB...')
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle0', timeout: 15000 })
    await page.evaluate(() => indexedDB.deleteDatabase('fast-chat-db'))
    await page.reload({ waitUntil: 'networkidle0', timeout: 15000 })

    // Login as admin
    console.log('\n2️⃣  Logging in as admin...')
    await login(page, 'admin@test.com')

    // Check admin button
    console.log('\n3️⃣  Checking for admin button...')
    
    // Check what's in appStore.user via API
    const meData = await page.evaluate(async () => {
      const res = await fetch('/api/auth/me')
      return res.json()
    })
    console.log(`   Server /api/auth/me: is_admin=${meData?.is_admin}`)
    
    // Check IndexedDB user
    const dbUser = await page.evaluate(async () => {
      return new Promise((resolve) => {
        const req = indexedDB.open('fast-chat-db')
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('auth', 'readonly')
          const store = tx.objectStore('auth')
          const getReq = store.get('current')
          getReq.onsuccess = () => resolve(getReq.result?.user)
          getReq.onerror = () => resolve(null)
        }
        req.onerror = () => resolve(null)
      })
    })
    console.log(`   IndexedDB user: is_admin=${dbUser?.is_admin}`)

    const adminBtn = await page.$('[title="Admin Panel"]') || await page.$('.mdi-shield-check')
    if (!adminBtn) {
      const btns = await page.$$('.v-btn')
      console.log(`   Found ${btns.length} buttons`)
      for (let i = 0; i < btns.length; i++) {
        const title = await btns[i].evaluate(el => el.getAttribute('title'))
        const icon = await btns[i].evaluate(el => el.querySelector('.mdi-shield-check')?.textContent)
        console.log(`     Button ${i}: title="${title}" shield_icon="${icon}"`)
      }
      console.log('   ❌ Admin button not found')
      await page.screenshot({ path: '/tmp/admin-button-test.png' })
    } else {
      console.log('   ✅ Admin button found')
    }

    // Check if we can navigate to /admin
    console.log('\n4️⃣  Testing /admin route...')
    await page.goto(`${BASE_URL}/admin`, { waitUntil: 'networkidle0', timeout: 15000 })
    const adminUrl = page.url()
    console.log(`   Page URL: ${adminUrl}`)
    if (adminUrl.includes('/login') || adminUrl.includes('/chat')) {
      console.log('   ❌ Redirected away from /admin')
    } else {
      console.log('   ✅ /admin page loaded')
    }

    // Check for create chat button
    console.log('\n5️⃣  Checking for create chat button...')
    await page.goto(`${BASE_URL}/chat`, { waitUntil: 'networkidle0', timeout: 15000 })
    const newChatBtn = await page.$('[title*="New"], [icon="mdi-plus"], .mdi-plus')
    if (!newChatBtn) {
      console.log('   ⚠️  No "New Chat" button found')
    } else {
      console.log('   ✅ New Chat button found')
    }

    console.log('\n✅ Test completed')
  } catch (err) {
    console.error(`   ❌ Test failed: ${err.message}`)
    await page.screenshot({ path: '/tmp/admin-button-test.png' })
  } finally {
    await browser.close()
  }
}

main()
