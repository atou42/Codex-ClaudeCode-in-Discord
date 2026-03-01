#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const VALID_BUMPS = new Set(["patch", "minor", "major"]);
const bump = process.argv[2];

if (!VALID_BUMPS.has(bump)) {
  console.error("Usage: node scripts/cut-release.mjs <patch|minor|major>");
  process.exit(1);
}

const ALLOWED_UNTRACKED = new Set([".bot.log"]);

function run(cmd, args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.error) {
    if (allowFailure) return "";
    throw result.error;
  }

  if (result.status !== 0) {
    if (allowFailure) return "";
    const detail = capture ? `\n${result.stderr || result.stdout}` : "";
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}${detail}`);
  }

  return capture ? result.stdout.trim() : "";
}

function assertCleanWorktree() {
  const status = run("git", ["status", "--porcelain"], { capture: true });
  if (!status) return;
  const blocked = status
    .split("\n")
    .filter(Boolean)
    .filter((line) => {
      if (!line.startsWith("?? ")) return true;
      const filePath = line.slice(3).trim();
      return !ALLOWED_UNTRACKED.has(filePath);
    });

  if (blocked.length > 0) {
    console.error("Working tree must be clean before cutting a release.");
    console.error(blocked.join("\n"));
    process.exit(1);
  }
}

function extractReleaseNotes(version) {
  const changelogPath = path.resolve(process.cwd(), "CHANGELOG.md");
  if (!fs.existsSync(changelogPath)) return "";
  const content = fs.readFileSync(changelogPath, "utf8");
  const lines = content.split(/\r?\n/);
  const header = `## [${version}]`;
  const start = lines.findIndex((line) => line.startsWith(header));
  if (start === -1) return "";

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## [")) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

run("gh", ["auth", "status"], { capture: false });
assertCleanWorktree();

const branch = run("git", ["branch", "--show-current"], { capture: true });
if (branch !== "main") {
  console.error(`Releases must be cut from main (current: ${branch}).`);
  process.exit(1);
}

const tag = run(
  "npm",
  ["version", bump, "-m", "chore(release): cut v%s"],
  { capture: true }
)
  .split("\n")
  .pop()
  .trim();

if (!tag.startsWith("v")) {
  throw new Error(`Unexpected npm version output: ${tag}`);
}

const version = tag.slice(1);
run("git", ["push", "origin", "main", "--follow-tags"]);

const notes = extractReleaseNotes(version);
if (notes) {
  const notesPath = path.join(os.tmpdir(), `release-notes-${tag}.md`);
  fs.writeFileSync(notesPath, notes + "\n", "utf8");
  const exists = run("gh", ["release", "view", tag], {
    capture: true,
    allowFailure: true,
  });

  if (exists) {
    run("gh", ["release", "edit", tag, "--title", tag, "--notes-file", notesPath]);
  } else {
    run("gh", [
      "release",
      "create",
      tag,
      "--target",
      "main",
      "--title",
      tag,
      "--notes-file",
      notesPath,
    ]);
  }
} else {
  run("gh", ["release", "create", tag, "--target", "main", "--title", tag, "--generate-notes"]);
}

console.log(`Release complete: ${tag}`);
