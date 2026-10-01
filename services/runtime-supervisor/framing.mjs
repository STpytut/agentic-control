// The supervisor's transport: versioned, bounded, and isolated per message
// (WP-8b, prework B3).
//
// What it was: newline-delimited JSON with no frame limit, `socket.write()` with
// no backpressure, and a client-side `JSON.parse()` whose failure was not
// isolated — one malformed byte took down the connection and every request on
// it. For a transport that already carries verbose CLI streams, and that A4's
// mailbox and A5's driver will load further, that is not sufficient.
//
// Four properties, and each is here because its absence has a name:
//
// * **A version in the handshake.** The client and the supervisor ship in one
//   release and restart together, so a mismatch means something is wrong —
//   a stale process, a half-finished update — and the useful behaviour is to
//   say so rather than to speak a protocol the peer does not.
// * **A maximum frame.** `readline` buffers a line of any length: a runtime
//   that prints a megabyte without a newline is a megabyte in memory on a 4 GB
//   host, per connection.
// * **Sequence numbers.** A dropped frame is otherwise a request that simply
//   never answers, and the timeout says only that.
// * **One message fails, not the connection.** The server already isolated its
//   parse; the client did not, and an exception inside its `line` handler took
//   the socket with it.

// Bumped when the shape of a frame changes in a way a peer must understand.
// Version 1 is the unversioned protocol every release before this one spoke:
// a peer that never says hello is treated as speaking it.
export const PROTOCOL_VERSION = 2;
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([1, 2]);

// One frame, as bytes on the wire. Chosen against what actually travels: the
// largest legitimate frame is a runtime's stdout chunk, which the supervisor
// already caps at 4 MiB in total and sends in pieces far below this.
export const MAX_FRAME_BYTES = 1024 * 1024;

// How much may wait in the kernel's buffer before a writer is told to stop.
// `socket.write` returns false past the high-water mark and keeps accepting
// anyway — it just buffers in the process, which on this host is the thing to
// avoid.
export const MAX_SPOOL_BYTES = 8 * 1024 * 1024;

export class ProtocolError extends Error {
  constructor(message, { reason, frameBytes } = {}) {
    super(message);
    this.name = "ProtocolError";
    this.code = "protocol";
    this.reason = reason;
    this.retryable = false;
    if (frameBytes !== undefined) this.frameBytes = frameBytes;
  }
}

// ------------------------------------------------------------------ schema
//
// What a frame must carry to be handled at all. Deliberately shallow: this is
// the transport's business — is this a frame of a kind we know, with the fields
// the dispatcher will read — and not the request's own validation, which stays
// where the request is served.
const FRAME_SHAPES = Object.freeze({
  hello: { required: ["protocol_version"], types: { protocol_version: "number" } },
  ping: { required: [], types: {} },
  stdout: { required: ["channel_id", "data"], types: { channel_id: "string", data: "string" } },
  stderr: { required: ["channel_id", "data"], types: { channel_id: "string", data: "string" } },
  channel_closed: { required: ["channel_id"], types: { channel_id: "string" } },
  protocol_error: { required: ["error"], types: { error: "string" } },
});

// A reply carries `request_id` and nothing else the transport reads; a request
// carries `type`. Both are checked, and an unknown `type` is *not* a protocol
// error — the dispatcher answers that, and it knows the allowlist.
export function frameProblem(frame) {
  if (frame === null || typeof frame !== "object" || Array.isArray(frame)) return "a frame must be a JSON object";
  const type = frame.type;
  if (type === undefined && typeof frame.request_id !== "string") {
    return "a frame must carry a type or a request_id";
  }
  if (type !== undefined && typeof type !== "string") return "a frame's type must be a string";
  if (frame.seq !== undefined && (!Number.isInteger(frame.seq) || frame.seq < 0)) {
    return "a frame's seq must be a non-negative integer";
  }
  const shape = FRAME_SHAPES[type];
  if (!shape) return null;
  for (const field of shape.required) {
    if (frame[field] === undefined) return `a ${type} frame must carry ${field}`;
  }
  for (const [field, expected] of Object.entries(shape.types)) {
    if (frame[field] !== undefined && typeof frame[field] !== expected) {
      return `a ${type} frame's ${field} must be a ${expected}`;
    }
  }
  return null;
}

