import { pathToFileURL } from "node:url";

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
  RECIPIENT_APP_ID,
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
  verifyTransferDeltas,
} from "./lib/transfer.mjs";
import {
  createReadOnlyContext,
  createWalletContext,
  sleep,
  withRpcRetry,
} from "./lib/wallet.mjs";

const RPC_PACING_MS = 400;

function printHelp() {
  console.log(`Usage: node scripts/private-transfer.mjs [--chain <key>]
       --token USDC|EURC|cirBTC --amount <human>

Transfers one configured token privately between the deterministic sender and
recipient Unlink accounts. Accepted transfers resume from their persisted
transaction id and completion requires exact sender and recipient deltas.

The protocol fee is charged on top of --amount and rides in the same private
transaction as a second recipient, so the recipient receives exactly --amount
and the fee never becomes a public transaction.`);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const args = {
    help: false,
    token: undefined,
    amount: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      args.help = true;
      continue;
    }
    if (arg === "--token" || arg === "--amount") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--token") {
        args.token = value;
      } else {
        args.amount = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.help && (!args.token || !args.amount)) {
    throw new Error("both --token and --amount are required");
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
  const environment = assertUnlinkEnvironment(
    await admin.environment(),
    config,
  );
  if (
    getAddress(environment.pool_address) !==
    getAddress(config.protocol.unlinkPool)
  ) {
    throw new Error("Unlink pool address does not match chain config");
  }
  if (environment.execution_account.enabled !== true) {
    throw new Error("Unlink ExecutionAccounts are not enabled");
  }
  return admin;
}

/**
 * Resume the prepared-without-id transfer branch against history, verify every
 * participant delta, and pass the stored fee through to completion.
 *
 * @param {{
 *   previous: any,
 *   senderClient: any,
 *   recipientClient: any,
 *   feeClient: any,
 *   tokenAddress: string,
 *   recipientAddress: string,
 *   feeRecipientAddress: string,
 *   checkpoint: {update: (mutate: (state: any) => void) => any},
 *   complete: (
 *     result: any,
 *     senderBefore: bigint,
 *     recipientBefore: bigint,
 *     balances: {senderAfter: bigint, recipientAfter: bigint, feeAfter?: bigint},
 *     amount: string,
 *     fee: string,
 *   ) => void | Promise<void>,
 *   onReconcileError?: (error: unknown) => void | Promise<void>,
 *   attempts?: number,
 *   delayMs?: number,
 *   sleep?: (milliseconds: number) => Promise<void>,
 * }} options
 */
