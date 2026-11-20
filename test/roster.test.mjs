import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { harness, until } from './harness.mjs'
import { call } from '../lib/client.mjs'
import { socketFor } from '../lib/paths.mjs'
import { templateArgs, validateTemplate } from '../lib/templates.mjs'
import { cursorModel } from '../lib/stream-workers.mjs'
import { DatabaseSync } from 'node:sqlite'
import { Roster } from '../lib/roster.mjs'

const template = { command:'template-cli', newArgs:['--prompt','{prompt}'], resumeArgs:['--resume','{session}','--prompt','{prompt}'], modelArgs:['--model','{model}'], effortArgs:['--effort','{effort}'], format:'json', reply:{path:'reply'}, session:{path:'id'} }
async function api(h) {
  const url = await h.cli('ui','--no-open')
  return async (path, data) => {
    const r = await fetch(url+'/api/'+path, {method:data?'POST':'GET',headers:data?{Origin:url,'Content-Type':'application/json'}:undefined,body:data?JSON.stringify(data):undefined})
    const value=await r.json()
    if(!r.ok) throw new Error(value.error.message)
    return value
  }
}

test('roster reads CLI metadata, reflects project overrides, and note proposals require explicit acceptance', async t => {
  const h=harness(t), p=await h.json('init','--allow','codex,claude,agy,cursor-agent,pi:deepseek','--default-worker','codex'), web=await api(h)
  const r=await h.json('roster')
  assert.equal(r.workers.length,5)
  assert.equal(r.workers[0].loginStatus,'ready')
  assert.equal(r.workers[0].defaultModel,'fixture-model')
  assert.deepEqual(r.workers[0].efforts,['low','medium'])
  assert.equal(r.workers.find(w=>w.id==='claude').loginStatus,'ready')
  assert.equal(r.workers.find(w=>w.id==='agy').defaultModel,'fixture-model')
  writeFileSync(join(h.cwd,'fixture-signed-out'),'')
  const afterSignOut = await h.json('roster')
  assert.equal(afterSignOut.workers.some(w=>w.id==='cursor-agent'),false)
  assert.equal(afterSignOut.workers.some(w=>w.id==='claude'),false)
  const global=await web('settings/global')
  Object.assign(global,{allow:['codex'],worker:'codex',rules:['Keep changes scoped'],entries:{codex:{model:'fixture-model',effort:'low',note:'User note'}}})
  await web('settings/global',global)
  const proposal=await call('/note-proposal',{projectId:p.id,worker:'codex',note:'Legacy proposal'},socketFor(h.data))
  assert.equal((await h.json('roster')).workers[0].note,'User note')
  let cfg=await web('settings/'+p.id)
  assert.equal(cfg.proposals[0].id,proposal.id)
  cfg=await web('notes/'+p.id+'/'+proposal.id,{accept:true})
  assert.equal(cfg.entries.codex.note,'Legacy proposal')
  const directNote=await h.json('note','codex','Manager suggestion')
  assert.ok(directNote.auditId>=1)
  assert.equal((await h.json('roster')).workers[0].note,'Manager suggestion')
  const result=await h.json('say','job','hello','--effort','medium')
  assert.deepEqual(result.reminders,['Rule reminder: Keep changes scoped'])
  assert.equal(result.effort,'medium')
  assert.equal((await h.json('show','job')).rules[0],'Keep changes scoped')
  assert.equal(JSON.parse(readFileSync(join(h.cwd,'selections'),'utf8').trim()).effort,'medium')
  await assert.rejects(web('settings/global',global),/Settings changed/)
  await h.cli('shutdown')
  assert.equal((await h.json('roster')).workers[0].note,'Manager suggestion')
})

test('new dispatch uses hot settings, in-flight model stays fixed, revoked workers are hard refused',async t=>{
  const h=harness(t),p=await h.json('init','--allow','codex,agy','--default-worker','codex'),web=await api(h)
  await h.json('say','active','hold','--model','original','--effort','low','--bg')
  let cfg=await web('settings/'+p.id)
  cfg.entries={codex:{model:'changed',effort:'high'}};cfg.rules=['Research with agy']
  await web('settings/'+p.id,cfg)
  const steer=await h.json('say','active','finish','--bg')
  assert.equal(steer.model,'original');assert.equal(steer.effort,'low');assert.equal(steer.outcome,'injected')
  await h.cli('wait','active','1')
  const again=await h.json('say','active','next')
  assert.equal(again.model,'changed');assert.equal(again.effort,'high')
  cfg=await web('settings/'+p.id);cfg.allow=['agy'];cfg.worker='agy'
  await web('settings/'+p.id,cfg)
  await assert.rejects(h.cli('say','active','blocked'),/not allowed/)
  const next=await h.json('say','new','hello')
  assert.equal(next.worker,'agy');assert.equal(next.reminders.length,1)
})

