import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const target = "src/common/errors/importer-error-responses.ts";
const original = readFileSync(target, "utf8");
const probe = ["true", "coach"].join("");

try {
  appendFileSync(target, `\n// ${probe} guard probe\n`);
  const result = spawnSync(process.execPath, ["scripts/vendor-name-guard.mjs"], {
    encoding: "utf8",
  });
  const output = `${result.stdout}${result.stderr}`;
  if (
    result.status === 0 ||
    !output.includes(target) ||
    !output.includes("outside the allowlist")
  ) {
    throw new Error(
      "guard did not reject a vendor name in importer-error-responses.ts",
    );
  }
  console.log("vendor-name guard self-test: passed");
} finally {
  writeFileSync(target, original);
}
