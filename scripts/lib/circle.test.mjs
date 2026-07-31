import assert from "node:assert/strict";
import test from "node:test";

import { encodeFunctionData, parseAbi } from "viem";

import { loadChainConfig } from "./config.mjs";
import {
  CIRCLE_ADAPTER_ABI,
  CIRCLE_CAPTURE_STOP,
  captureCircleSwapPlan,
  estimateCircleSwap,
  requireCircleKitKey,
  validateCircleSwapPlan,
  waitForCircleDone,
} from "./circle.mjs";

const config = loadChainConfig();
const sender = "0x1111111111111111111111111111111111111111";
const amountIn = 100_000n;
const nowSeconds = 2_000_000_000n;
const increaseAllowanceAbi = parseAbi([
  "function increaseAllowance(address spender,uint256 addedValue) returns (bool)",
]);
const approveAbi = parseAbi([
  "function approve(address spender,uint256 value) returns (bool)",
]);

function estimateFixture(overrides = {}) {
  return {
    chainIn: config.circleChain,
    chainOut: config.circleChain,
    fromAddress: sender,
    toAddress: sender,
    tokenIn: "USDC",
    tokenOut: "EURC",
    amountIn: "0.1",
    amountInBaseUnits: amountIn.toString(),
    stopLimit: { token: "EURC", amount: "0.073" },
    estimatedOutput: { token: "EURC", amount: "0.076" },
    fees: [],
    quotedAt: new Date().toISOString(),
    ...overrides,
  };
}

function captureFixture() {
  const fixture = {
    config,
    executionAccount: sender,
    amountIn,
    nowSeconds,
    estimate: estimateFixture(),
    actions: [
      {
        action: "usdc.increaseAllowance",
        address: sender,
        chainId: config.chainId,
        params: {
          amount: amountIn,
          delegate: config.protocol.circleAdapter,
        },
      },
      {
        action: "swap.execute",
        address: sender,
        chainId: config.chainId,
        params: {
          signature: "0x1234",
          inputAmount: amountIn,
          tokenInAddress: config.tokens.USDC.address,
          tokenInputs: [
            {
              permitType: 0,
              token: config.tokens.USDC.address,
              amount: amountIn,
              permitCalldata: "0x",
            },
          ],
          executeParams: {
            execId: 77n,
            deadline: nowSeconds + 600n,
            metadata: "0x",
            instructions: [
              {
                target: "0x2222222222222222222222222222222222222222",
                data: "0x1234",
                value: 0n,
                tokenIn: config.tokens.USDC.address,
                amountToApprove: 20n,
                tokenOut: "0x0000000000000000000000000000000000000000",
                minTokenOut: 0n,
              },
              {
                target: "0x3333333333333333333333333333333333333333",
                data: "0xabcd",
                value: 0n,
                tokenIn: config.tokens.USDC.address,
                amountToApprove: 99_980n,
                tokenOut: config.tokens.EURC.address,
                minTokenOut: 73_000n,
              },
            ],
            tokens: [
              { token: config.tokens.USDC.address, beneficiary: sender },
              { token: config.tokens.EURC.address, beneficiary: sender },
            ],
          },
        },
      },
    ],
    calls: [
      {
        to: config.tokens.USDC.address,
        value: 0n,
        data: encodeFunctionData({
          abi: increaseAllowanceAbi,
          functionName: "increaseAllowance",
          args: [config.protocol.circleAdapter, amountIn],
        }),
      },
      {
        to: config.protocol.circleAdapter,
        value: 0n,
        data: "0x",
      },
    ],
  };
  fixture.calls[1].data = encodeFunctionData({
    abi: CIRCLE_ADAPTER_ABI,
    functionName: "execute",
    args: [
      fixture.actions[1].params.executeParams,
      fixture.actions[1].params.tokenInputs,
      "0x1234",
    ],
  });
  return fixture;
}

