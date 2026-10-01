// Requires the two isolated services documented in docs/voice-input.md and agent-browser.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const session = 'lamplit-voice-click-fixture'
const workerOrigin = `http://127.0.0.1:${process.env.VOICE_FIXTURE_PORT || 8898}`
const uiOrigin = `http://127.0.0.1:${process.env.VOICE_UI_PORT || 5198}`
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
async function config(update) { await fetch(`${workerOrigin}/__fixture/state`, { method: 'POST', body: JSON.stringify(update) }) }
async function calls() { return (await (await fetch(`${workerOrigin}/__fixture/state`)).json()).calls }
function screenshot(name) { evaluate('document.fonts.ready.then(() => new Promise(requestAnimationFrame))'); copyFileSync(browser('screenshot').path, `${directory}/${name}.png`) }
function click(label) { browser('click', `button[aria-label="${label}"]`) }
function wait(code) { browser('wait', '--fn', code) }
function reset() { browser('open', uiOrigin); wait('Boolean(window.voiceFixture && document.querySelector("textarea"))') }
function start() { click('开始录音'); wait('document.querySelector("[data-testid=voice-record]").dataset.state === "recording"') }
function stop() { click('结束录音') }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function take() { start(); await delay(120); stop(); wait('!document.querySelector("textarea").readOnly') }
await config({ enabled: true, status: 200, delayMs: 0, calls: 0, text: '下午三点' })
reset(); browser('set', 'viewport', '390', '844'); screenshot('click-idle'); start(); screenshot('click-recording')
assert('window.voiceFixture.starts === 1 && document.querySelector("textarea").readOnly', 'One click starts recording and locks editing')
await delay(120); stop(); wait('document.querySelector("textarea").value === "下午三点"'); screenshot('click-draft')
assert('window.voiceFixture.sends.length === 0 && window.voiceFixture.tracks === 1', 'Second click recognizes into draft and releases capture without sending')
await take()
assert('document.querySelector("textarea").value === "下午三点下午三点" && window.voiceFixture.starts === 2', 'Another take inserts at restored cursor')
reset(); browser('fill', 'textarea', '我们明天去公园'); evaluate('document.querySelector("textarea").setSelectionRange(4,4)'); start()
assert('document.querySelector("button[aria-label=发送消息]").disabled', 'Existing draft cannot send during recording')
await delay(120); stop(); wait('document.querySelector("textarea").value === "我们明天下午三点去公园"')
assert('document.querySelector("textarea").selectionStart === 8 && window.voiceFixture.sends.length === 0', 'Recognition inserts at cursor and places caret after insertion')
evaluate('document.querySelector("textarea").setSelectionRange(4,8)'); await config({text:'晚上八点'}); await take()
assert('document.querySelector("textarea").value === "我们明天晚上八点去公园"', 'Selected text is replaced, surrounding text preserved')
screenshot('click-existing-text'); click('发送消息')
assert('window.voiceFixture.sends[0].text === "我们明天晚上八点去公园"', 'Explicit send uses completed draft')
reset(); browser('fill', 'textarea', '保留草稿'); start(); click('取消录音'); wait('!document.querySelector("textarea").readOnly')
assert('document.querySelector("textarea").value === "保留草稿" && window.voiceFixture.sends.length === 0', 'Cancellation preserves draft')
const beforePermission = await calls(); reset(); evaluate('window.voiceFixture.grantDelay = 600'); click('开始录音'); click('取消录音'); await delay(750)
assert('window.voiceFixture.starts === 0 && window.voiceFixture.tracks === 1', 'Cancel during permission prevents late capture and releases tracks')
if(await calls() !== beforePermission) throw Error('Cancelled permission submitted audio')
reset(); evaluate('window.voiceFixture.denied = true'); click('开始录音'); wait('document.body.textContent.includes("麦克风权限被拒绝")')
assert('!document.querySelector("textarea").readOnly', 'Permission denial restores editable text')
await config({status:429}); reset(); browser('fill','textarea','原文'); await take()
assert('document.querySelector("textarea").value === "原文" && window.voiceFixture.sends.length === 0', 'Recognition failure preserves existing text')
await config({status:200,delayMs:900}); reset(); browser('fill','textarea','原文'); start(); await delay(120); stop(); wait('document.querySelector("[data-testid=voice-record]").dataset.state === "transcribing"'); screenshot('click-recognizing'); click('取消录音'); await delay(1100)
assert('document.querySelector("textarea").value === "原文" && !document.querySelector("textarea").readOnly', 'Recognition cancellation discards late result')
reset(); start(); evaluate('window.voiceFixture.switchSession()'); await delay(100)
assert('window.voiceFixture.tracks === 1 && window.voiceFixture.sends.length === 0', 'Session change releases capture')
reset(); start(); evaluate('window.voiceFixture.capability(false)'); await delay(100)
assert('window.voiceFixture.tracks === 1 && !document.querySelector("textarea").readOnly', 'Capability loss cancels capture')
reset(); evaluate('window.voiceFixture.running(true)'); await delay(80)
assert('!document.querySelector("[data-testid=voice-record]")', 'Running model retains stop instead of starting capture')
await config({delayMs:0}); reset(); evaluate('document.querySelector("[data-testid=voice-record]").focus()'); browser('press','Enter'); wait('window.voiceFixture.starts === 1'); await delay(120); browser('press','Enter'); wait('document.querySelector("textarea").value.length > 0')
assert('window.voiceFixture.starts === 1 && window.voiceFixture.sends.length === 0', 'Native keyboard activation starts and stops once')
reset(); start(); browser('press','Escape'); wait('!document.querySelector("textarea").readOnly')
assert('window.voiceFixture.tracks === 1', 'Escape cancels recording')
reset(); browser('fill','textarea','附件草稿'); evaluate(`(() => { const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='), c=>c.charCodeAt(0)); const transfer=new DataTransfer(); transfer.items.add(new File([bytes],'fixture.png',{type:'image/png'})); const input=document.querySelector('input.companion-image-input'); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()`); wait('Boolean(document.querySelector(".companion-image-draft"))'); await take()
assert('Boolean(document.querySelector(".companion-image-draft")) && window.voiceFixture.sends.length === 0', 'Dictation retains pending attachment')
browser('set','viewport','320','568'); screenshot('click-narrow')
assert('document.documentElement.scrollWidth <= innerWidth && document.querySelector("[data-testid=voice-record]").getBoundingClientRect().bottom <= innerHeight', 'Narrow controls remain visible without horizontal overflow')
start(); screenshot('click-narrow-recording')
assert('document.documentElement.scrollWidth <= innerWidth && document.querySelector("[data-testid=voice-record]").getBoundingClientRect().right <= innerWidth', 'Narrow recording with draft keeps stop accessible')
click('取消录音')
evaluate('window.voiceFixture.dark()'); await delay(80); screenshot('click-dark')
// Voice must not change drafts through command completion or stale recovery offsets.
await config({delayMs:2000,text:'VOICE'}); reset(); browser('fill','textarea','/co'); start()
assert('document.querySelector("#companion-command-compact").disabled', 'Command completion is disabled during capture')
evaluate('document.querySelector("textarea").focus()'); browser('press','Tab'); evaluate('document.querySelector("textarea").focus()'); browser('press','Enter'); evaluate('document.querySelector("#companion-command-compact").click()')
assert('document.querySelector("textarea").value === "/co" && window.voiceFixture.sends.length === 0', 'Tab, Enter and suggestion cannot change locked capture draft')
click('取消录音'); assert('document.querySelector("textarea").value === "/co"', 'Cancel preserves command draft')
start(); await delay(120); stop(); wait('document.querySelector("[data-testid=voice-record]").dataset.state === "transcribing"')
evaluate('document.querySelector("textarea").focus()'); browser('press','Tab')
assert('document.querySelector("textarea").value === "/co" && document.querySelector("#companion-command-compact").disabled', 'Command completion remains blocked during recognition')
click('取消录音')
reset(); browser('fill','textarea','abcdef'); evaluate('document.querySelector("textarea").setSelectionRange(3,3)'); start(); await delay(120); stop(); wait('document.querySelector("[data-testid=voice-record]").dataset.state === "transcribing"')
evaluate('window.voiceFixture.recover("RESTORED")'); wait('document.querySelector("textarea").value === "RESTORED\\nabcdef"'); wait('!document.querySelector("textarea").readOnly')
assert('document.querySelector("textarea").value === "RESTORED\\nabcdef" && document.body.textContent.includes("草稿已修改") && window.voiceFixture.sends.length === 0', 'Recovered text stays intact and late recognition is discarded with feedback')
await config({delayMs:0})
writeFileSync(resolve('.scratch/voice-input/click-ui-checks.json'), JSON.stringify(checks,null,2)+'\n')
browser('close')