// ------------------------------------------------------------------ writing
//
// A writer that refuses rather than buffers. The alternative is what
// `socket.write` does on its own: accept everything, hold it in the process,
// and let a slow reader turn into memory on a 4 GB host.
export function createFrameWriter(socket, { maxFrameBytes = MAX_FRAME_BYTES, maxSpoolBytes = MAX_SPOOL_BYTES } = {}) {
  let seq = 0;
  return function write(message) {
    if (socket.destroyed || !socket.writable) return false;
    // Numbered only once it is actually sent. A refused frame that consumed a
    // number would show up at the peer as a gap — a lost frame — for something
    // that was never on the wire.
    const frame = `${JSON.stringify({ ...message, seq })}\n`;
    const bytes = Buffer.byteLength(frame);
    if (bytes > maxFrameBytes) {
      // Refused here, where the caller can still be told which message it was.
      // Sent and refused at the other end, it would arrive as a connection that
      // died for no stated reason.
      throw new ProtocolError(
        `a ${message.type ?? "reply"} frame is ${bytes} bytes, over the ${maxFrameBytes}-byte limit`,
        { reason: "frame_too_large", frameBytes: bytes },
      );
    }
    if (socket.writableLength + bytes > maxSpoolBytes) {
      throw new ProtocolError(
        `the connection has ${socket.writableLength} bytes unsent; a ${bytes}-byte frame would pass the ${maxSpoolBytes}-byte spool`,
        { reason: "spool_full" },
      );
    }
    seq += 1;
    // The return value is the backpressure signal, handed to the caller rather
    // than ignored: a streaming sender waits for `drain` before the next chunk.
    return socket.write(frame);
  };
}

// ------------------------------------------------------------------ reading
//
// Framing by newline, with the buffer bounded — which is the part `readline`
// does not do. A frame that is too long, unparseable or the wrong shape is
// reported and skipped; the connection carries on.
//
// `onMessage` is called for each good frame. `onProtocolError` is called with a
// ProtocolError for each bad one, and is where a peer decides whether to answer,
// log, or close.
export function createFrameReader({
  onMessage,
  onProtocolError,
  maxFrameBytes = MAX_FRAME_BYTES,
  expectSequence = true,
} = {}) {
  let buffer = "";
  let overlong = false;
  let nextSeq = null;

  return function feed(chunk) {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        // No frame yet. If what is accumulating is already over the limit, the
        // rest of it is dropped rather than held: the frame is lost either way,
        // and holding it is the failure mode this exists to prevent.
        if (Buffer.byteLength(buffer) > maxFrameBytes) {
          if (!overlong) {
            onProtocolError?.(new ProtocolError(
              `a frame passed the ${maxFrameBytes}-byte limit before a newline; it is being dropped`,
              { reason: "frame_too_large", frameBytes: Buffer.byteLength(buffer) },
            ));
          }
          overlong = true;
          buffer = "";
        }
        return;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (overlong) { overlong = false; continue; }   // the tail of a dropped frame
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > maxFrameBytes) {
        onProtocolError?.(new ProtocolError(
          `a frame of ${Buffer.byteLength(line)} bytes is over the ${maxFrameBytes}-byte limit`,
          { reason: "frame_too_large", frameBytes: Buffer.byteLength(line) },
        ));
        continue;
      }
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        // One message, not the connection. This is the isolation the client did
        // not have: its parse ran inside the `line` handler, and a throw there
        // took the socket and every request waiting on it.
        onProtocolError?.(new ProtocolError("a frame is not valid JSON", { reason: "invalid_json" }));
        continue;
      }
      const problem = frameProblem(frame);
      if (problem) {
        onProtocolError?.(new ProtocolError(problem, { reason: "invalid_frame" }));
        continue;
      }
      if (expectSequence && Number.isInteger(frame.seq)) {
        if (nextSeq !== null && frame.seq !== nextSeq) {
          // Reported, not fatal: the frames that did arrive are still answers to
          // real requests, and a gap the peer can see is better than a request
          // that only ever times out.
          onProtocolError?.(new ProtocolError(
            `frame ${frame.seq} arrived where ${nextSeq} was expected; ${frame.seq - nextSeq} frame(s) were lost`,
            { reason: "sequence_gap" },
          ));
        }
        nextSeq = frame.seq + 1;
      }
      onMessage?.(frame);
    }
  };
}

// What a frame says with the transport's own fields taken off.
//
// `seq` is the transport's: the writer adds it, the reader checks it, and
// nothing past the reader has any business with it. Handing it on made it part
// of every request, and a request that is validated field by field — the
// OpenCode account allowlist refuses any field it does not name — refused every
// frame a version-2 client sent: `unexpected OpenCode account field: seq`. Each
// account status, login and catalog listing since rc.36.
export function payloadOf(frame) {
  if (frame === null || typeof frame !== "object" || Array.isArray(frame)) return frame;
  const { seq: _seq, ...payload } = frame;
  return payload;
}

// The version two peers settle on: the highest both speak. A peer that never
// said hello is version 1, which is every release before this one.
export function negotiatedVersion(peerVersion) {
  if (!Number.isInteger(peerVersion)) return 1;
  const shared = SUPPORTED_PROTOCOL_VERSIONS.filter((version) => version <= peerVersion);
  return shared.length ? Math.max(...shared) : null;
}