test("Circle kit key is mandatory and permissionless mode is rejected", () => {
  assert.throws(() => requireCircleKitKey({}), /CIRCLE_APP_KIT_KEY/u);
  assert.throws(
    () => requireCircleKitKey({ CIRCLE_APP_KIT_KEY: "  " }),
    /CIRCLE_APP_KIT_KEY/u,
  );
  assert.equal(
    requireCircleKitKey({ CIRCLE_APP_KIT_KEY: "test-kit-key" }),
    "test-kit-key",
  );
});

test("Circle validator accepts the exact two-call Arc plan", () => {
  const plan = validateCircleSwapPlan(captureFixture());
  assert.equal(plan.chainId, 5_042_002);
  assert.equal(plan.amountIn, "100000");
  assert.equal(plan.minOut, "73000");
  assert.equal(plan.swapCall.target, config.protocol.circleAdapter);
  assert.equal(plan.fingerprint.length, 64);
  assert.equal("kitKey" in plan, false);
});

test("Circle validator rejects wrong chain, sender, beneficiary, and token", () => {
  const wrongChain = captureFixture();
  wrongChain.estimate.chainIn = "Ethereum";
  assert.throws(() => validateCircleSwapPlan(wrongChain), /estimate/u);

  const wrongSender = captureFixture();
  wrongSender.actions[1].address =
    "0x4444444444444444444444444444444444444444";
  assert.throws(() => validateCircleSwapPlan(wrongSender), /sender/u);

  const wrongBeneficiary = captureFixture();
  wrongBeneficiary.actions[1].params.executeParams.tokens[0].beneficiary =
    "0x4444444444444444444444444444444444444444";
  assert.throws(() => validateCircleSwapPlan(wrongBeneficiary), /beneficiar/u);

  const wrongToken = captureFixture();
  wrongToken.actions[1].params.tokenInputs[0].token =
    config.tokens.EURC.address;
  assert.throws(() => validateCircleSwapPlan(wrongToken), /token input/u);
});

test("Circle validator rejects target, allowance, value, and permit changes", () => {
  const wrongTarget = captureFixture();
  wrongTarget.calls[1].to = config.protocol.circleBridge;
  assert.throws(() => validateCircleSwapPlan(wrongTarget), /target/u);

  const wrongAllowance = captureFixture();
  wrongAllowance.actions[0].params.amount = 99_999n;
  assert.throws(() => validateCircleSwapPlan(wrongAllowance), /approval/u);

  const nativeValue = captureFixture();
  nativeValue.actions[1].params.executeParams.instructions[0].value = 1n;
  assert.throws(() => validateCircleSwapPlan(nativeValue), /instructions/u);

  const permit = captureFixture();
  permit.actions[1].params.tokenInputs[0].permitType = 1;
  assert.throws(() => validateCircleSwapPlan(permit), /PermitType.NONE/u);

  const tamperedCalldata = captureFixture();
  tamperedCalldata.calls[1].data = encodeFunctionData({
    abi: CIRCLE_ADAPTER_ABI,
    functionName: "execute",
    args: [
      tamperedCalldata.actions[1].params.executeParams,
      tamperedCalldata.actions[1].params.tokenInputs,
      "0xabcd",
    ],
  });
  assert.throws(
    () => validateCircleSwapPlan(tamperedCalldata),
    /calldata/u,
  );
});

test("Circle validator rejects stale deadlines and malformed totals", () => {
  const stale = captureFixture();
  stale.actions[1].params.executeParams.deadline = nowSeconds + 479n;
  assert.throws(() => validateCircleSwapPlan(stale), /deadline/u);

  const wrongTotal = captureFixture();
  wrongTotal.actions[1].params.executeParams.instructions[1].amountToApprove =
    99_979n;
  assert.throws(() => validateCircleSwapPlan(wrongTotal), /exact approved/u);

  const noOutput = captureFixture();
  noOutput.actions[1].params.executeParams.instructions[1].minTokenOut = 0n;
  assert.throws(() => validateCircleSwapPlan(noOutput), /positive EURC/u);
});

