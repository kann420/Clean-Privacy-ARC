import { createHash } from "node:crypto";
import { getAddress } from "viem";

import {
  captureCircleSwapPlan,
  estimateCircleSwap,
} from "../../scripts/lib/circle.mjs";
import {
  formatPublicError,
  parseDecimalAmount,
} from "../../scripts/lib/config.mjs";

// Venue cap expressed in whole input-token units, not raw base units: the same
// raw constant would mean different things for tokens with different decimals.
const MAX_NET_WHOLE_UNITS = 5n;

// Explicit allowlist. A pair is only routable if it appears here, so widening
// the surface is a deliberate edit rather than a side effect of a client body.
const SUPPORTED_PAIRS = {
  eurc: { tokenIn: "USDC", tokenOut: "EURC" },
  usdc: { tokenIn: "EURC", tokenOut: "USDC" },
};

function requirePair(value) {
  const route = value ?? "eurc";
  const pair = typeof route === "string" ? SUPPORTED_PAIRS[route] : undefined;
  if (!pair) {
    throw Object.assign(new Error("Unsupported swap route"), {
      statusCode: 400,
    });
  }
  return { route, ...pair };
}

function canonical(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

export function publicPlanFingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function decimalFromUnits(value, decimals) {
  const units = value.toString().padStart(decimals + 1, "0");
  const whole = units.slice(0, -decimals);
  const fraction = units.slice(-decimals).replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function requireNetUnits(value, token) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw Object.assign(
      new Error("amountNetUnits must be a positive base-unit string"),
      { statusCode: 400 },
    );
  }
  const units = BigInt(value);
  const cap = MAX_NET_WHOLE_UNITS * 10n ** BigInt(token.decimals);
  if (units > cap) {
    throw Object.assign(
      new Error(
        `The swap venue amount is capped at ${MAX_NET_WHOLE_UNITS} ${token.symbol}`,
      ),
      { statusCode: 400 },
    );
  }
  return units;
}

async function requireJson(request) {
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error("The request body must be valid JSON"), {
      statusCode: 400,
    });
  }
}

function jsonRoute(handler) {
  return async (request) => {
    try {
      return Response.json(
        await handler(await requireJson(request), request),
      );
    } catch (error) {
      // Redact at the source: upstream Circle SDK errors can quote request
      // context, so nothing leaves this process without formatPublicError
      // (Opus review, mandatory fix 5).
      return Response.json(
        {
          error: {
            title: "Swap request rejected",
            body: formatPublicError(
              error,
              "The swap request could not be completed.",
            ),
          },
        },
        { status: Number.isInteger(error?.statusCode) ? error.statusCode : 502 },
      );
    }
  };
}

export function createSwapRoutes(options) {
  const estimateFn = options.circle?.estimateCircleSwap ?? estimateCircleSwap;
  const captureFn =
    options.circle?.captureCircleSwapPlan ?? captureCircleSwapPlan;
  const config = options.config;
  const kitKey = options.kitKey;

  return {
    quote: jsonRoute(async (body, request) => {
      const pair = requirePair(body.route);
      const tokenIn = config.tokens[pair.tokenIn];
      const tokenOut = config.tokens[pair.tokenOut];
      const amountIn = requireNetUnits(body.amountNetUnits, {
        ...tokenIn,
        symbol: pair.tokenIn,
      });
      const queryTaker = new URL(request.url).searchParams.get("taker");
      const executionAccount = getAddress(
        queryTaker ?? options.quoteTaker ?? config.fees.owner,
      );
      const amountHuman = decimalFromUnits(amountIn, tokenIn.decimals);
      const estimate = await estimateFn({
        config,
        executionAccount,
        amountHuman,
        kitKey,
        tokenIn: pair.tokenIn,
        tokenOut: pair.tokenOut,
      });
      const estimatedOutUnits = parseDecimalAmount(
        estimate.estimatedOutput.amount,
        tokenOut.decimals,
      );
      return {
        estimatedOutUnits: estimatedOutUnits.toString(),
        indicative: true,
      };
    }),

    circlePlan: jsonRoute(async (body) => {
      const pair = requirePair(body.route);
      const tokenInConfig = config.tokens[pair.tokenIn];
      const amountIn = requireNetUnits(body.amountNetUnits, {
        ...tokenInConfig,
        symbol: pair.tokenIn,
      });
      const executionAccount = getAddress(body.executionAccount);
      if (
        !Number.isSafeInteger(body.accountIndex) ||
        body.accountIndex < 0
      ) {
        throw Object.assign(
          new Error("accountIndex must be a non-negative safe integer"),
          { statusCode: 400 },
        );
      }
      const amountHuman = decimalFromUnits(amountIn, tokenInConfig.decimals);
      const estimate = await estimateFn({
        config,
        executionAccount,
        amountHuman,
        kitKey,
        tokenIn: pair.tokenIn,
        tokenOut: pair.tokenOut,
      });
      const captured = await captureFn({
        config,
        executionAccount,
        amountHuman,
        amountIn,
        kitKey,
        estimate,
        tokenIn: pair.tokenIn,
        tokenOut: pair.tokenOut,
      });
      // Every field below comes from the CAPTURED plan, which
      // validateCircleSwapPlan already decoded out of the real calldata. The
      // route never echoes a request field back as if it were verified data:
      // a client check against an echoed field proves nothing.
      const tokenOutAddress = getAddress(config.tokens[pair.tokenOut].address);
      const outputs = (captured.beneficiaries ?? []).filter(
        (entry) => getAddress(entry.token) === tokenOutAddress,
      );
      if (outputs.length !== 1) {
        throw Object.assign(
          new Error(
            `captured plan does not carry exactly one ${pair.tokenOut} output`,
          ),
          { statusCode: 502 },
        );
      }
      const publicPlan = {
        chainId: config.chainId,
        executionAccount,
        amountIn: amountIn.toString(),
        tokenIn: getAddress(tokenInConfig.address),
        tokenOut: tokenOutAddress,
        adapter: getAddress(config.protocol.circleAdapter),
        swapCall: {
          target: getAddress(captured.swapCall.target),
          value: captured.swapCall.value,
          data: captured.swapCall.data,
        },
        // Decoded from the adapter calldata, not from the request body.
        beneficiary: getAddress(outputs[0].beneficiary),
        circleExecutionId: captured.circleExecutionId,
        minOut: captured.minOut,
        stopLimit: captured.stopLimit,
        estimatedOutput: captured.estimatedOutput,
        deadline: captured.deadline,
        quote: estimate,
      };
      return {
        ...publicPlan,
        fingerprint: publicPlanFingerprint(publicPlan),
      };
    }),
  };
}