for(const worker of ['agy','cursor-agent','claude']) test(worker+' resumes, queues interjections, shows changes, reviews and stops',async t=>{
  const h=harness(t),web=await api(h)
  execFileSync('git',['init','-q'],{cwd:h.cwd});execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.test','commit','--allow-empty','-qm','base'],{cwd:h.cwd})
  const p=await h.json('init','--allow',worker+',codex','--default-worker',worker)
  await h.json('say','memory','remember trail')
  const one=await h.json('show','memory')
  if(worker==='agy') assert.equal(one.cacheRatio,80/180)
  if(worker==='claude') assert.equal(one.cacheRatio,80/200)
  assert.equal((await h.json('say','memory','recall')).reply,'trail')
  assert.equal((await h.json('show','memory')).session,one.session)
  await h.json('say','queued','hold','--bg')
  const queued=await h.json('say','queued','second','--bg')
  assert.equal(queued.outcome,'queued');assert.equal(queued.turn,2)
  writeFileSync(join(h.cwd,'release-stream'),'')
  assert.equal((await h.json('wait','queued','2')).reply,'second')
  await h.json('say','change','write fixture','--worktree')
  const change=await h.json('show','change')
  assert.ok(change.branch);assert.ok(change.changedFiles.some(f=>f.path==='stream-proof.txt'))
  assert.equal(existsSync(join(h.cwd,'stream-proof.txt')),false)
  const review=await h.json('review','change','--by','codex')
  assert.equal((await h.json('show',review.name)).parent,'change')
  const reviewBack=await h.json('review',review.name,'--by',worker)
  assert.equal(reviewBack.worker,worker)
  await h.cli('done','change')
  assert.equal((await web('projects/'+p.id+'/tickets/change')).status,'done')
  await h.json('say','cancel','hold','--bg','--worktree');await h.cli('stop','cancel')
  assert.equal((await h.json('show','cancel')).status,'stopped')
})

test('custom template must pass new/resume trial; argument boundaries, snapshots and failed extraction are preserved',async t=>{
  const h=harness(t),p=await h.json('init','--allow','codex'),web=await api(h)
  const cfg=await web('settings/'+p.id)
  cfg.entries={'custom:fixture':{template}};cfg.allow=['codex','custom:fixture']
  await assert.rejects(web('settings/'+p.id,cfg),/Test this exact template/)
  const trial=await web('templates/'+p.id+'/test',{template})
  assert.equal(trial.status,'passed')
  await web('settings/'+p.id,cfg)
  const first=await h.json('say','custom','remember safe','--worker','custom:fixture','--model','m','--effort','low')
  assert.equal(first.capability,'degraded')
  assert.equal((await h.json('say','custom','recall')).reply,'safe')
  const id=(await h.json('show','custom')).session
  const shellText='$(touch should-not-exist) `touch also-not` ; quoted "value"'
  assert.equal((await h.json('say','custom',shellText)).reply,shellText)
  assert.equal(existsSync(join(h.cwd,'should-not-exist')),false)
  assert.equal((await h.json('show','custom')).session,id)
  const bad={...template,resumeArgs:[...template.resumeArgs,'--wrong-id']}
  await assert.rejects(web('templates/'+p.id+'/test',{template:bad}),/different session|remember/)
  await h.cli('done','custom')
})

test('global inheritance is explicit and project allowlists remain isolated',async t=>{
  const h=harness(t),p=await h.json('init','--allow','codex'),web=await api(h)
  let g=await web('settings/global');g.allow=['agy'];g.worker='agy';await web('settings/global',g)
  assert.equal((await h.json('roster')).defaultWorker,'codex')
  const cfg=await web('settings/'+p.id);cfg.inheritPolicy=true;await web('settings/'+p.id,cfg)
  assert.equal((await h.json('roster')).defaultWorker,'agy')
  await assert.rejects(h.cli('say','denied','hi','--worker','codex'),/not allowed/)
  await h.cli('init','--allow','codex')
  assert.equal((await h.json('roster')).defaultWorker,'codex')
})

