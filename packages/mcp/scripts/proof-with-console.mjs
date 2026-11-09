import { spawn } from 'node:child_process';
import { once } from 'node:events';
const env={...process.env,AUTH_SECRET:process.env.AUTH_SECRET||'isolated-ci-workflow-proof-only',AUTH_TRUST_HOST:'true',AGENTRAIL_PUBLIC_URL:'http://127.0.0.1:3310'};
const server=spawn('pnpm',['--filter','@agentrail/console','exec','next','start','--hostname','127.0.0.1','--port','3310'],{env,stdio:'inherit',detached:process.platform!=='win32'});
try {
 let ready=false;
 for(let i=0;i<120;i++) {
  try {const r=await fetch('http://127.0.0.1:3310/login'); if(r.ok){ready=true;break;}} catch{}
  await new Promise(r=>setTimeout(r,500));
 }
 if(!ready)throw new Error('Console did not become ready');
 const proof=spawn(process.execPath,['packages/mcp/scripts/proof-workflow.mjs'],{env,stdio:'inherit'});
 const [code]=await once(proof,'exit');if(code!==0)throw new Error(`Workflow proof failed: ${code}`);
} finally {
 if(process.platform!=='win32'){try{process.kill(-server.pid,'SIGTERM');}catch{}}
 else server.kill();
}
