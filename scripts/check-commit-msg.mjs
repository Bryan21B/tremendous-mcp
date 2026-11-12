/**
 * Rejects a commit message whose subject is not a Conventional Commit.
 * Run by `.husky/commit-msg` with the path of the message file.
 *
 * The type is code: semantic-release derives the next version from it
 * (feat -> minor, fix/perf -> patch, others -> no release). A subject without a
 * type silently produces no release, so this hook stops it before it exists.
 *
 * The types are those of the `conventionalcommits` preset in `.releaserc.json`.
 * Plain `.mjs`: it runs in a git hook, without the TypeScript toolchain.
 */
import { readFileSync } from "node:fs";

const TYPES = ["feat", "fix", "perf", "refactor", "docs", "test", "chore", "build", "ci", "style", "revert"];
const SUBJECT = new RegExp(`^(${TYPES.join("|")})(\\([^()\\s][^()]*\\))?!?: \\S`);
/** What git writes itself: merge, revert, and rebase fixup/squash/amend. */
const GIT_WRITTEN = /^(Merge |Revert "|fixup! |squash! |amend! )/;

/**
 * @param {string} message the full message, including git comments
 * @returns {string | null} why it is rejected, or `null`
 */
export function checkCommitMessage(message) {
  const subject =
    message
      .split("\n")
      .find((line) => line.trim() !== "" && !line.startsWith("#"))
      ?.trimEnd() ?? "";
  if (GIT_WRITTEN.test(subject) || SUBJECT.test(subject)) {
    return null;
  }
  return (
    `subject is not a Conventional Commit: "${subject}". ` +
    `Expected: <type>(<scope>): <description>, with type one of ${TYPES.join(", ")}. ` +
    "semantic-release derives the version from the type (see README > Releases)."
  );
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  const reason = checkCommitMessage(readFileSync(process.argv[2], "utf8"));
  if (reason) {
    process.stderr.write(`commit-msg: ${reason}\n`);
    process.exit(1);
  }
}
