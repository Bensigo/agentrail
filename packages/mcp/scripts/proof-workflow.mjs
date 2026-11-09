/** Local integrated protocol proof. Never run against a production database. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, mkdtemp, chmod, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const requireDb = createRequire(new URL('../../db-postgres/package.json', import.meta.url));
const postgres = requireDb('postgres');
const base = process.env.PROOF_BASE_URL || 'http://127.0.0.1:3310';
const database = process.env.DATABASE_URL;
assert(database && new URL(database).hostname === '127.0.0.1' && /_(proof|split)$/.test(new URL(database).pathname), 'Dedicated local proof database required');
assert.equal(new URL(base).hostname, '127.0.0.1');
const sql = postgres(database, { max: 4 });
const workspaceId = randomUUID(), foreignWorkspaceId = randomUUID(), repositoryId = randomUUID();
const ownerId = randomUUID(), token = randomBytes(32).toString('hex'), key = `ar_${randomBytes(32).toString('hex')}`;
const foreignKey = `ar_${randomBytes(32).toString('hex')}`, otherKey = `ar_${randomBytes(32).toString('hex')}`;
const keyHash = value => createHash('sha256').update(value).digest('hex');
const target = await mkdtemp(resolve(tmpdir(), 'agentrail-workflow-proof-'));
const git = (...args) => execFileSync('git', ['-C', target, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
git('init', '-b', 'proof/workflow'); git('config', 'user.name', 'AgentRail proof'); git('config', 'user.email', 'proof@example.invalid');
git('remote', 'add', 'origin', 'https://github.com/Bensigo/agentrail.git');
await mkdir(resolve(target, '.agentrail'));
await writeFile(resolve(target, 'sample.js'), 'export const value = 42;\n');
await writeFile(resolve(target, '.agentrail/config.json'), JSON.stringify({ workflow: { checks: {
  syntax: [process.execPath, '--check', 'sample.js'],
  once: [process.execPath, '-e', "require('fs').appendFileSync('executions','1')"],
  slow: [process.execPath, '-e', 'setTimeout(()=>process.exit(1),1500)'],
  gitFailure: [process.execPath, '-e', "require('fs').renameSync('.git','.git-held')"],
} } }));
git('add', '.'); git('commit', '-m', 'Proof fixture');
const clients = [];
async function client(name, secret = key) {
  const c = new Client({ name, version: '1.0.0' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/dist/index.js')], env: {
    PATH: process.env.PATH, AGENTRAIL_TARGET: target, AGENTRAIL_WORKFLOW_BASE_URL: base, AGENTRAIL_WORKFLOW_API_KEY: secret,
  }, stderr: 'pipe' }));
  clients.push(c); return c;
}
const tool = (client, name, args = {}) => client.callTool({ name, arguments: args });
const payload = result => { assert(!result.isError, JSON.stringify(result)); return result.structuredContent || JSON.parse(result.content[0].text); };
let state;
try {
  await sql`INSERT INTO users (id, name, email) VALUES (${ownerId}, 'Workflow owner', ${`${ownerId}@example.invalid`})`;
  await sql`INSERT INTO sessions (session_token, user_id, expires) VALUES (${token}, ${ownerId}, ${new Date(Date.now()+86400000)})`;
  await sql`INSERT INTO workspaces (id, name, slug) VALUES (${workspaceId}, 'AgentRail workflow proof', ${`proof-${workspaceId}`}), (${foreignWorkspaceId}, 'Foreign workspace', ${`proof-${foreignWorkspaceId}`})`;
  await sql`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES (${workspaceId}, ${ownerId}, 'owner')`;
  await sql`INSERT INTO repositories (id, workspace_id, name, url) VALUES (${repositoryId}, ${workspaceId}, 'Bensigo/agentrail', 'https://github.com/Bensigo/agentrail')`;
  await sql`INSERT INTO api_keys (workspace_id, name, key_prefix, key_hash, kind) VALUES (${workspaceId}, 'proof', 'ar_proof', ${keyHash(key)}, 'workflow_mcp'), (${foreignWorkspaceId}, 'foreign proof', 'ar_foreign', ${keyHash(foreignKey)}, 'workflow_mcp'), (${workspaceId}, 'other credential', 'ar_other', ${keyHash(otherKey)}, 'workflow_mcp')`;
  const a = await client('independent-mcp-client-a'), b = await client('independent-mcp-client-b');
  const names = (await a.listTools()).tools.map(t => t.name);
  assert(names.includes('workflow_start') && names.includes('context_search'));
  assert(!names.some(n => n.startsWith('jace_') || n.startsWith('acceptance_')));
  assert.equal(payload(await tool(a,'workflow_repositories')).repositories[0].id, repositoryId);
  const start = { taskKey: randomUUID(), title: 'Separate AgentRail workflow from Jace', agent: 'MCP client A', repositoryId, branch: 'proof/workflow' };
  const first = payload(await tool(a, 'workflow_start', start)).task;
  assert.equal(payload(await tool(a,'workflow_start',start)).task.id,first.id);
  assert((await tool(a,'workflow_start',{...start,title:'Conflicting retry'})).isError);
  const taskId = first.id;
  const progress = {taskId,eventKey:'implementation',expectedRevision:0,phase:'implementing',summary:'Repository separation is under implementation.'};
  assert.equal(payload(await tool(a,'workflow_update',progress)).task.revision,1);
  assert.equal(payload(await tool(a,'workflow_update',progress)).replayed,true);
  assert((await tool(a,'workflow_update',{...progress,eventKey:'stale'})).isError);
  const check = payload(await tool(a,'workflow_check',{taskId,eventKey:'syntax',expectedRevision:1,check:'syntax'}));
  assert.equal(check.check.exitCode,0); assert.equal(check.check.commitSha,git('rev-parse','HEAD'));
  let revision = check.task.revision;
  const once = {taskId,eventKey:'one-execution',expectedRevision:revision,check:'once'};
  const onceResult=payload(await tool(a,'workflow_check',once)); assert.equal(onceResult.check.dirty,true); payload(await tool(b,'workflow_check',once));
  assert.equal(await readFile(resolve(target,'executions'),'utf8'),'1');
  revision = payload(await tool(a,'workflow_get',{taskId})).task.revision;
  // A running check holds ordinary reports until its receipt has been retained.
  const running = tool(a,'workflow_check',{taskId,eventKey:'slow',expectedRevision:revision,check:'slow'});
  let held;
  for(let n=0;n<40;n++) {
    held = payload(await tool(b,'workflow_get',{taskId}));
    if(held.task.active_check_key) break;
    await new Promise(r=>setTimeout(r,100));
  }
  assert(held.task.active_check_key);
  const forged=await fetch(`${base}/api/v1/workflow/tasks/${taskId}`,{method:'POST',headers:{authorization:`Bearer ${otherKey}`,'content-type':'application/json'},body:JSON.stringify({eventKey:`check:${keyHash(held.task.active_check_key)}:finish`,expectedRevision:held.task.revision,phase:'testing',summary:'A different credential cannot finish this reservation.',check:{name:'slow',passed:true,exitCode:0,outputSha256:'0'.repeat(64),commitSha:git('rev-parse','HEAD'),dirty:false}})});
  assert.equal(forged.status,409);
  assert((await tool(b,'workflow_update',{taskId,eventKey:'premature-finish',expectedRevision:held.task.revision,phase:'needs_review',summary:'Must not advance during a running check.'})).isError);
  const failed = payload(await running); assert.equal(failed.check.passed,false); assert.equal(failed.task.phase,'blocked');
  revision = failed.task.revision;
  const gitFailure=payload(await tool(a,'workflow_check',{taskId,eventKey:'git-failure',expectedRevision:revision,check:'gitFailure'}));
  assert.equal(gitFailure.check.passed,false);assert.equal(gitFailure.check.dirty,true);assert.equal(gitFailure.task.active_check_key,null);
  await rename(resolve(target,'.git-held'),resolve(target,'.git'));
  revision=gitFailure.task.revision;
  git('checkout','-b','wrong/branch');
  assert((await tool(a,'workflow_check',{taskId,eventKey:'wrong-checkout',expectedRevision:revision,check:'syntax'})).isError);
  git('checkout','proof/workflow');
  assert.equal(payload(await tool(a,'workflow_get',{taskId})).task.revision,revision);
  const foreign = await client('foreign-workspace',foreignKey);
  assert((await tool(foreign,'workflow_get',{taskId})).isError);
  assert((await tool(foreign,'workflow_start',{...start,taskKey:randomUUID()})).isError);
  const bTask = payload(await tool(b,'workflow_start',{...start,taskKey:randomUUID(),title:'Second MCP client can use the same workflow',agent:'MCP client B'})).task;
  assert.equal(bTask.agent,'MCP client B');
  const ready = payload(await tool(a,'workflow_update',{taskId,eventKey:'handoff',expectedRevision:revision,phase:'needs_review',summary:'Review the split, check receipts and remaining deployment cutover.'})).task;
  const cookie = `authjs.session-token=${token}`;
  const updateUrl = `${base}/api/v1/workflow/tasks/${taskId}?workspaceId=${workspaceId}`;
  const decisionBody = {eventKey:'human-complete',expectedRevision:ready.revision,decision:'complete'};
  assert.equal((await fetch(updateUrl,{method:'POST',headers:{cookie,'content-type':'application/json',origin:'https://foreign.invalid'},body:JSON.stringify(decisionBody)})).status,403);
  const complete = await fetch(updateUrl,{method:'POST',headers:{cookie,'content-type':'application/json',origin:base},body:JSON.stringify(decisionBody)});
  assert.equal(complete.status,200); const closed=(await complete.json()).task;
  assert((await tool(a,'workflow_update',{taskId,eventKey:'agent-reopen',expectedRevision:closed.revision,phase:'implementing',summary:'Cannot reopen a human-closed task.'})).isError);
  const reopen = await fetch(updateUrl,{method:'POST',headers:{cookie,'content-type':'application/json',origin:base},body:JSON.stringify({eventKey:'human-reopen',expectedRevision:closed.revision,decision:'reopen'})});
  assert.equal(reopen.status,200);
  revision = (await reopen.json()).task.revision;
  payload(await tool(a,'workflow_update',{taskId,eventKey:'review-again',expectedRevision:revision,phase:'needs_review',summary:'MCP roundtrip, configured checks, conflict protection and human-decision boundaries passed locally.'}));
  const readback=payload(await tool(b,'workflow_get',{taskId}));
  assert(readback.events.some(e=>e.kind==='human_decision'&&e.payload.actorId===ownerId));
  const unauthorized=await fetch(`${base}/api/v1/runner/claim?workspace_id=${workspaceId}`,{headers:{authorization:`Bearer ${key}`}});
  assert.equal(unauthorized.status,403);
  await sql`UPDATE api_keys SET revoked_at=now() WHERE key_hash=${keyHash(foreignKey)}`;
  assert((await tool(foreign,'workflow_list')).isError);
  state={workspaceId,taskId,ownerId,sessionToken:token,key,base,target};
  if(process.env.PROOF_STATE_FILE){await writeFile(process.env.PROOF_STATE_FILE,JSON.stringify(state));await chmod(process.env.PROOF_STATE_FILE,0o600);}
  console.log(JSON.stringify({passed:true,workspaceId,taskId,checks:['real MCP protocol','two independent client identities','context/workflow tools only','start retry deduplication','stale update refusal','configured check subprocess','check replay once','concurrent check hold','reservation credential custody','dirty-after receipt','post-check Git failure receipt','wrong branch refusal','tenant isolation','human origin and terminal control','actor custody','credential separation','revocation'],proofLevel:'local runtime; no real third-party coding client or live deployment claimed'}));
} finally {
  await Promise.allSettled(clients.map(c=>c.close())); await sql.end();
}
