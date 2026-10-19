/**
 * config-recovery/routes.cjs
 * 配置恢复中心 — 独立模块路由
 * 
 * 功能域：灾备备份 + JSON编辑 + 变更追踪审计 + 概览面板
 * 位置：~/.openclaw/software/config-recovery/
 * 
 * 用法：server.js 中 require('../software/config-recovery/routes')
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ===== 模块路径 =====
const MODULE_ROOT = __dirname; // ~/.openclaw/software/config-recovery
const OPENCLAW_ROOT = process.env.OPENCLAW_ROOT || path.join(os.homedir(), '.openclaw');
const CONFIG_FILE = path.join(OPENCLAW_ROOT, 'openclaw.json');
const BACKUP_DIR = path.join(MODULE_ROOT, 'backups');           // 备份文件目录
const TRACKER_DIR = path.join(MODULE_ROOT, 'tracker');         // 追踪数据库目录
const DB_PATH = path.join(TRACKER_DIR, 'config-tracker.db');
const EMBED_HTML = path.join(MODULE_ROOT, 'public', 'config-center-embed.html');

// ===== SQLite / Fallback DB =====
let _db = null;
function getDb() {
  if (_db) return _db;
  try {
    const Database = require('better-sqlite3');
    if (!fs.existsSync(TRACKER_DIR)) fs.mkdirSync(TRACKER_DIR, { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    initSchema(_db);
    return _db;
  } catch (e) {
    console.warn('[config-recovery] better-sqlite3 not available, using JSON fallback');
    _db = new JsonFallbackDb(DB_PATH);
    initSchema(_db);
    return _db;
  }
}

function initSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS config_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      change_type TEXT NOT NULL,
      key_path TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      source TEXT DEFAULT 'unknown',
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      reverted_at DATETIME,
      backup_id TEXT);
    CREATE INDEX IF NOT EXISTS idx_changes_session ON config_changes(session_id);
    CREATE INDEX IF NOT EXISTS idx_changes_type ON config_changes(change_type);`);
}

class JsonFallbackDb {
  constructor(dbPath) { this.jp = dbPath.replace('.db', '-data.json'); this._d = { cc: [], _seq: 0 }; if (fs.existsSync(this.jp)) try { this._d = JSON.parse(fs.readFileSync(this.jp)); } catch {} }
  exec() {}
  prepare(sql) {
    const s = this;
    return {
      run(...a) {
        if (sql.includes('INSERT')) { const id=++s._d._seq; s._d.cc.push({id,session_id:a[0],change_type:a[1],key_path:a[2],old_value:a[3],new_value:a[4],source:a[5]||'unknown',created_at:new Date().toISOString().replace('T',' ').replace(/\.\d+Z$/,''),reverted_at:null}); s._save(); return{lastInsertRowid:id}; }
        if(sql.includes('UPDATE')&&sql.includes('reverted_at')){const r=s._d.cc.find(r=>r.id===a[0]);if(r){r.reverted_at=new Date().toISOString();s._save();}return{changes:r?1:0};}
        return{};
      },
      get(...a){if(sql.includes('WHERE id='))return s._d.cc.find(r=>r.id===a[0])||undefined;return undefined},
      all(...a){
        let rows=[...s._d.cc];if(a[0])rows=rows.filter(r=>r.change_type===a[0]);if(a[1])rows=rows.filter(r=>r.key_path.includes(a[1]));if(a[2]){const c=new Date();c.setDate(c.getDate()-parseInt(a[2]));rows=rows.filter(r=>new Date(r.created_at)>=c);}
        rows=rows.filter(r=>!r.reverted_at).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
        return rows.slice(0,200);
      }
    };
  }
  _save(){try{fs.writeFileSync(this.jp,JSON.stringify(this._d,null,2))}catch{}}
}

// ===== Config Read/Write =====
function readConfigRaw() { return fs.readFileSync(CONFIG_FILE, 'utf8'); }
function readConfigObj() { return JSON.parse(readConfigRaw()); }
function atomicWriteJSON(filePath, data) {
  const tmpFile = filePath + '.tmp.' + Date.now();
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpFile, filePath);
}
function writeConfigObj(obj) { atomicWriteJSON(CONFIG_FILE, obj); }

// ===== Deep Diff =====
function deepDiff(o,n,p='') { const ch=[]; const ks=new Set([...Object.keys(o||{}),...Object.keys(n||{})]);
  for(const k of ks){ const fp=p?p+'.'+k:k; const io=o&&k in o, inN=n&&k in n;
    if(!io&&inN)ch.push({t:'field_add',p:fp,oV:null,nV:JSON.stringify(n[k])});
    else if(io&&!inN)ch.push({t:'field_delete',p:fp,oV:JSON.stringify(o[k]),nV:null});
    else{
      const ov=o[k], nv=n[k];
      if(typeof ov!==typeof nv||ov===null||nv===null||Array.isArray(ov)||typeof ov!=='object'){
        const oJ=JSON.stringify(ov), nJ=JSON.stringify(nv);
        if(oJ!==nJ){let ct='field_update';if(k==='list'&&Array.isArray(ov)&&Array.isArray(nv)){const oN=(ov||[]).map(a=>a.name||a.id||''),nN=(nv||[]).map(a=>a.name||a.id||'');const a=nN.filter(x=>!oN.includes(x)),r=oN.filter(x=>!nN.includes(x));if(a.length>0&&r.length===0)ct='agent_create';else if(r.length>0&&a.length===0)ct='agent_delete';}
        ch.push({t:ct,p:fp,oV:oJ,nV:nJ});}
      }else ch.push(...deepDiff(ov,nv,fp));
    }}
  return ch;
}

// ===== Backup Helpers =====
function ensureDir(d){if(!fs.existsSync(d))fs.mkdirSync(d,{recursive:true});}
function listBackups(){
  ensureDir(BACKUP_DIR); const f=fs.readdirSync(BACKUP_DIR).filter(x=>x.endsWith('.json')).sort().reverse();
  return f.map(fn=>{const st=fs.statSync(path.join(BACKUP_DIR,fn)); return{fn,time:new Date(st.mtime).toISOString().replace('T',' ').replace(/\.\d+Z$/,''),sz:fmt(st.size)};}).slice(0,30);
}
function fmt(b){if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';return(b/1048576).toFixed(1)+' MB';}
function createBackup(label){
  ensureDir(BACKUP_DIR);
  const raw=fs.readFileSync(CONFIG_FILE,'utf8');
  const all=fs.readdirSync(BACKUP_DIR).filter(x=>x.endsWith('.json')).sort().reverse();
  let prevObj=null;
  if(all.length>0){
    const last=path.join(BACKUP_DIR,all[0]);
    const lastRaw=fs.readFileSync(last,'utf8');
    try{if(lastRaw===raw)return null;}catch(e){}
    try{prevObj=JSON.parse(lastRaw);}catch(e){}
  }
  let curObj=null; try{curObj=JSON.parse(raw);}catch(e){}
  // auto-track changes via diff
  if(prevObj&&curObj){
    const diff=deepDiff(prevObj,curObj);
    if(diff.length>0){
      try{
        const db=getDb();const sid='auto-'+Date.now();
        const ins=db.prepare("INSERT INTO config_changes(session_id,change_type,key_path,old_value,new_value,source) VALUES(?,?,?,?,?,?)");
        diff.forEach(d=>ins.run(sid,d.t,d.p,String(d.oV||''),String(d.nV||''),label||'auto-backup'));
      }catch(e){}
    }
  }
  const ts=new Date().toISOString().replace(/[:.]/g,'-').replace('T','_').replace('Z','');
  const fn=`openclaw-config-${ts}${label?'-'+label:''}.json`;
  fs.writeFileSync(path.join(BACKUP_DIR,fn),raw);
  const all2=fs.readdirSync(BACKUP_DIR).filter(x=>x.endsWith('.json')).sort();
  while(all2.length>5){fs.unlinkSync(path.join(BACKUP_DIR,all2.shift()));}
  return fn;
}

// ===== Nested value setter =====
function setVal(obj,kp,val){
  const parts=kp.split('.'); let cur=obj;
  for(let i=0;i<parts.length-1;i++){
    const p=parts[i]; const m=p.match(/^(.+)\[(\d+)\]$/);
    if(m){if(!cur[m[1]])cur[m[1]]=[];if(!cur[m[1]][m[2]])cur[m[1]][m[2]]={};cur=cur[m[1]][m[2]];}
    else{if(!cur[p])cur[p]={};cur=cur[p];}
  }
  const lp=parts[parts.length-1]; const lm=lp.match(/^(.+)\[(\d+)\]$/);
  if(lm){if(!cur[lm[1]])cur[lm[1]]=[];if(val===undefined)cur[lm[1]].splice(lm[2],1);else cur[lm[1]][lm[2]]=val;}
  else{if(val===undefined)delete cur[lp];else cur[lp]=val;}
}

// ===== Response helpers =====
function sendJson(res,d,c){try{res.writeHead(c||200,{'Content-Type':'application/json;charset=utf-8'});res.end(JSON.stringify(d));}catch{}}
function sendHTML(res,h,c){res.writeHead(c||200,{'Content-Type':'text/html;charset=utf-8'});res.end(h);}

// ===== Main handler =====
function handleRequest(req,res){
  const url=req.url.replace(/\?.*$/,''),method=req.method;

  // Serve embed HTML page
  if(url==='/api/config-center/page'||url==='/config-center-embed.html'||url==='/config-center-embed.html'){
    if(fs.existsSync(EMBED_HTML)){sendHTML(res,fs.readFileSync(EMBED_HTML,'utf8'));return true;}
    sendJson(res,{error:'page not found'},404);return true;
  }

  // Only handle /api/config-center/* requests


// ===== Field Mapping API =====
const MAPPING_FILE = path.join(MODULE_ROOT, 'field-mapping.json');

function loadMapping() {
  try {
    if (!fs.existsSync(MAPPING_FILE)) return { version: '1.0', mappings: {}, availableModels: [], mappingModel: '' };
    return JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));
  } catch (e) {
    return { version: '1.0', mappings: {}, availableModels: [], mappingModel: '' };
  }
}

function saveMapping(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(MAPPING_FILE, JSON.stringify(data, null, 2), 'utf8');
}

async function callLLMForMapping(configObj, existingMapping) {
  const model = existingMapping.mappingModel || 'cliproxy/minimax-m2.5-pro';
  const gatewayUrl = 'http://127.0.0.1:18789/v1/chat/completions';
  const gatewayToken = 'leon123';

  const prompt = `分析以下 OpenClaw 配置文件结构，生成字段路径与功能的映射关系。

配置内容（精简版）：
\`\`\`json
${JSON.stringify(configObj, null, 2).slice(0, 4000)}
\`\`\`

请返回 JSON 格式的映射表更新，格式：
{
  "字段路径": {
    "name": "字段名称",
    "description": "功能描述",
    "category": "分类",
    "impact": "影响说明"
  }
}

只返回新增或需要更新的映射。`;

  try {
    const resp = await new Promise((resolve, reject) => {
      const req = http.request(gatewayUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${gatewayToken}`
        },
        timeout: 30000
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('LLM timeout')); });
      req.write(JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3
      }));
      req.end();
    });

    if (resp.choices && resp.choices[0] && resp.choices[0].message) {
      const content = resp.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    }
    return {};
  } catch (e) {
    console.error('LLM call failed:', e.message);
    return {};
  }
}

  // Field Mapping Routes
  if (url === '/api/config-center/mapping' && method === 'GET') {
    sendJson(res, { ok: true, mapping: loadMapping() });
    return true;
  }

  // ===== Model Config API =====
  if (url === '/api/config-center/mapping/models' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { id, name, provider } = JSON.parse(body);
        if (!id || !name) { sendJson(res, { ok: false, error: 'missing fields' }, 400); return true; }
        const mp = loadMapping();
        if (mp.availableModels.find(m => m.id === id)) { sendJson(res, { ok: false, error: 'model exists' }, 400); return true; }
        mp.availableModels.push({ id, name, provider: provider || 'cliproxy' });
        saveMapping(mp);
        sendJson(res, { ok: true });
      } catch (e) { sendJson(res, { ok: false, error: e.message }, 500); }
    });
    return true;
  }

  if (url.match(/^\/api\/config-center\/mapping\/models\//) && method === 'DELETE') {
    const mid = decodeURIComponent(url.split('/')[5]);
    const mp = loadMapping();
    mp.availableModels = mp.availableModels.filter(m => m.id !== mid);
    saveMapping(mp);
    sendJson(res, { ok: true });
    return true;
  }

  if (url === '/api/config-center/mapping/update' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { model } = JSON.parse(body);
        const cfgRaw = fs.readFileSync(CONFIG_FILE, 'utf8');
        const cfg = JSON.parse(cfgRaw);
        const mp = loadMapping();

        // 精简配置：只提取 key 结构，不发完整值（避免 prompt 过大超时）
        function extractKeys(obj, prefix) {
          const result = [];
          for (const [k, v] of Object.entries(obj || {})) {
            const path = prefix ? prefix + '.' + k : k;
            if (v && typeof v === 'object' && !Array.isArray(v)) {
              result.push({ path, type: 'object' });
              result.push(...extractKeys(v, path));
            } else if (Array.isArray(v)) {
              result.push({ path, type: 'array', length: v.length });
              if (v[0] && typeof v[0] === 'object') result.push(...extractKeys(v[0], path + '[0]'));
            } else {
              const val = String(v).length > 50 ? String(v).substring(0, 50) + '...' : v;
              result.push({ path, type: typeof v, value: val });
            }
          }
          return result;
        }
        const keysInfo = extractKeys(cfg, '');
        const prompt = `分析以下 openclaw.json 配置的 key 结构，生成字段映射表。
每个字段返回: key_path / name(中文名) / description(中文说明) / category(分类: 核心配置/模型/Agent/插件/服务/其他) / impact(影响范围: 高/中/低)

配置 key 结构（共${keysInfo.length}个字段）:
${keysInfo.map(k => `${k.path} [${k.type}]${k.value ? ' = ' + k.value : ''}${k.length ? ' (length:' + k.length + ')' : ''}`).join('\n')}

只返回 JSON 数组，不要其他文字。`;

        // cliproxy 不接受 provider/ 前缀，需要剥离
        const cleanModel = (model || 'minimax-m2.5-pro').replace(/^[^/]+\//, '');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000); // 120秒超时
        let cliproxyRes;
        const provider = JSON.parse(fs.readFileSync(path.join(MODULE_ROOT, 'provider.local.json'), 'utf8'));
        if (!provider.baseUrl || !provider.apiKey) throw new Error('Configure the private local provider before generating field mappings');
        try {
          cliproxyRes = await fetch(provider.baseUrl.replace(/\/$/, '') + '/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + provider.apiKey },
            body: JSON.stringify({
              model: cleanModel,
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.3
            }),
            signal: controller.signal
          });
        } finally { clearTimeout(timeout); }
        if (!cliproxyRes.ok) {
          const errText = await cliproxyRes.text();
          throw new Error('cliproxy API error ' + cliproxyRes.status + ': ' + errText.substring(0, 200));
        }
        const gwData = await cliproxyRes.json();
        const content = gwData.choices?.[0]?.message?.content || '';

        let newMappings = {};
        try {
          const jsonMatch = content.match(/\[\s*\{[\s\S]*\}\s*\]/);
          if (jsonMatch) {
            const arr = JSON.parse(jsonMatch[0]);
            arr.forEach(item => { if (item.key_path) newMappings[item.key_path] = item; });
          }
        } catch (e) {}

        Object.assign(mp.mappings, newMappings);
        mp.lastUpdated = new Date().toISOString();
        saveMapping(mp);

        sendJson(res, { ok: true, mapping: mp });
      } catch (e) { sendJson(res, { ok: false, error: e.message }, 500); }
    });
    return true;
  }


  if (url === '/api/config-center/models' && method === 'GET') {
    const m = loadMapping();
    sendJson(res, { ok: true, models: m.availableModels || [], mappingModel: m.mappingModel || '' });
    return true;
  }

  if (url === '/api/config-center/models' && method === 'POST') {
    try {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const m = loadMapping();
          if (data.models) m.availableModels = data.models;
          if (data.mappingModel) m.mappingModel = data.mappingModel;
          saveMapping(m);
          sendJson(res, { ok: true });
        } catch (e) { sendJson(res, { ok: false, error: e.message }, 500); }
      });
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 500); }
    return true;
  }

  // === Built-in Models from openclaw.json ===
  if (url === '/api/config-center/builtin-models' && method === 'GET') {
    try {
      const cfg = readConfigObj();
      const providers = cfg.models?.providers || {};
      const allModels = [];
      for (const [provName, provData] of Object.entries(providers)) {
        const models = provData.models || [];
        models.forEach(m => {
          allModels.push({
            id: `${provName}/${m.id}`,
            name: m.name || m.id,
            provider: provName,
            maxTokens: m.maxTokens || null
          });
        });
      }
      sendJson(res, { ok: true, models: allModels });
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 500); }
    return true;
  }

  // === Save mapping fields directly ===
  if (url === '/api/config-center/mapping/save' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { mappings } = JSON.parse(body);
        const mp = loadMapping();
        if (mappings && typeof mappings === 'object') {
          mp.mappings = mappings;
        }
        saveMapping(mp);
        sendJson(res, { ok: true, mapping: mp });
      } catch (e) { sendJson(res, { ok: false, error: e.message }, 500); }
    });
    return true;
  }

  if(!url.startsWith('/api/config-center/'))return false;

  // === Backups ===
  if(url==='/api/config-center/backups'&&method==='GET'){sendJson(res,{ok:true,backups:listBackups()});return true;}

  if(url==='/api/config-center/backups'&&method==='POST'){
    try{sendJson(res,{ok:true,fn:createBackup('manual')});}catch(e){sendJson(res,{ok:false,error:e.message},500);}return true;
  }

  if(url.match(/^\/api\/config-center\/backups\/[^/]+\/restore$/)&&method==='POST'){
    const fn=decodeURIComponent(url.split('/')[4]),src=path.join(BACKUP_DIR,fn);
    if(!fs.existsSync(src)){sendJson(res,{ok:false,error:'not found'},404);return true;}
    const db=getDb(),sid='r-'+Date.now();
    db.prepare("INSERT INTO config_changes(session_id,change_type,key_path,old_value,new_value,source) VALUES(?,?,?,?,?,?)")
      .run(sid,'backup_restore','openclaw.json',null,fn,'cc-restore');
    fs.copyFileSync(src,CONFIG_FILE);sendJson(res,{ok:true});
    try{execSync('systemctl --user restart openclaw-gateway.service',{timeout:5000});}catch{}
    return true;
  }

  // === Validate ===
  if(url==='/api/config-center/validate'&&method==='GET'){
    try{readConfigObj();sendJson(res,{ok:true});}catch(e){sendJson(res,{ok:false,error:e.message});}return true;
  }

  // === Overview Dashboard ===
  if(url==='/api/config-center/overview'&&method==='GET'){
    const o={};
    try{readConfigObj();o.config_valid=true;}catch(e){o.config_valid=false;}
    try{const st=fs.statSync(CONFIG_FILE);o.file_size=fmt(st.size);o.last_modified=new Date(st.mtime).toISOString().slice(0,16).replace('T',' ');}
    catch{o.file_size='?';o.last_modified='-';}
    ensureDir(BACKUP_DIR);const bk=listBackups();o.backup_count=bk.length;o.has_backups=bk.length>0;o.can_restore=bk.length>0;o.latest_backup=bk[0]||null;
    o.backups_dir_ok=true;o.backups=bk.slice(0,5);
    let hp=100;const deductions=[];
    if(!o.has_backups){hp-=30;deductions.push({pts:30,reason:'无备份文件',fix:'点击「备份副本」创建一份备份'});}
    else if(bk[0]){const ah=(Date.now()-new Date(bk[0].time))/36e5;if(ah>168){hp-=20;deductions.push({pts:20,reason:`最新备份已超过 ${Math.round(ah/24)} 天`,fix:'点击「备份副本」创建新备份'});}else if(ah>24){hp-=10;deductions.push({pts:10,reason:`最新备份已 ${Math.round(ah)} 小时前`,fix:'点击「备份副本」刷新备份'});}}
    if(o.config_valid===false){hp-=50;deductions.push({pts:50,reason:'配置文件格式有误',fix:'点击「校验副本」检查，或从备份恢复'});}
    o.health_pct=Math.max(0,Math.min(100,hp));o.health_deductions=deductions;
    try{execSync('systemctl --user is-enabled openclaw-gateway.service',{timeout:3000});o.gateway_autostart=true;}catch{o.gateway_autostart=false;}
    try{const cj=JSON.parse(fs.readFileSync(path.join(OPENCLAW_ROOT,'cron','jobs.json'),'utf8'));o.auto_backup_enabled=Array.isArray(cj.jobs)?cj.jobs.some(j=>(j.payload&&((j.payload.text||'').includes('backup')||(j.payload.message||'').includes('backup')))||(j.command||'').includes('backup')):false}catch{o.auto_backup_enabled=false;}
    o.tracker_db_exists=fs.existsSync(DB_PATH)||fs.existsSync(DB_PATH.replace('.db','-data.json'));
    try{
      const db=getDb();
      if(db instanceof JsonFallbackDb)o.today_changes=db._d.cc.filter(r=>!r.reverted_at&&r.created_at&&r.created_at.startsWith(new Date().toISOString().slice(0,10))).length;
      else{o.today_changes=db.prepare("SELECT COUNT(*) as c FROM config_changes WHERE reverted_at IS NULL AND date(created_at)=?").get(new Date().toISOString().slice(0,10)).c;}
    }catch{o.today_changes=0;}
    sendJson(res,o);return true;
  }

  // === Raw Config ===
  if(url==='/api/config-center/raw'&&method==='GET'){
    res.writeHead(200,{'Content-Type':'text/plain;charset=utf-8'});res.end(readConfigRaw());return true;
  }

  // === Save Config (with diff tracking) ===
  if(url==='/api/config-center/save'&&method==='POST'){
    let body='';
    req.on('data',c=>body+=c.toString());
    req.on('end',()=>{
      try{
        const{content,source}=JSON.parse(body);if(!content)return sendJson(res,{ok:false,error:'empty'},400);
        let newObj;try{newObj=JSON.parse(content)}catch(e){return sendJson(res,{ok:false,error:'bad json: '+e.message},400)}
        let oldObj;try{oldObj=readConfigObj()}catch{oldObj={}}
        createBackup('pre-save');
        const diff=deepDiff(oldObj,newObj);const db=getDb();const sid='edit-'+Date.now();let rc=0;
        if(diff.length>0){
          const ins=db.prepare("INSERT INTO config_changes(session_id,change_type,key_path,old_value,new_value,source) VALUES(?,?,?,?,?,?)");
          diff.forEach(d=>{ins.run(sid,d.t,d.p,d.oV,d.nV,source||'cc-editor');rc++});
        }
        writeConfigObj(newObj,content);
        try{execSync('systemctl --user restart openclaw-gateway.service',{timeout:5000});}catch{}
        sendJson(res,{ok:true,changesRecorded:rc,sessionId:sid});
      }catch(e){sendJson(res,{ok:false,error:e.message},500);}
    });
    return true;
  }

  // === Change List ===
  if(url==='/api/config-center/changes'&&method==='GET'){
    try{
      const q=new URL(req.url,'http://l').searchParams;const t=q.get('type')||'',k=q.get('key')||'',d=q.get('days')||'';const db=getDb();let rows;
      if(db instanceof JsonFallbackDb)rows=db.prepare('').all(t,k,d||null);
      else{
        let sql="SELECT * FROM config_changes WHERE reverted_at IS NULL",pa=[];
        if(t){sql+=" AND change_type=?";pa.push(t);}if(k){sql+=" AND key_path LIKE ?";pa.push('%'+k+'%');}
        if(d){sql+=" AND created_at>=datetime('now','-'||?||' days','localtime')";pa.push(d);}
        sql+=' ORDER BY created_at DESC LIMIT 200';rows=db.prepare(sql).all(...pa);
      }
      sendJson(res,(rows||[]).map(r=>({...r,oV:r.old_value?(String(r.old_value)).substring(0,200):null,nV:r.new_value?(String(r.new_value)).substring(0,200):null})));
    }catch(e){sendJson(res,[e.message]);}
    return true;
  }

  // === Stats ===
  if(url==='/api/config-center/stats'&&method==='GET'){
    try{
      const db=getDb(),td=new Date().toISOString().slice(0,10);
      let tot,tod,wk,ses;
      if(db instanceof JsonFallbackDb){
        const a=db._d.cc.filter(r=>!r.reverted_at);tot=a.length;tod=a.filter(r=>r.created_at&&r.created_at.startsWith(td)).length;
        const wkAgo=new Date();wkAgo.setDate(wkAgo.getDate()-7);wk=a.filter(r=>new Date(r.created_at)>=wkAgo).length;ses=new Set(a.map(r=>r.session_id)).size;
      }else{
        tot=db.prepare("SELECT COUNT(*) as c FROM config_changes WHERE reverted_at IS NULL").get().c;
        tod=db.prepare("SELECT COUNT(*) as c FROM config_changes WHERE reverted_at IS NULL AND date(created_at)=?").get(td).c;
        wk=db.prepare("SELECT COUNT(*) as c FROM config_changes WHERE reverted_at IS NULL AND created_at>=datetime('now','-7 days','localtime')").get().c;
        ses=db.prepare("SELECT COUNT(DISTINCT session_id) as c FROM config_changes WHERE reverted_at IS NULL").get().c;
      }
      sendJson(res,{total:tot,today:tod,week:wk,sessions:ses});
    }catch(e){sendJson(res,{total:0,today:0,week:0,sessions:0});}
    return true;
  }

  // === Revert single change ===
  if(url.match(/^\/api\/config-center\/changes\/\d+\/revert$/)&&method==='POST'){
    try{
      const cid=parseInt(url.split('/')[4]),db=getDb();
      const ch=db.prepare('SELECT*FROM config_changes WHERE id=?').get(cid);
      if(!ch)return sendJson(res,{ok:false,error:'not found'},404);
      if(ch.reverted_at)return sendJson(res,{ok:false,error:'already reverted'},400);
      const cur=readConfigObj();createBackup('pre-revert');
      try{setVal(cur,ch.key_path,ch.old_value?JSON.parse(ch.old_value):undefined);}catch{}
      writeConfigObj(cur);
      db.prepare("UPDATE config_changes SET reverted_at=datetime('now','localtime') WHERE id=?").run(cid);
      const ins=db.prepare("INSERT INTO config_changes(session_id,change_type,key_path,old_value,new_value,source) VALUES(?,?,?,?,?,?)");
      ins.run('rv-'+Date.now(),'backup_restore',ch.key_path,ch.new_value,ch.old_value,'cc-revert');
      try{execSync('systemctl --user restart openclaw-gateway.service',{timeout:5000});}catch{}
      sendJson(res,{ok:true});
    }catch(e){sendJson(res,{ok:false,error:e.message},500);}
    return true;
  }

  // === Revert session ===
  if(url.match(/^\/api\/config-center\/sessions\/[^/]+\/revert$/)&&method==='POST'){
    try{
      const sid=decodeURIComponent(url.split('/')[4]),db=getDb();
      let rows; if(db instanceof JsonFallbackDb)rows=db._d.cc.filter(r=>r.session_id===sid&&!r.reverted_at);
      else rows=db.prepare('SELECT*FROM config_changes WHERE session_id=? AND reverted_at IS NULL').all(sid);
      if(!rows.length)return sendJson(res,{ok:true,rv:0});
      const cur=readConfigObj();createBackup('pre-session-rv');
      for(let i=rows.length-1;i>=0;i--)try{setVal(cur,rows[i].key_path,rows[i].old_value?JSON.parse(rows[i].old_value):undefined);}catch{}
      writeConfigObj(cur);
      rows.forEach(ch=>{
        if(db instanceof JsonFallbackDb){const r=db._d.cc.find(x=>x.id===ch.id);if(r)r.reverted_at=new Date().toISOString();}
        else db.prepare("UPDATE config_changes SET reverted_at=datetime('now','localtime') WHERE id=?").run(ch.id);
      });if(db instanceof JsonFallbackDb)db._save();
      try{execSync('systemctl --user restart openclaw-gateway.service',{timeout:5000});}catch{}
      sendJson(res,{ok:true,rv:rows.length});
    }catch(e){sendJson(res,{ok:false,error:e.message},500);}
    return true;
  }

  return false;
}

module.exports={handleRequest};

process.on('SIGTERM', () => { try { if (_db && typeof _db.close === 'function') _db.close(); } catch (e) {} process.exit(0); });
process.on('SIGINT', () => { try { if (_db && typeof _db.close === 'function') _db.close(); } catch (e) {} process.exit(0); });
