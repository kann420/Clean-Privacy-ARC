import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  projectArcRegistry,
  renderGeneratedConfig,
} from "../../web/tools/generate-chain-config.mjs";

test("chain config generator round-trips every Arc registry field", async () => {
  const registry = JSON.parse(
    await readFile(new URL("../../config/chains.json", import.meta.url), "utf8"),
  );
  const projected = projectArcRegistry(registry);
  assert.deepEqual(projected, registry["arc-testnet"]);
  const output = renderGeneratedConfig(projected);
  assert.match(output, /GENERATED — do not edit/u);
  assert.match(output, new RegExp(registry["arc-testnet"].fees.collector, "u"));
  assert.match(
    output,
    new RegExp(registry["arc-testnet"].protocol.circleAdapter, "u"),
  );
});
