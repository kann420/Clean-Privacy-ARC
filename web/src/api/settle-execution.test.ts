import { describe, expect, it, vi } from "vitest";

import { settleExecution } from "./unlinkBackend";

/**
 * Live QA, 2026-07-31: a return-to-pool execution was accepted, the SDK wait
 * returned while it was still pending, and the throw left the journal in
 * `recovery_pending`. The sweep completed on-chain seconds later with nothing
 * reading it, so a finished operation looked stranded.
 *
 * settleExecution waits that out. The safety properties matter more than the
 * waiting: it may only ever poll the id it was given, and it must never report
 * a pending execution as a success.
 */
describe("settleExecution", () => {
  const pending = { status: "pending", executionId: "exec-1" };
  const success = { status: "completed", executionId: "exec-1" };
  const reverted = { status: "user_op_reverted", executionId: "exec-1" };

  const clientOf = (...responses: unknown[]) => {
    const pollExecuteStatus = vi.fn();
    for (const response of responses) {
      pollExecuteStatus.mockResolvedValueOnce(response);
    }
    pollExecuteStatus.mockResolvedValue(responses.at(-1) ?? pending);
    return { pollExecuteStatus, execute: vi.fn(), executeAccountCall: vi.fn() };
  };

  it("returns an already-successful result without polling at all", async () => {
    const client = clientOf();
    expect(await settleExecution(client, success, 5, 0)).toBe(success);
    expect(client.pollExecuteStatus).not.toHaveBeenCalled();
  });

  it("polls the accepted id until the execution reaches success", async () => {
    const client = clientOf(pending, pending, success);
    const settled = await settleExecution(client, pending, 5, 0);
    expect(settled).toEqual(success);
    expect(client.pollExecuteStatus).toHaveBeenCalledTimes(3);
    // Every poll targets the SAME id it was handed.
    for (const call of client.pollExecuteStatus.mock.calls) {
      expect(call[0]).toBe("exec-1");
    }
  });

  it("never resubmits an execution", async () => {
    const client = clientOf(pending, success);
    await settleExecution(client, pending, 5, 0);
    expect(client.execute).not.toHaveBeenCalled();
    expect(client.executeAccountCall).not.toHaveBeenCalled();
  });

  it("returns a terminal failure immediately instead of waiting it out", async () => {
    const client = clientOf();
    expect(await settleExecution(client, reverted, 5, 0)).toBe(reverted);
    expect(client.pollExecuteStatus).not.toHaveBeenCalled();
  });

  it("stops at a terminal failure discovered while polling", async () => {
    const client = clientOf(pending, reverted, success);
    const settled = await settleExecution(client, pending, 5, 0);
    expect(settled).toEqual(reverted);
    // It must not keep polling past the verdict and pick up a later success.
    expect(client.pollExecuteStatus).toHaveBeenCalledTimes(2);
  });

  it("reports pending as pending when the window runs out", async () => {
    // The bounded window must expire into "still pending", never into success:
    // the caller's assertExecutionCompleted is what turns that into an error.
    const client = clientOf(pending);
    const settled = await settleExecution(client, pending, 3, 0);
    expect(settled.status).toBe("pending");
    expect(client.pollExecuteStatus).toHaveBeenCalledTimes(3);
  });

  it("survives a transient poll error and keeps the last known result", async () => {
    const pollExecuteStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error("RPC request limit reached"))
      .mockResolvedValueOnce(success);
    const settled = await settleExecution(
      { pollExecuteStatus },
      pending,
      5,
      0,
    );
    expect(settled).toEqual(success);
  });

  it("gives up when the result carries no execution id to poll", async () => {
    const client = clientOf(success);
    const orphan = { status: "pending" };
    expect(await settleExecution(client, orphan, 5, 0)).toBe(orphan);
    expect(client.pollExecuteStatus).not.toHaveBeenCalled();
  });

  it("reads the execution id from the nested session shape", async () => {
    const client = clientOf(success);
    const nested = { status: "pending", execution: { execution_id: "exec-9" } };
    await settleExecution(client, nested, 5, 0);
    expect(client.pollExecuteStatus).toHaveBeenCalledWith("exec-9", {
      waitUntil: "processed",
    });
  });
});
