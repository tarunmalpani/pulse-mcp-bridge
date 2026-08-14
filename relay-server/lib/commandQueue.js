import crypto from "crypto";

/**
 * In-memory on-demand command queue (per relay process). Used for tools like
 * get_mobile_screenshot that need a live round trip to the phone rather than
 * a previously-pushed snapshot: the MCP-side GET enqueues a command and waits
 * (with a timeout) for the phone to poll it up and POST back a result.
 *
 * Deliberately in-memory, not persisted - a command that outlives the relay
 * process restarting has no useful recovery story (the requester already got
 * a timeout error and moved on).
 */
const pendingByDevice = new Map(); // deviceId -> Array<{ id, type, createdAt }>
const waitersById = new Map(); // commandId -> { resolve, reject }

const COMMAND_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS || 10000);

/** Enqueues a command for a device and returns a promise that resolves with the phone's result, or rejects on timeout. */
export function enqueueCommand(deviceId, type) {
  const id = crypto.randomUUID();
  const queue = pendingByDevice.get(deviceId) || [];
  queue.push({ id, type, createdAt: Date.now() });
  pendingByDevice.set(deviceId, queue);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waitersById.delete(id);
      reject(new Error(`Timed out after ${COMMAND_TIMEOUT_MS}ms waiting for device to fulfill "${type}"`));
    }, COMMAND_TIMEOUT_MS);

    waitersById.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
  });
}

/** Drains and returns all pending commands for a device (called by the phone's poll loop). */
export function drainPendingCommands(deviceId) {
  const queue = pendingByDevice.get(deviceId) || [];
  pendingByDevice.set(deviceId, []);
  return queue;
}

/** Fulfills a previously enqueued command with the phone's result. */
export function fulfillCommand(commandId, result) {
  const waiter = waitersById.get(commandId);
  if (!waiter) return false;
  waitersById.delete(commandId);
  waiter.resolve(result);
  return true;
}
