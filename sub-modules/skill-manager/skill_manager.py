#!/usr/bin/env python3
"""
OpenClaw Skill Manager v2 — 通用技能管理引擎

Usage:
    python3 skill_manager.py list
    python3 skill_manager.py size --top 10
    python3 skill_manager.py audit
    python3 skill_manager.py clean --dry-run
    python3 skill_manager.py search browser
    python3 skill_manager.py serve --port 8080

Environment:
    SKILL_MANAGER_DIR   default skills directory
"""

from __future__ import annotations

import argparse
import hashlib
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys
import threading
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
SOURCE_TYPES = ["local", "clawhub", "github", "pypi", "npm", "git", "url"]
EXCLUDE_DIRS = {"node_modules", ".venv", ".git", "dist", "__pycache__", ".clawhub", ".idea", ".vscode"}
EXCLUDE_FILES = {"package-lock.json", "_filehash.sha256", ".DS_Store"}

_SENSITIVE_PATTERNS = [
    re.compile(r'[a-zA-Z0-9_-]{20,}\s*[:=]\s*["\']?[a-zA-Z0-9_-]{20,}["\']?'),
    re.compile(r'(api[_-]?key|token|secret|password|passwd)\s*[:=]\s*["\']?[^\s"\']{8,}["\']?', re.I),
    re.compile(r'sk-[a-zA-Z0-9]{20,}'),
    re.compile(r'ghp_[a-zA-Z0-9]{36}'),
    re.compile(r'AKIA[0-9A-Z]{16}'),
]

# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
def _fmt_bytes(n: int) -> str:
    for u in ["B", "KB", "MB", "GB"]:
        if n < 1024:
            return f"{n:.1f}{u}"
        n /= 1024
    return f"{n:.1f}TB"


def _health_color(score: int) -> str:
    if score >= 90:
        return "\033[32m"
    if score >= 60:
        return "\033[33m"
    return "\033[31m"


