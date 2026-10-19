#!/usr/bin/env python3
"""Regression tests use throwaway local repositories and synthetic secrets only."""
import importlib.util, json, os, subprocess, tempfile, unittest
from pathlib import Path
GATE=Path(__file__).resolve().parents[1]/"scripts/check-privacy.py"
spec=importlib.util.spec_from_file_location("privacy_gate",GATE)
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)

class GateTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix="cockpit-privacy-test-")
  self.repo=Path(self.temp.name)
  self.git("init","-b","main")
  self.git("config","user.name","Privacy Fixture")
  self.git("config","user.email","fixture@example.invalid")
 def tearDown(self):self.temp.cleanup()
 def git(self,*args):
  p=subprocess.run(["git","-C",str(self.repo),*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  self.assertEqual(p.returncode,0,"fixture Git operation failed")
  return p.stdout.decode().strip()
 def file(self,name,content):
  p=self.repo/name;p.parent.mkdir(parents=True,exist_ok=True)
  p.write_bytes(content if isinstance(content,bytes) else content.encode())
  self.git("add","--",name)
 def check(self,*args,stdin=None):
  return subprocess.run(["python3",str(GATE),"--repo",str(self.repo),*args],input=stdin,text=True,capture_output=True)
 def commit(self):self.git("commit","-m","Synthetic fixture")
 def test_clean_source_and_dependency_cookie(self):
  self.file("app.py","print('hello')\n")
  self.file("package-lock.json",json.dumps({"packages":{"node_modules/express":{"dependencies":{"cookie":"^0.7.1"}}}}))
  self.assertEqual(self.check("--staged").returncode,0)
 def test_staged_secret_is_blocked_without_value(self):
  value="fixture"+"z"*32
  self.file("settings.json",json.dumps({"appSecret":value}))
  p=self.check("--staged")
  self.assertEqual(p.returncode,1);self.assertNotIn(value,p.stdout+p.stderr)
 def test_history_removal_does_not_hide_secret(self):
  value="sk-"+"Q"*32
  self.file("old.txt",value);self.commit()
  (self.repo/"old.txt").unlink();self.git("add","-u");self.commit()
  self.assertEqual(self.check("--staged").returncode,0)
  p=self.check("--history");self.assertEqual(p.returncode,1);self.assertNotIn(value,p.stdout+p.stderr)
 def test_pre_push_scans_proposed_ref_not_only_head(self):
  self.file("safe.txt","safe");self.commit()
  self.git("checkout","-b","candidate")
  self.file("settings.json",json.dumps({"token":"fixture"+"a"*32}));self.commit()
  bad=self.git("rev-parse","HEAD");self.git("checkout","main")
  zeros="0"*40
  p=self.check("--pre-push",stdin=f"refs/heads/candidate {bad} refs/heads/candidate {zeros}\n")
  self.assertEqual(p.returncode,1)
 def test_short_bearer_is_blocked(self):
  value="sk-"+"B"*17
  self.file("request.js","const headers = {Authorization: "+json.dumps("Bearer "+value)+"};\n")
  p=self.check("--staged");self.assertEqual(p.returncode,1);self.assertNotIn(value,p.stdout+p.stderr)
 def test_real_git_hook_accepts_clean_and_blocks_secret(self):
  self.file("safe.txt","safe");self.commit();good=self.git("rev-parse","HEAD")
  with tempfile.TemporaryDirectory(prefix="cockpit-local-remote-") as temp:
   remote=Path(temp)/"repo.git"
   self.git("init","--bare",str(remote))
   hooks=self.repo/".hooks";hooks.mkdir()
   hook=hooks/"pre-push"
   import shlex
   hook.write_text("#!/bin/sh\nexec python3 "+shlex.quote(str(GATE))+" --repo "+shlex.quote(str(self.repo))+" --pre-push\n")
   hook.chmod(0o755);self.git("config","core.hooksPath",str(hooks))
   self.git("push",str(remote),"HEAD:refs/heads/main")
   value="fixture"+"h"*32
   self.file("settings.json",json.dumps({"appSecret":value}));self.commit()
   p=subprocess.run(["git","-C",str(self.repo),"push",str(remote),"HEAD:refs/heads/main"],capture_output=True,text=True)
   self.assertNotEqual(p.returncode,0);self.assertNotIn(value,p.stdout+p.stderr)
   actual=subprocess.check_output(["git","--git-dir",str(remote),"rev-parse","refs/heads/main"],text=True).strip()
   self.assertEqual(actual,good)
 def test_utf16_secret(self):
  self.file("utf16.json",json.dumps({"pass"+"word":"fixture"+"b"*16}).encode("utf-16"))
  self.assertEqual(self.check("--staged").returncode,1)
 def test_private_path_and_address(self):
  home="/home/"+"private-owner"+"/config"
  addr="192."+"168."+"50."+"20"
  self.file("settings.txt",home+"\n"+addr)
  self.assertEqual(self.check("--staged").returncode,1)
 def test_runtime_alias_paths_checked_even_same_blob(self):
  self.file("safe.txt","identical")
  self.file("data/copy.txt","identical")
  self.assertEqual(self.check("--staged").returncode,1)
 def test_forced_local_config_path_is_blocked(self):
  self.file("provider.local.json",'{"baseUrl":"http://127.0.0.1:8317"}')
  self.assertEqual(self.check("--staged").returncode,1)
 def test_symlink_is_blocked(self):
  self.file("safe.txt","safe")
  (self.repo/"alias").symlink_to("safe.txt");self.git("add","--","alias")
  self.assertEqual(self.check("--staged").returncode,1)
 def test_binary_fails_closed(self):
  self.file("unknown.dat",b"\x00\x01\x02")
  self.assertEqual(self.check("--staged").returncode,1)
 def test_private_commit_metadata_is_blocked(self):
  self.file("safe.txt","safe")
  self.git("config","user.email","fixture@"+"private-domain.invalid")
  self.commit()
  self.assertEqual(self.check("--history").returncode,1)
 def test_invalid_pre_push_input_fails_closed(self):
  self.assertEqual(self.check("--pre-push",stdin="bad\n").returncode,2)
 def test_generic_home_examples_allowed(self):
  self.file("examples.txt","/home/user\n/home/user/files\n/home/example\n")
  self.assertEqual(self.check("--staged").returncode,0)
 def test_placeholders_allowed(self):
  self.file("config.example.json",json.dumps({"apiKey":"$"+"{PROVIDER_API_KEY}","token":"<set-locally>"}))
  self.assertEqual(self.check("--staged").returncode,0)
if __name__=="__main__":
 unittest.main()
