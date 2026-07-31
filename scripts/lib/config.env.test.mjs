import assert from "node:assert/strict";
import test from "node:test";

import {
  assertChainKey,
  createEvidenceWriter,
  formatPublicError,
  loadLocalEnv,
  parseChainFlag,
  parseEnvFile,
  selectRpcEndpoint,
  toBaseUnitString,
} from "./config.mjs";

test("chain keys must be kebab-case", () => {
  assert.equal(assertChainKey("arc-testnet"), "arc-testnet");
  assert.throws(() => assertChainKey("Arc_Testnet"));
  assert.throws(() => assertChainKey(""));
  assert.throws(() => assertChainKey("arc--testnet"));
});

test("base-unit conversion accepts only non-negative bigints", () => {
  assert.equal(toBaseUnitString(0n), "0");
  assert.equal(toBaseUnitString(1_500_000n), "1500000");
  assert.throws(() => toBaseUnitString(-1n));
  assert.throws(() => toBaseUnitString("1500000"));
  assert.throws(() => toBaseUnitString(1.5));
});

test("env file parsing ignores comments and malformed lines", () => {
  const parsed = parseEnvFile(
    [
      "# comment",
      "",
      "UNLINK_API_KEY_ARC_TESTNET=abc123",
      "OWNER_PRIVATE_KEY= 0xdeadbeef ",
      "lowercase=ignored",
      "NOEQUALS",
      "TRAILING=with=equals",
    ].join("\n"),
  );
  assert.deepEqual(parsed, {
    UNLINK_API_KEY_ARC_TESTNET: "abc123",
    OWNER_PRIVATE_KEY: "0xdeadbeef",
    TRAILING: "with=equals",
  });
});

test("process environment overrides file entries", () => {
  const env = loadLocalEnv({
    envFileUrl: new URL("file:///nonexistent/.env.local"),
    processEnv: { FROM_PROCESS: "yes", EMPTY: "" },
  });
  assert.equal(env.FROM_PROCESS, "yes");
  assert.equal(env.EMPTY, undefined);
  assert.equal(Object.isFrozen(env), true);
});

test("--chain flag parses once and validates the key", () => {
  assert.deepEqual(parseChainFlag(["--chain", "arc-testnet", "--x"]), {
    chainKey: "arc-testnet",
    rest: ["--x"],
  });
  assert.deepEqual(parseChainFlag([]), {
    chainKey: "arc-testnet",
    rest: [],
  });
  assert.throws(() =>
    parseChainFlag(["--chain", "a", "--chain", "b"]),
  );
  assert.throws(() => parseChainFlag(["--chain"]));
  assert.throws(() => parseChainFlag([], { requireChain: true }));
});

test("public errors redact hex material and credential fields", () => {
  const redacted = formatPublicError(
    new Error(
      `boom signature: 0x${"ab".repeat(64)}\nRequest Arguments:\n  secret stuff`,
    ),
    "fallback",
  );
  assert.ok(!redacted.includes("ab".repeat(64)));
  assert.ok(!redacted.includes("secret stuff"));
  assert.ok(redacted.includes("[redacted"));
  assert.equal(formatPublicError("not an error", "fallback"), "fallback");
});

test("public errors redact Circle kit key fields", () => {
  // A Circle SDK failure can echo request context; the kit key must never
  // survive redaction in any spelling the SDK uses.
  for (const spelling of ["kitKey", "kit_key", "kit key", "KIT_KEY"]) {
    const redacted = formatPublicError(
      new Error(`upstream rejected ${spelling}: super-secret-kit-value`),
      "fallback",
    );
    assert.ok(
      !redacted.includes("super-secret-kit-value"),
      `${spelling} leaked through redaction`,
    );
    assert.ok(redacted.includes("[redacted]"));
  }
});

test("evidence writer enforces the allowlist and serializes bigints", () => {
  const lines = [];
  const evidence = createEvidenceWriter({
    chainKey: "arc-testnet",
    flow: "unit_test",
    runId: "0123456789abcdef01234567",
    append: (line) => lines.push(line),
  });

  evidence("deposit_completed", {
    status: "processed",
    amount: 1_000_000n,
    tokenSymbol: "USDC",
  });
  const record = JSON.parse(lines[0]);
  assert.equal(record.event, "deposit_completed");
  assert.equal(record.chainKey, "arc-testnet");
  assert.equal(record.runId, "0123456789abcdef01234567");
  assert.equal(record.amount, "1000000");
  assert.equal(record.tokenSymbol, "USDC");

  assert.throws(
    () => evidence("bad_field", { privateKey: "value" }),
    /not allowlisted/u,
  );
  assert.throws(() => evidence("Bad-Event", {}), /invalid evidence event/u);
  assert.throws(
    () => evidence("bad_value", { status: { nested: true } }),
    /public scalars/u,
  );
  assert.throws(() =>
    createEvidenceWriter({ chainKey: "arc-testnet", flow: "Bad Flow" }),
  );
  assert.throws(() =>
    createEvidenceWriter({
      chainKey: "arc-testnet",
      flow: "ok",
      runId: "short",
    }),
  );
});

test("ARC_RPC_URL overrides the dialled endpoint but never the recorded one", () => {
  const config = Object.freeze({ rpc: "https://rpc.testnet.arc.network" });

  // Opt-in only.
  assert.equal(selectRpcEndpoint({}, config), config.rpc);
  assert.equal(selectRpcEndpoint({ ARC_RPC_URL: "  " }, config), config.rpc);

  const override = "https://provider.example/secret-token";
  assert.equal(selectRpcEndpoint({ ARC_RPC_URL: override }, config), override);

  // The canonical endpoint is untouched, which is what evidence and manifests
  // record — a tokenised provider URL must never reach a committed file.
  assert.equal(config.rpc, "https://rpc.testnet.arc.network");

  assert.throws(
    () => selectRpcEndpoint({ ARC_RPC_URL: "http://provider.example" }, config),
    /must use HTTPS/u,
  );
  assert.throws(
    () => selectRpcEndpoint({ ARC_RPC_URL: "not-a-url" }, config),
    /must be a valid URL/u,
  );
});
