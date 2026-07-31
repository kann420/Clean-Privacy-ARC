import { getAddress } from "viem";
import { createUnlinkAdmin } from "@unlink-xyz/sdk/admin";

import {
  createEvidenceWriter,
  formatPublicError,
  loadChainConfig,
  parseChainFlag,
  parseDecimalAmount,
  toBaseUnitString,
} from "./lib/config.mjs";
import {
  createCheckpointStore,
  createTransactionStatusPersister,
} from "./lib/checkpoint.mjs";
import { describeFee, feeOnTop, feePolicy } from "./lib/fees.mjs";
import {
  FEE_APP_ID,
  SENDER_APP_ID,
  assertProcessedTransaction,
  assertUnlinkEnvironment,
  createUnlinkContext,
  getCurrentPrivateBalance,
  loadApiKey,
  reconcilePrivateOperation,
  waitForProcessedTransaction,
} from "./lib/unlink.mjs";
import {
  assertUnlinkAddress,
  resolveOperationResume,
  resultFromHistory,
  verifyBalanceDeltas,
} from "./lib/transfer.mjs";
import {
  assertRecipientHygiene,
  readPublicBalance,
  verifyPublicBalanceDelta,
} from "./lib/withdraw.mjs";
import {
  createReadOnlyContext,
  createWalletContext,
  sleep,
  withRpcRetry,
} from "./lib/wallet.mjs";

const RPC_PACING_MS = 400;

function printHelp() {
  console.log(`Usage: node scripts/private-withdraw.mjs [--chain <key>]
       --token USDC|EURC|cirBTC --amount <human> --to <0xEvmAddress>
       [--allow-self-withdrawal]

Moves a private Unlink balance out to a public EVM address. The source private
account stays hidden; the destination, token, and amount are public on Arc.

Completion requires an exact private debit and an exact public credit. The
protocol fee is charged on top and is paid privately to the Unlink fee account,
so no percentage-sized public transaction is ever created.`);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const args = {
    help: false,
    token: undefined,
    amount: undefined,
    to: undefined,
    allowSelfWithdrawal: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      args.help = true;
      continue;
    }
    if (arg === "--allow-self-withdrawal") {
      args.allowSelfWithdrawal = true;
      continue;
    }
    if (arg === "--token" || arg === "--amount" || arg === "--to") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--token") {
        args.token = value;
      } else if (arg === "--amount") {
        args.amount = value;
      } else {
        args.to = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.help && (!args.token || !args.amount || !args.to)) {
    throw new Error("--token, --amount and --to are all required");
  }
  return args;
}

/**
 * @param {ReturnType<import("./lib/config.mjs").loadChainConfig>} config
 * @param {{address: string, symbol: string}} token
 */
async function runPreflight(config, token) {
  const publicClient = createReadOnlyContext(config);
  const rpcChainId = await withRpcRetry(() => publicClient.getChainId());
  if (rpcChainId !== config.chainId) {
    throw new Error(
      `RPC returned chain ${rpcChainId}, expected ${config.chainId}`,
    );
  }

  for (const check of [
    { label: token.symbol, address: token.address },
    { label: "unlinkPool", address: config.protocol.unlinkPool },
  ]) {
    await sleep(RPC_PACING_MS);
    const code = await withRpcRetry(() =>
      publicClient.getCode({ address: getAddress(check.address) }),
    );
    if (!code || code === "0x") {
      throw new Error(`${check.label} has no bytecode at ${check.address}`);
    }
  }

  const admin = createUnlinkAdmin({
    environment: config.unlinkEnvironment,
    apiKey: loadApiKey(config.chainKey),
  });
  const environment = assertUnlinkEnvironment(await admin.environment(), config);
  if (
    getAddress(environment.pool_address) !==
    getAddress(config.protocol.unlinkPool)
  ) {
    throw new Error("Unlink pool address does not match chain config");
  }
  return { admin, publicClient };
}

