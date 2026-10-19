#!/usr/bin/env python3
"""Create missing private local configs from reviewed examples; never overwrite."""
from pathlib import Path
import json, os
def main():
 root=Path(__file__).resolve().parents[1]
 entries=json.loads((root/"deploy/local-config-manifest.json").read_text())
 for item in entries:
  example=root/item["example"];target=root/item["target"]
  if not example.resolve().is_relative_to(root) or not target.resolve().is_relative_to(root):
   raise SystemExit("Unsafe config manifest path")
  if target.exists() or target.is_symlink():
   print("Preserved existing local config: "+item["target"]);continue
  text=example.read_text().replace("$"+"{HOME}",str(Path.home())).replace("$"+"{PROJECT_ROOT}",str(root))
  json.loads(text)
  target.parent.mkdir(parents=True,exist_ok=True)
  fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,"w") as out:out.write(text)
  print("Created private local config: "+item["target"])
if __name__=="__main__":main()
