"""Offline launcher checks using a fake Docker CLI; no real Docker calls."""
from pathlib import Path
import json
import os
import shutil
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).with_name("fnos.sh")
ID = "a" * 64

class LauncherChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cockpit entry ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "openclaw-cockpit-shell"
        (self.root / "deploy").mkdir(parents=True)
        self.launcher = self.root / "deploy/fnos.sh"
        shutil.copyfile(SOURCE, self.launcher)
        self.log = Path(self.temp.name) / "calls"
        self.cli = Path(self.temp.name) / "docker"
        self.cli.write_text("""#!/usr/bin/env python3
import json, os, pathlib, sys
p=pathlib.Path(os.environ['CALLS'])
with p.open('a') as out: out.write(json.dumps(sys.argv[1:])+'\\n')
if os.environ.get('FAIL_QUERY')=='1': sys.exit(9)
args=sys.argv[1:]
if args[0]=='ps':
 print(os.environ.get('CANDIDATE','a'*64))
elif args[0]=='inspect':
 if os.environ.get('MISMATCH')=='1': sys.exit(7)
 print(os.environ['METADATA'])
elif args[0]=='stop':
 if os.environ.get('FAIL_STOP')=='1': sys.exit(8)
 print(args[-1])
else: sys.exit(20)
""")
        self.cli.chmod(0o700)
        self.env = dict(os.environ, PATH=self.temp.name + ":" + os.environ["PATH"], CALLS=str(self.log), COCKPIT_CONTAINER_ROOT="/home/user/workspace/openclaw-cockpit-shell")
        self.env["METADATA"] = "|".join((ID, "/cockpit", "leon-cockpit-7001", "cockpit", str(self.root / "deploy"), str(self.root / "deploy/compose.fnos.yaml"), "/home/user/workspace/openclaw-cockpit-shell", "running"))

    def run_entry(self, action):
        return subprocess.run(["sh", str(self.launcher), action], env=self.env, capture_output=True, text=True)

    def calls(self):
        return [json.loads(row) for row in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_missing_env_and_disk_status(self):
        self.assertEqual(self.run_entry("status").returncode, 0)
        self.assertEqual(len(self.calls()), 3)

    def test_stop_uses_full_inspected_id(self):
        self.assertEqual(self.run_entry("stop").returncode, 0)
        self.assertEqual(self.calls()[-1], ["stop", "--time", "20", ID])

    def test_saved_launcher_stops_missing_original_disk(self):
        missing = "/not-mounted/original disk/openclaw-cockpit-shell"
        self.env["COCKPIT_HOST_ROOT"] = missing
        self.env["METADATA"] = self.env["METADATA"].replace(str(self.root), missing)
        self.assertEqual(self.run_entry("stop").returncode, 0)
        self.assertEqual(self.calls()[-1], ["stop", "--time", "20", ID])

    def test_missing_explicit_container_root_refuses(self):
        self.env.pop("COCKPIT_CONTAINER_ROOT")
        self.assertNotEqual(self.run_entry("stop").returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_different_container_root_refuses(self):
        self.env["COCKPIT_CONTAINER_ROOT"] = "/home/user/workspace/another-project"
        self.assertNotEqual(self.run_entry("stop").returncode, 0)
        self.assertFalse(any(row[0] == "stop" for row in self.calls()))

    def test_foreign_project_is_refused(self):
        self.env["METADATA"] = self.env["METADATA"].replace("|leon-cockpit-7001|", "|foreign|")
        self.assertNotEqual(self.run_entry("stop").returncode, 0)
        self.assertFalse(any(row[0] == "stop" for row in self.calls()))

    def test_ambiguous_ids_refused(self):
        self.env["CANDIDATE"] = ID + "\n" + "b" * 64
        self.assertNotEqual(self.run_entry("stop").returncode, 0)
        self.assertEqual(len(self.calls()), 1)

    def test_query_failure_propagates(self):
        self.env["FAIL_QUERY"] = "1"
        self.assertNotEqual(self.run_entry("status").returncode, 0)

    def test_inspection_failure_propagates(self):
        self.env["MISMATCH"] = "1"
        self.assertNotEqual(self.run_entry("stop").returncode, 0)

    def test_stop_failure_propagates(self):
        self.env["FAIL_STOP"] = "1"
        self.assertEqual(self.run_entry("stop").returncode, 8)

    def test_missing_mount_fails_before_prepare(self):
        mapping = self.root / "deploy/paths.fnos.env"
        stage = Path(self.temp.name) / "must-not-exist"
        mapping.write_text("COCKPIT_WORKSPACE_ROOT='/not-mounted/workspace'\nCOCKPIT_CONTAINER_ROOT='/home/user/workspace/openclaw-cockpit-shell'\nCOCKPIT_BIND_ADDR='127.0.0.1'\nCOCKPIT_DISK_ROOT='/not-mounted/cockpit-disk'\nCOCKPIT_STAGE='" + str(stage) + "'\n")
        self.env["COCKPIT_ENV_FILE"] = str(mapping)
        result = self.run_entry("prepare")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not mounted", result.stderr)
        self.assertFalse(stage.exists())
        self.assertEqual(self.calls(), [])

if __name__ == "__main__":
    unittest.main()