test('template validation rejects missing resume and treats placeholders as single argv entries',()=>{
  assert.throws(()=>validateTemplate({...template,resumeArgs:['--prompt','{prompt}']}),/session/)
  assert.throws(()=>validateTemplate({...template,command:'sh -c'}),/executable/)
  const t=validateTemplate(template)
  assert.deepEqual(templateArgs(t,{text:'a b; $x',provider:'custom:fixture',model:'custom:fixture',cwd:'/tmp'}).args,['--prompt','a b; $x'])
  assert.equal(cursorModel('grok-4.7','low'),'grok-4.7[effort=low]')
  assert.equal(cursorModel('grok-4.7-high','low',['grok-4.7-low']),'grok-4.7-low')
  assert.equal(cursorModel('m[fast=true,effort=high]','low'),'m[fast=true,effort=low]')
})

test('Terminal actions use explicit commands and quote each custom argument',()=>{
  const roster=Object.create(Roster.prototype)
  roster.read=()=>({entries:{'custom:example':{template:{actions:{login:['example-cli','login','literal $(touch nope)',"quote'value"]}}}}})
  assert.equal(roster.terminalCommand('custom:example','login','global'),"'example-cli' 'login' 'literal $(touch nope)' 'quote'\\''value'")
  assert.equal(roster.terminalCommand('codex','upgrade','global'),'npm install -g @openai/codex@latest')
  assert.throws(()=>roster.terminalCommand('codex','remove','global'),/Unknown CLI action/)
})

test('defaults CLI applies immediately with audit undo, while legacy default proposals persist until accepted', async t => {
  const h=harness(t), p=await h.json('init','--allow','codex')
  let web=await api(h)
  const cfg=await web('settings/'+p.id)
  cfg.entries.codex={model:'gpt-5.6-sol',effort:'low',note:'Keep this note',rules:['Keep this rule']}
  await web('settings/'+p.id,cfg)
  for (const args of [[],['--full']]) {
    const roster=await h.json('roster',...args)
    assert.match(roster.workers[0].warnings.join(' '),/gpt-5.6-sol.*older or superseded/)
    assert.match(await h.cli('roster',...args),/Default model gpt-5.6-sol/)
  }
  await assert.rejects(h.cli('defaults','codex'),/Supply --model/)
  await assert.rejects(h.cli('defaults','codex','--model',' '),/empty/)
  await assert.rejects(h.cli('defaults','unknown','--effort','high'),/Unknown worker/)
  const proposal=await call('/defaults-proposal',{projectId:p.id,worker:'codex',model:'gpt-6-astra',effort:'high'},socketFor(h.data))
  assert.equal(proposal.status,'pending-user-confirmation')
  await h.cli('shutdown')
  assert.equal((await h.json('roster')).workers[0].defaultModel,'gpt-5.6-sol')
  web=await api(h)
  const pending=await web('settings/'+p.id)
  assert.deepEqual(pending.proposals[0].defaults,{model:'gpt-6-astra',effort:'high'})
  await assert.rejects(web('notes/global/'+proposal.id,{accept:true}),/Unknown proposal/)
  const accepted=await web('notes/'+p.id+'/'+proposal.id,{accept:true})
  assert.deepEqual(accepted.entries.codex,{model:'gpt-6-astra',effort:'high',note:'Keep this note',rules:['Keep this rule']})
  assert.equal(accepted.proposals.length,0)
  const roster=await h.json('roster')
  assert.equal(roster.workers[0].defaultModel,'gpt-6-astra')
  assert.equal((roster.workers[0].warnings ?? []).some(w=>w.includes('older or superseded')),false)
  const effort=await call('/defaults-proposal',{projectId:p.id,worker:'codex',effort:'medium'},socketFor(h.data))
  await web('notes/'+p.id+'/'+effort.id,{accept:false})
  assert.equal((await h.json('roster')).workers[0].defaultEffort,'high')
  const direct=await h.json('defaults','codex','--model','gpt-6.1-sol')
  assert.ok(direct.auditId>=1)
  assert.equal((await h.json('roster')).workers[0].defaultModel,'gpt-6.1-sol')
  assert.equal((await h.json('roster')).workers[0].defaultEffort,'high')
  await h.json('undo',String(direct.auditId))
  assert.equal((await h.json('roster')).workers[0].defaultModel,'gpt-6-astra')
})