test("Circle estimate validates route and uses token decimals once", async () => {
  const result = await estimateCircleSwap({
    config,
    executionAccount: sender,
    amountHuman: "0.1",
    kitKey: "test-kit-key",
    adapter: {},
    context: {},
    estimateFn: async () => ({
      chainIn: config.circleChain,
      chainOut: config.circleChain,
      fromAddress: sender,
      toAddress: sender,
      tokenIn: "USDC",
      tokenOut: "EURC",
      amountIn: "0.1",
      stopLimit: { token: "EURC", amount: "0.073" },
      estimatedOutput: { token: "EURC", amount: "0.076" },
      fees: [{ token: "USDC", amount: "0.00002", type: "provider" }],
    }),
  });
  assert.equal(result.amountInBaseUnits, "100000");
  assert.equal(result.estimatedOutput.amount, "0.076");
});

test("capture adapter stops at batchExecute and never broadcasts", async () => {
  let broadcasted = false;
  const baseAdapter = {
    prepareAction: async () => ({ execute: async () => {
      broadcasted = true;
    } }),
  };
  const fixture = captureFixture();
  const plan = await captureCircleSwapPlan({
    config,
    executionAccount: sender,
    amountHuman: "0.1",
    amountIn,
    kitKey: "test-kit-key",
    estimate: estimateFixture(),
    baseAdapter,
    context: {},
    nowSeconds,
    swapFn: async (_context, params) => {
      const first = await params.from.adapter.prepareAction(
        fixture.actions[0].action,
        fixture.actions[0].params,
        { address: sender, chain: { chainId: config.chainId } },
      );
      const second = await params.from.adapter.prepareAction(
        fixture.actions[1].action,
        fixture.actions[1].params,
        { address: sender, chain: { chainId: config.chainId } },
      );
      await params.from.adapter.batchExecute(fixture.calls);
      await first.execute();
      await second.execute();
      throw new Error("unreachable");
    },
  });
  assert.equal(plan.minOut, "73000");
  assert.equal(broadcasted, false);
  assert.equal(CIRCLE_CAPTURE_STOP, "CIRCLE_CAPTURE_COMPLETE");
});

test("Circle status recovery polls only the persisted hash", async () => {
  const seen = [];
  const result = await waitForCircleDone({
    txHash: `0x${"12".repeat(32)}`,
    kitKey: "test-kit-key",
    attempts: 3,
    delayMs: 0,
    sleepFn: async () => {},
    getStatusFn: async (params) => {
      seen.push(params.txHash);
      return {
        progress: { status: seen.length === 2 ? "DONE" : "PENDING" },
      };
    },
  });
  assert.equal(result.progress.status, "DONE");
  assert.deepEqual(seen, [
    `0x${"12".repeat(32)}`,
    `0x${"12".repeat(32)}`,
  ]);
});

test("Circle status recovery never retries a terminal failure", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      waitForCircleDone({
        txHash: `0x${"34".repeat(32)}`,
        kitKey: "test-kit-key",
        getStatusFn: async () => {
          calls += 1;
          return { progress: { status: "FAILED" } };
        },
      }),
    /terminal/u,
  );
  assert.equal(calls, 1);
});

/**
 * Reverse-route fixture. Mirrors what Circle actually plans for EURC -> USDC on
 * Arc Testnet, captured live on 2026-07-31: the approval action is the generic
 * `token.approve` (carrying an explicit tokenAddress) rather than the
 * USDC-specific `usdc.increaseAllowance`, and the fee instruction is denominated
 * in the input token.
 */
