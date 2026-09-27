import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const terms = [
  ["true", "coach"],
  ["trainer", "ize"],
  ["ever", "fit"],
  ["my", "pt", "hub"],
  ["my ", "pt ", "hub"],
  ["pt", "distinction"],
  ["pt ", "distinction"],
  ["coach", "rx"],
  ["train", "heroic"],
  ["fit", "sw"],
  ["team", "buildr"],
  ["kab", "ata"],
].map((parts) => parts.join(""));

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hitPattern = new RegExp(terms.map(escapeRegExp).join("|"), "gi");

function globToRegExp(glob) {
  let expression = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += escapeRegExp(character);
    }
  }
  return new RegExp(`${expression}$`);
}

function fail(message) {
  console.error(`vendor-name guard: ${message}`);
  process.exitCode = 1;
}

let configuration;
try {
  configuration = JSON.parse(readFileSync(".vendor-name-guard.json", "utf8"));
} catch (error) {
  fail(`could not read .vendor-name-guard.json: ${error.message}`);
  process.exit();
}

if (
  !configuration ||
  !Array.isArray(configuration.include) ||
  !Array.isArray(configuration.allowlist) ||
  configuration.include.some((glob) => typeof glob !== "string") ||
  configuration.allowlist.some(
    (entry) =>
      !entry ||
      typeof entry.glob !== "string" ||
      typeof entry.reason !== "string" ||
      typeof entry.retire !== "string",
  )
) {
  fail(
    "configuration must contain include globs and allowlist {glob, reason, retire} entries",
  );
  process.exit();
}

const includes = configuration.include.map(globToRegExp);
const entries = configuration.allowlist.map((entry) => ({
  ...entry,
  pattern: globToRegExp(entry.glob),
  hits: 0,
}));
const trackedFiles = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

for (const file of trackedFiles) {
  if (!includes.some((pattern) => pattern.test(file))) {
    continue;
  }

  const content = readFileSync(file, "utf8");
  const hits = content.match(hitPattern) ?? [];
  if (hits.length === 0) {
    continue;
  }

  const matchingEntries = entries.filter((entry) => entry.pattern.test(file));
  if (matchingEntries.length === 0) {
    fail(`${file}: ${hits.length} prohibited name hit(s) outside the allowlist`);
    continue;
  }

  for (const entry of matchingEntries) {
    entry.hits += hits.length;
  }
}

for (const entry of entries) {
  console.log(
    `${entry.glob}: ${entry.hits} hit(s) — ${entry.reason}; retire: ${entry.retire}`,
  );
  if (entry.hits === 0) {
    fail(`${entry.glob}: stale allowlist entry matches zero hits`);
  }
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log("vendor-name guard: passed");
