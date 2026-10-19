#!/usr/bin/env python3
"""Offline privacy gate for the Git index and every commit reachable by pushed refs.
No network calls, dependencies, secret excerpts, automatic fixes, or file deletion.
"""
import argparse, hashlib, json, os, re, subprocess, sys
from pathlib import Path, PurePosixPath

MAX_BYTES = 8 * 1024 * 1024
PUBLIC_DOMAINS = {"example.com", "example.org", "example.invalid", "localhost", "github.com", "users.noreply.github.com"}
RULES = [
 ("private-key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
 ("provider-secret", re.compile(r"\b(?:sk-(?:proj-|ant-|or-v1-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{25,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b")),
 ("hardcoded-bearer", re.compile(r"Bearer[ \t]+(?![\$<{])[A-Za-z0-9._-]{6,}")),
 ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")),
 ("credential-url", re.compile(r"\b(?:https?|postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?)://[^/\s:@]+:[^/\s@]{3,}@")),
 ("private-address", re.compile(r"\b(?:192\.168(?:\.\d{1,3}){2}|10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b")),
 ("personal-path", re.compile(r"(?:/home/(?!(?:user|example|USERNAME)(?![A-Za-z0-9_.-]))[A-Za-z0-9_.-]+(?:/|\b)|[A-Z]:[\\/](?:Users|用户)[\\/](?!user[\\/]|example[\\/])[^\\/\s]+[\\/])")),
 ("private-platform-id", re.compile(r"\b(?:ou_[A-Za-z0-9]{20,}|cli_[A-Za-z0-9]{8,})\b")),
 ("phone-candidate", re.compile(r"(?<![A-Za-z0-9])(?:\+?86[- ]?)?1[3-9]\d{9}(?![A-Za-z0-9])")),
]
EMAIL = re.compile(r"(?<![\w.+-])[\w.+-]+@((?:[\w-]+\.)+[A-Za-z]{2,})(?![\w.-])")
SECRET_KEYS = {"password", "passwd", "token", "secret", "apikey", "apisecret", "accesstoken", "refreshtoken", "bottoken", "clientsecret", "appsecret", "privatekey", "authorization", "cookie"}
PLACEHOLDER = re.compile(r"^(?:|none|null|false|true|undefined|\*+|x+|<[^>]+>|your[-_ ].*|example.*|dummy.*|test(?:[-_].*)?|changeme|change[-_]?me|placeholder.*|redacted.*|\$\{.*\}|process\.env.*|os\.environ.*)$", re.I)
LITERAL = re.compile(r"""(?i)(?<![\w\\])["']?(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|bot[_-]?token|client[_-]?secret|app[_-]?secret)["']?\s*[:=]\s*["']([^"'\r\n]{6,})["']""")

def forbidden_path(name):
 p = PurePosixPath(name)
 parts = p.parts
 if not name or name.startswith("/") or ".." in parts:
  return "unsafe-path"
 if any(x in {"node_modules", "data", "backups", "tracker", "legacy-data", "_archive", "_probe", ".dbg", ".agentport-tmp", ".git", "__pycache__", "logs", "uploads", "downloads", "sessions", "credentials"} or x.startswith((".backup", "__ui_", ".venv")) for x in parts):
  return "private-runtime-path"
 if name.startswith("docs/") and name not in {"docs/PRIVACY.md", "docs/SETUP.md"}:
  return "unreviewed-internal-document"
 if name.startswith("sub-modules/applist/registry/") and p.name != ".gitkeep":
  return "private-host-registry"
 if p.name in {"config.json", "AGENTS.md", "AGENT.md", "CLAUDE.md", ".clinerules", ".cursorrules", ".windsurfrules", ".codex", "SOURCE-PROVENANCE.json", "WORKSPACE-MIGRATION.txt", "server.log"}:
  return "private-local-config-or-instructions"
 if (p.name.startswith(".env") and p.name not in {".env.example", ".env.sample"}) or p.suffix.lower() in {".db", ".sqlite", ".sqlite3", ".log", ".pem", ".key", ".p12", ".pfx", ".zip", ".gz"} or p.name.endswith(("-wal", "-shm")):
  return "private-file"
 if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf", ".woff", ".woff2", ".bin"}:
  return "unreviewed-binary"
 if (".local." in p.name and not p.name.endswith(".example.json")) or ".bak" in p.name or p.name.endswith("~"):
  return "private-local-or-backup-file"
 if p.suffix == ".pid" or name == "sub-modules/config-recovery/field-mapping.json":
  return "private-generated-state"
 if p.suffix == ".service":
  return "private-service-unit"
 return None

def text_of(data):
 try:
  if data.startswith((b"\xff\xfe\0\0", b"\0\0\xfe\xff")):
   return data.decode("utf-32")
  if data.startswith((b"\xff\xfe", b"\xfe\xff")):
   return data.decode("utf-16")
  if b"\0" in data:
   # NUL-containing inputs without a declared encoding are refused.
   return None
  return data.decode("utf-8-sig")
 except UnicodeError:
  return None

def content_findings(data, metadata=False):
 if len(data) > MAX_BYTES: return [(0, "file-too-large-to-review")]
 text = text_of(data)
 if text is None: return [(0, "binary-or-unsupported-encoding")]
 found = []
 for kind, pattern in RULES:
  for m in pattern.finditer(text):
   found.append((text.count("\n", 0, m.start()) + 1, kind))
 for m in EMAIL.finditer(text):
  domain=m.group(1).lower()
  if domain not in PUBLIC_DOMAINS and not domain.endswith(".users.noreply.github.com"):
   found.append((text.count("\n", 0, m.start()) + 1, "personal-email"))
 try: obj=json.loads(text)
 except (ValueError, RecursionError): obj=None
 def walk(value, keys=()):
  if isinstance(value, dict):
   for key, item in value.items():
    normalized=re.sub(r"[^a-z0-9]", "", key.lower())
    dependency_context=any(k in {"dependencies", "devDependencies", "optionalDependencies", "peerDependencies"} for k in keys)
    if normalized in SECRET_KEYS and isinstance(item, str):
     raw=item.strip()
     semver=dependency_context and bool(re.fullmatch(r"[\^~<>=*v\d.| -]+",raw))
     if raw and not semver and not PLACEHOLDER.fullmatch(raw):
      found.append((0, "credential-field"))
    walk(item, keys+(key,))
  elif isinstance(value, list):
   for item in value: walk(item, keys)
 if obj is not None:
  walk(obj)
 elif not metadata:
  for m in LITERAL.finditer(text):
   value=m.group(1).strip()
   # UI field captions are not passwords.
   caption=re.sub(r"[^a-z0-9\u4e00-\u9fff]", "", value.casefold()) in {"password", "apikey", "api密钥", "密码"}
   if not caption and not PLACEHOLDER.fullmatch(value):
    found.append((text.count("\n",0,m.start())+1,"literal-credential"))
 return sorted(set(found))

def run_git(root, *args, input=None, allow_failure=False):
 p=subprocess.run(["git","-C",str(root),*args],input=input,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 if p.returncode and not allow_failure: raise RuntimeError("Git inspection failed; no command output exposed")
 return p

def display_path(path):
 if any(p.search(path) for _,p in RULES) or EMAIL.search(path):
  return "[redacted-path-"+hashlib.sha256(path.encode("utf8",errors="replace")).hexdigest()[:12]+"]"
 return path

class Gate:
 def __init__(self, root):
  self.root=root;self.findings=set();self.blobs={};self.entries=0;self.commits=0
 def add(self,path,line,kind,scope):
  self.findings.add((display_path(path),line,kind,scope))
 def entry(self,path,mode,oid,scope):
  self.entries+=1
  reason=forbidden_path(path)
  if reason:self.add(path,0,reason,scope)
  if mode not in {"100644","100755"}:
   self.add(path,0,"symlink-or-submodule-not-permitted",scope);return
  if oid not in self.blobs:
   size=int(run_git(self.root,"cat-file","-s",oid).stdout)
   self.blobs[oid]=[(0,"file-too-large-to-review")] if size>MAX_BYTES else content_findings(run_git(self.root,"cat-file","blob",oid).stdout)
  for line,kind in self.blobs[oid]:self.add(path,line,kind,scope)
 def index(self):
  raw=run_git(self.root,"ls-files","--stage","-z").stdout
  for record in raw.split(b"\0"):
   if not record:continue
   header,path=record.split(b"\t",1);mode,oid,stage=header.decode().split()
   path=path.decode("utf8",errors="surrogateescape")
   if stage!="0":self.add(path,0,"unmerged-index","index");continue
   self.entry(path,mode,oid,"index")
 def history(self,revisions):
  if not revisions:return
  commits=run_git(self.root,"rev-list",*revisions).stdout.decode().splitlines()
  for oid in dict.fromkeys(commits):
   self.commits+=1
   meta=run_git(self.root,"cat-file","commit",oid).stdout
   for line,kind in content_findings(meta,metadata=True):self.add("commit:"+oid[:12],line,kind,"history")
   records=run_git(self.root,"ls-tree","-rz","--full-tree",oid).stdout
   for record in records.split(b"\0"):
    if not record:continue
    header,path=record.split(b"\t",1);mode,kind,obj=header.decode().split()
    self.entry(path.decode("utf8",errors="surrogateescape"),mode,obj,"history")
  # Annotated tag identities/messages are publication metadata too.
  for oid in run_git(self.root,"for-each-ref","--format=%(objectname)","refs/tags").stdout.decode().splitlines():
   if run_git(self.root,"cat-file","-t",oid).stdout.strip()==b"tag":
    for line,kind in content_findings(run_git(self.root,"cat-file","tag",oid).stdout,metadata=True):
     self.add("tag:"+oid[:12],line,kind,"history")

def main(argv=None):
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument("--staged", action="store_true",help="Check exactly the Git index")
 parser.add_argument("--history", action="store_true",help="Check every reachable commit and tag")
 parser.add_argument("--pre-push", action="store_true",help="Read Git pre-push ref updates on stdin")
 parser.add_argument("--repo", default=".")
 args=parser.parse_args(argv)
 try:
  root=Path(run_git(args.repo,"rev-parse","--show-toplevel").stdout.decode().strip())
  gate=Gate(root);gate.index()
  revisions=[]
  if args.pre_push:
   for line in sys.stdin:
    fields=line.split()
    if len(fields)!=4:raise RuntimeError("Malformed pre-push update")
    local_oid=fields[1]
    if not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})",local_oid):raise RuntimeError("Malformed object ID")
    if set(local_oid)!={"0"}:revisions.append(local_oid)
  elif args.history or not args.staged:
   revisions=["--all"]
  gate.history(revisions)
  for path,line,kind,scope in sorted(gate.findings):
   print(f"{scope}:{path}:{line}: {kind}")
  print(json.dumps({"status":"FAIL" if gate.findings else "PASS","indexAndTreeEntries":gate.entries,"uniqueBlobs":len(gate.blobs),"commits":gate.commits,"findingCount":len(gate.findings)}))
  return 1 if gate.findings else 0
 except Exception:
  print("Privacy gate could not complete; push blocked. No sensitive values printed.",file=sys.stderr)
  return 2
if __name__=="__main__":
 sys.exit(main())
