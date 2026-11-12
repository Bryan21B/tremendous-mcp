#!/usr/bin/env node
import { execFileSync } from "node:child_process";

/**
 * Blocks a push that carries credentials.
 *
 * Runs at pre-push rather than pre-commit on purpose: a secret committed
 * locally is recoverable with a rebase, one that reached the remote has to be
 * treated as burned. This complements the pre-commit hook, it does not replace
 * it.
 *
 * Every git invocation goes through `execFileSync` with an argument array —
 * interpolating a branch or file name into a shell string is CWE-78.
 */
const PATTERNS = [
  { name: "AWS access key", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "PEM private key block", regex: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "Stripe secret key", regex: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: "Anthropic API key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "OpenAI API key", regex: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  {
    name: "JSON web token",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    name: "connection URL with a password",
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/,
  },
];

/** Binary blobs and lockfiles produce nothing but false positives. */
const SKIPPED = /(^|\/)(bun\.lock|package-lock\.json|pnpm-lock\.yaml)$|\.(png|jpe?g|gif|ico|webp|pdf|woff2?)$/;

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // The probes below fail on purpose; their stderr is not useful to the user.
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** git output, or `null` when the command fails. */
function tryGit(args) {
  try {
    return git(args).trim();
  } catch {
    return null;
  }
}

/**
 * Files to scan before a push, from the most precise to the widest:
 *   1. The branch has an upstream: only what separates it from HEAD.
 *   2. No upstream but a known remote default branch: everything since the merge base.
 *   3. Neither (never pushed): every tracked file.
 *
 * Case 3 must stay a full scan: diffing against the worktree would return
 * nothing once the secrets are committed, which is exactly when the push takes them.
 */
function filesToScan() {
  const upstream = tryGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);

  if (upstream !== null) {
    return listDiff(`${upstream}..HEAD`);
  }

  const defaultRef = tryGit(["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  const base = defaultRef === null ? null : tryGit(["merge-base", defaultRef, "HEAD"]);

  if (base !== null) {
    return listDiff(`${base}..HEAD`);
  }

  return filter(git(["ls-tree", "-r", "--name-only", "HEAD"]));
}

function listDiff(range) {
  return filter(git(["diff", "--name-only", range]));
}

function filter(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !SKIPPED.test(line));
}

const findings = [];

for (const file of filesToScan()) {
  let content;
  try {
    content = git(["show", `HEAD:${file}`]);
  } catch {
    continue; // File deleted in the range.
  }

  content.split("\n").forEach((line, index) => {
    for (const { name, regex } of PATTERNS) {
      if (regex.test(line)) {
        findings.push(`  ${file}:${index + 1} — ${name}`);
      }
    }
  });
}

if (findings.length > 0) {
  process.stderr.write(
    [
      "Push blocked: possible secret found.",
      ...findings,
      "",
      "Remove it and rewrite the history before you push again.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
