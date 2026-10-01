// The transport's four properties (WP-8b, prework B3): a version peers agree
// on, a bounded frame, sequence numbers that make a gap visible, and a bad
// message that costs one message rather than the connection.

import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import {
  MAX_FRAME_BYTES, PROTOCOL_VERSION, ProtocolError, createFrameReader, createFrameWriter,
  frameProblem, negotiatedVersion, payloadOf,
} from "../framing.mjs";
import { validateOpenCodeAccountInput } from "../opencode-account-channel.mjs";

function reader(options = {}) {
  const messages = [];
  const errors = [];
  const feed = createFrameReader({
    onMessage: (frame) => messages.push(frame),
    onProtocolError: (error) => errors.push(error),
    ...options,
  });
  return { messages, errors, feed, reasons: () => errors.map((error) => error.reason) };
}

test("a frame that is not JSON costs one frame, and the ones after it still arrive", () => {
  const { messages, feed, reasons } = reader();
  feed('{"type":"ping","seq":0}\n');
  feed('not json at all\n');
  feed('{"type":"ping","seq":1}\n');
  assert.deepEqual(messages.map((frame) => frame.seq), [0, 1]);
  assert.deepEqual(reasons(), ["invalid_json"]);
});

test("a frame arriving in pieces is assembled, and two in one chunk are both read", () => {
  const { messages, feed } = reader({ expectSequence: false });
  feed('{"type":"pi');
  feed('ng"}\n{"type":"ping"}');
  feed('\n');
  assert.equal(messages.length, 2);
});

test("an oversized frame is dropped rather than buffered, and the stream recovers", () => {
  const { messages, feed, reasons } = reader({ maxFrameBytes: 100, expectSequence: false });
  feed(`{"type":"stdout","channel_id":"c","data":"${"x".repeat(500)}`);
  feed(`${"x".repeat(500)}"}\n`);
  feed('{"type":"ping"}\n');
  assert.deepEqual(messages, [{ type: "ping" }], "the frame after the oversized one was lost");
  assert.deepEqual(reasons(), ["frame_too_large"]);
  // Reported once, not once per chunk of the thing being dropped.
  assert.equal(reasons().length, 1);
});

test("a frame of the wrong shape is refused by name", () => {
  assert.equal(frameProblem({ type: "ping" }), null);
  assert.equal(frameProblem({ request_id: "r1", ok: true }), null);
  assert.match(frameProblem([]), /must be a JSON object/);
  assert.match(frameProblem({ ok: true }), /must carry a type or a request_id/);
  assert.match(frameProblem({ type: "stdout", channel_id: "c" }), /must carry data/);
  assert.match(frameProblem({ type: "stdout", channel_id: 7, data: "x" }), /channel_id must be a string/);
  assert.match(frameProblem({ type: "ping", seq: -1 }), /seq must be a non-negative integer/);
  // An unknown type is the dispatcher's to refuse: it owns the allowlist, and
  // the transport inventing one would mean two lists to keep in step.
  assert.equal(frameProblem({ type: "open_something_new", request_id: "r" }), null);
});

test("a gap in the sequence is reported, and the frames that did arrive are still delivered", () => {
  const { messages, feed, errors } = reader();
  feed('{"type":"ping","seq":0}\n{"type":"ping","seq":1}\n{"type":"ping","seq":5}\n');
  assert.equal(messages.length, 3);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].reason, "sequence_gap");
  assert.match(errors[0].message, /3 frame\(s\) were lost/);
  // And it resynchronises: the next frame in order is not a second complaint.
  feed('{"type":"ping","seq":6}\n');
  assert.equal(errors.length, 1);
});

test("the writer numbers its frames and refuses one over the limit", () => {
  const socket = new PassThrough();
  const written = [];
  socket.on("data", (chunk) => written.push(String(chunk)));
  const write = createFrameWriter(socket, { maxFrameBytes: 200 });
  write({ type: "ping" });
  write({ type: "ping" });
  assert.deepEqual(written.map((line) => JSON.parse(line).seq), [0, 1]);

  assert.throws(() => write({ type: "stdout", channel_id: "c", data: "x".repeat(500) }), (error) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.reason, "frame_too_large");
    assert.equal(error.code, "protocol");
    assert.equal(error.retryable, false);
    return true;
  });
  // The refused frame consumed no sequence number, so the peer sees no gap for
  // something that was never sent.
  write({ type: "ping" });
  assert.deepEqual(written.map((line) => JSON.parse(line).seq), [0, 1, 2]);
});

