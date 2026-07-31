import { erc20Abi, getAddress } from "viem";

import {
  createEvidenceWriter,
  formatPublicError,
  loadChainConfig,
  parseChainFlag,
  parseDecimalAmount,
  toBaseUnitString,
} from "./lib/config.mjs";
import {
  RECIPIENT_APP_ID,
  SENDER_APP_ID,
  assertProcessedTransaction,
  assertUnlinkEnvironment,
  createUnlinkContext,
  getCurrentPrivateBalance,
  reconcilePrivateOperation,
  waitForProcessedTransaction,
} from "./lib/unlink.mjs";
import {
  resolveOperationResume,
  resultFromHistory,
  verifyBalanceDeltas,
} from "./lib/transfer.mjs";
import {
  createCheckpointStore,
  createTransactionStatusPersister,
} from "./lib/checkpoint.mjs";
import {
  GENEROUS_WRITE_GAS,
  assertUsdcGasBuffer,
  createWalletContext,
} from "./lib/wallet.mjs";

const DEFAULT_GAS_BUFFER_NATIVE = 10n ** 18n; // 1.0 USDC in the 18-decimal gas view

function printHelp() {
  console.log(`Usage: node scripts/private-deposit.mjs [--chain <key>] [--register-only]
       [--token <symbol> --amount <human>] [--gas-buffer <human USDC>]

Registers the sender and recipient Unlink accounts, then optionally submits an
idempotent, checkpointed deposit for one configured token. Evidence is
allowlisted and contains no SDK or admin payloads.`);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const args = {
    help: false,
    registerOnly: false,
    token: undefined,
    amount: undefined,
    gasBuffer: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      args.help = true;
      continue;
    }
    if (arg === "--register-only") {
      args.registerOnly = true;
      continue;
    }
    if (arg === "--token" || arg === "--amount" || arg === "--gas-buffer") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--token") {
        args.token = value;
      } else if (arg === "--amount") {
        args.amount = value;
      } else {
        args.gasBuffer = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.help && !args.registerOnly) {
    if (!args.token || !args.amount) {
      throw new Error(
        "either --register-only or both --token and --amount are required",
      );
    }
  }
  return args;
}