test('legacy note storage migrates and default proposals merge only after scoped acceptance', t => {
  const db=new DatabaseSync(':memory:')
  t.after(()=>db.close())
  db.exec('CREATE TABLE note_proposals(id TEXT PRIMARY KEY,scope TEXT NOT NULL,worker TEXT NOT NULL,note TEXT NOT NULL,created INTEGER NOT NULL)')
  db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,allow TEXT,worker TEXT)')
  db.prepare('INSERT INTO note_proposals VALUES (?,?,?,?,?)').run('legacy','project','codex','Legacy note',1)
  const project={id:'project',allow:['codex'],worker:'codex'}
  const projects={db,entries:new Map(),publish(){},get(id){if(id!==project.id) throw new Error('Unknown project');return project}}
  let roster=new Roster(projects)
  assert.equal(roster.config('project').proposals[0].note,'Legacy note')
  roster.resolveProposal('project','legacy',true)
  const proposal=roster.proposeDefaults('project','codex',{model:'gpt-6-astra',effort:'high',allow:['agy'],note:'Ignored'})
  assert.equal(roster.read('project').entries.codex.model,undefined)
  roster=new Roster(projects)
  assert.deepEqual(roster.config('project').proposals[0].defaults,{model:'gpt-6-astra',effort:'high'})
  assert.throws(()=>roster.resolveProposal('global',proposal.id,true),/Unknown proposal/)
  roster.resolveProposal('project',proposal.id,true)
  assert.deepEqual(roster.read('project').entries.codex,{note:'Legacy note',model:'gpt-6-astra',effort:'high'})
  const rejected=roster.proposeDefaults('project','codex',{model:'rejected'})
  roster.resolveProposal('project',rejected.id,false)
  assert.equal(roster.read('project').entries.codex.model,'gpt-6-astra')
  const effort=roster.proposeDefaults('project','codex',{effort:'medium'})
  roster.resolveProposal('project',effort.id,true)
  assert.equal(roster.read('project').entries.codex.effort,'medium')
  assert.equal(roster.read('project').entries.codex.model,'gpt-6-astra')
  assert.throws(()=>roster.proposeDefaults('project','codex',{}),/Supply --model/)
  assert.throws(()=>roster.proposeDefaults('project','codex',{model:' '}),/empty/)
  assert.throws(()=>roster.proposeDefaults('project','codex',{effort:1}),/Invalid text/)
  assert.throws(()=>roster.proposeDefaults('project','unknown',{model:'x'}),/Unknown worker/)
  assert.throws(()=>roster.proposeDefaults('global','codex',{model:'x'}),/Unknown project/)
})

test('roster warns about old default families even when the CLI no longer lists the model', t => {
  const h=harness(t)
  mkdirSync(h.data,{recursive:true})
  const script=`
    import assert from 'node:assert/strict'
    import { DatabaseSync } from 'node:sqlite'
    import { Roster } from './lib/roster.mjs'
    import { rosterOutput, rosterText } from './lib/roster-output.mjs'
    const db=new DatabaseSync(':memory:')
    const roster=new Roster({db,crews:()=>[]})
    let model='gpt-5.6-sol'
    roster.read=()=>({entries:{codex:{model}},allow:['codex'],worker:'codex',rules:[]})
    for (const id of ['gpt-5.6-sol','openai-codex/gpt-5.6-terra-high','gpt-6-sol']) {
      model=id
      const raw=await roster.list('global')
      assert.equal(raw.workers[0].models.some(m=>m.id===id),false)
      for (const full of [false,true]) {
        const output=rosterOutput(raw,{full})
        assert.match(output.workers[0].warnings.join(' '),/older or superseded/)
        assert.match(rosterText(output),/Default model .*older or superseded/)
      }
    }
    model='gpt-6-astra'
    assert.equal((await roster.list('global')).workers[0].warnings.some(w=>w.includes('older or superseded')),false)
    db.close()
  `
  execFileSync(process.execPath,['--input-type=module','-e',script],{env:h.env,timeout:30000})
})
