"""Behavioral checks use disposable external Git indexes, never create commits."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import source


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="apex-oh-test-")
        self.base = Path(self.temporary.name).resolve()
        self.addCleanup(self.temporary.cleanup)

    def repository(self):
        directory = self.base / "repository"
        directory.mkdir()
        source.run(["git", "-c", "init.templateDir=", "init", "--quiet"], directory)
        return directory

    def add(self, repo, name, blob, worktree=None, mode="100644"):
        oid = source.git(repo, "hash-object", "-w", "--stdin", data=blob, text=False).decode().strip()
        source.git(repo, "update-index", "--add", "--cacheinfo", f"{mode},{oid},{name}")
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if mode == "120000":
            path.symlink_to(os.fsdecode(blob))
        else:
            path.write_bytes(blob if worktree is None else worktree)
            path.chmod(0o755 if mode == "100755" else 0o644)
        return {name: {"mode": mode, "kind": "blob", "oid": oid, "size": len(blob)}}

    def manifest(self, revision=None, clone=True):
        revision = revision or "refs/tags/" + source.TAG
        extra = ' clone-depth="1"' if clone else ""
        return (f'<manifest><remote name="gitcode" fetch="https://gitcode.com/openharmony"/>'
                f'<default remote="gitcode" revision="refs/tags/{source.TAG}"/>'
                f'<project name="example" path="src/example" revision="{revision}"{extra}>'
                '<linkfile src="start.sh" dest="start.sh"/></project></manifest>').encode()

    def test_clean_files_are_verified_without_writing_index(self):
        repo = self.repository()
        entries = self.add(repo, "file.txt", b"official content\n")
        entries.update(self.add(repo, "bin/start", b"#!/bin/sh\n", mode="100755"))
        entries.update(self.add(repo, "link", b"file.txt", mode="120000"))
        before = (repo / ".git/index").read_bytes()
        result = source.verify_files(repo, entries)
        self.assertEqual(result["files"], 3)
        self.assertEqual((repo / ".git/index").read_bytes(), before)
        self.assertFalse((repo / ".git/index.lock").exists())

    def test_same_size_changed_content_is_rejected_even_with_skip_worktree(self):
        repo = self.repository()
        entries = self.add(repo, "file", b"original")
        source.git(repo, "update-index", "--skip-worktree", "file")
        (repo / "file").write_bytes(b"modified")
        with self.assertRaisesRegex(source.SourceError, "content differs"):
            source.verify_files(repo, entries)

    def test_staged_change_is_rejected(self):
        repo = self.repository()
        entries = self.add(repo, "file", b"original")
        oid = source.git(repo, "hash-object", "-w", "--stdin", data=b"changed", text=False).decode().strip()
        source.git(repo, "update-index", "--cacheinfo", f"100644,{oid},file")
        with self.assertRaisesRegex(source.SourceError, "index differs"):
            source.verify_files(repo, entries)

    def test_mode_and_missing_files_are_rejected(self):
        repo = self.repository()
        entries = self.add(repo, "file", b"content")
        (repo / "file").chmod(0o755)
        with self.assertRaisesRegex(source.SourceError, "mode differs"):
            source.verify_files(repo, entries)
        (repo / "file").unlink()
        with self.assertRaisesRegex(source.SourceError, "file missing"):
            source.verify_files(repo, entries)

    def test_lfs_payload_uses_pointer_hash_and_size(self):
        repo = self.repository()
        payload = b"binary payload" * 100
        pointer = ("version https://git-lfs.github.com/spec/v1\n"
                   f"oid sha256:{hashlib.sha256(payload).hexdigest()}\nsize {len(payload)}\n").encode()
        entries = self.add(repo, "asset.bin", pointer, payload)
        result = source.verify_files(repo, entries)
        self.assertEqual((result["lfsFiles"], result["lfsBytes"]), (1, len(payload)))
        (repo / "asset.bin").write_bytes(b"X" + payload[1:])
        with self.assertRaisesRegex(source.SourceError, "LFS payload"):
            source.verify_files(repo, entries)
        (repo / "asset.bin").write_bytes(pointer)
        with self.assertRaisesRegex(source.SourceError, "LFS payload"):
            source.verify_files(repo, entries)

    def test_missing_lfs_attribute_is_added_only_to_new_checkout_metadata(self):
        repo = self.repository()
        payload = b"official asset"
        pointer = ("version https://git-lfs.github.com/spec/v1\n"
                   f"oid sha256:{hashlib.sha256(payload).hexdigest()}\nsize {len(payload)}\n").encode()
        entries = self.add(repo, "asset with space.bin", pointer)
        tracked = self.add(repo, ".gitattributes", b"*.txt text\n")
        entries.update(tracked)
        before = (repo / ".gitattributes").read_bytes()
        with patch.object(source, "tree_entries", return_value=entries), \
             patch.object(source, "committed_attributes_many", return_value={"asset with space.bin": {"filter": "unspecified"}}):
            self.assertEqual(source.supplement_lfs_attributes(repo, self.base), 1)
        self.assertEqual((repo / ".gitattributes").read_bytes(), before)
        self.assertEqual((repo / "asset with space.bin").read_bytes(), pointer)
        self.assertIn('"/asset with space.bin" filter=lfs', (repo / ".git/info/attributes").read_text())

    def test_lfs_metadata_matches_literal_glob_characters_only(self):
        repo = self.repository()
        pointer = b"version https://git-lfs.github.com/spec/v1\noid sha256:" + b"a" * 64 + b"\nsize 3\n"
        name = "font[wght]*?.ttf"
        entries = self.add(repo, name, pointer)
        with patch.object(source, "tree_entries", return_value=entries), \
             patch.object(source, "committed_attributes_many", return_value={name: {"filter": "unspecified"}}):
            source.supplement_lfs_attributes(repo, self.base)
        matched = source.git(repo, "check-attr", "-z", "filter", "--", name, "fontwXY.ttf").split("\0")
        self.assertEqual(matched, [name, "filter", "lfs", "fontwXY.ttf", "filter", "unspecified", ""])

    def test_new_checkout_lfs_setup_is_local_without_hooks_and_explicit_remote(self):
        repo = self.repository()
        source.git(repo, "remote", "add", "gitcode", "https://gitcode.com/openharmony/example.git")
        # Let metadata queries use real Git, but intercept LFS commands so
        # ordinary wrapper tests do not need network or the git-lfs binary.
        real_run = source.run
        calls = []
        def run(args, *positional, **kwargs):
            if args[:2] == ["git", "lfs"]:
                calls.append(args)
                return ""
            return real_run(args, *positional, **kwargs)
        with patch.object(source, "run", side_effect=run), patch.object(source, "supplement_lfs_attributes") as supplement:
            source.hydrate_lfs(repo, self.base, "https://gitcode.com/openharmony/example.git")
        self.assertEqual(calls, [["git", "lfs", "install", "--local", "--skip-repo"],
                                 ["git", "lfs", "pull", "--include=", "--exclude=", "gitcode"]])
        supplement.assert_called_once_with(repo, self.base)

    def test_old_repo_launcher_is_rejected_before_target_creation(self):
        root = self.base / "apex"
        root.mkdir()
        target = self.base / "new-source"
        lock = {"manifest": {"path": "manifests/openharmony-7.0.xml"},
                "tooling": {"repoRepository": "https://gerrit.googlesource.com/git-repo", "repoCommit": "b" * 40}}
        with patch.object(source, "load_lock", return_value=(lock, {"projects": {}})), \
             patch.object(source, "run", return_value="old launcher"):
            with self.assertRaisesRegex(source.SourceError, "launcher lacks"):
                source.sync_source(root, target)
        self.assertFalse(target.exists())

    def test_parent_symlink_cannot_redirect_source_reads(self):
        repo = self.repository()
        entries = self.add(repo, "directory/file", b"content")
        (repo / "directory").rename(self.base / "outside")
        (repo / "directory").symlink_to(self.base / "outside", target_is_directory=True)
        with self.assertRaisesRegex(source.SourceError, "escapes checkout"):
            source.verify_files(repo, entries)

    def test_crlf_checkout_requires_explicit_committed_eol_attribute(self):
        repo = self.repository()
        entries = self.add(repo, "script.bat", b"one\ntwo\n", b"one\r\ntwo\r\n")
        attributes = {"text": "set", "eol": "crlf", "filter": "unspecified",
                      "working-tree-encoding": "unspecified", "ident": "unspecified"}
        with patch.object(source, "committed_attributes", return_value=attributes):
            self.assertEqual(source.verify_files(repo, entries)["files"], 1)
            attributes["eol"] = "unspecified"
            with self.assertRaisesRegex(source.SourceError, "content differs"):
                source.verify_files(repo, entries)
            attributes["eol"] = "crlf"
            attributes["filter"] = "arbitrary-command"
            with self.assertRaisesRegex(source.SourceError, "Unsupported official"):
                source.verify_files(repo, entries)

    def test_environment_does_not_inherit_git_redirects(self):
        with patch.dict(os.environ, {"GIT_DIR": "/private/repository", "GIT_WORK_TREE": "/private/tree", "GIT_CONFIG_COUNT": "4"}):
            actual = source.environment()
        self.assertNotIn("GIT_DIR", actual)
        self.assertNotIn("GIT_WORK_TREE", actual)
        self.assertNotIn("GIT_CONFIG_COUNT", actual)
        self.assertEqual(actual["GIT_OPTIONAL_LOCKS"], "0")

    def test_external_paths_exclude_project_and_ancestors(self):
        root = self.base / "apex"
        root.mkdir()
        for path in (root, root / "source", self.base):
            with self.assertRaises(source.SourceError):
                source.assert_external(root, path)
        link = self.base / "redirect"
        link.symlink_to(root, target_is_directory=True)
        with self.assertRaises(source.SourceError):
            source.assert_external(root, link / "source")
        self.assertEqual(source.assert_external(root, self.base / "external"), self.base / "external")

    def test_existing_acquisition_is_rejected_without_any_command(self):
        root = self.base / "apex"
        root.mkdir()
        existing = self.base / "source"
        existing.mkdir()
        (existing / "precious.txt").write_text("retain")
        with patch.object(source, "load_lock", return_value=({}, {})), patch.object(source, "run") as run:
            with self.assertRaisesRegex(source.SourceError, "new empty"):
                source.sync_source(root, existing)
            run.assert_not_called()
        self.assertEqual((existing / "precious.txt").read_text(), "retain")

    def test_empty_child_of_existing_repo_or_git_workspace_is_never_initialized(self):
        root = self.base / "apex"
        root.mkdir()
        for marker in (".repo", ".git"):
            existing = self.base / marker[1:]
            (existing / marker).mkdir(parents=True)
            target = existing / "new-empty-child"
            with patch.object(source, "load_lock", return_value=({}, {})), patch.object(source, "run") as run:
                with self.assertRaisesRegex(source.SourceError, "existing Repo or Git"):
                    source.sync_source(root, target)
                run.assert_not_called()
            self.assertFalse(target.exists())

    def test_nested_symlink_is_rejected_before_writes(self):
        parent = self.base / "parent"
        parent.mkdir()
        destination = self.base / "precious"
        destination.mkdir()
        (parent / "nested").symlink_to(destination, target_is_directory=True)
        with patch.object(source, "tree_entries", return_value={}), \
             patch.object(source, "gitlink_sources", return_value=[("nested", "a" * 40, "https://example.org/repo")]), \
             patch.object(source, "run") as run:
            with self.assertRaisesRegex(source.SourceError, "cannot be a symlink"):
                source.initialize_nested(parent, "parent", {}, self.base)
            run.assert_not_called()
        self.assertEqual(list(destination.iterdir()), [])

    def test_xml_entities_and_paths_are_rejected(self):
        for content in (b'<!DOCTYPE manifest [<!ENTITY secret SYSTEM "file:///private">]><manifest/>',
                        b'<manifest><project name="../escape"/></manifest>',
                        b'<manifest><project name="x" path="/absolute"/></manifest>',
                        b'<manifest><project name="x"><linkfile src="../x" dest="x"/></project></manifest>'):
            with self.assertRaises(source.SourceError):
                source.read_manifest(content)

    def test_recursive_include_and_duplicates_are_rejected(self):
        cycle = b'<manifest><include name="same.xml"/></manifest>'
        with self.assertRaisesRegex(source.SourceError, "cyclic"):
            source.read_manifest(cycle, lambda name: cycle)
        with self.assertRaisesRegex(source.SourceError, "Duplicate project"):
            source.read_manifest(b'<manifest><project name="x"/><project name="x"/></manifest>')

    def test_manifest_preserves_provenance_mappings_and_clone_depth(self):
        official = source.read_manifest(self.manifest())
        resolved = source.read_manifest(self.manifest("a" * 40))
        source.compare_manifest(official, resolved)
        for invalid in (self.manifest("main"), self.manifest("a" * 40, clone=False),
                        self.manifest("a" * 40).replace(b"https://gitcode.com/openharmony", b"https://example.org/other"),
                        self.manifest("a" * 40).replace(b'dest="start.sh"', b'dest="different.sh"')):
            with self.assertRaises(source.SourceError):
                source.compare_manifest(official, source.read_manifest(invalid))

    def test_https_sources_only(self):
        for url in ("file:///private", "../other", "http://example.com/repo", "https://user:password@example.com/repo"):
            with self.assertRaises(source.SourceError):
                source.https_source(url)

    def test_extra_local_manifest_is_rejected_before_git_reads(self):
        directory = self.base / "source"
        overrides = directory / ".repo/local_manifests"
        overrides.mkdir(parents=True)
        (overrides / "override.xml").write_text("<manifest/>")
        with patch.object(source, "git") as git:
            with self.assertRaisesRegex(source.SourceError, "overrides"):
                source.verify_workspace_metadata(directory, {}, {})
            git.assert_not_called()

    def test_standalone_manifest_wrapper_is_accepted_and_hash_is_checked(self):
        directory = self.base / "source"
        (directory / ".repo/manifests").mkdir(parents=True)
        content = self.manifest("a" * 40)
        (directory / ".repo/manifests/default.xml").write_bytes(content)
        (directory / ".repo/manifest.xml").write_text('<manifest><include name="default.xml"/></manifest>')
        lock = {"manifest": {"sha256": source.sha256(content)}}
        with patch.object(source, "git", return_value="file:///somewhere/manifest.xml\n"):
            self.assertEqual(source.verify_workspace_metadata(directory, lock, {}), "standalone")
            (directory / ".repo/manifests/default.xml").write_text("<manifest/>")
            with self.assertRaisesRegex(source.SourceError, "differs"):
                source.verify_workspace_metadata(directory, lock, {})

    def test_unknown_root_files_and_symlink_container_are_rejected(self):
        directory = self.base / "source"
        (directory / "components/project").mkdir(parents=True)
        source.verify_root_layout(directory, {"components/project"}, set())
        (directory / "unknown").write_text("unknown")
        with self.assertRaisesRegex(source.SourceError, "Unexpected file"):
            source.verify_root_layout(directory, {"components/project"}, set())
        (directory / "unknown").unlink()
        (directory / "components").rename(self.base / "components")
        (directory / "components").symlink_to(self.base / "components", target_is_directory=True)
        with self.assertRaisesRegex(source.SourceError, "Unexpected file"):
            source.verify_root_layout(directory, {"components/project"}, set())

    def test_unknown_nested_source_is_rejected(self):
        entries = {"nested": {"mode": "160000", "oid": "a" * 40}}
        with self.assertRaisesRegex(source.SourceError, "Undocumented nested"):
            source.gitlink_sources(self.base, entries, "parent", {"gitlinkSources": []})
        lock = {"gitlinkSources": [{"parent": "parent", "path": "nested", "commit": "a" * 40,
                                    "repository": "https://gitcode.com/openharmony/example.git"}]}
        self.assertEqual(source.gitlink_sources(self.base, entries, "parent", lock),
                         [("nested", "a" * 40, "https://gitcode.com/openharmony/example.git")])

    def test_unused_gitmodules_are_not_treated_as_source_dependencies(self):
        entries = {".gitmodules": {"mode": "100644", "oid": "a" * 40}}
        with patch.object(source, "git") as git:
            self.assertEqual(source.gitlink_sources(self.base, entries, "parent", {}), [])
            git.assert_not_called()

    def test_only_actual_gitlinks_require_valid_mapping_urls(self):
        entries = {".gitmodules": {"mode": "100644", "oid": "a" * 40},
                   "actual": {"mode": "160000", "oid": "b" * 40}}
        rows = ("submodule.unused.path\nunused\0submodule.unused.url\ngit://example.org/unused\0"
                "submodule.actual.path\nactual\0submodule.actual.url\nhttps://example.org/actual.git\0")
        with patch.object(source, "git", return_value=rows):
            self.assertEqual(source.gitlink_sources(self.base, entries, "parent", {}),
                             [("actual", "b" * 40, "https://example.org/actual.git")])
        with patch.object(source, "git", return_value=""):
            with self.assertRaisesRegex(source.SourceError, "Undocumented nested"):
                source.gitlink_sources(self.base, entries, "parent", {})

    def test_sync_uses_pinned_tool_and_static_manifest_without_reconfiguration(self):
        root = self.base / "apex"
        root.mkdir()
        target = self.base / "new-source"
        lock = {"manifest": {"path": "manifests/openharmony-7.0.xml"},
                "tooling": {"repoRepository": "https://gerrit.googlesource.com/git-repo", "repoCommit": "b" * 40}}
        calls = []
        def record(args, *a, **kw):
            calls.append(args)
            return "--standalone-manifest --repo-rev" if args == ["repo", "init", "--help"] else ""
        with patch.object(source, "load_lock", return_value=(lock, {"projects": {}})), \
             patch.object(source, "case_sensitive_probe"), \
             patch.object(source, "run", side_effect=record), \
             patch.object(source, "git", return_value="b" * 40 + "\n"), \
             patch.object(source, "verify_source", return_value={"ok": True}) as verify:
            self.assertEqual(source.sync_source(root, target), {"ok": True})
        init = next(args for args in calls if args[:2] == ["repo", "init"] and "--standalone-manifest" in args)
        self.assertIn("--standalone-manifest", init)
        self.assertEqual(init[init.index("--repo-rev") + 1], "b" * 40)
        self.assertTrue(init[init.index("-u") + 1].startswith("file:///"))
        self.assertFalse(any(arg.startswith("--force") for args in calls for arg in args))
        verify.assert_called_once_with(root, target, 4)


if __name__ == "__main__":
    unittest.main()
