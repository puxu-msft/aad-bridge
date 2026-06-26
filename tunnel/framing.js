'use strict';

/**
 * Wire framing for the reverse tunnel control connection.
 *
 * A single TCP connection (B's proxy-client -> A's proxy-server) carries many logical streams, one per public TCP client.
 * Every message is length-prefixed so the receiver can split a byte stream back into discrete frames.
 *
 *   +--------+-------------------+-------------------+------------------+
 *   | type   | streamId (uint32) | length (uint32)   | payload[length]  |
 *   | 1 byte | 4 bytes BE        | 4 bytes BE        | length bytes     |
 *   +--------+-------------------+-------------------+------------------+
 *
 * streamId is 0 for connection-level frames (AUTH/PING/PONG).
 */

const HEADER_SIZE = 9;

// Upper bound on a single frame's payload.
// DATA frames carry raw TCP read chunks (Node's socket highWaterMark is ~64KB), so 16 MiB is comfortably above anything legitimate while refusing a forged/corrupt length that would otherwise make the parser buffer gigabytes.
// On violation we throw; callers destroy the socket.
const MAX_FRAME_LENGTH = 16 * 1024 * 1024;

// Preamble a `connect` sends immediately before its AUTH frame, so `listen` can recognize the tunnel connection (vs. raw public clients) while it has no active tunnel.
// 8 bytes, leading with a NUL to avoid colliding with text protocols (HTTP/SMTP/etc. never start with this).
const CONTROL_MAGIC = Buffer.from([0x00, 0x52, 0x54, 0x55, 0x4e, 0x4c, 0x01, 0x00]);

const FrameType = Object.freeze({
  AUTH: 1, // client -> server, payload = token. First frame on a fresh tunnel.
  OPEN: 2, // server -> client, a public client connected; open a provider stream.
  DATA: 3, // bidirectional, payload = raw bytes for the stream.
  CLOSE: 4, // bidirectional, the stream is fully closed.
  PING: 5, // client -> server keepalive.
  PONG: 6, // server -> client keepalive reply.
  PAUSE: 7, // receiver -> sender: stop sending DATA for this stream (my downstream is congested).
  RESUME: 8, // receiver -> sender: resume sending DATA for this stream.
  SHUTDOWN: 9, // sender -> receiver: my source sent FIN (half-close); end your write side, keep reading.
});

/** Encode a single frame to a Buffer ready for the wire. */
function encodeFrame(type, streamId, payload) {
  const body = payload && payload.length ? payload : Buffer.alloc(0);
  const header = Buffer.allocUnsafe(HEADER_SIZE);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(streamId >>> 0, 1);
  header.writeUInt32BE(body.length, 5);
  return body.length ? Buffer.concat([header, body]) : header;
}

/**
 * Stateful decoder.
 * Feed it arbitrary TCP chunks via push(); it returns the complete frames it could parse and buffers any trailing partial frame for the next call.
 */
class FrameParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames = [];
    while (this.buffer.length >= HEADER_SIZE) {
      const length = this.buffer.readUInt32BE(5);
      if (length > MAX_FRAME_LENGTH) {
        throw new Error(`frame length ${length} exceeds max ${MAX_FRAME_LENGTH}`);
      }
      const total = HEADER_SIZE + length;
      if (this.buffer.length < total) break; // wait for the rest of this frame
      frames.push({
        type: this.buffer.readUInt8(0),
        streamId: this.buffer.readUInt32BE(1),
        // copy out so we don't pin the whole growing buffer
        payload: Buffer.from(this.buffer.subarray(HEADER_SIZE, total)),
      });
      this.buffer = this.buffer.subarray(total);
    }
    return frames;
  }
}

module.exports = { FrameType, encodeFrame, FrameParser, HEADER_SIZE, MAX_FRAME_LENGTH, CONTROL_MAGIC };
