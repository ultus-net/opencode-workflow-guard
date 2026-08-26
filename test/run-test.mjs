import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testHome = mkdtempSync(join(tmpdir(), "workflow-guard-test-home-"));
process.env.XDG_STATE_HOME = join(testHome, "state");
process.env.XDG_DATA_HOME = join(testHome, "data");

try {
	await import("./test.mts");
} finally {
	rmSync(testHome, { recursive: true, force: true });
}
