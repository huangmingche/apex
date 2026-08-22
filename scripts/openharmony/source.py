#!/usr/bin/env python3
"""Apex-owned OpenHarmony source acquisition and read-only verification.

Only ``sync`` writes an external, initially empty workspace. Git configuration,
the upstream manifest checkout, and an existing source workspace are never fixed
or normalized by the verifier. No third-party Python packages are required.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
OFFICIAL = "https://gitcode.com/openharmony/manifest.git"
TAG = "OpenHarmony-v7.0-Release"
COMMIT = "2cf9dc1ee5c1738f1aa5ef31a96c4de705e8bd1f"
TAG_OBJECT = "af9147402dd7f7ad1c0cd6e7adabf73bfe9cfcdf"
TREE = "a91df637e54b9940434a7cbad952ef5c2c895e60"
SHA1 = re.compile(r"[0-9a-f]{40}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
POINTER = re.compile(rb"version https://git-lfs.github.com/spec/v1\noid sha256:([0-9a-f]{64})\nsize ([0-9]+)\n?\Z")


class SourceError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise SourceError(message)


def environment(**extra):
    result = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    result.update(GIT_OPTIONAL_LOCKS="0", GIT_NO_LAZY_FETCH="1", GIT_NO_REPLACE_OBJECTS="1", GIT_ATTR_NOSYSTEM="1",
                  GIT_TERMINAL_PROMPT="0", PYTHONDONTWRITEBYTECODE="1")
    result.update(extra)
    return result


def run(args, cwd=None, *, data=None, text=True, inherit=False, extra_env=None):
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, input=data,
                            stdout=None if inherit else subprocess.PIPE,
                            stderr=None if inherit else subprocess.PIPE,
                            text=text, env=environment(**(extra_env or {})))
    if result.returncode:
        error = result.stderr if text else (result.stderr or b"").decode(errors="replace")
        raise SourceError(f"{args[0]} {args[1]} failed ({result.returncode}): {(error or '').strip()[:2000]}")
    return result.stdout


def git(cwd, *args, data=None, text=True):
    return run(["git", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", *args],
               cwd, data=data, text=text)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def relative_path(value, label="path", allow_dot=False):
    require(isinstance(value, str) and value and "\\" not in value and "\0" not in value,
            f"Invalid {label}: {value!r}")
    if allow_dot and value == ".":
        return value
    parts = value.split("/")
    require(not value.startswith("/") and all(p not in ("", ".", "..") for p in parts)
            and all(p.lower() not in (".git", ".repo") for p in parts), f"Unsafe {label}: {value}")
    return value


def regular_bytes(path):
    require(path.is_file() and not path.is_symlink(), f"Expected a regular file: {path}")
    return path.read_bytes()


def xml(data):
    require(b"<!DOCTYPE" not in data.upper() and b"<!ENTITY" not in data.upper(), "XML entities/DOCTYPE are not allowed")
    try:
        root = ET.fromstring(data)
    except ET.ParseError as error:
        raise SourceError(f"Invalid source manifest: {error}") from error
    require(root.tag == "manifest", "XML root must be manifest")
    return root


def normalized_url(url):
    return url.rstrip("/").removesuffix(".git")


def https_source(url):
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == "https" and parsed.netloc and not parsed.username and not parsed.password
            and not parsed.query and not parsed.fragment, f"Source must be an explicit HTTPS repository: {url}")
    return url


def read_manifest(data, reader=None, seen=None):
    """Expand official includes; duplicate identical defaults/remotes are legal."""
    result = {"remotes": {}, "default": {}, "projects": {}}
    seen = set() if seen is None else seen
    for node in xml(data):
        if node.tag == "include":
            name = relative_path(node.get("name"), "include")
            require(reader is not None and name not in seen and set(node.attrib) == {"name"},
                    f"Unsupported or cyclic manifest include: {name}")
            nested = read_manifest(reader(name), reader, seen | {name})
            for group in ("remotes", "projects"):
                for key, value in nested[group].items():
                    require(key not in result[group] or result[group][key] == value, f"Conflicting {group}: {key}")
                    result[group][key] = value
            if nested["default"]:
                require(not result["default"] or result["default"] == nested["default"], "Conflicting manifest defaults")
                result["default"] = nested["default"]
        elif node.tag == "remote":
            value = dict(node.attrib)
            name = value.get("name")
            require(name and "fetch" in value, "Invalid manifest remote")
            https_source(value["fetch"])
            require(name not in result["remotes"] or result["remotes"][name] == value, f"Duplicate remote: {name}")
            result["remotes"][name] = value
        elif node.tag == "default":
            value = dict(node.attrib)
            require(not result["default"] or result["default"] == value, "Conflicting manifest defaults")
            result["default"] = value
        elif node.tag == "project":
            attrs = dict(node.attrib)
            name = relative_path(attrs.get("name"), "project name")
            path = relative_path(attrs.get("path", name), "project path")
            require(path not in result["projects"], f"Duplicate project path: {path}")
            children = []
            for child in node:
                require(child.tag in ("copyfile", "linkfile"), f"Unsupported project child: {child.tag}")
                require(set(child.attrib) == {"src", "dest"}, "Unexpected file mapping attributes")
                relative_path(child.get("src"), "mapping source", allow_dot=True)
                relative_path(child.get("dest"), "mapping destination")
                children.append((child.tag, dict(child.attrib)))
            result["projects"][path] = {"attrs": attrs, "files": children}
        else:
            raise SourceError(f"Unsupported manifest element: {node.tag}")
    return result


def project_url(manifest, project):
    attrs = project["attrs"]
    remote = attrs.get("remote", manifest["default"].get("remote"))
    require(remote in manifest["remotes"], f"Missing remote: {remote}")
    return manifest["remotes"][remote]["fetch"].rstrip("/") + "/" + attrs["name"] + ".git"


def project_revision(manifest, project):
    attrs = project["attrs"]
    remote = attrs.get("remote", manifest["default"].get("remote"))
    return attrs.get("revision", manifest["remotes"][remote].get("revision", manifest["default"].get("revision")))


def compare_manifest(official, resolved):
    require(official["remotes"] == resolved["remotes"], "Locked manifest remotes differ from official manifest")
    require(official["default"] == resolved["default"], "Locked manifest defaults differ from official manifest")
    require(official["projects"].keys() == resolved["projects"].keys(), "Locked manifest project set differs from official manifest")
    for path, source in official["projects"].items():
        pinned = resolved["projects"][path]
        a, b = source["attrs"], pinned["attrs"]
        require(SHA1.fullmatch(b.get("revision", "")), f"Project must use a full commit SHA: {path}")
        require(project_url(official, source) == project_url(resolved, pinned), f"Project source differs: {path}")
        require(source["files"] == pinned["files"], f"Project file mappings differ: {path}")
        require(project_revision(official, source) == "refs/tags/" + TAG, f"Unexpected official revision: {path}")
        def stable(attrs):
            result = {key: value for key, value in attrs.items()
                      if key not in ("revision", "remote", "path", "groups", "upstream", "dest-branch")}
            result["path"] = attrs.get("path", attrs["name"])
            groups = set(filter(None, attrs.get("groups", "").split(",")))
            if "notdefault" not in groups:
                groups.add("default")
            result["groups"] = sorted(groups)
            return result
        require(stable(a) == stable(b), f"Project attributes differ from official manifest: {path}")
        for attr in ("upstream", "dest-branch"):
            require(b.get(attr, "refs/tags/" + TAG) == "refs/tags/" + TAG, f"Unexpected {attr}: {path}")


def tree_entries(path, revision="HEAD"):
    entries = {}
    for entry in git(path, "ls-tree", "-r", "-l", "-z", revision, text=False).split(b"\0"):
        if not entry:
            continue
        info, name = entry.split(b"\t", 1)
        mode, kind, oid, size = info.decode().split()
        filename = name.decode("utf-8", "surrogateescape")
        relative_path(filename, "Git tree path")
        require(mode in ("100644", "100755", "120000", "160000"), f"Unsupported Git file mode: {filename}")
        entries[filename] = {"mode": mode, "kind": kind, "oid": oid, "size": int(size) if size != "-" else None}
    return entries


def small_blobs(path, entries):
    ids = sorted({entry["oid"] for entry in entries.values() if entry["kind"] == "blob" and entry["size"] <= 1024})
    if not ids:
        return {}
    output = git(path, "cat-file", "--batch", data=("\n".join(ids) + "\n").encode(), text=False)
    blobs, cursor = {}, 0
    for oid in ids:
        end = output.index(b"\n", cursor)
        actual, kind, length = output[cursor:end].decode().split()
        require(actual == oid and kind == "blob", f"Missing Git blob: {oid}")
        length = int(length)
        blobs[oid] = output[end + 1:end + 1 + length]
        cursor = end + 2 + length
    return blobs


def digest_file(path, algorithm, prefix=b""):
    result = hashlib.new(algorithm)
    result.update(prefix)
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            result.update(chunk)
    return result.hexdigest()


def committed_attributes_many(repo, names):
    """Read only official attributes, isolated from source info/attributes.

    The temporary Git metadata is outside both source trees. Existing objects
    are referenced read-only; no repository is cloned and no commit is made.
    """
    objects = Path(git(repo, "rev-parse", "--git-path", "objects").strip())
    if not objects.is_absolute():
        objects = repo / objects
    objects = objects.resolve()
    require("\n" not in str(objects) and "\r" not in str(objects), "Unsupported Git object directory")
    commit = git(repo, "rev-parse", "HEAD").strip()
    with tempfile.TemporaryDirectory(prefix="apex-oh-attributes-") as temporary:
        view = Path(temporary)
        (view / "objects/info").mkdir(parents=True)
        (view / "refs").mkdir()
        (view / "HEAD").write_text(commit + "\n")
        (view / "config").write_text("[core]\n bare = true\n")
        (view / "objects/info/alternates").write_text(str(objects) + "\n")
        output = run(["git", "--git-dir", str(view), "-c", "core.attributesFile=/dev/null",
                      "check-attr", "--source=HEAD", "-z", "--stdin", "text", "eol", "filter",
                      "working-tree-encoding", "ident"], data=b"".join(os.fsencode(name) + b"\0" for name in names), text=False)
    parts = output.split(b"\0")
    attributes = {}
    for i in range(0, len(parts) - 1, 3):
        attributes.setdefault(os.fsdecode(parts[i]), {})[parts[i + 1].decode()] = parts[i + 2].decode()
    return attributes


def committed_attributes(repo, name):
    return committed_attributes_many(repo, [name])[name]


def official_crlf_checkout(repo, name, file, entry):
    """Accept only CRLF expansion explicitly required by committed attributes.

    No clean/smudge filter runs. Global, system and local info attributes cannot
    approve conversions; normalized content must equal the locked Git blob.
    """
    attrs = committed_attributes(repo, name)
    if attrs.get("eol") != "crlf" or attrs.get("text") == "unset":
        return False
    require(all(attrs.get(key) in ("unspecified", "unset") for key in ("filter", "working-tree-encoding", "ident")),
            f"Unsupported official checkout conversion: {file}")
    digest = hashlib.sha1(b"blob " + str(entry["size"]).encode() + b"\0")
    length, tail = 0, b""
    with file.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            chunk = tail + chunk
            tail = b"\r" if chunk.endswith(b"\r") else b""
            if tail:
                chunk = chunk[:-1]
            normalized = chunk.replace(b"\r\n", b"\n")
            digest.update(normalized)
            length += len(normalized)
    digest.update(tail)
    return length + len(tail) == entry["size"] and digest.hexdigest() == entry["oid"]


def contained(root, candidate):
    return candidate == root or root in candidate.parents


def assert_external(root, source):
    root = root.resolve()
    source = Path(source).absolute()
    require(not source.is_symlink(), f"Source directory cannot be a symlink: {source}")
    actual = source.resolve()
    require(not contained(root, actual) and not contained(actual, root), "Source directory must be outside and not contain the Apex project")
    return actual


def assert_no_symlink_parents(root, path):
    current = path.parent
    while current != root:
        require(contained(root, current) and not current.is_symlink(), f"Source parent escapes checkout: {path}")
        current = current.parent


def check_index(path, entries):
    index = {}
    for row in git(path, "ls-files", "--stage", "-z", text=False).split(b"\0"):
        if row:
            info, filename = row.split(b"\t", 1)
            mode, oid, stage = info.decode().split()
            filename = filename.decode("utf-8", "surrogateescape")
            require(stage == "0" and filename not in index, f"Unmerged Git index: {path}/{filename}")
            index[filename] = (mode, oid)
    require(index == {name: (e["mode"], e["oid"]) for name, e in entries.items()}, f"Git index differs from locked tree: {path}")


def verify_files(path, entries):
    check_index(path, entries)
    blobs = small_blobs(path, entries)
    counts = {"files": 0, "lfsFiles": 0, "lfsBytes": 0}
    for name, entry in entries.items():
        if entry["mode"] == "160000":
            continue
        file = path / name
        assert_no_symlink_parents(path, file)
        try:
            info = file.lstat()
        except FileNotFoundError as error:
            raise SourceError(f"Source file missing: {file}") from error
        expected_mode = entry["mode"]
        mode = "120000" if stat.S_ISLNK(info.st_mode) else (
            "100755" if info.st_mode & 0o111 else "100644") if stat.S_ISREG(info.st_mode) else None
        require(mode == expected_mode, f"Source file mode differs: {file} ({mode}, expected {expected_mode})")
        pointer = POINTER.fullmatch(blobs.get(entry["oid"], b"")) if mode != "120000" else None
        if pointer:
            digest, size = pointer[1].decode(), int(pointer[2])
            require(info.st_size == size and digest_file(file, "sha256") == digest,
                    f"LFS payload missing or changed: {file}")
            counts["lfsFiles"] += 1
            counts["lfsBytes"] += size
        elif mode == "120000":
            content = os.fsencode(os.readlink(file))
            actual = hashlib.sha1(b"blob " + str(len(content)).encode() + b"\0" + content).hexdigest()
            require(actual == entry["oid"], f"Source symlink differs: {file}")
        else:
            actual = digest_file(file, "sha1", b"blob " + str(info.st_size).encode() + b"\0")
            if actual != entry["oid"]:
                require(info.st_size > entry["size"] and official_crlf_checkout(path, name, file, entry),
                        f"Source file content differs: {file}")
        counts["files"] += 1
    return counts


def require_origin(path, expected):
    urls = git(path, "config", "--local", "--get-regexp", r"^remote\..*\.url$").splitlines()
    actual = [line.split(None, 1)[1] for line in urls]
    require(any(normalized_url(url) == normalized_url(expected) for url in actual), f"Official origin missing at {path}: expected {expected}")


def load_lock(root=ROOT):
    root = Path(root).resolve()
    lock = json.loads(regular_bytes(root / "openharmony-source.lock.json"))
    expected = {"schemaVersion": 1, "repository": OFFICIAL, "tag": TAG, "commit": COMMIT,
                "tagObject": TAG_OBJECT, "tree": TREE, "referencePath": ".submodules/openharmony"}
    for key, value in expected.items():
        require(lock.get(key) == value, f"Unexpected OpenHarmony release lock field: {key}")
    gitlink = git(root, "ls-files", "--stage", "--", lock["referencePath"]).strip()
    require(gitlink == f"160000 {COMMIT} 0\t{lock['referencePath']}", "Apex index must record the locked OpenHarmony manifest gitlink")
    for field, expected_value in (("path", lock["referencePath"]), ("url", OFFICIAL)):
        value = git(root, "config", "--file", str(root / ".gitmodules"), "--get", "submodule.openharmony." + field).strip()
        require(value == expected_value, f".gitmodules OpenHarmony {field} differs from lock")
    tooling = lock.get("tooling", {})
    require(tooling.get("repoVersion") == "2.54" and tooling.get("repoRepository") == "https://gerrit.googlesource.com/git-repo"
            and tooling.get("repoCommit") == "97dc5c1bd9527c2abe2183b16a4b7ef037dc34a7", "Unexpected Repo tool identity")
    meta = lock["manifest"]
    require(meta["path"] == "manifests/openharmony-7.0.xml" and SHA256.fullmatch(meta.get("sha256", "")), "Invalid manifest lock metadata")
    content = regular_bytes(root / meta["path"])
    require(sha256(content) == meta["sha256"], "Locked manifest SHA-256 mismatch")
    upstream = root / lock["referencePath"]
    require(upstream.is_dir() and not upstream.is_symlink(), "Official manifest submodule is not initialized")
    for revision, value in [("HEAD", COMMIT), ("HEAD^{tree}", TREE), ("refs/tags/" + TAG, TAG_OBJECT),
                            ("refs/tags/" + TAG + "^{commit}", COMMIT)]:
        require(git(upstream, "rev-parse", "--verify", revision).strip() == value, f"Official manifest {revision} differs from lock")
    require_origin(upstream, OFFICIAL)
    verify_files(upstream, tree_entries(upstream, COMMIT))
    require(not git(upstream, "ls-files", "--others", "--exclude-standard").strip(), "Official manifest contains untracked files")
    resolved = read_manifest(content)
    official = read_manifest(git(upstream, "show", COMMIT + ":default.xml", text=False),
                             lambda name: git(upstream, "show", COMMIT + ":" + name, text=False))
    compare_manifest(official, resolved)
    require(len(resolved["projects"]) == meta["projectCount"] == 518, "Unexpected official project count")
    require(lock.get("release", {}).get("taggerDate") == "2026-08-21T17:06:02Z" and
            lock["release"].get("commitDate") == "2026-08-21T17:03:30Z", "Unexpected release object timestamps")
    for source in lock.get("gitlinkSources", []):
        relative_path(source["parent"]); relative_path(source["path"])
        https_source(source["repository"])
        require(SHA1.fullmatch(source["commit"]) and source.get("evidence"), "Invalid documented nested source")
    return lock, resolved


def gitlink_sources(path, entries, relative, lock):
    required = {name: entry for name, entry in entries.items() if entry["mode"] == "160000"}
    if not required:
        return []
    mappings = {}
    if ".gitmodules" in entries:
        # An empty .gitmodules is valid. --get-regexp would exit 1 for that
        # case; --list yields an empty successful result instead.
        rows = git(path, "config", "--blob", "HEAD:.gitmodules", "--null", "--list")
        sections = {}
        for row in rows.split("\0"):
            if not row:
                continue
            key, separator, value = row.partition("\n")
            if not separator or not key.startswith("submodule.") or key.rsplit(".", 1)[-1] not in ("path", "url"):
                continue
            section, field = key.rsplit(".", 1)
            sections.setdefault(section, {})[field] = value
        for value in sections.values():
            if value.get("path") in required and "url" in value:
                name = relative_path(value["path"])
                require(name not in mappings, f"Duplicate nested source mapping: {relative}/{name}")
                mappings[name] = https_source(value["url"])
    explicit = {(item["parent"], item["path"]): item for item in lock.get("gitlinkSources", [])}
    result = []
    for name, entry in required.items():
        url = mappings.get(name)
        if url is None:
            item = explicit.get((relative, name))
            require(item is not None and item["commit"] == entry["oid"], f"Undocumented nested Git source: {relative}/{name}")
            url = item["repository"]
        result.append((name, entry["oid"], url))
    return result


def verify_repository(workspace, relative, commit, url, lock, project_paths, *, release=False):
    path = workspace / relative
    require(path.is_dir() and not path.is_symlink(), f"Missing source repository: {relative}")
    assert_no_symlink_parents(workspace, path)
    require(Path(git(path, "rev-parse", "--show-toplevel").strip()).resolve() == path.resolve(), f"Wrong Git root: {relative}")
    require(git(path, "rev-parse", "HEAD").strip() == commit, f"Source HEAD differs from lock: {relative}")
    if release:
        require(git(path, "rev-parse", "refs/tags/" + TAG + "^{commit}").strip() == commit,
                f"Official release tag differs: {relative}")
    require_origin(path, url)
    entries = tree_entries(path, commit)
    counts = verify_files(path, entries)
    counts["repositories"] = 1
    nested = gitlink_sources(path, entries, relative, lock)
    exclusions = [name for name, _, _ in nested]
    exclusions += [str(PurePosixPath(p).relative_to(relative)) for p in project_paths
                   if p.startswith(relative + "/")]
    untracked = git(path, "ls-files", "--others", "--exclude-standard", "-z").split("\0")
    unexpected = [name for name in untracked if name and not any(name == prefix or name.startswith(prefix + "/") for prefix in exclusions)]
    require(not unexpected, f"Unexpected source files in {relative}: {unexpected[:5]}")
    for name, nested_commit, nested_url in nested:
        child = verify_repository(workspace, relative + "/" + name, nested_commit, nested_url, lock, project_paths)
        for key, value in child.items():
            counts[key] = counts.get(key, 0) + value
    return counts


def verify_workspace_metadata(source, lock, manifest):
    repo = source / ".repo"
    require(repo.is_dir() and not repo.is_symlink(), "Expected an existing Repo source workspace")
    overrides = repo / "local_manifests"
    require(not overrides.is_symlink() and (not overrides.exists() or not list(overrides.iterdir())), "Local manifest overrides are not allowed")
    require(not (repo / "local_manifest.xml").exists(), "Legacy local manifest override is not allowed")
    manifest_file = repo / "manifest.xml"
    require(manifest_file.exists(), "Workspace manifest is missing")
    if manifest_file.is_symlink():
        require(manifest_file.resolve() == (repo / "manifests/default.xml").resolve(), "Workspace uses another entry manifest")
    else:
        entry = xml(regular_bytes(manifest_file))
        require(not entry.attrib and len(entry) == 1 and entry[0].tag == "include"
                and entry[0].attrib == {"name": "default.xml"} and len(entry[0]) == 0,
                "Workspace entry must include only default.xml")
    try:
        standalone = git(source, "config", "--file", str(repo / "manifests.git/config"), "--get", "manifest.standalone").strip()
    except SourceError:
        standalone = ""
    if not standalone and (repo / "manifests" / ".git").exists():
        upstream = repo / "manifests"
        require(git(upstream, "rev-parse", "HEAD").strip() == lock["commit"], "Existing official manifest checkout has another revision")
        require_origin(upstream, lock["repository"])
        verify_files(upstream, tree_entries(upstream))
        require(not git(upstream, "ls-files", "--others", "--exclude-standard").strip(), "Official workspace manifest has extra files")
        return "official"
    require(standalone, "Workspace has neither an official manifest checkout nor standalone configuration")
    require(sha256(regular_bytes(repo / "manifests/default.xml")) == lock["manifest"]["sha256"], "Standalone workspace manifest differs from the locked XML")
    return "standalone"


def verify_mappings(source, manifest):
    allowed = set()
    for relative, project in manifest["projects"].items():
        for kind, mapping in project["files"]:
            target = source / mapping["dest"]
            origin = source / relative / mapping["src"]
            assert_no_symlink_parents(source, target)
            if kind == "linkfile":
                require(target.is_symlink() and target.resolve() == origin.resolve(), f"Manifest link differs: {mapping['dest']}")
            else:
                require(not target.is_symlink() and target.is_file() and digest_file(target, "sha256") == digest_file(origin, "sha256"),
                        f"Manifest copied file differs: {mapping['dest']}")
            allowed.add(mapping["dest"])
    return allowed


def verify_root_layout(source, project_paths, mapped):
    paths = set(project_paths) | mapped
    def visit(directory, prefix=""):
        for child in directory.iterdir():
            relative = prefix + child.name
            if relative == ".repo" or relative in paths:
                continue
            # APFS creates this volume metadata; it is not part of a source
            # checkout and is permitted only at the actual macOS mount root.
            if (relative == ".fseventsd" and sys.platform == "darwin" and os.path.ismount(source)
                    and child.is_dir() and not child.is_symlink()):
                continue
            if child.is_dir() and not child.is_symlink() and any(p.startswith(relative + "/") for p in paths):
                visit(child, relative + "/")
            else:
                raise SourceError(f"Unexpected file outside source projects: {relative}")
    visit(source)


def verify_source(root, source, jobs=4):
    lock, manifest = load_lock(root)
    source = assert_external(root, source)
    require(source.is_dir(), f"Source directory is missing: {source}")
    mode = verify_workspace_metadata(source, lock, manifest)
    mapped = verify_mappings(source, manifest)
    verify_root_layout(source, manifest["projects"], mapped)
    started = time.monotonic()
    totals = {"repositories": 0, "files": 0, "lfsFiles": 0, "lfsBytes": 0}
    projects = manifest["projects"]
    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as executor:
        pending = {executor.submit(verify_repository, source, path, project["attrs"]["revision"],
                                   project_url(manifest, project), lock, projects, release=True): path
                   for path, project in projects.items()}
        done = 0
        for future in concurrent.futures.as_completed(pending):
            try:
                result = future.result()
                for key, value in result.items():
                    totals[key] += value
            except (SourceError, OSError, ValueError, KeyError) as error:
                failures.append({"project": pending[future], "error": str(error)})
                print(f"OpenHarmony: FAILED {pending[future]}: {error}", file=sys.stderr, flush=True)
            done += 1
            if done % 25 == 0 or done == len(projects):
                print(f"OpenHarmony: verified {done}/{len(projects)} projects", file=sys.stderr, flush=True)
    return {"ok": not failures, "failures": sorted(failures, key=lambda item: item["project"]),
            "sourceDirectory": str(source), "manifestMode": mode, "tag": lock["tag"],
            "manifestCommit": lock["commit"], "projects": len(projects), **totals,
            "readOnly": True, "seconds": round(time.monotonic() - started, 2)}


def fresh_directory(root, source):
    source = assert_external(root, source)
    # Repo searches upward for .repo. An empty child of an existing workspace
    # would otherwise reconfigure its parent during standalone initialization.
    for ancestor in (source, *source.parents):
        require(not os.path.lexists(ancestor / ".repo") and not os.path.lexists(ancestor / ".git"),
                f"Acquisition cannot be inside an existing Repo or Git workspace: {ancestor}")
    require(not source.exists() or (source.is_dir() and not any(source.iterdir())),
            "Acquisition only accepts a new empty directory; use oh:verify to reuse existing sources")
    return source


def case_sensitive_probe(source):
    with tempfile.TemporaryDirectory(prefix=".apex-case-probe-", dir=source) as probe:
        path = Path(probe) / "CaseProbe"
        path.write_text("Apex")
        require(not (Path(probe) / "caseprobe").exists(), "OpenHarmony requires a case-sensitive filesystem")


def supplement_lfs_attributes(path, workspace):
    """Fresh-checkout metadata for genuine upstream LFS pointers lacking attrs.

    Some release blobs are LFS pointers without a matching .gitattributes rule.
    Keep the official tracked files untouched, and declare only those exact
    paths in this new checkout's private Git metadata before LFS materialization.
    """
    entries = tree_entries(path)
    blobs = small_blobs(path, entries)
    pointers = [name for name, item in entries.items()
                if item["mode"] != "160000" and POINTER.fullmatch(blobs.get(item["oid"], b""))]
    if not pointers:
        return 0
    attributes = committed_attributes_many(path, pointers)
    missing = [name for name in pointers if attributes[name].get("filter") != "lfs"]
    if missing:
        file = Path(git(path, "rev-parse", "--git-path", "info/attributes").strip())
        if not file.is_absolute():
            file = path / file
        require(contained(workspace.resolve(), file.resolve()), "LFS metadata escapes the new workspace")
        require(not file.is_symlink() and (not file.exists() or file.is_file()), "Invalid private LFS attributes file")
        file.parent.mkdir(parents=True, exist_ok=True)
        with file.open("a", encoding="utf-8") as stream:
            stream.write("\n# Apex: exact official LFS pointers without upstream attributes.\n")
            for name in missing:
                literal = "/" + re.sub(r"([*?\[\]])", r"\\\1", name)
                stream.write(json.dumps(literal, ensure_ascii=False) + " filter=lfs diff=lfs merge=lfs -text\n")
    return len(missing)


def hydrate_lfs(path, workspace, repository):
    """Configure only new checkout metadata; do not depend on global LFS setup."""
    gitdir = Path(git(path, "rev-parse", "--absolute-git-dir").strip()).resolve()
    require(contained(workspace.resolve(), gitdir), "LFS configuration escapes the new workspace")
    # --skip-repo skips hooks, while --local installs the required Git filters
    # only in this newly acquired repository's config.
    run(["git", "lfs", "install", "--local", "--skip-repo"], path)
    supplement_lfs_attributes(path, workspace)
    rows = git(path, "config", "--local", "--get-regexp", r"^remote\..*\.url$").splitlines()
    remotes = [key[len("remote."):-len(".url")] for row in rows for key, url in [row.split(None, 1)]
               if normalized_url(url) == normalized_url(repository)]
    require(len(remotes) == 1, f"LFS requires one explicit source remote: {path}")
    # User-wide include/exclude settings must not silently omit release assets.
    run(["git", "lfs", "pull", "--include=", "--exclude=", remotes[0]], path, inherit=True)


def initialize_nested(path, relative, lock, workspace):
    entries = tree_entries(path)
    for name, commit, url in gitlink_sources(path, entries, relative, lock):
        target = path / name
        assert_no_symlink_parents(path, target)
        require(not target.is_symlink(), f"Nested source cannot be a symlink: {relative}/{name}")
        if target.exists() and any(target.iterdir()):
            require(git(target, "rev-parse", "HEAD").strip() == commit, f"Nested source differs: {relative}/{name}")
        else:
            target.mkdir(parents=True, exist_ok=True)
            run(["git", "-c", "init.templateDir=", "init", "--quiet"], target)
            run(["git", "config", "--local", "core.hooksPath", ".git/apex-disabled-hooks"], target)
            run(["git", "remote", "add", "origin", url], target)
            run(["git", "fetch", "--no-recurse-submodules", "origin", commit], target, inherit=True)
            run(["git", "-c", "advice.detachedHead=false", "checkout", "--detach", commit], target,
                inherit=True, extra_env={"GIT_LFS_SKIP_SMUDGE": "1"})
        require(Path(git(target, "rev-parse", "--show-toplevel").strip()).resolve() == target.resolve(),
                f"Nested Git root points elsewhere: {relative}/{name}")
        require(contained(workspace, Path(git(target, "rev-parse", "--absolute-git-dir").strip()).resolve()),
                f"Nested Git metadata points outside acquisition: {relative}/{name}")
        hydrate_lfs(target, workspace, url)
        initialize_nested(target, relative + "/" + name, lock, workspace)


def sync_source(root, source, jobs=4):
    lock, manifest = load_lock(root)
    source = fresh_directory(root, source)
    tooling = lock["tooling"]
    require(tooling.get("repoRepository") == "https://gerrit.googlesource.com/git-repo"
            and SHA1.fullmatch(tooling.get("repoCommit", "")), "Repo tool must have a locked official commit")
    run(["git", "lfs", "version"])
    # Verify the launcher is present before creating any acquisition files.
    run(["repo", "--version"], Path(root))
    launcher_help = run(["repo", "init", "--help"], Path(root))
    require("--standalone-manifest" in launcher_help and "--repo-rev" in launcher_help,
            "The installed Repo launcher lacks standalone-manifest support; use the official Repo 2.54 launcher on PATH")
    source.mkdir(parents=True, exist_ok=True)
    case_sensitive_probe(source)
    try:
        run(["repo", "init", "--standalone-manifest", "-u", (Path(root) / lock["manifest"]["path"]).resolve().as_uri(),
             "--repo-url", tooling["repoRepository"], "--repo-rev", tooling["repoCommit"], "--no-clone-bundle"],
            source, inherit=True)
        require(git(source / ".repo/repo", "rev-parse", "HEAD").strip() == tooling["repoCommit"], "Repo tool revision differs from lock")
        run(["repo", "sync", "-c", "--no-clone-bundle", "--fail-fast", "-j", str(jobs)], source,
            inherit=True, extra_env={"GIT_LFS_SKIP_SMUDGE": "1"})
        for relative, project in manifest["projects"].items():
            path = source / relative
            require(git(path, "rev-parse", "HEAD").strip() == project["attrs"]["revision"], f"Downloaded another revision: {relative}")
            # Repo may fetch a commit without retaining the release tag; fetch its
            # official tag for independent release-provenance verification.
            run(["git", "fetch", "--no-recurse-submodules", project_url(manifest, project), "refs/tags/" + TAG + ":refs/tags/" + TAG], path, inherit=True)
            hydrate_lfs(path, source, project_url(manifest, project))
            initialize_nested(path, relative, lock, source)
        return verify_source(root, source, jobs)
    except Exception as error:
        raise SourceError(f"{error}\nIncomplete acquisition preserved at {source}; existing files were not erased.") from error


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("lock", "verify", "sync", "test"))
    parser.add_argument("--source-dir", type=Path)
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--report", type=Path, help="Write JSON report outside the Apex project")
    args = parser.parse_args(argv)
    require(1 <= args.jobs <= 32, "--jobs must be between 1 and 32")
    if args.command == "test":
        return subprocess.call([sys.executable, "-B", "-m", "unittest", "discover", "-s", str(Path(__file__).parent), "-p", "test_*.py", "-v"], env=environment())
    if args.command == "lock":
        lock, manifest = load_lock()
        result = {"ok": True, "tag": lock["tag"], "manifestCommit": lock["commit"], "projects": len(manifest["projects"]), "scope": "source-lock"}
    else:
        require(args.source_dir is not None, "--source-dir is required; a private machine path is never assumed")
        result = (verify_source if args.command == "verify" else sync_source)(ROOT, args.source_dir, args.jobs)
    output = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
    if args.report:
        report = assert_external(ROOT, args.report)
        require(not report.exists(), "Refusing to overwrite an existing report")
        if args.source_dir:
            require(not contained(args.source_dir.resolve(), report), "Verification reports must stay outside the source workspace")
        report.parent.mkdir(parents=True, exist_ok=True)
        with report.open("x", encoding="utf-8") as stream:
            stream.write(output)
    print(output, end="")
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (SourceError, OSError, ValueError, KeyError) as error:
        print(f"FAIL OpenHarmony: {error}", file=sys.stderr)
        sys.exit(1)
