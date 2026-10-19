const {execSync,execFileSync}=require('child_process'),path=require('path'),fs=require('fs'),os=require('os');
const cfg=JSON.parse(fs.readFileSync(path.join(__dirname,'config.json'),'utf8'));
const PY=cfg.skillManagerPy,DIR=cfg.sharedSkillsDir,REG=cfg.registryFile;
const OPENCLAW_PKG = process.env.OPENCLAW_PKG || path.join(os.homedir(), '.npm-global/lib/node_modules/openclaw');
const OPENCLAW_HOME=path.join(os.homedir(),'.openclaw');
const CACHE_TTL_MS=15000;
const EXPENSIVE_CACHE_TTL_MS=60000;
const cache={skills:null,skillsAt:0,overview:null,overviewAt:0,size:null,sizeAt:0,deps:null,depsAt:0};

function cors(r){r.setHeader('Access-Control-Allow-Origin','*');r.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');r.setHeader('Access-Control-Allow-Headers','Content-Type');}
function py(args,t=30000){try{const r=execSync(`cd ${DIR}&&python3 ${PY} ${args} 2>/dev/null`,{encoding:'utf8',timeout:t});try{return{ok:true,data:JSON.parse(r)};}catch{}return{ok:true,raw:r.trim()};}catch(e){return{ok:false,error:(e.stderr||e.stdout||e.message||'').toString().trim()};}}
function reg(){try{return JSON.parse(fs.readFileSync(REG,'utf8'));}catch{return null;}}
function dsize(p){try{const b=parseInt(execSync(`du -sb ${p} 2>/dev/null`,{encoding:'utf8',timeout:5000}).split('\t')[0])||0;let n=0;const np=path.join(p,'node_modules');if(fs.existsSync(np))try{n=parseInt(execSync(`du -sb ${np} 2>/dev/null`,{encoding:'utf8',timeout:5000}).split('\t')[0])||0;}catch{}return{total:b,nodeModules:n,core:b-n};}catch{return{total:0,nodeModules:0,core:0};}}
function duMany(paths){
  const unique=[...new Set(paths.filter(Boolean).filter(p=>{try{return fs.existsSync(p);}catch{return false;}}))];
  const sizes={};
  if(!unique.length)return sizes;
  try{
    const out=execFileSync('du',['-sb',...unique],{encoding:'utf8',timeout:15000});
    for(const line of out.split('\n')){
      const m=line.match(/^(\d+)\s+(.+)$/);
      if(m)sizes[m[2]]=parseInt(m[1],10)||0;
    }
  }catch{
    for(const p of unique)sizes[p]=dsize(p).total;
  }
  return sizes;
}
function isFresh(at,ttl){return at&&Date.now()-at<ttl;}
function clearSkillCaches(){cache.skills=null;cache.skillsAt=0;cache.overview=null;cache.overviewAt=0;cache.size=null;cache.sizeAt=0;cache.deps=null;cache.depsAt=0;}
function cachedSkills(){
  if(cache.skills&&isFresh(cache.skillsAt,CACHE_TTL_MS))return cache.skills;
  const skills=scanAllSkills();
  cache.skills=skills;
  cache.skillsAt=Date.now();
  return skills;
}
function cachedOverview(){
  if(cache.overview&&isFresh(cache.overviewAt,CACHE_TTL_MS))return cache.overview;
  const skills=cachedSkills();
  const c={},s={},v={};let wd=0,wm=0;
  for(const x of skills){
    const cat=x.category||'other';c[cat]=(c[cat]||0)+1;
    s[x.source]=(s[x.source]||0)+1;
    const ver=x.version||'unknown';v[ver]=(v[ver]||0)+1;
    if(x.dependencies&&x.dependencies.length)wd++;
    if(x.hasMeta)wm++;
  }
  let td=0;try{td=parseInt(execSync(`du -sb ${DIR} 2>/dev/null`,{encoding:'utf8',timeout:10000}).split('\t')[0])||0;}catch{}
  cache.overview={total:skills.length,categories:c,sources:s,versions:v,withDependencies:wd,withMeta:wm,totalDiskBytes:td};
  cache.overviewAt=Date.now();
  return cache.overview;
}
function cachedSizes(){
  if(cache.size&&isFresh(cache.sizeAt,EXPENSIVE_CACHE_TTL_MS))return cache.size;
  const skills=cachedSkills();
  const sizePaths=skills.map(s=>s.sharedPath||path.dirname(s.location||'')).filter(Boolean);
  const nodeModulePaths=sizePaths.map(p=>path.join(p,'node_modules'));
  const totals=duMany(sizePaths);
  const nodeModules=duMany(nodeModulePaths);
  const sizes=[];
  for(const s of skills){
    const sizePath=s.sharedPath||path.dirname(s.location||'');
    if(sizePath&&fs.existsSync(sizePath)){
      const total=totals[sizePath]||0;
      const nm=nodeModules[path.join(sizePath,'node_modules')]||0;
      sizes.push({slug:s.id,name:s.name||s.id,source:s.source||'local',total,nodeModules:nm,core:Math.max(0,total-nm)});
    }else sizes.push({slug:s.id,name:s.name||s.id,source:s.source||'local',total:0,nodeModules:0,core:0});
  }
  sizes.sort((a,b)=>b.total-a.total);
  cache.size={skills:sizes};
  cache.sizeAt=Date.now();
  return cache.size;
}
function cachedDeps(){
  if(cache.deps&&isFresh(cache.depsAt,EXPENSIVE_CACHE_TTL_MS))return cache.deps;
  cache.deps=py('deps');
  cache.depsAt=Date.now();
  return cache.deps;
}
function runSkillMutation(args,t){
  const result=py(args,t);
  clearSkillCaches();
  return result;
}

// Parse SKILL.md frontmatter
function parseSkillMd(content){
  const r={name:'',description:'',emoji:''};
  const fm=content.match(/^---\n([\s\S]*?)\n---/);
  if(!fm)return r;
  const f=fm[1];
  const nm=f.match(/^name:\s*(.+)$/m);if(nm)r.name=nm[1].trim();
  const ds=f.match(/^description:\s*[|>]?\s*\n([\s\S]*?)(?=\n\w|\n*$)/m);
  if(ds)r.description=ds[1].split('\n').map(l=>l.trim()).join(' ').trim();
  else{const d1=f.match(/^description:\s*["']?(.+?)["']?\s*$/m);if(d1)r.description=d1[1].trim();}
  const em=f.match(/"emoji":\s*"([^"]+)"/);if(em)r.emoji=em[1];
  return r;
}

// Scan ALL skill sources (matching dashboard logic)
function scanAllSkills(){
  const skills=[];
  const seen=new Set();

  function addSkill(id,name,desc,emoji,source,location,version,extra={}){
    if(seen.has(id))return;
    seen.add(id);
    skills.push({id,name,description:desc,emoji,source,location,version,usedBy:[],...extra});
  }

  // 1. Builtin skills (from openclaw npm package)
  const builtinDir=path.join(OPENCLAW_PKG,'skills');
  if(fs.existsSync(builtinDir)){
    for(const name of fs.readdirSync(builtinDir).sort()){
      const skillMd=path.join(builtinDir,name,'SKILL.md');
      const pkgFile=path.join(builtinDir,name,'package.json');
      if(!fs.existsSync(skillMd))continue;
      const p=parseSkillMd(fs.readFileSync(skillMd,'utf8'));
      let ver='builtin';
      if(fs.existsSync(pkgFile))try{ver=JSON.parse(fs.readFileSync(pkgFile,'utf8')).version||'builtin';}catch{}
      addSkill(name,p.name||name,p.description,p.emoji||'🔧','builtin',skillMd,ver);
    }
  }

  // 2. Extension skills (from openclaw/dist/extensions)
  const distExtDir=path.join(OPENCLAW_PKG,'extensions');
  if(fs.existsSync(distExtDir)){
    for(const ext of fs.readdirSync(distExtDir)){
      const extSkillMd=path.join(distExtDir,ext,'SKILL.md');
      if(!fs.existsSync(extSkillMd))continue;
      const p=parseSkillMd(fs.readFileSync(extSkillMd,'utf8'));
      addSkill(ext,p.name||ext,p.description,p.emoji||'🔌','extension',extSkillMd,'',{extension:ext});
    }
  }

  // 3. User-installed extensions (e.g. openclaw-lark)
  const userExtDir=path.join(OPENCLAW_HOME,'extensions');
  if(fs.existsSync(userExtDir)){
    for(const ext of fs.readdirSync(userExtDir)){
      const extPath=path.join(userExtDir,ext);
      if(!fs.statSync(extPath).isDirectory())continue;
      const extSkillsDir=path.join(extPath,'skills');
      if(!fs.existsSync(extSkillsDir))continue;
      for(const skillName of fs.readdirSync(extSkillsDir)){
        const skillMd=path.join(extSkillsDir,skillName,'SKILL.md');
        const pkgFile=path.join(extSkillsDir,skillName,'package.json');
        if(!fs.existsSync(skillMd))continue;
        const p=parseSkillMd(fs.readFileSync(skillMd,'utf8'));
        let ver='';
        if(fs.existsSync(pkgFile))try{ver=JSON.parse(fs.readFileSync(pkgFile,'utf8')).version||'';}catch{}
        addSkill(skillName,p.name||skillName,p.description,p.emoji||'🔌','extension',skillMd,ver,{extension:ext});
      }
    }
  }

  // 4. Custom skills (~/.openclaw/skills)
  const customDir=path.join(OPENCLAW_HOME,'skills');
  if(fs.existsSync(customDir)){
    for(const name of fs.readdirSync(customDir).sort()){
      const skillMd=path.join(customDir,name,'SKILL.md');
      const pkgFile=path.join(customDir,name,'package.json');
      if(!fs.existsSync(skillMd))continue;
      const p=parseSkillMd(fs.readFileSync(skillMd,'utf8'));
      let ver='';
      if(fs.existsSync(pkgFile))try{ver=JSON.parse(fs.readFileSync(pkgFile,'utf8')).version||'';}catch{}
      addSkill(name,p.name||name,p.description,p.emoji||'🎨','custom',skillMd,ver);
    }
  }

  // 5. Workspace skills (per-agent)
  try{
    const config=JSON.parse(fs.readFileSync(path.join(OPENCLAW_HOME,'openclaw.json'),'utf8'));
    const agentList=config.agents?.list||[];
    for(const agent of agentList){
      if(!agent.workspace)continue;
      const wsSkillsDir=path.join(agent.workspace,'skills');
      if(!fs.existsSync(wsSkillsDir))continue;
      for(const name of fs.readdirSync(wsSkillsDir).sort()){
        const skillMd=path.join(wsSkillsDir,name,'SKILL.md');
        if(!fs.existsSync(skillMd))continue;
        const p=parseSkillMd(fs.readFileSync(skillMd,'utf8'));
        const existing=skills.find(s=>s.id===name);
        if(existing){existing.usedBy.push(agent.id);}
        else{addSkill(name,p.name||name,p.description,p.emoji||'📁','workspace',skillMd,'',{usedBy:[agent.id]});}
      }
    }
  }catch{}

  // 6. Shared skills (from registry.json) — enrich with registry metadata
  const r=reg();
  if(r&&r.skills){
    for(const[slug,info]of Object.entries(r.skills)){
      const existing=skills.find(s=>s.id===slug);
      if(existing){
        // Enrich existing skill with registry data (category, dependencies, etc.)
        existing.category=info.category||'other';
        existing.dependencies=info.dependencies||[];
        existing.hasMeta=info.hasMeta||false;
        existing.hasOrigin=info.hasOrigin||false;
        existing.contentHash=info.contentHash||'';
        existing.registrySource=typeof info.source==='object'?info.source.type:(info.source||'local');
        existing.sharedPath=info.path||'';
      }else{
        // Skill only in registry (not in builtin/extension/custom/workspace)
        addSkill(slug,info.name||slug,info.description||'',info.emoji||'📦',
          typeof info.source==='object'?info.source.type:(info.source||'shared'),
          info.path||'',info.version||'0.0.0',
          {category:info.category||'other',dependencies:info.dependencies||[],hasMeta:info.hasMeta||false,hasOrigin:info.hasOrigin||false,contentHash:info.contentHash||'',sharedPath:info.path||''});
      }
    }
  }

  // ClawdHub install status
  const clawhubLockPath=path.join(OPENCLAW_HOME,'shared-skills/.clawhub/lock.json');
  if(fs.existsSync(clawhubLockPath)){
    try{
      const lockData=JSON.parse(fs.readFileSync(clawhubLockPath,'utf8'));
      if(lockData.skills){
        const installed=new Set(Object.keys(lockData.skills));
        skills.forEach(s=>{
          if(installed.has(s.id)){s.clawhubInstalled=true;s.clawhubUrl=`https://clawhub.com/skills/${s.id}`;}
          else if(s.source==='builtin'){s.clawhubUrl=`https://clawhub.com/skills/${s.id}`;s.clawhubInstalled=false;}
        });
      }
    }catch{}
  }

  // Service status (MCP skills with running services)
  const serviceSkills={
    'xiaohongshu-mcp':{port:18060},
    'douyin-mcp':{port:18061},
    'wechat-video-mcp':{port:18062}
  };
  for(const s of skills){
    const svc=serviceSkills[s.id];
    if(svc){
      s.needsService=true;
      s.servicePort=svc.port;
      try{const r=execSync(`curl -s --max-time 2 http://127.0.0.1:${svc.port}/health`,{encoding:'utf8',timeout:3000});s.serviceRunning=r.includes('ok')||r.includes('success');}catch{s.serviceRunning=false;}
    }else{
      s.needsService=false;
      s.serviceRunning=null;
    }
    // Derive status: enabled = has SKILL.md and is accessible
    s.status=s.serviceRunning===true?'running':s.needsService?'stopped':'available';
  }

  return skills;
}

function handleRequest(req,res){
  const url=req.url.replace(/\?.*$/,''),m=req.method;
  if(m==='OPTIONS'){cors(res);res.writeHead(204);res.end();return true;}

  // GET /api/skills — full scan from all sources
  if(url==='/api/skills'&&m==='GET'){
    cors(res);res.writeHead(200,{'Content-Type':'application/json'});
    try{
      const skills=cachedSkills();
      // Compute source/category stats
      const srcStats={},catStats={};
      for(const s of skills){
        srcStats[s.source]=(srcStats[s.source]||0)+1;
        const cat=s.category||'other';
        catStats[cat]=(catStats[cat]||0)+1;
      }
      res.end(JSON.stringify({total:skills.length,sources:srcStats,categories:catStats,skills}));
    }catch(e){res.end(JSON.stringify({skills:[],error:e.message}));}
    return true;
  }

  // GET /api/skills/overview
  if(url==='/api/skills/overview'&&m==='GET'){
    cors(res);res.writeHead(200,{'Content-Type':'application/json'});
    try{
      res.end(JSON.stringify(cachedOverview()));
    }catch(e){res.end(JSON.stringify({error:e.message}));}
    return true;
  }

  // GET /api/skills/health (must be before /api/skills/:slug)
  if(url==='/api/skills/health'&&m==='GET'){cors(res);res.writeHead(200,{'Content-Type':'application/json'});const result=py('list --format json');res.end(JSON.stringify(result));return true;}

  // GET /api/skills/size (must be before /api/skills/:slug)
  if(url==='/api/skills/size'&&m==='GET'){cors(res);res.writeHead(200,{'Content-Type':'application/json'});try{res.end(JSON.stringify(cachedSizes()));}catch(e){res.end(JSON.stringify({error:e.message}));}return true;}

  // GET /api/skills/export?format= (must be before /api/skills/:slug)
  if(url.startsWith('/api/skills/export')&&m==='GET'){cors(res);res.writeHead(200,{'Content-Type':'application/json'});const f=new URL(req.url,'http://localhost').searchParams.get('format')||'json';res.end(JSON.stringify(py(`export --format ${f}`)));return true;}

  // GET requests to POST-only endpoints → 405 (避免被 :slug 路由误捕获返回 200+error)
  const POST_ONLY_PATHS=['/api/skills/registry','/api/skills/deps','/api/skills/outdated','/api/skills/check','/api/skills/verify','/api/skills/verify-fix','/api/skills/init','/api/skills/enrich'];
  if(m==='GET'&&POST_ONLY_PATHS.includes(url)){cors(res);res.writeHead(405,{'Content-Type':'application/json','Allow':'POST'});res.end(JSON.stringify({error:'Method Not Allowed',allowed:'POST'}));return true;}

  // GET /api/skills/:slug
  const sm=url.match(/^\/api\/skills\/([\w-]+)$/);
  if(sm&&m==='GET'){
    cors(res);const slug=sm[1];res.writeHead(200,{'Content-Type':'application/json'});
    try{
      const skills=cachedSkills();
      const info=skills.find(s=>s.id===slug);
      if(!info){res.end(JSON.stringify({error:`'${slug}' not found`}));return true;}
      // Try to get size from shared path or location dir
      const sizePath=info.sharedPath||path.dirname(info.location||'');
      const size=fs.existsSync(sizePath)?dsize(sizePath):{total:0,nodeModules:0,core:0};
      let meta=null,md=null;
      if(info.sharedPath){
        try{meta=JSON.parse(fs.readFileSync(path.join(info.sharedPath,'_meta.json'),'utf8'));}catch{}
        try{md=fs.readFileSync(path.join(info.sharedPath,'SKILL.md'),'utf8');}catch{}
      }else if(info.location){
        try{md=fs.readFileSync(info.location,'utf8');}catch{}
      }
      res.end(JSON.stringify({...info,meta,skillMd:md,size}));
    }catch(e){res.end(JSON.stringify({error:e.message}));}
    return true;
  }

  // GET /api/skills/:slug/content
  const cm=url.match(/^\/api\/skills\/([\w-]+)\/content$/);
  if(cm&&m==='GET'){cors(res);const slug=cm[1];res.writeHead(200,{'Content-Type':'application/json'});const r=reg(),info=r?.skills?.[slug];if(!info){res.end(JSON.stringify({error:'not found'}));return true;}try{res.end(JSON.stringify({slug,content:fs.readFileSync(path.join(info.path,'SKILL.md'),'utf8')}));}catch{res.end(JSON.stringify({error:'read failed'}));}return true;}

  // GET /api/skills/:slug/size
  const szm=url.match(/^\/api\/skills\/([\w-]+)\/size$/);
  if(szm&&m==='GET'){cors(res);const slug=szm[1];res.writeHead(200,{'Content-Type':'application/json'});const r=reg(),info=r?.skills?.[slug];if(!info){res.end(JSON.stringify({error:'not found'}));return true;}res.end(JSON.stringify({slug,...dsize(info.path)}));return true;}

  // POST endpoints
  const postRoutes={
    '/api/skills/verify':()=>py('verify'),
    '/api/skills/verify-fix':()=>runSkillMutation('verify --fix'),
    '/api/skills/outdated':()=>py('outdated'),
    '/api/skills/deps':()=>cachedDeps(),
    '/api/skills/check':()=>py('check',60000),
    '/api/skills/registry':()=>runSkillMutation('registry'),
    '/api/skills/init':()=>py('init --force'),
    '/api/skills/enrich':()=>runSkillMutation('enrich'),
  };

  // POST /api/skills/check/:slug — check single skill upstream
  const ckm=url.match(/^\/api\/skills\/check\/([\w-]+)$/);
  if(ckm&&m==='POST'){cors(res);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(py(`check ${ckm[1]}`,30000)));return true;}

  // POST /api/skills/verify/:slug — verify single skill
  const vsm=url.match(/^\/api\/skills\/verify\/([\w-]+)$/);
  if(vsm&&m==='POST'){cors(res);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(py(`verify ${vsm[1]}`,30000)));return true;}

  if(postRoutes[url]&&m==='POST'){cors(res);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(postRoutes[url]()));return true;}

  // POST /api/skills/bump/:slug/:component
  const bm=url.match(/^\/api\/skills\/bump\/([\w-]+)\/(major|minor|patch)$/);
  if(bm&&m==='POST'){cors(res);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(runSkillMutation(`bump ${bm[1]} ${bm[2]}`)));return true;}

  // POST /api/skills/sync/:slug
  const sym=url.match(/^\/api\/skills\/sync\/([\w-]+)$/);
  if(sym&&m==='POST'){cors(res);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(runSkillMutation(`sync ${sym[1]}`)));return true;}

  return false;
}

module.exports = { handleRequest };