def _health_bar(score: int) -> str:
    c = _health_color(score)
    icon = "✓" if score >= 90 else "○" if score >= 60 else "✗"
    bar = "█" * (score // 10)
    empty = "·" * (10 - score // 10)
    return f"{c}{icon} [{bar}{empty}] {score:>3}\033[0m"


def _fetch_json(url: str, timeout: int = 10) -> Optional[dict]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "skill-manager/2.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except Exception:
        return None


def _run_shell(cmd: str, timeout: int = 30) -> tuple[bool, str]:
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.returncode == 0, (r.stdout or r.stderr or "").strip()
    except Exception as e:
        return False, str(e)


# ---------------------------------------------------------------------------
# Frontmatter 解析
# ---------------------------------------------------------------------------
def parse_frontmatter(content: str) -> dict:
    parts = content.split("---", 2)
    if len(parts) < 3:
        return {}
    fm_text = parts[1].strip()
    result = {}
    for line in fm_text.split("\n"):
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("metadata:"):
            continue
        m = re.match(r'^(\w+)\s*:\s*"?(.+?)"?\s*$', line)
        if m:
            key, val = m.group(1), m.group(2)
            if not val.startswith("|"):
                result[key] = val
        m = re.match(r'^(\w+)\s*:\s*$', line)
        if m:
            key = m.group(1)
            val_lines = []
            start = False
            for sub in fm_text.split("\n"):
                if sub.strip() == line:
                    start = True
                    continue
                if start:
                    if sub.startswith("  ") or sub.startswith("\t"):
                        val_lines.append(sub.strip())
                    else:
                        break
            if val_lines:
                result[key] = " ".join(val_lines)
    return result


def read_frontmatter_yaml(skill_md_path: Path) -> dict:
    try:
        import yaml
    except ImportError:
        return parse_frontmatter(skill_md_path.read_text(encoding="utf-8"))
    content = skill_md_path.read_text(encoding="utf-8")
    parts = content.split("---", 2)
    if len(parts) < 3:
        return {}
    try:
        return yaml.safe_load(parts[1]) or {}
    except Exception:
        return parse_frontmatter(content)


# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------
@dataclass
class SkillInfo:
    name: str
    slug: str
    dir_name: str
    path: str
    version: str
    description: str
    category: str
    source: dict
    has_meta: bool
    has_origin: bool
    content_hash: str
    dependencies: list = field(default_factory=list)
    frontmatter: dict = field(default_factory=dict)
    existing_meta: dict = field(default_factory=dict)
    existing_origin: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "name": self.name, "slug": self.slug, "dir_name": self.dir_name,
            "path": self.path, "version": self.version, "description": self.description,
            "category": self.category, "source": self.source,
            "has_meta": self.has_meta, "has_origin": self.has_origin,
            "content_hash": self.content_hash, "dependencies": self.dependencies,
            "frontmatter": self.frontmatter, "existing_meta": self.existing_meta,
            "existing_origin": self.existing_origin,
        }


# ---------------------------------------------------------------------------
# 核心引擎
# ---------------------------------------------------------------------------
class SkillManager:
    def __init__(self, skills_dir: Path, registry_file: Optional[Path] = None,
                 maps_file: Optional[Path] = None):
        self.skills_dir = skills_dir.resolve()
        self.registry_file = registry_file or (self.skills_dir / "registry.json")
        self.maps = self._load_maps(maps_file)

    # ---- maps / config ----
    def _load_maps(self, path: Optional[Path]) -> dict:
        # 1. 内置 maps.json (随 skill-manager 分发)
        builtin = Path(__file__).with_suffix(".json")
        if builtin.exists():
            try:
                data = json.loads(builtin.read_text(encoding="utf-8"))
            except Exception:
                data = {}
        else:
            data = {}
        # 2. 技能目录下的 .skill-manager/maps.json (覆盖)
        custom = self.skills_dir / ".skill-manager" / "maps.json"
        if custom.exists():
            try:
                data.update(json.loads(custom.read_text(encoding="utf-8")))
            except Exception:
                pass
        # 3. 显式传入的 maps.json (最高优先级)
        if path and path.exists():
            try:
                data.update(json.loads(path.read_text(encoding="utf-8")))
            except Exception:
                pass
        return data

    def _category(self, slug: str, fm: dict) -> str:
        if "category" in fm and fm["category"]:
            return str(fm["category"])
        return self.maps.get("categories", {}).get(slug, "other")

    def _source(self, slug: str, fm: dict) -> dict:
        if "source" in fm and fm["source"]:
            s = fm["source"]
            if isinstance(s, dict):
                return s
            if isinstance(s, str):
                parts = s.split(None, 1)
                if len(parts) == 2 and parts[0] in SOURCE_TYPES:
                    return {"type": parts[0], "url": parts[1]}
                return {"type": s}
        return self.maps.get("sources", {}).get(slug, {"type": "local"})

    # ---- scan ----
    def dir_hash(self, directory: Path) -> str:
        h = hashlib.sha256()
        for f in sorted(directory.rglob("*")):
            if any(part in EXCLUDE_DIRS for part in f.parts):
                continue
            if f.is_file() and f.name not in EXCLUDE_FILES:
                h.update(f.name.encode())
                try:
                    h.update(str(f.stat().st_mtime).encode())
                except OSError:
                    pass
        return h.hexdigest()[:16]

    def _scan_dir(self, root: Path, out: list) -> None:
        if not root.exists():
            return
        for item in sorted(root.iterdir()):
            if item.name.startswith(".") or not item.is_dir():
                continue
            skill_md = item / "SKILL.md"
            if skill_md.exists():
                out.append(self._build_info(item, skill_md))

    def find_all(self) -> list[SkillInfo]:
        skills: list[SkillInfo] = []
        self._scan_dir(self.skills_dir, skills)
        self._scan_dir(self.skills_dir / "skills", skills)
        self._scan_dir(self.skills_dir / "OpenCLI" / "skills", skills)
        return skills

    def _build_info(self, skill_dir: Path, skill_md: Path) -> SkillInfo:
        fm = read_frontmatter_yaml(skill_md)
        meta_path = skill_dir / "_meta.json"
        origin_path = skill_dir / ".clawhub" / "origin.json"

        existing_meta = {}
        if meta_path.exists():
            try:
                existing_meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                pass

        existing_origin = {}
        if origin_path.exists():
            try:
                existing_origin = json.loads(origin_path.read_text(encoding="utf-8"))
            except Exception:
                pass

        name = fm.get("name", skill_dir.name)
        version = fm.get("version") or existing_meta.get("version") or existing_origin.get("installedVersion") or "0.0.0"
        description = fm.get("description", "")
        if isinstance(description, dict):
            description = str(description)

        deps = fm.get("dependencies", [])
        if isinstance(deps, str):
            deps = [deps]

        return SkillInfo(
            name=name,
            slug=existing_meta.get("slug") or existing_origin.get("slug") or skill_dir.name,
            dir_name=skill_dir.name,
            path=str(skill_dir),
            version=str(version),
            description=str(description)[:120] if description else "",
            category=self._category(skill_dir.name, fm),
            source=self._source(skill_dir.name, fm),
            has_meta=meta_path.exists(),
            has_origin=origin_path.exists(),
            content_hash=self.dir_hash(skill_dir),
            dependencies=list(deps),
            frontmatter=dict(fm),
            existing_meta=existing_meta,
            existing_origin=existing_origin,
        )

    # ---- meta / registry ----
    def generate_meta(self, skill: SkillInfo) -> dict:
        now = datetime.now(timezone.utc).isoformat()
        meta = {
            "name": skill.slug, "slug": skill.slug,
            "version": skill.version, "description": skill.description,
            "category": skill.category, "source": skill.source,
            "contentHash": skill.content_hash, "dependencies": skill.dependencies,
            "createdAt": skill.existing_meta.get("createdAt") or skill.existing_meta.get("publishedAt") or now,
            "updatedAt": now,
        }
        for k in ("ownerId", "publishedAt"):
            if skill.existing_meta.get(k):
                meta[k] = skill.existing_meta[k]
        for k in ("registry", "installedAt"):
            if skill.existing_origin.get(k):
                meta[k] = skill.existing_origin[k]
        return meta

    def health_score(self, skill: SkillInfo) -> tuple[int, list[str]]:
        score, details = 0, []
        if skill.version != "0.0.0":
            score += 30
        else:
            details.append("缺版本号(-30)")
        if skill.has_meta:
            score += 20
            try:
                meta = json.loads(Path(skill.path, "_meta.json").read_text(encoding="utf-8"))
                if meta.get("contentHash") and meta["contentHash"] != skill.content_hash:
                    details.append("哈希过期(-10)")
                else:
                    score += 10
            except Exception:
                details.append("meta损坏(-30)")
                score -= 30
        else:
            details.append("缺meta(-20)")
        if skill.source["type"] != "local" or skill.source.get("author"):
            score += 10
        else:
            details.append("未标注来源(-10)")
        if skill.has_origin:
            score += 5
        if skill.description:
            score += 20
        else:
            details.append("缺描述(-20)")
        if skill.dependencies:
            score += 5
        return min(score, 100), details

    # ---- disk ----
    def dir_size(self, path: Path) -> dict:
        total = 0
        for root, dirs, files in os.walk(path):
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
            for f in files:
                fp = Path(root) / f
                try:
                    total += fp.stat().st_size
                except OSError:
                    pass
        nm = 0
        nm_path = path / "node_modules"
        if nm_path.exists():
            for root, _, files in os.walk(nm_path):
                for f in files:
                    try:
                        nm += (Path(root) / f).stat().st_size
                    except OSError:
                        pass
        return {"total": total, "node_modules": nm, "core": total - nm}

    # ---- audit ----
    def audit_skill(self, skill: SkillInfo) -> list[dict]:
        issues = []
        skill_dir = Path(skill.path)

        # 1. 敏感文件扫描
        for root, _, files in os.walk(skill_dir):
            for f in files:
                l = f.lower()
                if any(k in l for k in ("cookie", "token", "secret", "password", "key")):
                    if "package" in l or "lock" in l or "meta" in l:
                        continue
                    issues.append({"type": "sensitive_file", "file": str(Path(root) / f), "level": "high"})

        # 2. API Key 硬编码
        md_path = skill_dir / "SKILL.md"
        if md_path.exists():
            text = md_path.read_text(encoding="utf-8", errors="ignore")
            for pat in _SENSITIVE_PATTERNS:
                for m in pat.finditer(text):
                    issues.append({"type": "api_key", "file": str(md_path), "level": "high",
                                   "match": text[max(0, m.start()-10):m.end()+10]})

        # 3. frontmatter 格式
        try:
            fm = read_frontmatter_yaml(md_path)
            if not fm.get("name"):
                issues.append({"type": "frontmatter", "file": str(md_path), "level": "medium", "msg": "缺少 name"})
        except Exception as e:
            issues.append({"type": "frontmatter", "file": str(md_path), "level": "critical", "msg": str(e)})

        # 4. 依赖完整性
        for dep in skill.dependencies:
            dep_path = self.skills_dir / dep
            if not dep_path.exists() and not (self.skills_dir / "skills" / dep).exists():
                issues.append({"type": "missing_dep", "dep": dep, "level": "medium"})

        return issues

    # ---- clean targets ----
    def clean_targets(self, skill: SkillInfo) -> list[dict]:
        targets = []
        sd = Path(skill.path)
        for name in ("node_modules", "__pycache__", ".clawhub"):
            p = sd / name
            if p.exists():
                sz = self.dir_size(p)["total"]
                targets.append({"path": str(p), "type": name, "size": sz})
        for pat in ("*.tar.gz", "*.tar", "package-lock.json"):
            for f in sd.rglob(pat):
                targets.append({"path": str(f), "type": "artifact", "size": f.stat().st_size})
        return targets


# ---------------------------------------------------------------------------
# CLI 命令实现
# ---------------------------------------------------------------------------
class SkillManagerCLI:
    def __init__(self, manager: SkillManager):
        self.m = manager

    # ---- list ----
    def cmd_list(self, args):
        skills = self.m.find_all()
        if args.category:
            skills = [s for s in skills if s.category == args.category]
        if args.source:
            skills = [s for s in skills if s.source.get("type") == args.source]
        if args.missing_meta:
            skills = [s for s in skills if not s.has_meta]

        scored = [(s, *self.m.health_score(s)) for s in skills]
        if args.health is not None:
            scored = [(s, sc, dt) for s, sc, dt in scored if sc < args.health]
        scored.sort(key=lambda x: x[1])

        if args.stats:
            cats = {}
            for s, sc, _ in scored:
                cats.setdefault(s.category, []).append(sc)
            print(f"{'Category':<16} {'Count':<8} {'Avg':<8} {'Min':<8} {'Max':<8}")
            print("-" * 50)
            for cat, scores in sorted(cats.items()):
                print(f"{cat:<16} {len(scores):<8} {sum(scores)//len(scores):<8} {min(scores):<8} {max(scores):<8}")
            all_scores = [sc for _, sc, _ in scored]
            if all_scores:
                print(f"\n总技能: {len(all_scores)} | 平均健康分: {sum(all_scores)//len(all_scores)} | "
                      f">=80: {sum(1 for s in all_scores if s >= 80)} | <50: {sum(1 for s in all_scores if s < 50)}")
            return

        fmt = args.format
        if fmt == "json":
            data = [{"slug": s.slug, "version": s.version, "health_score": sc,
                     "issues": dt, "category": s.category, "source": s.source["type"]}
                    for s, sc, dt in scored]
            print(json.dumps(data, indent=2, ensure_ascii=False))
            return
        if fmt == "short":
            for s, sc, _ in scored:
                print(f"{_health_bar(sc)} {s.slug}@{s.version} [{s.source['type']}]")
            return

        print(f"{'Health':<22} {'Slug':<30} {'Version':<10} {'Source':<10} {'Issues'}")
        print("-" * 100)
        for s, sc, dt in scored:
            issues = ", ".join(dt) if dt else "-"
            print(f"{_health_bar(sc):<22} {s.slug:<30} {s.version:<10} {s.source['type']:<10} {issues}")
        all_scores = [sc for _, sc, _ in scored]
        if all_scores:
            avg = sum(all_scores) // len(all_scores)
            print(f"\n{len(all_scores)} 个技能 | 平均健康分: {avg} | "
                  f">=80: {sum(1 for s in all_scores if s >= 80)} | <50: {sum(1 for s in all_scores if s < 50)}")

    # ---- inspect ----
    def cmd_inspect(self, args):
        skills = self.m.find_all()
        skill = next((s for s in skills if s.slug == args.skill or s.dir_name == args.skill), None)
        if not skill:
            print(f"未找到技能: {args.skill}")
            sys.exit(1)
        if args.json:
            print(json.dumps(skill.to_dict(), indent=2, ensure_ascii=False))
            return
        print(f"╔══════════════════════════════════════════════════╗")
        print(f"║  {skill.name:<46} ║")
        print(f"╚══════════════════════════════════════════════════╝")
        print(f"  Slug:          {skill.slug}")
        print(f"  Version:       {skill.version}")
        print(f"  Category:      {skill.category}")
        print(f"  Path:          {skill.path}")
        print(f"  Content Hash:  {skill.content_hash}")
        print(f"  Has _meta.json:{'  ✓' if skill.has_meta else '  ✗'}")
        print(f"  Has origin:    {'✓' if skill.has_origin else '✗'}")
        print(f"  Source:")
        for k, v in skill.source.items():
            print(f"    {k}: {v}")
        if skill.dependencies:
            print(f"  Dependencies:  {', '.join(skill.dependencies)}")
        print(f"  Description:   {skill.description}")

    # ---- init ----
    def cmd_init(self, args):
        skills = self.m.find_all()
        target, force, dry_run = args.skill, args.force, args.dry_run
        count = 0
        for s in skills:
            if target and s.slug != target and s.dir_name != target:
                continue
            meta_path = Path(s.path) / "_meta.json"
            if meta_path.exists() and not force:
                if not args.quiet:
                    print(f"  跳过 {s.slug} (已有 _meta.json，使用 --force 覆盖)")
                continue
            meta = self.m.generate_meta(s)
            if dry_run:
                print(f"  [DRY-RUN] 将生成: {meta_path}")
            else:
                meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
                print(f"  ✓ 生成 {s.slug}/_meta.json (v{s.version})")
            count += 1
        print(f"\n共处理 {count} 个技能")

    # ---- registry ----
    def cmd_registry(self, args):
        skills = self.m.find_all()
        registry = {
            "version": 1,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "totalSkills": len(skills),
            "categories": {}, "sources": {}, "skills": {},
        }
        for s in skills:
            registry["skills"][s.slug] = {
                "name": s.name, "slug": s.slug, "version": s.version,
                "category": s.category, "source": s.source, "path": s.path,
                "contentHash": s.content_hash, "hasMeta": s.has_meta,
                "hasOrigin": s.has_origin, "dependencies": s.dependencies,
            }
            registry["categories"].setdefault(s.category, []).append(s.slug)
            registry["sources"].setdefault(s.source["type"], []).append(s.slug)
        if args.dry_run:
            print(json.dumps(registry, indent=2, ensure_ascii=False))
        else:
            self.m.registry_file.write_text(json.dumps(registry, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            print(f"✓ 生成 registry.json ({len(skills)} 个技能)")

    # ---- verify ----
    def cmd_verify(self, args):
        skills = self.m.find_all()
        target, fix_mode = args.skill, args.fix
        issues, fixed_count = [], 0
        for s in skills:
            if target and s.slug != target and s.dir_name != target:
                continue
            sd = Path(s.path)
            mp = sd / "_meta.json"
            if not (sd / "SKILL.md").exists():
                issues.append((s.slug, "CRITICAL", "缺少 SKILL.md"))
            if not s.has_meta:
                if fix_mode:
                    mp.write_text(json.dumps(self.m.generate_meta(s), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
                    fixed_count += 1
                    print(f"  ✓ 生成 {s.slug}/_meta.json")
                else:
                    issues.append((s.slug, "WARN", "缺少 _meta.json"))
            if s.version == "0.0.0":
                issues.append((s.slug, "WARN", "版本号为 0.0.0"))
            if s.source["type"] == "local" and not s.source.get("author"):
                issues.append((s.slug, "INFO", "本地技能未标注作者"))
            if mp.exists():
                try:
                    meta = json.loads(mp.read_text(encoding="utf-8"))
                    if meta.get("contentHash") and meta["contentHash"] != s.content_hash:
                        if fix_mode:
                            meta["contentHash"] = s.content_hash
                            meta["updatedAt"] = datetime.now(timezone.utc).isoformat()
                            mp.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
                            fixed_count += 1
                        else:
                            issues.append((s.slug, "WARN", "内容哈希变化"))
                except json.JSONDecodeError:
                    issues.append((s.slug, "CRITICAL", "_meta.json 格式错误"))
            if not s.description:
                issues.append((s.slug, "INFO", "缺少描述"))
        if fix_mode:
            print(f"\n✓ 自动修复完成，共修复 {fixed_count} 个问题")
        if issues:
            print(f"{'Level':<10} {'Skill':<35} {'Issue'}")
            print("─" * 80)
            for slug, level, msg in issues:
                print(f"{'🟢🟡🔵'['CRITICALWARNINFO'.index(level)//8]:<10} {slug:<35} {msg}")
        elif not fix_mode:
            print("✓ 所有技能验证通过")

    # ---- outdated ----
    def cmd_outdated(self, args):
        skills = self.m.find_all()
        print(f"{'Slug':<35} {'Local':<12} {'Source':<12} {'Status'}")
        print("─" * 80)
        no_version = 0
        for s in skills:
            src, ver = s.source["type"], s.version
            if ver == "0.0.0":
                status, no_version = "⚠ 无版本号", no_version + 1
            elif src == "clawhub":
                status = f"installed:{s.existing_origin.get('installedVersion', '未知')}"
            elif src == "github":
                status = "需手动检查"
            elif src == "pypi":
                status = "需 pip check"
            elif src == "local":
                status = "本地维护"
            else:
                status = "-"
            print(f"{s.slug:<35} {ver:<12} {src:<12} {status}")
        print(f"\n共 {len(skills)} 个技能 | 无版本号: {no_version}")

    # ---- deps ----
    def cmd_deps(self, args):
        skills = self.m.find_all()
        target = args.skill
        dep_graph = {s.slug: s.dependencies for s in skills}
        if target:
            if target not in dep_graph:
                print(f"未找到技能: {target}")
                sys.exit(1)
            deps = dep_graph[target]
            if not deps:
                print(f"{target} 无外部依赖")
            else:
                print(f"{target} 依赖:")
                for d in deps:
                    installed = any(s.slug == d for s in skills)
                    print(f"  {'✓' if installed else '✗'} {d}")
            return
        print("技能依赖关系图:")
        for slug, deps in sorted(dep_graph.items()):
            if deps:
                print(f"  {slug} → {', '.join(deps)}")
        known = {s.slug for s in skills}
        reverse = {}
        for s in skills:
            for d in s.dependencies:
                reverse.setdefault(d, []).append(s.slug)
        if reverse:
            print("\n反向依赖:")
            for dep, users in sorted(reverse.items()):
                print(f"  {'⚠ ' if dep not in known else '  '}{dep} ← {', '.join(users)}")

    # ---- export ----
    def cmd_export(self, args):
        skills = self.m.find_all()
        fmt = args.format
        if fmt == "json":
            data = {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "totalSkills": len(skills),
                "skills": [{"slug": s.slug, "version": s.version, "category": s.category,
                            "source": s.source["type"], "description": s.description,
                            "hasMeta": s.has_meta, "dependencies": s.dependencies}
                           for s in skills],
            }
            print(json.dumps(data, indent=2, ensure_ascii=False))
            return
        if fmt == "markdown":
            print("# OpenClaw Shared Skills Registry\n")
            print(f"生成时间: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n")
            print(f"总技能数: {len(skills)}\n")
            by_cat = {}
            for s in skills:
                by_cat.setdefault(s.category, []).append(s)
            cat_names = self.m.maps.get("cat_names", {})
            for cat, items in sorted(by_cat.items()):
                print(f"## {cat_names.get(cat, cat)}\n")
                print("| 技能 | 版本 | 来源 | 描述 |")
                print("|------|------|------|------|")
                for s in items:
                    print(f"| {s.slug} | {s.version} | {s.source['type']} | {s.description[:50]} |")
                print()
            return
        if fmt == "csv":
            print("slug,version,category,source,has_meta,description")
            for s in skills:
                desc = s.description.replace(",", "，").replace('"', "'")
                print(f"{s.slug},{s.version},{s.category},{s.source['type']},{s.has_meta},\"{desc}\"")

    # ---- check ----
    def cmd_check(self, args):
        skills = self.m.find_all()
        target = args.skill
        results = []
        for s in skills:
            if target and s.slug != target and s.dir_name != target:
                continue
            src = s.source
            st = src.get("type", "local")
            if st == "clawhub":
                results.append((s.slug, s.version, "clawhub", src.get("slug", s.slug), "需手动确认"))
            elif st == "github":
                url = src.get("url", "")
                m = re.search(r'github\.com/([^/]+)/([^/]+?)(?:\.git)?$', url)
                if m:
                    owner, repo = m.group(1), m.group(2)
                    data = _fetch_json(f"https://api.github.com/repos/{owner}/{repo}/releases/latest")
                    if data:
                        latest = data.get("tag_name", "").lstrip("v")
                        status = f"✓ 已是最新 ({latest})" if latest == s.version else f"↑ 可更新 {s.version} → {latest}" if latest else "无发行版标签"
                    else:
                        data = _fetch_json(f"https://api.github.com/repos/{owner}/{repo}/tags")
                        latest = data[0].get("name", "").lstrip("v") if data and len(data) > 0 else ""
                        status = f"↑ 可更新 {s.version} → {latest}" if latest and latest != s.version else "✓ 已是最新" if latest else "无法获取"
                else:
                    status = "无法解析仓库名"
                results.append((s.slug, s.version, "github", url, status))
            elif st == "pypi":
                pkg = src.get("package", s.slug)
                data = _fetch_json(f"https://pypi.org/pypi/{pkg}/json")
                latest = data.get("info", {}).get("version", "unknown") if data else "unknown"
                status = f"✓ 已是最新" if latest == s.version else f"↑ 可更新 {s.version} → {latest}"
                results.append((s.slug, s.version, "pypi", pkg, status))
            elif st == "npm":
                pkg = src.get("package", s.slug)
                data = _fetch_json(f"https://registry.npmjs.org/{pkg}/latest")
                latest = data.get("version", "unknown") if data else "unknown"
                status = f"✓ 已是最新" if latest == s.version else f"↑ 可更新 {s.version} → {latest}"
                results.append((s.slug, s.version, "npm", pkg, status))
            else:
                results.append((s.slug, s.version, "local", "-", "本地维护，无上游"))
        if not results:
            print("没有可检查的技能")
            return
        print(f"{'Slug':<35} {'Local':<10} {'Source':<10} {'Info':<38} {'Status'}")
        print("─" * 120)
        for slug, ver, src, info, status in results:
            print(f"{slug:<35} {ver:<10} {src:<10} {info:<38} {status}")

    # ---- sync ----
    def cmd_sync(self, args):
        skills = self.m.find_all()
        target, count = args.skill, 0
        for s in skills:
            if target and s.slug != target and s.dir_name != target:
                continue
            skill_md = Path(s.path) / "SKILL.md"
            if not skill_md.exists():
                print(f"  ✗ {s.slug}: 缺少 SKILL.md")
                continue
            content = skill_md.read_text(encoding="utf-8")
            parts = content.split("---", 2)
            if len(parts) < 3:
                print(f"  ✗ {s.slug}: SKILL.md 格式不正确")
                continue
            fm = parts[1]
            ver_line = re.search(r'^version\s*:.*$', fm, re.MULTILINE)
            src_line = re.search(r'^source\s*:.*$', fm, re.MULTILINE)
            src_type = s.source.get("type", "local")
            src_url = s.source.get("url") or s.source.get("slug") or s.source.get("package") or ""
            source_str = f"{src_type}:{src_url}" if src_url else src_type
            if not ver_line and s.version != "0.0.0":
                fm = f"version: {s.version}\n{fm}"
            elif ver_line:
                fm = re.sub(r'^version\s*:.*$', f"version: {s.version}", fm, flags=re.MULTILINE)
            if not src_line:
                fm = f"source: {source_str}\n{fm}"
            elif src_line:
                fm = re.sub(r'^source\s*:.*$', f"source: {source_str}", fm, flags=re.MULTILINE)
            new_content = f"---\n{fm}---{parts[2]}"
            if args.dry_run:
                print(f"  [DRY-RUN] {s.slug}: version={s.version} source={source_str}")
            elif new_content != content:
                skill_md.write_text(new_content, encoding="utf-8")
                print(f"  ✓ {s.slug}: version={s.version} source={source_str}")
                count += 1
            else:
                print(f"  - {s.slug}: 已同步")
        print(f"\n共同步 {count} 个技能")

    # ---- bump ----
    def cmd_bump(self, args):
        skills = self.m.find_all()
        target, component, all_mode, dry_run = args.skill, args.component, args.all, args.dry_run
        if all_mode:
            zeros = [s for s in skills if s.version == "0.0.0"]
            if not zeros:
                print("没有版本号为 0.0.0 的技能")
                return
            print(f"批量升级 {len(zeros)} 个 0.0.0 技能 → 1.0.0")
            for s in zeros:
                self._do_bump(s, "1.0.0", dry_run)
                print(f"  {'[DRY-RUN]' if dry_run else '✓'} {s.slug}: 0.0.0 → 1.0.0")
            return
        skill = next((s for s in skills if s.slug == target or s.dir_name == target), None)
        if not skill:
            print(f"未找到技能: {target}")
            sys.exit(1)
        parts = skill.version.split(".")
        if len(parts) != 3:
            parts = ["0", "0", "0"]
        try:
            major, minor, patch = int(parts[0]), int(parts[1]), int(parts[2])
        except ValueError:
            major = minor = patch = 0
        if component == "major":
            major, minor, patch = major + 1, 0, 0
        elif component == "minor":
            minor, patch = minor + 1, 0
        elif component == "patch":
            patch += 1
        new_v = f"{major}.{minor}.{patch}"
        self._do_bump(skill, new_v, dry_run)
        print(f"✓ {skill.slug}: {skill.existing_meta.get('version', '0.0.0')} → {new_v}")

    def _do_bump(self, skill: SkillInfo, new_version: str, dry_run: bool):
        skill.version = new_version
        mp = Path(skill.path) / "_meta.json"
        meta = json.loads(mp.read_text(encoding="utf-8")) if mp.exists() else {}
        meta["version"] = new_version
        meta["updatedAt"] = datetime.now(timezone.utc).isoformat()
        if not dry_run:
            meta["contentHash"] = self.m.dir_hash(Path(skill.path))
            mp.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            skill_md = Path(skill.path) / "SKILL.md"
            if skill_md.exists():
                self.cmd_sync(type("A", (), {"skill": skill.dir_name, "dry_run": False})())

    # ---- enrich ----
    def cmd_enrich(self, args):
        skills = self.m.find_all()
        target, count = args.skill, 0
        for s in skills:
            if target and s.slug != target and s.dir_name != target:
                continue
            skill_md = Path(s.path) / "SKILL.md"
            if not skill_md.exists():
                continue
            content = skill_md.read_text(encoding="utf-8")
            parts = content.split("---", 2)
            if len(parts) < 3:
                continue
            fm = parts[1]
            modified = False
            if not re.search(r'^version\s*:', fm, re.MULTILINE) and s.version != "0.0.0":
                fm = f"version: {s.version}\n{fm}"
                modified = True
            if not re.search(r'^source\s*:', fm, re.MULTILINE):
                src = s.source
                src_str = src.get("type", "local")
                for k in ("url", "slug", "package"):
                    if src.get(k):
                        src_str += f" {src[k]}"
                fm = f"source: {src_str}\n{fm}"
                modified = True
            if modified:
                if args.dry_run:
                    print(f"  [DRY-RUN] {s.slug}")
                else:
                    skill_md.write_text(f"---\n{fm}---{parts[2]}", encoding="utf-8")
                    print(f"  ✓ {s.slug}: 已补全 version/source")
                    count += 1
        print(f"\n共补全 {count} 个技能")

    # ---- health ----
    def cmd_health(self, args):
        skills = self.m.find_all()
        scored = [(s, *self.m.health_score(s)) for s in skills]
        scored.sort(key=lambda x: x[1], reverse=True)
        all_scores = [sc for _, sc, _ in scored]
        avg = sum(all_scores) // len(all_scores) if all_scores else 0
        print("╔══════════════════════════════════════════╗")
        print(f"║  🏥 Skill Health Dashboard              ║")
        print("╠══════════════════════════════════════════╣")
        print(f"║  Total: {len(skills):<3}  |  Avg: {avg:<3}  |  >=80: {sum(1 for s in all_scores if s >= 80):<3}  |  <50: {sum(1 for s in all_scores if s < 50):<3}  ║")
        print("╚══════════════════════════════════════════╝")
        print(f"\n{'🏆 Top 5':-^50}")
        for s, sc, dt in scored[:5]:
            print(f"  {_health_bar(sc)} {s.slug}")
        print(f"\n{'⚠️ Bottom 5':-^50}")
        for s, sc, dt in scored[-5:]:
            print(f"  {_health_bar(sc)} {s.slug} ({', '.join(dt[:2]) if dt else '-'})")
        print(f"\n{'By Category':-^50}")
        cats = {}
        for s, sc, _ in scored:
            cats.setdefault(s.category, []).append(sc)
        for cat, scores in sorted(cats.items(), key=lambda x: sum(x[1])//len(x[1]), reverse=True):
            a = sum(scores)//len(scores)
            print(f"  {cat:<20} {_health_bar(a)}")

    # ---- size (新增) ----
    def cmd_size(self, args):
        skills = self.m.find_all()
        sizes = []
        for s in skills:
            d = self.m.dir_size(Path(s.path))
            targets = self.m.clean_targets(s)
            cleanable = sum(t["size"] for t in targets)
            sizes.append({"skill": s, **d, "cleanable": cleanable, "targets": targets})
        sizes.sort(key=lambda x: x["total"], reverse=True)
        limit = args.top or len(sizes)
        print(f"{'Rank':<6} {'Slug':<30} {'Total':<10} {'Core':<10} {'node_modules':<12} {'Cleanable':<10}")
        print("─" * 90)
        total_all = core_all = nm_all = clean_all = 0
        for i, item in enumerate(sizes[:limit], 1):
            s = item["skill"]
            print(f"{i:<6} {s.slug:<30} {_fmt_bytes(item['total']):<10} {_fmt_bytes(item['core']):<10} "
                  f"{_fmt_bytes(item['node_modules']):<12} {_fmt_bytes(item['cleanable']):<10}")
            total_all += item["total"]
            core_all += item["core"]
            nm_all += item["node_modules"]
            clean_all += item["cleanable"]
        print("─" * 90)
        print(f"{'Total':<6} {'':<30} {_fmt_bytes(total_all):<10} {_fmt_bytes(core_all):<10} "
              f"{_fmt_bytes(nm_all):<12} {_fmt_bytes(clean_all):<10}")
        if args.targets:
            print("\n可清理项:")
            for item in sizes[:limit]:
                if item["targets"]:
                    print(f"  {item['skill'].slug}:")
                    for t in item["targets"]:
                        print(f"    - {t['type']}: {t['path']} ({_fmt_bytes(t['size'])})")

    # ---- audit (新增) ----
    def cmd_audit(self, args):
        skills = self.m.find_all()
        all_issues = []
        for s in skills:
            issues = self.m.audit_skill(s)
            for issue in issues:
                all_issues.append({"skill": s.slug, **issue})
        if not all_issues:
            print("✓ 审计通过，未发现问题")
            return
        by_level = {"high": [], "medium": [], "critical": [], "low": []}
        for issue in all_issues:
            by_level.setdefault(issue["level"], []).append(issue)
        for level in ("critical", "high", "medium", "low"):
            items = by_level.get(level, [])
            if not items:
                continue
            print(f"\n[{level.upper()}] {len(items)} 项")
            for issue in items:
                msg = issue.get("msg", issue.get("file", issue.get("dep", "")))
                print(f"  {issue['skill']}: {issue['type']} → {msg}")
        print(f"\n共 {len(all_issues)} 个问题")

    # ---- clean / prune (新增) ----
    def cmd_clean(self, args):
        skills = self.m.find_all()
        target = args.skill
        total_saved = 0
        for s in skills:
            if target and s.slug != target and s.dir_name != target:
                continue
            targets = self.m.clean_targets(s)
            if not targets:
                continue
            print(f"{s.slug}:")
            for t in targets:
                p = Path(t["path"])
                if not p.exists():
                    continue
                if args.dry_run:
                    print(f"  [DRY-RUN] 将删除 {t['path']} ({_fmt_bytes(t['size'])})")
                    total_saved += t["size"]
                else:
                    try:
                        if p.is_dir():
                            shutil.rmtree(p)
                        else:
                            p.unlink()
                        print(f"  ✓ 已删除 {t['path']} ({_fmt_bytes(t['size'])})")
                        total_saved += t["size"]
                    except Exception as e:
                        print(f"  ✗ 删除失败 {t['path']}: {e}")
        action = "[DRY-RUN] 可释放" if args.dry_run else "已释放"
        print(f"\n{action}: {_fmt_bytes(total_saved)}")

    # ---- search (新增) ----
    def cmd_search(self, args):
        skills = self.m.find_all()
        kw = args.keyword.lower()
        results = []
        for s in skills:
            score = 0
            if kw in s.slug.lower():
                score += 100
            if kw in s.name.lower():
                score += 80
            if kw in s.description.lower():
                score += 50
            if kw in s.category.lower():
                score += 30
            if s.source.get("type", "").lower() == kw:
                score += 20
            if score > 0:
                results.append((s, score))
        results.sort(key=lambda x: x[1], reverse=True)
        if not results:
            print(f"未找到匹配 '{args.keyword}' 的技能")
            return
        print(f"找到 {len(results)} 个匹配结果:")
        print(f"{'Score':<8} {'Slug':<30} {'Version':<10} {'Category':<12} {'Source'}")
        print("─" * 80)
        for s, score in results:
            print(f"{score:<8} {s.slug:<30} {s.version:<10} {s.category:<12} {s.source['type']}")

    # ---- template (新增) ----
    def cmd_template(self, args):
        slug = args.slug
        out_dir = self.m.skills_dir / slug
        if out_dir.exists():
            print(f"目录已存在: {out_dir}")
            sys.exit(1)
        out_dir.mkdir(parents=True)
        skill_md = out_dir / "SKILL.md"
        skill_md.write_text(f"""---
name: {slug}
version: 0.0.0
category: other
source: local
author: openclaw
description: |
  TODO: 添加技能描述
dependencies: []
---

# {slug}

> TODO: 补充技能文档

## 功能

## 使用方式

## 依赖

## 注意事项
""", encoding="utf-8")
        meta = {
            "name": slug, "slug": slug, "version": "0.0.0",
            "description": "TODO: 添加技能描述", "category": "other",
            "source": {"type": "local", "author": "openclaw"},
            "contentHash": "", "dependencies": [],
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }
        (out_dir / "_meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"✓ 生成技能骨架: {out_dir}")
        print(f"  文件: SKILL.md, _meta.json")

    # ---- conflicts (新增) ----
    def cmd_conflicts(self, args):
        skills = self.m.find_all()
        from itertools import combinations
        pairs = []
        for a, b in combinations(skills, 2):
            desc_a = set(a.description.lower().split())
            desc_b = set(b.description.lower().split())
            if not desc_a or not desc_b:
                continue
            sim = len(desc_a & desc_b) / len(desc_a | desc_b)
            if sim >= (args.threshold or 0.3):
                pairs.append((a, b, sim))
        pairs.sort(key=lambda x: x[2], reverse=True)
        if not pairs:
            print("✓ 未检测到高相似度重复技能")
            return
        print(f"{'Score':<8} {'Skill A':<30} {'Skill B':<30} {'Category'}")
        print("─" * 80)
        for a, b, sim in pairs:
            cat_match = "⚠ 不同分类" if a.category != b.category else ""
            print(f"{sim:<8.2f} {a.slug:<30} {b.slug:<30} {cat_match}")

    def _run_cmd(self, cmd_name, **kwargs):
        """内部辅助：将 CLI 命令结果转为 dict（供 serve 模式 POST 调用）"""
        if cmd_name == "audit":
            skills = self.m.find_all()
            issues = []
            for s in skills:
                for issue in self.m.audit_skill(s):
                    issues.append({"skill": s.slug, **issue})
            return {"command": cmd_name, "issues": issues, "totalIssues": len(issues)}
        elif cmd_name == "clean":
            skills = self.m.find_all()
            total = 0
            cleaned = []
            for s in skills:
                for t in self.m.clean_targets(s):
                    p = Path(t["path"])
                    if p.exists():
                        total += t["size"]
                        cleaned.append(t["path"])
            return {"command": cmd_name, "totalCleanable": total, "items": cleaned}
        else:
            return {"command": cmd_name, "status": "ok", "note": "use CLI for full output"}

    # ---- serve (新增: 内嵌 HTTP API) ----
    def cmd_serve(self, args):
        manager = self.m
        port = args.port
        cli = self  # 闭包引用

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass  # 静默日志

            def _json(self, status, data):
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps(data, ensure_ascii=False).encode())

            def do_OPTIONS(self):
                self.send_response(204)
                for k, v in [("Access-Control-Allow-Origin", "*"),
                             ("Access-Control-Allow-Methods", "GET,POST,OPTIONS"),
                             ("Access-Control-Allow-Headers", "Content-Type")]:
                    self.send_header(k, v)
                self.end_headers()

            def do_GET(self):
                url = self.path.split("?")[0]
                if url == "/health":
                    self._json(200, {"status": "ok", "service": "skill-manager", "port": port})
                    return
                if url == "/api/skills":
                    skills = manager.find_all()
                    data = [s.to_dict() for s in skills]
                    self._json(200, {"total": len(data), "skills": data})
                    return
                if url == "/api/skills/overview":
                    skills = manager.find_all()
                    c, s, v = {}, {}, {}
                    wd = wm = 0
                    for x in skills:
                        c[x.category] = c.get(x.category, 0) + 1
                        st = x.source.get("type", "local")
                        s[st] = s.get(st, 0) + 1
                        v[x.version] = v.get(x.version, 0) + 1
                        if x.dependencies:
                            wd += 1
                        if x.has_meta:
                            wm += 1
                    td = manager.dir_size(manager.skills_dir)["total"]
                    self._json(200, {"total": len(skills), "categories": c, "sources": s,
                                     "versions": v, "withDependencies": wd, "withMeta": wm,
                                     "totalDiskBytes": td})
                    return
                if url == "/api/skills/health":
                    skills = manager.find_all()
                    scored = [{"slug": s.slug, "score": sc, "issues": dt}
                              for s, sc, dt in [(*_,) for _ in [(s, *manager.health_score(s)) for s in skills]]]
                    self._json(200, {"skills": scored})
                    return
                if url == "/api/skills/size":
                    skills = manager.find_all()
                    sizes = []
                    for s in skills:
                        d = manager.dir_size(Path(s.path))
                        targets = manager.clean_targets(s)
                        sizes.append({"slug": s.slug, "name": s.name, "source": s.source.get("type", "local"),
                                      **d, "cleanable": sum(t["size"] for t in targets),
                                      "targets": [{"path": t["path"], "type": t["type"], "size": t["size"]}
                                                  for t in targets]})
                    sizes.sort(key=lambda x: x["total"], reverse=True)
                    self._json(200, {"skills": sizes})
                    return
                # single skill
                m = re.match(r'^/api/skills/([\w-]+)$', url)
                if m:
                    slug = m.group(1)
                    skills = manager.find_all()
                    info = next((s for s in skills if s.slug == slug), None)
                    if not info:
                        self._json(404, {"error": "not found"})
                        return
                    size = manager.dir_size(Path(info.path))
                    meta = None
                    try:
                        meta = json.loads((Path(info.path) / "_meta.json").read_text(encoding="utf-8"))
                    except Exception:
                        pass
                    self._json(200, {**info.to_dict(), "size": size, "meta": meta})
                    return
                self._json(404, {"error": "not_found"})

            def do_POST(self):
                url = self.path.split("?")[0]
                # 把命令行映射为 REST 按钮
                routes = {
                    "/api/skills/verify": lambda: cli._run_cmd("verify"),
                    "/api/skills/verify-fix": lambda: cli._run_cmd("verify", fix=True),
                    "/api/skills/outdated": lambda: cli._run_cmd("outdated"),
                    "/api/skills/deps": lambda: cli._run_cmd("deps"),
                    "/api/skills/registry": lambda: cli._run_cmd("registry"),
                    "/api/skills/init": lambda: cli._run_cmd("init", force=True),
                    "/api/skills/audit": lambda: cli._run_cmd("audit"),
                    "/api/skills/clean": lambda: cli._run_cmd("clean"),
                }
                if url in routes:
                    result = routes[url]()
                    self._json(200, result)
                    return
                # check single
                m = re.match(r'^/api/skills/check/([\w-]+)$', url)
                if m:
                    self._json(200, cli._run_cmd("check", skill=m.group(1)))
                    return
                # bump
                m = re.match(r'^/api/skills/bump/([\w-]+)/(major|minor|patch)$', url)
                if m:
                    self._json(200, cli._run_cmd("bump", skill=m.group(1), component=m.group(2)))
                    return
                self._json(404, {"error": "not_found"})

        print(f"🚀 Skill Manager API 启动: http://0.0.0.0:{port}")
        print(f"   可用端点: GET  /api/skills, /api/skills/overview, /api/skills/size, /api/skills/health")
        print(f"            POST /api/skills/{{verify,audit,clean,registry,init,deps,outdated}}")
        print(f"   按 Ctrl+C 停止")
        with socketserver.TCPServer(("0.0.0.0", port), Handler) as httpd:
            try:
                httpd.serve_forever()
            except KeyboardInterrupt:
                print("\n👋 已停止")


# ---------------------------------------------------------------------------
# CLI 入口
# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="OpenClaw Skill Manager v2 — 通用技能管理引擎",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--skills-dir", default=os.environ.get("SKILL_MANAGER_DIR", str(Path.home() / ".openclaw" / "shared-skills")),
                      help="技能根目录（默认 ~/.openclaw/shared-skills）")
    parser.add_argument("--registry", default=None, help="registry.json 路径")
    parser.add_argument("--maps", default=None, help="maps.json 路径（覆盖内置映射）")
    sub = parser.add_subparsers(dest="command", help="子命令")

    # existing commands
    p_list = sub.add_parser("list", help="列出所有技能")
    p_list.add_argument("--category", "-c", help="按分类过滤")
    p_list.add_argument("--source", "-s", help="按来源过滤")
    p_list.add_argument("--missing-meta", action="store_true", help="仅显示缺少 _meta.json")
    p_list.add_argument("--health", type=int, metavar="N", help="仅显示健康分低于 N")
    p_list.add_argument("--stats", action="store_true", help="显示统计汇总")
    p_list.add_argument("--format", "-f", choices=["table", "short", "json"], default="table")

    sub.add_parser("health", help="技能健康仪表盘")

    p_inspect = sub.add_parser("inspect", help="查看技能详情")
    p_inspect.add_argument("skill", help="技能 slug")
    p_inspect.add_argument("--json", action="store_true")

    p_init = sub.add_parser("init", help="生成 _meta.json")
    p_init.add_argument("skill", nargs="?")
    p_init.add_argument("--force", action="store_true")
    p_init.add_argument("--dry-run", action="store_true")
    p_init.add_argument("--quiet", "-q", action="store_true")

    p_registry = sub.add_parser("registry", help="生成 registry.json")
    p_registry.add_argument("--dry-run", action="store_true")

    p_verify = sub.add_parser("verify", help="验证完整性")
    p_verify.add_argument("skill", nargs="?")
    p_verify.add_argument("--fix", action="store_true")

    sub.add_parser("outdated", help="列出需要更新的技能")

    p_deps = sub.add_parser("deps", help="查看依赖关系")
    p_deps.add_argument("skill", nargs="?")

    p_export = sub.add_parser("export", help="导出技能清单")
    p_export.add_argument("--format", "-f", choices=["json", "markdown", "csv"], default="json")

    p_check = sub.add_parser("check", help="检查上游更新")
    p_check.add_argument("skill", nargs="?")

    p_sync = sub.add_parser("sync", help="同步 frontmatter")
    p_sync.add_argument("skill", nargs="?")
    p_sync.add_argument("--dry-run", action="store_true")

    p_bump = sub.add_parser("bump", help="版本号升级")
    p_bump.add_argument("skill", nargs="?")
    p_bump.add_argument("component", nargs="?", choices=["major", "minor", "patch"])
    p_bump.add_argument("--all", action="store_true", help="批量升级 0.0.0 → 1.0.0")
    p_bump.add_argument("--dry-run", action="store_true")

    p_enrich = sub.add_parser("enrich", help="补全 frontmatter")
    p_enrich.add_argument("skill", nargs="?")
    p_enrich.add_argument("--dry-run", action="store_true")

    # new commands
    p_size = sub.add_parser("size", help="磁盘占用分析")
    p_size.add_argument("--top", type=int, default=10, help="显示 Top N")
    p_size.add_argument("--targets", action="store_true", help="列出可清理项")

    sub.add_parser("audit", help="安全与质量审计")

    p_clean = sub.add_parser("clean", help="清理冗余文件")
    p_clean.add_argument("skill", nargs="?")
    p_clean.add_argument("--dry-run", action="store_true", help="预览不删除")

    p_search = sub.add_parser("search", help="搜索技能")
    p_search.add_argument("keyword", help="关键词")

    p_template = sub.add_parser("template", help="生成新技能骨架")
    p_template.add_argument("slug", help="技能 slug")

    p_conflicts = sub.add_parser("conflicts", help="检测重复/相似技能")
    p_conflicts.add_argument("--threshold", type=float, default=0.3, help="相似度阈值 0-1")

    p_serve = sub.add_parser("serve", help="启动 HTTP API（把 CLI 变按钮）")
    p_serve.add_argument("--port", type=int, default=8080, help="监听端口")

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(0)

    manager = SkillManager(
        skills_dir=Path(args.skills_dir),
        registry_file=Path(args.registry) if args.registry else None,
        maps_file=Path(args.maps) if args.maps else None,
    )
    cli = SkillManagerCLI(manager)

    commands = {
        "list": cli.cmd_list, "inspect": cli.cmd_inspect, "init": cli.cmd_init,
        "registry": cli.cmd_registry, "verify": cli.cmd_verify,
        "outdated": cli.cmd_outdated, "deps": cli.cmd_deps,
        "export": cli.cmd_export, "check": cli.cmd_check,
        "sync": cli.cmd_sync, "bump": cli.cmd_bump,
        "enrich": cli.cmd_enrich, "health": cli.cmd_health,
        # new
        "size": cli.cmd_size, "audit": cli.cmd_audit, "clean": cli.cmd_clean,
        "search": cli.cmd_search, "template": cli.cmd_template,
        "conflicts": cli.cmd_conflicts, "serve": cli.cmd_serve,
    }
    commands[args.command](args)


if __name__ == "__main__":
    main()
