// Read-only reviewed Platform handler, genuine local D1/DO/R2, synthetic host/session.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { artifactRoot, verifyDefaultArtifacts } from './default-shared-artifacts.mjs'
verifyDefaultArtifacts()
const repo = resolve(import.meta.dirname, '..'), platform = resolve(repo, '../lamplit-platform')
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: platform, encoding: 'utf8' }).trim() !== 'd61c1c4244af43a63758d6b1e42c187bc9fce8b2') throw new Error('Platform differs from reviewed HEAD')
const root = join(repo, '.scratch/default-shared-frontend/hosted', String(Date.now())); mkdirSync(root, { recursive: true })
const migrations = readdirSync(join(platform, 'migrations')).sort().map(name => readFileSync(join(platform, 'migrations', name), 'utf8'))
const platformAssets = Object.fromEntries(readdirSync(join(platform, 'public')).filter(name => ['index.html','manifest.webmanifest','settings-manifest.webmanifest','service-worker.js'].includes(name) || name.startsWith('pwa-')).map(name => [name, readFileSync(join(platform, 'public', name)).toString('base64')]))
const entry = join(root, 'entry.ts')
writeFileSync(entry, `
import { WorkerEntrypoint } from 'cloudflare:workers';
import gateway from ${JSON.stringify(join(platform, 'src/index.ts'))};
import { hashToken } from ${JSON.stringify(join(platform, 'src/personal-host.ts'))};
import { saveModelSettings } from ${JSON.stringify(join(platform, 'src/model-settings.ts'))};
import { saveVoiceSettings } from ${JSON.stringify(join(platform, 'src/voice-settings.ts'))};
import native from ${JSON.stringify(join(repo, 'scripts/fixtures/text-voice.ts'))};
export { PiSession, PiRegistry } from ${JSON.stringify(join(repo, 'scripts/fixtures/text-voice.ts'))};
const assets=${JSON.stringify(platformAssets)}, migrations=${JSON.stringify(migrations)};
const label='u-111111111111111111111111',hostname=label+'.localhost',token='a'.repeat(64),userId='fixture-hosted-user';
const platformEnv=(env)=>({...env, CHAT:{fetch:(request)=>native.fetch(request,env)},ASSETS:{fetch:async(request)=>{
 const path=new URL(request.url).pathname.replace(/^\\//,'')||'index.html';
 if(!assets[path])return new Response('Not found',{status:404});
 return new Response(Uint8Array.from(atob(assets[path]),c=>c.charCodeAt(0)),{headers:{'content-type':path.endsWith('.webmanifest')?'application/manifest+json':path.endsWith('.js')?'application/javascript':path.endsWith('.png')?'image/png':'text/html'}});
}}});
export class Platform extends WorkerEntrypoint { fetch(request){return gateway.fetch(request,platformEnv(this.env));} }
let initialized=false;
async function seed(env){
 if(initialized)return;
 for(const sql of migrations)for(const statement of sql.split(';').filter(part=>part.trim()))await env.DB.prepare(statement).run();
 const now=Date.now();
 await env.DB.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)').bind(userId,'Fixture','fixture@example.invalid',1,now,now).run();
 await env.DB.prepare('INSERT INTO personal_hosts VALUES (?,?,?)').bind(userId,label,now).run();
 await env.DB.prepare('INSERT INTO personal_sessions VALUES (?,?,?,?,?)').bind(await hashToken(token),userId,hostname,now+3600000,now).run();
 await env.DB.prepare('INSERT INTO chat_instances VALUES (?,?,?)').bind(env.FIXTURE_HOSTED_INSTANCE,userId,new Date(now).toISOString()).run();
 await saveModelSettings(env.DB,env.MODEL_KEY_ENCRYPTION_KEY,userId,{baseUrl:'https://example.invalid/v1',model:'fixture-model',apiKey:'fixture-key'});
 await saveVoiceSettings(env.DB,env.MODEL_KEY_ENCRYPTION_KEY,userId,{enabled:true,apiKey:'fixture-voice-key'});
 initialized=true;
}
export default {async fetch(request,env){
 if(new URL(request.url).pathname.startsWith('/__test/')){
  await seed(env);
  if(new URL(request.url).pathname==='/__test/revoke'){await env.DB.prepare('DELETE FROM personal_sessions').run();return Response.json({revoked:true});}
  const input=await request.clone().json();
  if(input.action==='reset'||(input.action==='speech'&&input.availability!==undefined))await saveVoiceSettings(env.DB,env.MODEL_KEY_ENCRYPTION_KEY,userId,{enabled:input.availability!=='disabled',apiKey:'fixture-voice-key'});
  const result=await native.fetch(request,env);const headers=new Headers(result.headers);headers.set('set-cookie','lamplit-dev-session='+token+'; Path=/; HttpOnly; SameSite=Lax');return new Response(result.body,{status:result.status,headers});
 }
 // Test-owned loopback hostname mapping, before the unmodified gateway. Preserve
 // foreign Origin values so the native same-origin boundary remains observable.
 const url=new URL(request.url),original=url.origin;url.hostname=hostname;
 const headers=new Headers(request.headers);if(headers.get('origin')===original)headers.set('origin',url.origin);
 return gateway.fetch(new Request(url,{...request,method:request.method,headers,body:request.body}),platformEnv(env));
}};
`)
const config = JSON.parse(readFileSync(join(repo, 'wrangler.test.jsonc')))
config.name='lamplit-default-hosted-fixture'; config.main=entry
config.assets={directory:join(artifactRoot,'browser'),binding:'ASSETS',not_found_handling:'none',html_handling:'none',run_worker_first:true}
config.vars={...config.vars, HOSTED_MODE:'true', FIXTURE_HOSTED_INSTANCE:'11111111-1111-4111-8111-111111111111', CHAT_INTERNAL_SECRET:'fixture-internal', APP_ORIGIN:'http://app.localhost:8986',PLATFORM_ORIGIN:'http://app.localhost:8986',ROOT_DOMAIN:'localhost',BETTER_AUTH_SECRET:'fixture-better-auth-secret-long-enough',MODEL_KEY_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')}
config.services=[{binding:'PLATFORM',service:config.name,entrypoint:'Platform'}]
config.d1_databases=[{binding:'DB',database_name:'hosted-test-owned',database_id:'22222222-2222-4222-8222-222222222222'}]
writeFileSync(join(root,'wrangler.jsonc'),JSON.stringify(config));writeFileSync(join(root,'.dev.vars'),'')
const child=spawn(join(repo,'node_modules/.bin/wrangler'),['dev','--config',join(root,'wrangler.jsonc'),'--local','--ip','127.0.0.1','--port','8986','--inspector-port','0','--persist-to',join(root,'state'),'--show-interactive-dev-session=false'],{cwd:root,stdio:'inherit',env:{PATH:process.env.PATH,TMPDIR:root,XDG_CONFIG_HOME:join(root,'config'),XDG_CACHE_HOME:join(root,'cache'),XDG_DATA_HOME:join(root,'data'),WRANGLER_REGISTRY_PATH:join(root,'registry'),WRANGLER_LOG_PATH:join(root,'logs'),WRANGLER_SEND_METRICS:'false',CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false'}})
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));child.on('exit',code=>{verifyDefaultArtifacts();process.exitCode=code??0})