export async function reconcilePreparedTransfer(options) {
  const previous = options.previous;
  // Guard inside the function, not only at the CLI call site, so a direct
  // caller cannot reconcile against a recipient other than the derived one.
  if (previous.recipientAddress !== options.recipientAddress) {
    throw new Error(
      "saved transfer recipient does not match the derived recipient",
    );
  }
  const savedFee = BigInt(previous.feeAmount ?? "0");
  const recipientAddresses = [previous.recipientAddress];
  let feeBefore;
  if (savedFee > 0n) {
    assertUnlinkAddress(previous.feeRecipientAddress);
    if (previous.feeRecipientAddress !== options.feeRecipientAddress) {
      throw new Error(
        "saved transfer fee recipient does not match the derived fee account",
      );
    }
    if (previous.feeBefore === undefined || previous.feeBefore === null) {
      throw new Error(
        "saved fee-bearing transfer is missing its fee account balance snapshot",
      );
    }
    feeBefore = BigInt(previous.feeBefore);
    recipientAddresses.push(options.feeRecipientAddress);
  }

  let reconciled;
  try {
    reconciled = await reconcilePrivateOperation({
      client: options.senderClient,
      type: "transfer",
      token: options.tokenAddress,
      amount: previous.amount,
      feeAmount: savedFee.toString(),
      beforeBalance: previous.senderBefore,
      expectedDelta: -(BigInt(previous.amount) + savedFee),
      recipientAddresses,
      createdAfter: previous.createdAt,
    });
  } catch (error) {
    if (options.onReconcileError) {
      await options.onReconcileError(error);
    }
    throw error;
  }

  const result = resultFromHistory(reconciled.transaction);
  assertProcessedTransaction(result, "private transfer");
  options.checkpoint.update((state) => {
    state.operations.transfer = {
      ...state.operations.transfer,
      txId: result.txId,
      status: result.status,
      reconciledAt: new Date().toISOString(),
    };
  });
  const senderBefore = BigInt(previous.senderBefore);
  const recipientBefore = BigInt(previous.recipientBefore);
  const balances = await verifyTransferDeltas({
    senderClient: options.senderClient,
    recipientClient: options.recipientClient,
    tokenAddress: options.tokenAddress,
    senderBefore,
    recipientBefore,
    amount: BigInt(previous.amount),
    fee: savedFee,
    ...(savedFee > 0n
      ? { feeClient: options.feeClient, feeBefore }
      : {}),
    attempts: options.attempts ?? 10,
    delayMs: options.delayMs ?? 3_000,
    sleep: options.sleep,
  });
  await options.complete(
    result,
    senderBefore,
    recipientBefore,
    balances,
    previous.amount,
    savedFee.toString(),
  );
  return { result, balances, savedFee };
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
    throw new Error(
      `unsupported token on ${config.chainKey}: ${args.token}`,
    );
  }
  const amountUnits = parseDecimalAmount(args.amount, token.decimals);
  if (amountUnits === 0n) {
    throw new Error("--amount must be greater than zero");
  }
  const policy = feePolicy(config);
  const split = feeOnTop(amountUnits, policy.transferBps);
  const amount = toBaseUnitString(split.amount);
  const feeAmount = toBaseUnitString(split.fee);
  const tokenAddress = getAddress(token.address);
  const checkpoint = createCheckpointStore({
    chainKey: config.chainKey,
    flow: `unlink_transfer_${token.symbol.toLowerCase()}`,
  });
  const evidence = createEvidenceWriter({
    chainKey: config.chainKey,
    flow: "unlink_transfer",
  });

  const admin = await runPreflight(config, token);
  const wallet = createWalletContext(config, {
    checkpointFlow: "unlink_transfer_eoa",
  });
  const sender = await createUnlinkContext({
    config,
    wallet,
    appId: SENDER_APP_ID,
    admin,
  });
  const recipient = await createUnlinkContext({
    config,
    wallet,
    appId: RECIPIENT_APP_ID,
    admin: sender.admin,
  });
  const feeAccount = await createUnlinkContext({
    config,
    wallet,
    appId: FEE_APP_ID,
    admin: sender.admin,
  });
  await sender.client.ensureRegistered();
  await recipient.client.ensureRegistered();
  await feeAccount.client.ensureRegistered();
  assertUnlinkAddress(recipient.unlinkAddress);
  assertUnlinkAddress(feeAccount.unlinkAddress);
  console.log(
    `${token.symbol} private transfer of ${args.amount}; ${describeFee({
      fee: split.fee,
      bps: policy.transferBps,
      symbol: token.symbol,
      decimals: token.decimals,
    })}, charged on top and paid inside the same private transaction`,
  );

  const previous = checkpoint.read().operations.transfer;
  const resume = resolveOperationResume(previous);
  if (resume === "done") {
    console.log(
      `${token.symbol} private transfer already verified: ${previous.txId}`,
    );
    return;
  }

  /**
   * Completion evidence is persisted before `verifiedAt`. The status
   * persister's `status` field is the SDK transaction status, not the
   * workflow completion gate.
   *
   * @param {import("@unlink-xyz/sdk/client").TransactionResult} result
   * @param {bigint} senderBefore
   * @param {bigint} recipientBefore
   * @param {{senderAfter: bigint, recipientAfter: bigint, feeAfter?: bigint}} balances
   * @param {string} completedAmount
   * @param {string} completedFee
   */
  function complete(
    result,
    senderBefore,
    recipientBefore,
    balances,
    completedAmount,
    completedFee,
  ) {
    const senderDelta = balances.senderAfter - senderBefore;
    const recipientDelta = balances.recipientAfter - recipientBefore;
    evidence("transfer_completed", {
      txId: result.txId,
      txHash: result.txHash ?? null,
      status: result.status,
      confirmationStatus: result.confirmationStatus,
      fundsUsable: result.fundsUsable,
      token: tokenAddress,
      tokenSymbol: token.symbol,
      tokenDecimals: token.decimals,
      amount: completedAmount,
      feeAmount: completedFee,
      feeBps: policy.transferBps,
      feeRecipient: feeAccount.unlinkAddress,
      recipientAddress: recipient.unlinkAddress,
      senderBeforeBalance: senderBefore,
      senderAfterBalance: balances.senderAfter,
      recipientBeforeBalance: recipientBefore,
      recipientAfterBalance: balances.recipientAfter,
      senderDelta,
      recipientDelta,
    });
    checkpoint.update((state) => {
      state.operations.transfer = {
        ...state.operations.transfer,
        verifiedAt: new Date().toISOString(),
      };
    });
    console.log(`${token.symbol} private transfer completed: ${result.txId}`);
  }

  const onStatus = createTransactionStatusPersister({
    store: checkpoint,
    label: "transfer",
  });

  if (resume === "poll") {
    assertUnlinkAddress(previous.recipientAddress);
    if (previous.recipientAddress !== recipient.unlinkAddress) {
      throw new Error(
        "saved transfer recipient does not match the derived recipient",
      );
    }
    if (previous.token !== tokenAddress) {
      throw new Error(
        "saved transfer token does not match the requested token",
      );
    }
    if (previous.amount !== amount) {
      console.log(
        `Resuming the saved transfer amount ${previous.amount}; the requested amount is ignored`,
      );
    }
    const result = await sender.client.pollTransactionStatus(previous.txId, {
      until: "processed",
      onStatus,
    });
    assertProcessedTransaction(result, `${token.symbol} transfer`);
    const senderBefore = BigInt(previous.senderBefore);
    const recipientBefore = BigInt(previous.recipientBefore);
    const savedFee = BigInt(previous.feeAmount ?? "0");
    const balances = await verifyTransferDeltas({
      senderClient: sender.client,
      recipientClient: recipient.client,
      tokenAddress,
      senderBefore,
      recipientBefore,
      amount: BigInt(previous.amount),
      fee: savedFee,
      feeClient: feeAccount.client,
      feeBefore: BigInt(previous.feeBefore ?? "0"),
      attempts: 10,
      delayMs: 3_000,
    });
    complete(
      result,
      senderBefore,
      recipientBefore,
      balances,
      previous.amount,
      savedFee.toString(),
    );
    return;
  }

  if (resume === "reconcile") {
    assertUnlinkAddress(previous.recipientAddress);
    if (previous.recipientAddress !== recipient.unlinkAddress) {
      throw new Error(
        "saved transfer recipient does not match the derived recipient",
      );
    }
    if (previous.token !== tokenAddress) {
      throw new Error(
        "saved transfer token does not match the requested token",
      );
    }
    if (previous.amount !== amount) {
      console.log(
        `Resuming the saved transfer amount ${previous.amount}; the requested amount is ignored`,
      );
    }
    await reconcilePreparedTransfer({
      previous,
      senderClient: sender.client,
      recipientClient: recipient.client,
      feeClient: feeAccount.client,
      tokenAddress,
      recipientAddress: recipient.unlinkAddress,
      feeRecipientAddress: feeAccount.unlinkAddress,
      checkpoint,
      complete,
      onReconcileError: async (error) => {
        // Disambiguate the hard stop so an operator never deletes a checkpoint
        // that still guards an in-flight transfer.
        const currentBalance = await getCurrentPrivateBalance(
          sender.client,
          tokenAddress,
          "reconciliation guidance",
        );
        if (currentBalance === BigInt(previous.senderBefore)) {
          throw new Error(
            `${token.symbol} transfer reconciliation found no accepted transfer and ` +
              "the sender private balance is unchanged; the prepared checkpoint " +
              `may be cleared to retry (${checkpoint.target})`,
          );
        }
        throw new Error(
          `${token.symbol} transfer reconciliation is ambiguous while the sender ` +
            "private balance has moved; a transfer may still be in flight. Do NOT " +
            "delete the checkpoint; re-run this command later",
          { cause: error },
        );
      },
    });
    return;
  }

  const [senderBefore, recipientBefore, feeBefore] = await Promise.all([
    getCurrentPrivateBalance(
      sender.client,
      tokenAddress,
      "sender pre-transfer",
    ),
    getCurrentPrivateBalance(
      recipient.client,
      tokenAddress,
      "recipient pre-transfer",
    ),
    getCurrentPrivateBalance(
      feeAccount.client,
      tokenAddress,
      "fee account pre-transfer",
    ),
  ]);
  if (senderBefore < split.total) {
    throw new Error(
      `private ${token.symbol} balance is insufficient for the transfer plus its fee`,
    );
  }
  checkpoint.update((state) => {
    state.operations.transfer = {
      status: "prepared",
      token: tokenAddress,
      amount,
      feeAmount,
      feeRecipientAddress: feeAccount.unlinkAddress,
      senderBefore: senderBefore.toString(),
      recipientBefore: recipientBefore.toString(),
      feeBefore: feeBefore.toString(),
      recipientAddress: recipient.unlinkAddress,
      createdAt: new Date().toISOString(),
    };
  });

  // One transaction, two recipients: the fee never leaves the private set.
  const handle = await (split.fee > 0n
    ? sender.client.transfer({
        token: tokenAddress,
        transfers: [
          { recipientAddress: recipient.unlinkAddress, amount },
          { recipientAddress: feeAccount.unlinkAddress, amount: feeAmount },
        ],
      })
    : sender.client.transfer({
        recipientAddress: recipient.unlinkAddress,
        token: tokenAddress,
        amount,
      }));
  checkpoint.update((state) => {
    state.operations.transfer = {
      ...state.operations.transfer,
      txId: handle.txId,
      status: handle.status,
      acceptedAt: new Date().toISOString(),
    };
  });
  evidence("transfer_accepted", {
    txId: handle.txId,
    status: handle.status,
    token: tokenAddress,
    tokenSymbol: token.symbol,
    tokenDecimals: token.decimals,
    amount,
    feeAmount,
    feeBps: policy.transferBps,
    feeRecipient: feeAccount.unlinkAddress,
    recipientAddress: recipient.unlinkAddress,
  });
  console.log(`${token.symbol} private transfer accepted: ${handle.txId}`);

  const result = await waitForProcessedTransaction(sender.client, handle, {
    onStatus,
  });
  assertProcessedTransaction(result, `${token.symbol} transfer`);
  const balances = await verifyTransferDeltas({
    senderClient: sender.client,
    recipientClient: recipient.client,
    tokenAddress,
    senderBefore,
    recipientBefore,
    amount: split.amount,
    fee: split.fee,
    feeClient: feeAccount.client,
    feeBefore,
    attempts: 10,
    delayMs: 3_000,
  });
  complete(result, senderBefore, recipientBefore, balances, amount, feeAmount);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.exitCode = 1;
    console.error(formatPublicError(error, "private transfer failed"));
  });
}