test("a writer refuses once the unsent spool would pass its bound", () => {
  // A socket nobody reads: `writableLength` is what has piled up in the process.
  const socket = new PassThrough({ highWaterMark: 1 });
  const write = createFrameWriter(socket, { maxSpoolBytes: 400 });
  let refused = null;
  try {
    for (let index = 0; index < 100; index += 1) write({ type: "stdout", channel_id: "c", data: "x".repeat(50) });
  } catch (error) {
    refused = error;
  }
  assert.ok(refused, "the writer buffered without bound into a socket nobody reads");
  assert.equal(refused.reason, "spool_full");
});

test("a closed socket is not written to, and says so without throwing", () => {
  const socket = new PassThrough();
  socket.destroy();
  assert.equal(createFrameWriter(socket)({ type: "ping" }), false);
});

test("peers settle on the highest version both speak", () => {
  assert.equal(negotiatedVersion(PROTOCOL_VERSION), PROTOCOL_VERSION);
  // A peer from before the handshake existed says nothing, and is version 1.
  assert.equal(negotiatedVersion(undefined), 1);
  assert.equal(negotiatedVersion(1), 1);
  // A newer peer is met at the highest this side implements.
  assert.equal(negotiatedVersion(99), PROTOCOL_VERSION);
  // And a peer below everything this side speaks is not served by guessing.
  assert.equal(negotiatedVersion(0), null);
});

test("the default frame limit is the one the supervisor's own output fits in", () => {
  // The supervisor caps a runtime's total output at 4 MiB and sends it in
  // chunks; a single frame at the limit is already far above any of them.
  assert.equal(MAX_FRAME_BYTES, 1024 * 1024);
});

// The handshake over a real socket. It is the one piece of WP-8b that only
// exists on a live connection, and its failure mode is quiet: a client that
// never gets an answer waits out its timeout on every connect and then carries
// on as if nothing happened.
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { RuntimeSupervisorClient } from "../client.mjs";

async function withServer(onFrame, body) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "framing-"));
  const socketPath = path.join(directory, "s.sock");
  const server = net.createServer((socket) => {
    const write = createFrameWriter(socket);
    const feed = createFrameReader({ onMessage: (frame) => onFrame(frame, write), expectSequence: false });
    socket.setEncoding("utf8");
    socket.on("data", feed);
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    return await body(socketPath);
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a client and a supervisor of this release settle on the current version", async () => {
  await withServer((frame, write) => {
    if (frame.type === "hello") {
      write({ request_id: frame.request_id, ok: true,
        result: { protocol_version: negotiatedVersion(frame.protocol_version), supervisor_id: "test" } });
    }
  }, async (socketPath) => {
    const client = new RuntimeSupervisorClient({ socketPath });
    await client.connect();
    assert.equal(client.protocolVersion, PROTOCOL_VERSION);
    client.close();
  });
});

test("a supervisor from before the handshake is version 1, and the client does not hang on it", async () => {
  // What an older release does with an unknown request type: refuses it.
  const started = Date.now();
  await withServer((frame, write) => {
    write({ request_id: frame.request_id, ok: false, error: "unsupported supervisor request" });
  }, async (socketPath) => {
    const client = new RuntimeSupervisorClient({ socketPath });
    await client.connect();
    assert.equal(client.protocolVersion, 1);
    client.close();
  });
  assert.ok(Date.now() - started < 5_000, "the client waited out its handshake timeout");
});

test("a supervisor that refuses the version closes the connection, and the client says so", async () => {
  await withServer((frame, write) => {
    if (frame.type === "hello") {
      write({ request_id: frame.request_id, ok: false, failure_code: "protocol",
        error: "this supervisor speaks protocol 3, 4, not 2" });
    }
  }, async (socketPath) => {
    const client = new RuntimeSupervisorClient({ socketPath });
    // A refusal is not a crash: the client falls back rather than throwing out
    // of `connect`, and the version it reports is the one it can rely on.
    await client.connect();
    assert.equal(client.protocolVersion, 1);
    client.close();
  });
});

test("the sequence number stays in the transport, so a request validated field by field still passes", () => {
  // Found while building WP-5b: the writer numbers every frame, the server
  // handed the numbered frame to the request's own validation, and the OpenCode
  // account allowlist refuses any field it does not name. Every account status,
  // login and catalog listing a version-2 client sent was refused with
  // `unexpected OpenCode account field: seq`.
  const written = [];
  const write = createFrameWriter({ destroyed: false, writable: true, writableLength: 0,
    write: (line) => { written.push(line); return true; } });
  write({ type: "opencode_account", request_id: "r-1", operation: "status" });
  const { messages, feed } = reader();
  feed(written[0]);
  assert.equal(messages[0].seq, 0, "the reader still sees the number it checks");
  assert.throws(() => validateOpenCodeAccountInput(messages[0]), /unexpected OpenCode account field: seq/,
    "the frame as the reader delivers it is what used to be validated");
  const request = payloadOf(messages[0]);
  assert.equal("seq" in request, false);
  assert.equal(validateOpenCodeAccountInput(request).operation, "status");
});
