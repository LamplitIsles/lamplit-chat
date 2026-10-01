// Requires the two isolated services documented in docs/voice-input.md and agent-browser.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const session = 'lamplit-voice-fixture'
const directory = resolve('.scratch/voice-input/screenshots')
mkdirSync(directory, { recursive: true })
const browserConfig = resolve('.scratch/voice-input/browser-config.json')
writeFileSync(browserConfig, '{}\n')
const checks = []
function browser(...args) {
  const output = execFileSync('agent-browser', ['--config', browserConfig, '--session', session, '--json', ...args], { encoding: 'utf8' })
  const response = JSON.parse(output)
  if (!response.success) throw new Error(response.error)
  return response.data
}
function evaluate(code) { return browser('eval', '-b', Buffer.from(code).toString('base64')).result }
function assert(code, label) { if (!evaluate(code)) throw new Error(label); checks.push(label); console.log('PASS', label) }
async function config(update) { await fetch('http://127.0.0.1:8898/__fixture/state', { method: 'POST', body: JSON.stringify(update) }) }
async function calls() { return (await (await fetch('http://127.0.0.1:8898/__fixture/state')).json()).calls }
function screenshot(name) { evaluate('document.fonts.ready.then(() => new Promise(requestAnimationFrame))'); copyFileSync(browser('screenshot').path, `${directory}/${name}.png`) }
function click(label) { browser('click', `button[aria-label="${label}"]`) }
function wait(code) { browser('wait', '--fn', code) }
function reset() { browser('open', 'http://127.0.0.1:5198'); wait('Boolean(window.voiceFixture && document.querySelector("textarea"))') }
function mode() { click('切换语音输入'); wait('Boolean(document.querySelector("[data-testid=voice-hold]"))') }
function down() {
  const point = evaluate('(() => { const r=document.querySelector("[data-testid=voice-hold]").getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2] })()')
  browser('mouse', 'move', ...point.map(value => String(Math.round(value)))); browser('mouse', 'down')
  return point
}
function up() { browser('mouse', 'up') }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
await config({ enabled: true, status: 200, delayMs: 1600, calls: 0 })
reset(); browser('set', 'viewport', '390', '844'); screenshot('10'); mode(); browser('mouse', 'move', '195', '500'); screenshot('11')
assert('window.voiceFixture.starts === 0', 'Tap mic switches mode without recording')
down(); wait('document.querySelector("[data-testid=voice-hold]").dataset.state === "recording"'); await delay(6100); screenshot('12'); up(); wait('document.querySelector("[data-testid=voice-hold]").dataset.state === "transcribing"'); screenshot('13')
assert('window.voiceFixture.sends.length === 0 && window.voiceFixture.tracks === 1', 'Release submits recognition once and releases all fixture tracks')
wait('document.querySelector("textarea")?.value === "明天我们一起去散步吧。"'); screenshot('14')
assert('window.voiceFixture.sends.length === 0', 'Transcript is editable draft without autosend')
browser('fill', 'textarea', 'Edited synthetic draft'); click('发送消息')
assert('window.voiceFixture.sends.length === 1 && window.voiceFixture.sends[0].text === "Edited synthetic draft"', 'Explicit normal text send uses edited draft')
await config({ status: 429, delayMs: 0 }); reset(); mode(); down(); await delay(120); up(); wait('document.body.textContent.includes("识别失败 · 按住重试")'); screenshot('15')
assert('window.voiceFixture.sends.length === 0', 'Failure retains draft and offers retry/text mode')
await config({ status: 200 }); down(); await delay(120); up(); wait('document.querySelector("textarea")?.value.length > 0')
assert('window.voiceFixture.sends.length === 0', 'Retry succeeds into draft')
reset(); mode(); const beforeCancel = await calls(); const point=down(); await delay(120); browser('mouse', 'move', String(point[0]), String(Math.round(point[1]-65))); up(); wait('document.body.textContent.includes("已取消 · 按住说话")'); screenshot('16')
if (await calls() !== beforeCancel) throw new Error('Upward cancellation submitted provider request')
checks.push('60px upward cancellation makes zero provider requests'); console.log('PASS', checks.at(-1))
assert('window.voiceFixture.tracks === 1 && window.voiceFixture.sends.length === 0', 'Upward cancellation releases media and never sends')
reset(); mode(); evaluate('window.voiceFixture.grantDelay = 600'); const permissionCalls=await calls(); down(); up(); await delay(750)
assert('window.voiceFixture.starts === 0 && window.voiceFixture.tracks === 1', 'Release while permission pending never starts late recorder')
if (await calls() !== permissionCalls) throw new Error('Permission race submitted provider request')
reset(); mode(); evaluate('window.voiceFixture.denied = true'); down(); await delay(120); up(); wait('document.body.textContent.includes("麦克风权限被拒绝")')
assert('window.voiceFixture.starts === 0', 'Permission denial is recoverable without capture')
await config({ delayMs: 1600 }); reset(); mode(); down(); await delay(120); up(); wait('document.querySelector("[data-testid=voice-hold]").dataset.state === "transcribing"'); click('取消录音'); await delay(1800)
assert('!document.querySelector("textarea") && window.voiceFixture.sends.length === 0', 'Recognition cancellation discards late response')
reset(); mode(); down(); await delay(120); up(); wait('document.querySelector("[data-testid=voice-hold]").dataset.state === "transcribing"'); evaluate('window.voiceFixture.switchSession()'); await delay(1800)
assert('document.querySelector("textarea").value === "" && window.voiceFixture.sends.length === 0', 'Session switch aborts and cannot receive old transcript')
reset(); mode(); down(); await delay(120); up(); wait('document.querySelector("[data-testid=voice-hold]").dataset.state === "transcribing"'); evaluate('window.voiceFixture.recover("New recovered draft")'); await delay(1800)
assert('document.querySelector("textarea").value === "New recovered draft" && document.body.textContent.includes("识别结果已丢弃")', 'Changed draft survives stale transcription')
reset(); mode(); down(); await delay(120); evaluate('window.dispatchEvent(new PopStateEvent("popstate"))'); up()
assert('window.voiceFixture.tracks === 1 && document.body.textContent.includes("已取消")', 'Browser back lifecycle cancels active capture')
reset(); mode(); down(); await delay(120); evaluate('Object.defineProperty(document,"hidden",{configurable:true,value:true}); document.dispatchEvent(new Event("visibilitychange"))'); up()
assert('window.voiceFixture.tracks === 1 && window.voiceFixture.sends.length === 0', 'Tab hide releases capture')
// DOM keyboard events exercise the hold lifecycle, including key repeat, without click-to-toggle.
await config({ delayMs: 0 }); reset(); mode(); evaluate('document.querySelector("[data-testid=voice-hold]").dispatchEvent(new KeyboardEvent("keydown",{key:" ",bubbles:true}))'); await delay(120)
evaluate('document.querySelector("[data-testid=voice-hold]").dispatchEvent(new KeyboardEvent("keydown",{key:" ",repeat:true,bubbles:true})); document.querySelector("[data-testid=voice-hold]").dispatchEvent(new KeyboardEvent("keyup",{key:" ",bubbles:true}))'); wait('document.querySelector("textarea")?.value.length > 0')
assert('window.voiceFixture.starts === 1 && window.voiceFixture.sends.length === 0', 'Space hold/release and repeat guard recognize once')
reset(); mode(); evaluate('window.voiceFixture.running(true)'); await delay(80)
assert('document.querySelector("[data-testid=voice-hold]").disabled', 'Busy gate prevents new recording')
reset(); evaluate('window.voiceFixture.capability(false)'); await delay(80); click('切换语音输入')
assert('Boolean(document.querySelector("textarea")) && Array.from(document.links).some(a => a.getAttribute("href") === "/settings#voice")', 'Disabled capability stays text with configuration link')
reset(); mode(); evaluate('window.voiceFixture.recover("Retained draft")'); evaluate(`(() => { const transfer=new DataTransfer(); transfer.items.add(new File([Uint8Array.of(1)],'fixture.png',{type:'image/png'})); const input=document.querySelector('input.companion-image-input'); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()`); wait('Boolean(document.querySelector(".companion-image-draft"))'); evaluate('window.voiceFixture.capability(false)'); wait('Boolean(document.querySelector("textarea"))')
assert('document.querySelector("textarea").value === "Retained draft" && Boolean(document.querySelector(".companion-image-draft")) && !document.querySelector("[data-testid=voice-hold]") && window.voiceFixture.sends.length === 0', 'Capability loss from voice idle returns to text preserving draft and attachment')
const lossCalls = await calls(); reset(); mode(); down(); wait('window.voiceFixture.starts === 1'); evaluate('window.voiceFixture.capability(false)'); up(); wait('Boolean(document.querySelector("textarea"))')
assert('window.voiceFixture.tracks === 1 && document.querySelector("textarea").value === "" && window.voiceFixture.sends.length === 0', 'Capability loss during recording releases tracks and returns to text')
reset(); mode(); evaluate('window.voiceFixture.grantDelay = 600'); down(); evaluate('window.voiceFixture.capability(false)'); up(); await delay(750)
assert('document.querySelector("textarea").value === "" && window.voiceFixture.starts === 0 && window.voiceFixture.tracks === 1', 'Capability loss while permission pending prevents late recording and releases tracks')
if (await calls() !== lossCalls) throw new Error('Capability loss submitted cancelled capture')
await config({ delayMs: 1600 }); reset(); mode(); down(); await delay(120); up(); wait('document.querySelector("[data-testid=voice-hold]").dataset.state === "transcribing"'); evaluate('window.voiceFixture.capability(false)'); await delay(1800)
assert('document.querySelector("textarea").value === "" && window.voiceFixture.tracks === 1 && window.voiceFixture.sends.length === 0', 'Capability loss during recognition discards stale transcript and restores text')
await config({ delayMs: 0 })
// A fixture-owned PNG passes through the actual attachment intake.
reset(); mode(); evaluate(`(() => { const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='), c=>c.charCodeAt(0)); const transfer=new DataTransfer(); transfer.items.add(new File([bytes],'fixture.png',{type:'image/png'})); const input=document.querySelector('input.companion-image-input'); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()`); wait('Boolean(document.querySelector(".companion-image-draft"))'); down(); await delay(120); up(); wait('document.querySelector("textarea")?.value.length > 0')
assert('Boolean(document.querySelector(".companion-image-draft")) && window.voiceFixture.sends.length === 0', 'Voice draft preserves pending attachment')
click('发送消息'); assert('window.voiceFixture.sends[0].images === 1', 'Explicit send includes retained attachment')
reset(); evaluate(`(() => { const transfer=new DataTransfer(); transfer.items.add(new File([Uint8Array.of(1)],'fixture.png',{type:'image/png'})); const input=document.querySelector('input.companion-image-input'); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()`); wait('Boolean(document.querySelector(".companion-image-draft"))'); click('发送消息'); assert('window.voiceFixture.sends[0].images === 1 && window.voiceFixture.sends[0].text === ""', 'Image-only normal send remains available')
reset(); mode(); browser('set', 'viewport', '320', '568'); screenshot('narrow-short')
assert('document.documentElement.scrollWidth <= innerWidth && document.querySelector("[data-testid=voice-hold]").getBoundingClientRect().bottom <= innerHeight', 'Narrow/short layout retains visible controls without horizontal overflow')
evaluate('window.voiceFixture.dark()'); await delay(80); screenshot('dark')
assert('document.documentElement.dataset.theme === "night-voyage"', 'Dark theme uses existing tokens')
writeFileSync(resolve('.scratch/voice-input/ui-checks.json'), JSON.stringify({ checks, screenshots: directory }, null, 2))
console.log(`${checks.length} UI checks passed`)