async function main() {
  const chainArgs = parseChainFlag(process.argv.slice(2));
  const args = parseArgs(chainArgs.rest);
  if (args.help) {
    printHelp();
    return;
  }
  const config = loadChainConfig(chainArgs.chainKey);
  const wallet = createWalletContext(config, {
    checkpointFlow: "unlink_deposit_eoa",
  });

  const sender = await createUnlinkContext({
    config,
    wallet,
    appId: SENDER_APP_ID,
  });
  const environment = assertUnlinkEnvironment(
    await sender.admin.environment(),
    config,
  );
  await sender.client.ensureRegistered();
  const recipient = await createUnlinkContext({
    config,
    wallet,
    appId: RECIPIENT_APP_ID,
    admin: sender.admin,
  });
  await recipient.client.ensureRegistered();

  const registrationEvidence = createEvidenceWriter({
    chainKey: config.chainKey,
    flow: "unlink_registration",
  });
  for (const [appId, context] of [
    [SENDER_APP_ID, sender],
    [RECIPIENT_APP_ID, recipient],
  ]) {
    registrationEvidence("registration_checked", {
      status: "ok",
      environment: environment.name,
      chainId: environment.chain_id,
      appId,
      unlinkAddress: context.unlinkAddress,
    });
    console.log(`Registered ${appId}: ${context.unlinkAddress}`);
  }
  if (args.registerOnly) {
    console.log("Unlink registration check completed.");
    return;
  }

  const token = config.tokens[args.token];
  if (!token) {
    throw new Error(
      `unsupported token on ${config.chainKey}: ${args.token}`,
    );
  }
  const amountUnits = parseDecimalAmount(args.amount, token.decimals);
  if (amountUnits === 0n) {
    throw new Error("--amount must be greater than zero");
  }
  const amount = toBaseUnitString(amountUnits);
  const tokenAddress = getAddress(token.address);

  const checkpoint = createCheckpointStore({
    chainKey: config.chainKey,
    flow: `unlink_deposit_${token.symbol.toLowerCase()}`,
  });
  const evidence = createEvidenceWriter({
    chainKey: config.chainKey,
    flow: "unlink_deposit",
  });
  const onStatus = createTransactionStatusPersister({
    store: checkpoint,
    label: "deposit",
  });

  /**
   * Completion evidence is persisted before `verifiedAt`, the only done
   * gate. An SDK "processed" status alone never completes the workflow.
   *
   * @param {{
   *   txId: string,
   *   txHash?: string | null,
   *   status: string,
   *   confirmationStatus: string,
   *   fundsUsable: boolean,
   * }} result
   * @param {bigint} before
   * @param {bigint} after
   * @param {string} completedAmount
   */
  function complete(result, before, after, completedAmount) {
    evidence("deposit_completed", {
      txId: result.txId,
      txHash: result.txHash ?? null,
      status: result.status,
      confirmationStatus: result.confirmationStatus,
      fundsUsable: result.fundsUsable,
      token: tokenAddress,
      tokenSymbol: token.symbol,
      tokenDecimals: token.decimals,
      amount: completedAmount,
      beforeBalance: before,
      afterBalance: after,
      delta: after - before,
    });
    checkpoint.update((state) => {
      state.operations.deposit = {
        ...state.operations.deposit,
        verifiedAt: new Date().toISOString(),
      };
    });
    console.log(`${token.symbol} deposit completed: ${result.txId}`);
  }

  const previous = checkpoint.read().operations.deposit;
  const resume = resolveOperationResume(previous);
  if (resume === "done") {
    console.log(
      `${token.symbol} deposit already verified: ${previous.txId}`,
    );
    return;
  }
  if (resume === "poll" || resume === "reconcile") {
    if (previous.token !== tokenAddress) {
      throw new Error(
        "saved deposit token does not match the requested token",
      );
    }
    if (previous.amount !== amount) {
      console.log(
        `Resuming the saved deposit amount ${previous.amount}; the requested amount is ignored`,
      );
    }
  }

  if (resume === "poll") {
    const result = await sender.client.pollTransactionStatus(previous.txId, {
      until: "processed",
      onStatus,
    });
    assertProcessedTransaction(result, `${token.symbol} deposit`);
    const before = BigInt(previous.beforeBalance);
    const [after] = await verifyBalanceDeltas({
      tokenAddress,
      participants: [
        {
          client: sender.client,
          label: "deposit verification",
          before,
          expectedDelta: BigInt(previous.amount),
        },
      ],
      attempts: 10,
      delayMs: 3_000,
    });
    complete(result, before, after, previous.amount);
    return;
  }

  if (resume === "reconcile") {
    let reconciled;
    try {
      reconciled = await reconcilePrivateOperation({
        client: sender.client,
        type: "deposit",
        token: tokenAddress,
        amount: previous.amount,
        beforeBalance: previous.beforeBalance,
        expectedDelta: BigInt(previous.amount),
        createdAfter: previous.createdAt,
      });
    } catch (error) {
      // Disambiguate the hard stop so an operator never deletes a checkpoint
      // that still guards an in-flight deposit.
      const currentBalance = await getCurrentPrivateBalance(
        sender.client,
        tokenAddress,
        "reconciliation guidance",
      );
      if (currentBalance === BigInt(previous.beforeBalance)) {
        throw new Error(
          `${token.symbol} deposit reconciliation found no accepted deposit and ` +
            "the private balance is unchanged; the prepared checkpoint " +
            `may be cleared to retry (${checkpoint.target})`,
        );
      }
      throw new Error(
        `${token.symbol} deposit reconciliation is ambiguous while the ` +
          "private balance has moved; a deposit may still be in flight. Do NOT " +
          "delete the checkpoint; re-run this command later",
        { cause: error },
      );
    }
    const result = resultFromHistory(reconciled.transaction);
    assertProcessedTransaction(result, `${token.symbol} deposit`);
    checkpoint.update((state) => {
      state.operations.deposit = {
        ...state.operations.deposit,
        txId: result.txId,
        status: result.status,
        reconciledAt: new Date().toISOString(),
      };
    });
    const before = BigInt(previous.beforeBalance);
    complete(result, before, reconciled.currentBalance, previous.amount);
    return;
  }

  const publicBalance = await wallet.publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [wallet.account.address],
  });
  if (publicBalance < amountUnits) {
    throw new Error(
      `public ${token.symbol} balance is insufficient for the deposit`,
    );
  }
  const nativeBalance = await wallet.publicClient.getBalance({
    address: wallet.account.address,
  });
  const gasPrice = await wallet.publicClient.getGasPrice();
  // Approve plus deposit are two EOA-adjacent transactions at most.
  const projectedGasCost = GENEROUS_WRITE_GAS * gasPrice * 2n;
  if (token.symbol === "USDC") {
    const bufferNative =
      args.gasBuffer === undefined
        ? DEFAULT_GAS_BUFFER_NATIVE
        : parseDecimalAmount(args.gasBuffer, config.nativeCurrency.decimals);
    assertUsdcGasBuffer({
      nativeBalance,
      projectedGasCost,
      plannedUsdcErc20: amountUnits,
      bufferNative,
      label: `${token.symbol} deposit`,
    });
  } else if (nativeBalance < projectedGasCost) {
    throw new Error("native USDC balance cannot cover projected gas");
  }

  const before = await getCurrentPrivateBalance(
    sender.client,
    tokenAddress,
    "deposit before",
  );
  checkpoint.update((state) => {
    state.operations.deposit = {
      status: "prepared",
      token: tokenAddress,
      amount,
      beforeBalance: before.toString(),
      createdAt: new Date().toISOString(),
    };
  });
  const handle = await sender.client.depositWithApproval({
    token: tokenAddress,
    amount,
    evm: sender.evmProvider,
    waitForApproval: async (hash) => {
      await wallet.confirm(/** @type {`0x${string}`} */ (hash));
    },
  });
  checkpoint.update((state) => {
    state.operations.deposit = {
      ...state.operations.deposit,
      txId: handle.txId,
      status: handle.status,
      acceptedAt: new Date().toISOString(),
    };
  });
  evidence("deposit_accepted", {
    txId: handle.txId,
    status: handle.status,
    token: tokenAddress,
    tokenSymbol: token.symbol,
    tokenDecimals: token.decimals,
    amount,
  });
  console.log(`${token.symbol} deposit accepted: ${handle.txId}`);

  const result = await waitForProcessedTransaction(sender.client, handle, {
    onStatus,
  });
  assertProcessedTransaction(result, `${token.symbol} deposit`);
  const [after] = await verifyBalanceDeltas({
    tokenAddress,
    participants: [
      {
        client: sender.client,
        label: "deposit verification",
        before,
        expectedDelta: amountUnits,
      },
    ],
    attempts: 10,
    delayMs: 3_000,
  });
  complete(result, before, after, amount);
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(formatPublicError(error, "private deposit failed"));
});