async function main() {
  const chainArgs = parseChainFlag(process.argv.slice(2));
  const args = parseArgs(chainArgs.rest);
  if (args.help) {
    printHelp();
    return;
  }

  const config = loadChainConfig(chainArgs.chainKey);
  const token = config.tokens[args.token];
  if (!token) {
    throw new Error(`unsupported token on ${config.chainKey}: ${args.token}`);
  }
  const policy = feePolicy(config);
  const requested = parseDecimalAmount(args.amount, token.decimals);
  if (requested === 0n) {
    throw new Error("--amount must be greater than zero");
  }
  const split = feeOnTop(requested, policy.transferBps);
  const amount = toBaseUnitString(split.amount);
  const feeAmount = toBaseUnitString(split.fee);
  const tokenAddress = getAddress(token.address);

  const checkpoint = createCheckpointStore({
    chainKey: config.chainKey,
    flow: `unlink_withdraw_${token.symbol.toLowerCase()}`,
  });
  const evidence = createEvidenceWriter({
    chainKey: config.chainKey,
    flow: "unlink_withdraw",
  });

  const { admin, publicClient } = await runPreflight(config, token);
  const wallet = createWalletContext(config, {
    checkpointFlow: "unlink_withdraw_eoa",
  });
  const hygiene = assertRecipientHygiene({
    recipient: args.to,
    depositor: wallet.account.address,
    allowSelf: args.allowSelfWithdrawal,
  });
  const recipientEvmAddress = hygiene.recipient;

  const sender = await createUnlinkContext({
    config,
    wallet,
    appId: SENDER_APP_ID,
    admin,
  });
  const feeAccount = await createUnlinkContext({
    config,
    wallet,
    appId: FEE_APP_ID,
    admin: sender.admin,
  });
  await sender.client.ensureRegistered();
  await feeAccount.client.ensureRegistered();
  assertUnlinkAddress(feeAccount.unlinkAddress);

  console.log(
    `Withdrawing ${args.amount} ${token.symbol} to ${recipientEvmAddress}`,
  );
  console.log(
    `  ${describeFee({
      fee: split.fee,
      bps: policy.transferBps,
      symbol: token.symbol,
      decimals: token.decimals,
    })}, charged on top and paid privately`,
  );
  console.log(
    "  Public on Arc: destination, token, amount. Private: which account funded it.",
  );
  if (hygiene.selfWithdrawal) {
    console.log(
      "  WARNING: the destination is the depositing EOA; this re-links deposit to withdrawal.",
    );
  }

  const onWithdrawStatus = createTransactionStatusPersister({
    store: checkpoint,
    label: "withdraw",
  });
  const onFeeStatus = createTransactionStatusPersister({
    store: checkpoint,
    label: "fee",
  });

  /**
   * @param {import("@unlink-xyz/sdk/client").TransactionResult} result
   * @param {{privateBefore: bigint, publicBefore: bigint, publicAfter: bigint, privateAfter: bigint}} balances
   * @param {string} completedAmount
   */
  function completeWithdrawal(result, balances, completedAmount) {
    evidence("withdraw_completed", {
      txId: result.txId,
      txHash: result.txHash ?? null,
      status: result.status,
      confirmationStatus: result.confirmationStatus,
      fundsUsable: result.fundsUsable,
      token: tokenAddress,
      tokenSymbol: token.symbol,
      tokenDecimals: token.decimals,
      amount: completedAmount,
      recipientEvmAddress,
      senderBeforeBalance: balances.privateBefore,
      senderAfterBalance: balances.privateAfter,
      senderDelta: balances.privateAfter - balances.privateBefore,
      recipientPublicBeforeBalance: balances.publicBefore,
      recipientPublicAfterBalance: balances.publicAfter,
      recipientPublicDelta: balances.publicAfter - balances.publicBefore,
    });
    checkpoint.update((state) => {
      state.operations.withdraw = {
        ...state.operations.withdraw,
        verifiedAt: new Date().toISOString(),
      };
    });
    console.log(`${token.symbol} withdrawal completed: ${result.txId}`);
  }

  /**
   * Verify both sides of a withdrawal: the private debit and the public credit.
   *
   * @param {{privateBefore: bigint, publicBefore: bigint, amountUnits: bigint}} options
   */
  async function verifyBothSides(options) {
    const [privateAfter] = await verifyBalanceDeltas({
      tokenAddress,
      participants: [
        {
          client: sender.client,
          label: "sender withdrawal verification",
          before: options.privateBefore,
          expectedDelta: -options.amountUnits,
        },
      ],
      attempts: 10,
      delayMs: 3_000,
    });
    const publicAfter = await verifyPublicBalanceDelta({
      publicClient,
      token: tokenAddress,
      address: recipientEvmAddress,
      before: options.publicBefore,
      expectedDelta: options.amountUnits,
      attempts: 10,
      delayMs: 3_000,
    });
    return { privateAfter, publicAfter };
  }

  const previousWithdraw = checkpoint.read().operations.withdraw;
  const withdrawResume = resolveOperationResume(previousWithdraw);

  if (withdrawResume === "done") {
    console.log(
      `${token.symbol} withdrawal already verified: ${previousWithdraw.txId}`,
    );
  } else if (withdrawResume === "poll") {
    if (previousWithdraw.token !== tokenAddress) {
      throw new Error("saved withdrawal token does not match the requested token");
    }
    if (previousWithdraw.recipientEvmAddress !== recipientEvmAddress) {
      throw new Error(
        "saved withdrawal destination does not match the requested destination",
      );
    }
    if (previousWithdraw.amount !== amount) {
      console.log(
        `Resuming the saved withdrawal amount ${previousWithdraw.amount}; the requested amount is ignored`,
      );
    }
    const result = await sender.client.pollTransactionStatus(
      previousWithdraw.txId,
      { until: "processed", onStatus: onWithdrawStatus },
    );
    assertProcessedTransaction(result, `${token.symbol} withdrawal`);
    const privateBefore = BigInt(previousWithdraw.senderBefore);
    const publicBefore = BigInt(previousWithdraw.recipientPublicBefore);
    const balances = await verifyBothSides({
      privateBefore,
      publicBefore,
      amountUnits: BigInt(previousWithdraw.amount),
    });
    completeWithdrawal(
      result,
      { privateBefore, publicBefore, ...balances },
      previousWithdraw.amount,
    );
  } else if (withdrawResume === "reconcile") {
    // The crash window between writing the prepared checkpoint and persisting
    // the accepted id. Never resubmit: either history proves exactly one
    // matching withdrawal, or this stops and asks for a later re-run.
    const privateBefore = BigInt(previousWithdraw.senderBefore);
    const publicBefore = BigInt(previousWithdraw.recipientPublicBefore);
    let reconciled;
    try {
      reconciled = await reconcilePrivateOperation({
        client: sender.client,
        type: "withdraw",
        token: tokenAddress,
        amount: previousWithdraw.amount,
        beforeBalance: previousWithdraw.senderBefore,
        expectedDelta: -BigInt(previousWithdraw.amount),
        createdAfter: previousWithdraw.createdAt,
      });
    } catch (error) {
      const currentBalance = await getCurrentPrivateBalance(
        sender.client,
        tokenAddress,
        "reconciliation guidance",
      );
      if (currentBalance === privateBefore) {
        throw new Error(
          `${token.symbol} withdrawal reconciliation found no accepted withdrawal ` +
            "and the private balance is unchanged; the prepared checkpoint may be " +
            `cleared to retry (${checkpoint.target})`,
        );
      }
      throw new Error(
        `${token.symbol} withdrawal reconciliation is ambiguous while the private ` +
          "balance has moved; a withdrawal may still be in flight. Do NOT delete " +
          "the checkpoint; re-run this command later",
        { cause: error },
      );
    }
    const result = resultFromHistory(reconciled.transaction);
    assertProcessedTransaction(result, `${token.symbol} withdrawal`);
    checkpoint.update((state) => {
      state.operations.withdraw = {
        ...state.operations.withdraw,
        txId: result.txId,
        status: result.status,
        reconciledAt: new Date().toISOString(),
      };
    });
    const balances = await verifyBothSides({
      privateBefore,
      publicBefore,
      amountUnits: BigInt(previousWithdraw.amount),
    });
    completeWithdrawal(
      result,
      { privateBefore, publicBefore, ...balances },
      previousWithdraw.amount,
    );
  } else {
    const privateBefore = await getCurrentPrivateBalance(
      sender.client,
      tokenAddress,
      "sender pre-withdrawal",
    );
    if (privateBefore < split.total) {
      throw new Error(
        `private ${token.symbol} balance is insufficient for the withdrawal plus its fee`,
      );
    }
    const publicBefore = await readPublicBalance({
      publicClient,
      token: tokenAddress,
      address: recipientEvmAddress,
    });

    checkpoint.update((state) => {
      state.operations.withdraw = {
        status: "prepared",
        token: tokenAddress,
        amount,
        feeAmount,
        recipientEvmAddress,
        senderBefore: privateBefore.toString(),
        recipientPublicBefore: publicBefore.toString(),
        createdAt: new Date().toISOString(),
      };
    });

    const handle = await sender.client.withdraw({
      recipientEvmAddress,
      token: tokenAddress,
      amount,
    });
    checkpoint.update((state) => {
      state.operations.withdraw = {
        ...state.operations.withdraw,
        txId: handle.txId,
        status: handle.status,
        acceptedAt: new Date().toISOString(),
      };
    });
    evidence("withdraw_accepted", {
      txId: handle.txId,
      status: handle.status,
      token: tokenAddress,
      tokenSymbol: token.symbol,
      tokenDecimals: token.decimals,
      amount,
      feeAmount,
      feeBps: policy.transferBps,
      recipientEvmAddress,
    });
    console.log(`${token.symbol} withdrawal accepted: ${handle.txId}`);

    const result = await waitForProcessedTransaction(sender.client, handle, {
      onStatus: onWithdrawStatus,
    });
    assertProcessedTransaction(result, `${token.symbol} withdrawal`);
    const balances = await verifyBothSides({
      privateBefore,
      publicBefore,
      amountUnits: split.amount,
    });
    completeWithdrawal(
      result,
      { privateBefore, publicBefore, ...balances },
      amount,
    );
  }

  // ── Fee leg ────────────────────────────────────────────────────────────────
  // The SDK's withdraw() takes a single recipient, so the fee cannot ride along
  // in the same transaction. It runs after the withdrawal has settled: if this
  // leg fails, the protocol is owed a fee and the user is unaffected, which is
  // the correct direction for the risk to point.
  if (split.fee === 0n) {
    console.log(
      `No protocol fee for this amount (${policy.transferBps} bps rounds to zero).`,
    );
    return;
  }

  const previousFee = checkpoint.read().operations.fee;
  const feeResume = resolveOperationResume(previousFee);
  if (feeResume === "done") {
    console.log(`Withdrawal fee already verified: ${previousFee.txId}`);
    return;
  }
  if (feeResume === "reconcile" && previousFee) {
    throw new Error(
      "a prepared withdrawal fee has no accepted transaction id; re-run this " +
        `command later or inspect the checkpoint (${checkpoint.target})`,
    );
  }

  /**
   * @param {import("@unlink-xyz/sdk/client").TransactionResult} result
   * @param {bigint} senderBefore
   * @param {bigint} collectorBefore
   * @param {bigint[]} after
   */
  function completeFee(result, senderBefore, collectorBefore, after) {
    evidence("withdraw_fee_completed", {
      feeTxId: result.txId,
      txHash: result.txHash ?? null,
      status: result.status,
      confirmationStatus: result.confirmationStatus,
      fundsUsable: result.fundsUsable,
      token: tokenAddress,
      tokenSymbol: token.symbol,
      tokenDecimals: token.decimals,
      feeAmount,
      feeBps: policy.transferBps,
      feeRecipient: feeAccount.unlinkAddress,
      senderBeforeBalance: senderBefore,
      senderAfterBalance: after[0],
      senderDelta: after[0] - senderBefore,
      recipientBeforeBalance: collectorBefore,
      recipientAfterBalance: after[1],
      recipientDelta: after[1] - collectorBefore,
    });
    checkpoint.update((state) => {
      state.operations.fee = {
        ...state.operations.fee,
        verifiedAt: new Date().toISOString(),
      };
    });
    console.log(`Withdrawal fee collected privately: ${result.txId}`);
  }

  if (feeResume === "poll") {
    const senderBefore = BigInt(previousFee.senderBefore);
    const collectorBefore = BigInt(previousFee.recipientBefore);
    const result = await sender.client.pollTransactionStatus(previousFee.txId, {
      until: "processed",
      onStatus: onFeeStatus,
    });
    assertProcessedTransaction(result, `${token.symbol} withdrawal fee`);
    const after = await verifyBalanceDeltas({
      tokenAddress,
      participants: [
        {
          client: sender.client,
          label: "sender fee verification",
          before: senderBefore,
          expectedDelta: -BigInt(previousFee.amount),
        },
        {
          client: feeAccount.client,
          label: "fee account verification",
          before: collectorBefore,
          expectedDelta: BigInt(previousFee.amount),
        },
      ],
      attempts: 10,
      delayMs: 3_000,
    });
    completeFee(result, senderBefore, collectorBefore, after);
    return;
  }

  const [senderBefore, collectorBefore] = await Promise.all([
    getCurrentPrivateBalance(sender.client, tokenAddress, "sender pre-fee"),
    getCurrentPrivateBalance(
      feeAccount.client,
      tokenAddress,
      "fee account pre-fee",
    ),
  ]);
  if (senderBefore < split.fee) {
    throw new Error(
      `private ${token.symbol} balance is insufficient for the protocol fee`,
    );
  }
  checkpoint.update((state) => {
    state.operations.fee = {
      status: "prepared",
      token: tokenAddress,
      amount: feeAmount,
      recipientAddress: feeAccount.unlinkAddress,
      senderBefore: senderBefore.toString(),
      recipientBefore: collectorBefore.toString(),
      createdAt: new Date().toISOString(),
    };
  });

  const feeHandle = await sender.client.transfer({
    recipientAddress: feeAccount.unlinkAddress,
    token: tokenAddress,
    amount: feeAmount,
  });
  checkpoint.update((state) => {
    state.operations.fee = {
      ...state.operations.fee,
      txId: feeHandle.txId,
      status: feeHandle.status,
      acceptedAt: new Date().toISOString(),
    };
  });
  evidence("withdraw_fee_accepted", {
    feeTxId: feeHandle.txId,
    status: feeHandle.status,
    token: tokenAddress,
    tokenSymbol: token.symbol,
    feeAmount,
    feeBps: policy.transferBps,
    feeRecipient: feeAccount.unlinkAddress,
  });

  const feeResult = await waitForProcessedTransaction(sender.client, feeHandle, {
    onStatus: onFeeStatus,
  });
  assertProcessedTransaction(feeResult, `${token.symbol} withdrawal fee`);
  const feeBalances = await verifyBalanceDeltas({
    tokenAddress,
    participants: [
      {
        client: sender.client,
        label: "sender fee verification",
        before: senderBefore,
        expectedDelta: -split.fee,
      },
      {
        client: feeAccount.client,
        label: "fee account verification",
        before: collectorBefore,
        expectedDelta: split.fee,
      },
    ],
    attempts: 10,
    delayMs: 3_000,
  });
  completeFee(feeResult, senderBefore, collectorBefore, feeBalances);
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(formatPublicError(error, "private withdrawal failed"));
});
