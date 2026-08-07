import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertProjectionIsComplete,
  projectArcRegistry,
  renderGeneratedConfig,
} from "../../web/tools/generate-chain-config.mjs";

/**
 * This projection is hashed into durable user state. `registryFingerprint()`
 * digests the whole of `ARC_REGISTRY`, every journal entry stores that digest,
 * and a mismatch on page load sends the entry to `manual_recovery_required`.
 *
 * So the rule is NOT "project everything". It is: project exactly what binds an
 * operation's safety, and keep CLI-only configuration out. An earlier
 * round-trip assertion here said the opposite, which is how `bridgeSources`
 * reached the browser and invalidated live journals on 2026-08-07.
 */
test("the projection carries the safety-bearing registry fields and no more", async () => {
  const registry = JSON.parse(
    await readFile(new URL("../../config/chains.json", import.meta.url), "utf8"),
  );
  const chain = registry["arc-testnet"];
  const projected = projectArcRegistry(registry);

  for (const field of [
    "chainId",
    "rpc",
    "explorer",
    "unlinkEnvironment",
    "circleChain",
    "nativeCurrency",
    "tokens",
    "fees",
    "protocol",
  ]) {
    assert.deepEqual(projected[field], chain[field], `${field} must reach the browser`);
  }

  // The CLI-only CCTP allowlist must never be published: the browser does not
  // bridge, and shipping it would move the fingerprint for every user.
  assert.equal("bridgeSources" in chain, true);
  assert.equal("bridgeSources" in projected, false);

  // Every registry field is either projected or explicitly declared CLI-only,
  // so a newly added field cannot silently move the fingerprint.
  assert.deepEqual(assertProjectionIsComplete(chain, projected), projected);
  assert.throws(
    () => assertProjectionIsComplete({ ...chain, somethingNew: 1 }, projected),
    /neither projected nor declared CLI-only: somethingNew/u,
  );

  const output = renderGeneratedConfig(projected);
  assert.doesNotMatch(output, /bridgeSources/u);
  assert.match(output, /GENERATED — do not edit/u);
  assert.match(output, new RegExp(registry["arc-testnet"].fees.collector, "u"));
  assert.match(
    output,
    new RegExp(registry["arc-testnet"].protocol.circleAdapter, "u"),
  );
});
