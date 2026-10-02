// Local actual-workerd acceptance. All assets, config and storage belong to the caller's fixture root.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(process.argv[2] ?? '.scratch/companion-panels/acceptance')
if (!root.startsWith(join(repo, '.scratch/companion-panels') + '/')) throw new Error('Fixture root must be inside this repo .scratch/companion-panels/')
mkdirSync(root, { recursive: true })
const handoff = join(repo, '../lamplit-app/.scratch/companion-panels/artifacts')
const identity = JSON.parse(readFileSync(join(handoff, 'identity.json')))
for (const [archive, expected] of [['lamplit-web-panels.tgz', identity.browserArchiveSHA256], ['lamplit-contracts-panels.tgz', identity.contractsArchiveSHA256]]) {
  if (!execFileSync('shasum', ['-a', '256', join(handoff, archive)], { encoding: 'utf8' }).startsWith(expected + ' ')) throw new Error('Artifact archive mismatch')
}
for (const [manifest, expected] of [['browser.sha256', identity.browserManifestSHA256], ['contracts.sha256', identity.contractsManifestSHA256]]) {
  if (!execFileSync('shasum', ['-a', '256', join(handoff, manifest)], { encoding: 'utf8' }).startsWith(expected + ' ')) throw new Error('Artifact manifest mismatch')
}
execFileSync('shasum', ['-a', '256', '-c', join(handoff, 'contracts.sha256')], { cwd: join(repo, 'node_modules/@lamplit/contracts') })
for (const [folder, archive, manifest] of [['web', 'lamplit-web-panels.tgz', 'browser.sha256'], ['contracts', 'lamplit-contracts-panels.tgz', 'contracts.sha256']]) {
  mkdirSync(join(root, folder), { recursive: true })
  execFileSync('tar', ['-xzf', join(handoff, archive), '-C', join(root, folder)])
  writeFileSync(join(root, `${folder}-manifest.log`), execFileSync('shasum', ['-a', '256', '-c', join(handoff, manifest)], { cwd: join(root, folder, ...(folder === 'contracts' ? ['package'] : [])) }))
}
const data = JSON.parse(execFileSync('bun', ['--eval', `import {panelsFixture,fixtureImage} from ${JSON.stringify(join(repo, '../lamplit-app/tests/panels-fixture.ts'))}; const f=panelsFixture(); console.log(JSON.stringify({dates:f.dates,images:f.images,records:f.records,reminders:f.reminders,image:Array.from(fixtureImage)}))`], { encoding: 'utf8' }))
writeFileSync(join(root, 'fixture.json'), JSON.stringify(data, null, 2))
writeFileSync(join(root, 'identity.json'), JSON.stringify(identity, null, 2))
const config = JSON.parse(readFileSync(join(repo, 'wrangler.slice.jsonc')))
config.name = 'lamplit-panels-local-fixture'
config.main = join(root, 'entry.ts')
config.assets.directory = join(root, 'web')
config.r2_buckets = [{ binding: 'COMPUTER_R2', bucket_name: 'panels-test-owned' }]
delete config.secrets
config.vars = { ...config.vars, AI_MODEL: 'fixture-model', AI_MEMORY_MODEL: 'fixture-model', MODEL_BASE_URL: 'https://example.invalid/v1', MODEL_API_KEY: 'fixture-key', AUTH_PASSWORD: 'fixture-password-long-enough', VOICE_API_KEY: 'fixture-voice-key' }
writeFileSync(join(root, 'pi-fixture.jsonc'), JSON.stringify(config, null, 2))
writeFileSync(config.main, `
import worker from ${JSON.stringify(join(repo, 'src/server.ts'))};
import { PiSession as NativeSession } from ${JSON.stringify(join(repo, 'src/server/pi-session.ts'))};
import { PiRegistry as NativeRegistry } from ${JSON.stringify(join(repo, 'src/server/pi-registry.ts'))};
import { PiSessionStorage } from ${JSON.stringify(join(repo, 'src/server/pi-session-storage.ts'))};

const fixture = ${JSON.stringify(data)};
const state = { modelCalls: 0, frames: 0, bytes: 0, closes: 0, seeded: false };
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith('https://example.invalid/')) {
    state.modelCalls++;
    const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({id:'fixture', object:'chat.completion.chunk', created:1, model:'fixture-model', choices:[{index:0, delta, finish_reason}]}) + '\\n\\n';
    return new Response(chunk({role:'assistant', content:'fixture reply'},null) + chunk({},'stop') + 'data: [DONE]\\n\\n', {headers:{'content-type':'text/event-stream'}});
  }
  if (url !== 'https://dashscope.aliyuncs.com/api-ws/v1/inference') throw new Error('Fixture forbids external provider');
  const pair = new WebSocketPair(); const socket=pair[1]; socket.binaryType='arraybuffer'; socket.accept();
  let taskId;
  const send = (event,payload={}) => socket.send(JSON.stringify({header:{event,task_id:taskId},payload}));
  socket.addEventListener('close',()=>state.closes++);
  socket.addEventListener('message',event=>{
    if(typeof event.data !== 'string'){state.frames++;state.bytes+=event.data.byteLength;return;}
    const command=JSON.parse(event.data);taskId=command.header.task_id;
    if(command.header.action==='run-task')send('task-started');
    if(command.header.action==='finish-task'){send('result-generated',{output:{sentence:{sentence_id:1,sentence_end:true,text:'recognized final'}}});send('task-finished');}
  });
  return new Response(null,{status:101,webSocket:pair[0]});
};
export class PiRegistry extends NativeRegistry {
  async seedRelationships() {
    if (await this.ctx.storage.get('fixtureSeeded')) throw new Error('Already seeded; use a fresh fixture root');
    for(const record of [...fixture.records].reverse())await this.updateRelationship({mood:{value:record.state.mood,note:record.state.note,reason:'fixture mood'},signature:{value:record.state.signature,reason:'fixture signature'},affinity:{delta:record.state.affinity-(await this.getRelationshipSnapshot({limit:1})).state.affinity,reason:record.changes.affinity.reason}});
    await this.ctx.storage.put('fixtureSeeded',true);
  }
}
export class PiSession extends NativeSession {
  // Test-only deletion race: a listed diary disappears before its public detail read.
  async listDiary() {
    await this.workspace.writeFile('/workspace/memory/'+fixture.dates[1], 'removed after directory read');
    const names = await super.listDiary();
    await this.workspace.rm('/workspace/memory/'+fixture.dates[1]);
    return names;
  }
  async seedPanels() {
    const storage = new PiSessionStorage(this.ctx.storage);
    const metadata=storage.getMetadataSync();
    await this.importSession({metadata,entries:[],compaction:{enabled:true,reserveTokens:16384,keepRecentTokens:20000},files:[
      ...fixture.dates.map((name,i)=>({path:'/memory/'+name,content:i===2?'灯'.repeat(43690)+'xxx':'# 灯火日记\\n\\n今天一起走过小岛。\\n\\n[看看海](https://example.com/diary)'})),
      {path:'/memory/notes.md',content:'private fixture'},
    ]});
    for(const image of fixture.images){
      const id=crypto.randomUUID(),operationId=crypto.randomUUID();
      const png=btoa(String.fromCharCode(...fixture.image));const jpeg=btoa(String.fromCharCode(255,216,255,217));
      await this.uploadPhoto({id,operationId,order:0,name:image.filename,mediaType:'image/png',original:png,preview:jpeg,model:jpeg});
      storage.admitPromptSubmission(operationId,'fixture-native-membership',[id]);storage.acceptPromptSubmission(operationId,'fixture-entry-'+id);
      this.ctx.storage.sql.exec('UPDATE conversation_photos SET created_at = ? WHERE id = ?',image.createdAt,id);
      if(!image.available)await this.env.COMPUTER_R2.delete('conversation-photos/'+metadata.id+'/'+id+'/original');
    }
    // Admission and consumption retain the real native receipt and immutable custom input.
    const wake=await this.saveTimedWake({title:'Fixture source',reminder:'带上围巾',plan:{type:'once',at:new Date(Date.now()+120000).toISOString()}});
    const due={...wake,nextAt:new Date(Date.now()-500).toISOString()};storage.setSetting('timedWakes',[due]);
    await this.acceptTimedWake({wakeId:due.id,revision:due.revision,scheduledAt:due.nextAt,title:due.title,reminder:due.reminder});
    await this.drainPendingWork();
    for(const reminder of fixture.reminders){
      const s=reminder.schedule;
      const plan=s.kind==='once'?{type:'once',at:new Date(s.at).toISOString()}:s.kind==='interval'?{type:'interval',seconds:s.everySeconds,anchor:new Date(s.anchor).toISOString()}:{type:s.kind,time:String(s.hour).padStart(2,'0')+':'+String(s.minute).padStart(2,'0'),timeZone:s.timeZone,...(s.kind==='weekly'?{weekday:s.weekday}:{})};
      await this.saveTimedWake({title:reminder.title||'Fixture reminder',reminder:reminder.message,plan});
    }
    return metadata.id;
  }
}
export default {async fetch(request,env){
  const path=new URL(request.url).pathname;
  if(path==='/__fixture/state')return Response.json(state);
  if(path==='/__fixture/seed'&&request.method==='POST'){
    if(state.seeded)throw new Error('Already seeded; use a fresh fixture root');
    const registry=env.PiRegistry.getByName('singleton');
    const session=await registry.ensureDefaultSession();
    await registry.seedRelationships();
    const id=await env.PiSession.getByName(session.id).seedPanels();state.seeded=true;return Response.json({id,...state});
  }
  return worker.fetch(request,env);
}};
`)
const child = spawn(join(repo, 'node_modules/.bin/wrangler'), ['dev', '--config', join(root, 'pi-fixture.jsonc'), '--local', '--persist-to', join(root, 'pi-state'), '--ip', '127.0.0.1', '--port', '8951', '--inspector-port', '0', '--show-interactive-dev-session=false'], {
  cwd: root, stdio: 'inherit', env: { PATH: process.env.PATH, TMPDIR: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'), WRANGLER_REGISTRY_PATH: join(root, 'registry'), WRANGLER_LOG_PATH: join(root, 'logs'), WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' },
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', code => { process.exitCode = code ?? 0 })
