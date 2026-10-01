// Start frontend/fixtures/timed-wake/vite.config.mjs; no live browser or services.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const directory = resolve('.scratch/timed-wake/screenshots')
mkdirSync(directory, { recursive: true })
const config = resolve('.scratch/timed-wake/browser-config.json')
writeFileSync(config, '{}\n')
const checks = []
function browser(...args) {
  const result = JSON.parse(execFileSync('agent-browser', ['--config', config, '--session', 'timed-wake-impl', '--json', ...args], { encoding: 'utf8' }))
  if (!result.success) throw new Error(result.error)
  return result.data
}
const evaluate = code => browser('eval', '-b', Buffer.from(code).toString('base64')).result
const wait = code => browser('wait', '--fn', code)
function assert(code, label) { if (!evaluate(code)) throw new Error(label); checks.push(label); console.log('PASS', label) }
function screenshot(name) { evaluate('document.fonts.ready.then(() => new Promise(requestAnimationFrame))'); copyFileSync(browser('screenshot').path, `${directory}/${name}.png`) }
function reset(mode = 'list') {
  browser('open', 'http://127.0.0.1:5199')
  wait('Boolean(window.wakeFixture && document.querySelector("textarea"))')
  evaluate(`window.wakeFixture.mode(${JSON.stringify(mode)})`)
}
function drawer() { browser('click', '.companion-history-toggle'); wait('document.querySelector(".companion-history-drawer")?.getAnimations().every(a => a.playState === "finished")'); browser('click', '#companion-wakes-tab') }
function ready() { wait('document.querySelectorAll(".wake-row").length === 2') }
browser('set', 'viewport', '390', '844')
reset(); drawer(); ready(); browser('mouse', 'move', '380', '820'); screenshot('01-list')
browser('click', '.wake-expand'); wait('Boolean(document.querySelector(".wake-expanded"))'); screenshot('02-expanded')
assert('document.querySelector(".wake-expanded").scrollHeight === document.querySelector(".wake-expanded").clientHeight', 'Long reminder expands in place')
reset('empty'); drawer(); wait('document.body.innerText.includes("还没有唤醒安排")'); screenshot('03-empty')
assert('!document.querySelector(".wake-empty button")', 'Empty state contains no action')
reset('error'); drawer(); wait('Boolean(document.querySelector(".wake-retry"))'); screenshot('04-error')
evaluate('window.wakeFixture.mode("list", false)'); browser('click', '.wake-retry'); ready()
assert('window.wakeFixture.stats().sends === 0', 'Retry reloads without sending chat')
reset('loading'); drawer(); wait('document.body.innerText.includes("正在读取安排")'); screenshot('07-loading')
assert('!document.body.innerText.includes("还没有唤醒安排") && document.querySelectorAll(".wake-skeleton").length === 2', 'Loading shows static rows without empty flash')
evaluate('window.wakeFixture.release()'); ready()
reset('trigger'); wait('Boolean(document.querySelector(".companion-wake-source"))'); screenshot('05-trigger')
assert('document.querySelector(".companion-wake-source").parentElement.querySelectorAll(".outgoing").length === 0', 'Trigger source is not a human bubble')
browser('click', '.wake-source-toggle'); wait('Boolean(document.querySelector(".wake-source-content"))'); screenshot('06-source')
assert('document.querySelector(".wake-source-toggle").getAttribute("aria-expanded") === "true"', 'Source snapshot expands inline')
reset(); browser('fill', 'textarea', 'Synthetic retained draft'); drawer(); ready(); browser('click', '.companion-history-controls button'); wait('!document.querySelector(".companion-history-drawer")')
assert('document.querySelector("textarea").value === "Synthetic retained draft" && window.wakeFixture.stats().sends === 0', 'Closing drawer retains draft without autosend')
drawer(); ready(); const before = evaluate('window.wakeFixture.stats().reads'); evaluate('window.wakeFixture.reconnect()'); wait(`window.wakeFixture.stats().reads > ${before}`)
assert('document.querySelectorAll(".wake-row").length === 2', 'Reconnect refreshes current arrangements')
evaluate('window.wakeFixture.mode("stale")'); wait(`window.wakeFixture.stats().reads > ${before + 1}`); evaluate('window.wakeFixture.switchSession()'); wait('document.body.innerText.includes("还没有唤醒安排")'); evaluate('window.wakeFixture.release()')
assert('document.querySelectorAll(".wake-row").length === 0', 'Old response cannot contaminate switched session')
reset(); drawer(); ready(); browser('press', 'Escape'); wait('!document.querySelector(".companion-history-drawer")'); assert('document.activeElement.classList.contains("companion-history-toggle")', 'Escape closes and restores trigger focus')
drawer(); ready(); browser('set', 'viewport', '320', '568'); screenshot('narrow')
assert('document.documentElement.scrollWidth <= innerWidth', 'Narrow native viewport has no horizontal overflow')
evaluate('window.wakeFixture.dark()'); wait('document.documentElement.dataset.theme === "night-voyage"'); screenshot('dark')
browser('set', 'viewport', '1280', '900'); screenshot('desktop')
assert('document.querySelector(".companion-history-drawer").getBoundingClientRect().width <= 420', 'Desktop preserves existing drawer width')
writeFileSync(resolve('.scratch/timed-wake/ui-checks.json'), JSON.stringify({ commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), checks, screenshots: directory }, null, 2))
console.log(`${checks.length} UI checks passed`)