function reverseCaptureFixture() {
  const fixture = captureFixture();
  const eurc = config.tokens.EURC.address;
  const usdc = config.tokens.USDC.address;
  fixture.tokenIn = "EURC";
  fixture.tokenOut = "USDC";
  fixture.estimate = estimateFixture({
    tokenIn: "EURC",
    tokenOut: "USDC",
    stopLimit: { token: "USDC", amount: "0.127" },
    estimatedOutput: { token: "USDC", amount: "0.131" },
  });
  fixture.actions[0] = {
    action: "token.approve",
    address: sender,
    chainId: config.chainId,
    params: {
      tokenAddress: eurc,
      amount: amountIn,
      delegate: config.protocol.circleAdapter,
    },
  };
  const swapParams = fixture.actions[1].params;
  swapParams.tokenInAddress = eurc;
  swapParams.tokenInputs[0].token = eurc;
  swapParams.executeParams.instructions[0].tokenIn = eurc;
  swapParams.executeParams.instructions[1].tokenIn = eurc;
  swapParams.executeParams.instructions[1].tokenOut = usdc;
  swapParams.executeParams.instructions[1].minTokenOut = 127_000n;
  swapParams.executeParams.tokens = [
    { token: eurc, beneficiary: sender },
    { token: usdc, beneficiary: sender },
  ];
  fixture.calls[0] = {
    to: eurc,
    value: 0n,
    data: encodeFunctionData({
      abi: approveAbi,
      functionName: "approve",
      args: [config.protocol.circleAdapter, amountIn],
    }),
  };
  fixture.calls[1].data = encodeFunctionData({
    abi: CIRCLE_ADAPTER_ABI,
    functionName: "execute",
    args: [swapParams.executeParams, swapParams.tokenInputs, "0x1234"],
  });
  return fixture;
}

test("Circle validator accepts the reverse EURC to USDC plan", () => {
  const plan = validateCircleSwapPlan(reverseCaptureFixture());
  assert.equal(plan.tokenIn, config.tokens.EURC.address);
  assert.equal(plan.tokenOut, config.tokens.USDC.address);
  assert.equal(plan.minOut, "127000");
  assert.equal(plan.amountIn, amountIn.toString());
});

test("the two directions produce different plan fingerprints", () => {
  const forward = validateCircleSwapPlan(captureFixture());
  const reverse = validateCircleSwapPlan(reverseCaptureFixture());
  assert.notEqual(forward.fingerprint, reverse.fingerprint);
});

test("a reverse capture cannot be validated as the forward route", () => {
  // Omitting tokenIn/tokenOut means "the default USDC -> EURC route". A reverse
  // capture presented that way must be rejected, not silently accepted.
  const mislabelled = reverseCaptureFixture();
  delete mislabelled.tokenIn;
  delete mislabelled.tokenOut;
  assert.throws(() => validateCircleSwapPlan(mislabelled), /approval token/u);
});

test("a forward capture cannot be validated as the reverse route", () => {
  const mislabelled = captureFixture();
  mislabelled.tokenIn = "EURC";
  mislabelled.tokenOut = "USDC";
  assert.throws(() => validateCircleSwapPlan(mislabelled), /approval token/u);
});

test("the reverse route still enforces exact approval and beneficiaries", () => {
  const wrongAmount = reverseCaptureFixture();
  wrongAmount.actions[0].params.amount = 99_999n;
  assert.throws(() => validateCircleSwapPlan(wrongAmount), /approval/u);

  const wrongApprovalToken = reverseCaptureFixture();
  wrongApprovalToken.actions[0].params.tokenAddress = config.tokens.USDC.address;
  assert.throws(
    () => validateCircleSwapPlan(wrongApprovalToken),
    /approval token/u,
  );

  const strayBeneficiary = reverseCaptureFixture();
  strayBeneficiary.actions[1].params.executeParams.tokens[1].beneficiary =
    "0x4444444444444444444444444444444444444444";
  assert.throws(() => validateCircleSwapPlan(strayBeneficiary), /beneficiar/u);

  // A second positive output instruction must not slip past the "exactly one"
  // rule just because the route is parameterised now.
  const twoOutputs = reverseCaptureFixture();
  const params = twoOutputs.actions[1].params;
  params.executeParams.instructions[0].tokenOut = config.tokens.USDC.address;
  params.executeParams.instructions[0].minTokenOut = 10n;
  twoOutputs.calls[1].data = encodeFunctionData({
    abi: CIRCLE_ADAPTER_ABI,
    functionName: "execute",
    args: [params.executeParams, params.tokenInputs, "0x1234"],
  });
  assert.throws(
    () => validateCircleSwapPlan(twoOutputs),
    /exactly one positive USDC output/u,
  );
});

test("a route whose input equals its output is rejected outright", () => {
  const same = reverseCaptureFixture();
  same.tokenOut = "EURC";
  assert.throws(() => validateCircleSwapPlan(same), /must differ/u);
});
