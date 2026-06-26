'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { FrameType, encodeFrame, FrameParser, HEADER_SIZE, MAX_FRAME_LENGTH } = require('../framing');

test('encodeFrame lays out type, streamId and length in the header', () => {
  const payload = Buffer.from('hello');
  const f = encodeFrame(FrameType.DATA, 7, payload);
  assert.equal(f.readUInt8(0), FrameType.DATA);
  assert.equal(f.readUInt32BE(1), 7);
  assert.equal(f.readUInt32BE(5), payload.length);
  assert.equal(f.length, HEADER_SIZE + payload.length);
  assert.equal(f.subarray(HEADER_SIZE).toString(), 'hello');
});

test('parser round-trips a single frame', () => {
  const p = new FrameParser();
  const frames = p.push(encodeFrame(FrameType.DATA, 42, Buffer.from('abc')));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, FrameType.DATA);
  assert.equal(frames[0].streamId, 42);
  assert.equal(frames[0].payload.toString(), 'abc');
});

test('encodes empty-payload control frames (PING/PONG/OPEN/CLOSE)', () => {
  const p = new FrameParser();
  const frames = p.push(encodeFrame(FrameType.PING, 0));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, FrameType.PING);
  assert.equal(frames[0].streamId, 0);
  assert.equal(frames[0].payload.length, 0);
});

test('parses several frames delivered in one chunk', () => {
  const p = new FrameParser();
  const chunk = Buffer.concat([
    encodeFrame(FrameType.OPEN, 1),
    encodeFrame(FrameType.DATA, 1, Buffer.from('x')),
    encodeFrame(FrameType.CLOSE, 1),
  ]);
  const types = p.push(chunk).map((f) => f.type);
  assert.deepEqual(types, [FrameType.OPEN, FrameType.DATA, FrameType.CLOSE]);
});

test('reassembles a frame split across many chunk boundaries', () => {
  const p = new FrameParser();
  const full = encodeFrame(FrameType.DATA, 5, Buffer.from('split me'));
  assert.equal(p.push(full.subarray(0, 3)).length, 0); // partial header
  assert.equal(p.push(full.subarray(3, HEADER_SIZE)).length, 0); // rest of header
  assert.equal(p.push(full.subarray(HEADER_SIZE, HEADER_SIZE + 4)).length, 0); // partial body
  const frames = p.push(full.subarray(HEADER_SIZE + 4));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.toString(), 'split me');
});

test('handles a large (100KB) payload reassembled from 1KB chunks', () => {
  const p = new FrameParser();
  const big = Buffer.alloc(100_000, 0x61);
  const full = encodeFrame(FrameType.DATA, 9, big);
  const out = [];
  for (let i = 0; i < full.length; i += 1024) out.push(...p.push(full.subarray(i, i + 1024)));
  assert.equal(out.length, 1);
  assert.ok(out[0].payload.equals(big));
});

test('preserves a full 32-bit stream id', () => {
  const p = new FrameParser();
  const id = 0xfffffffe;
  const frames = p.push(encodeFrame(FrameType.DATA, id, Buffer.from('z')));
  assert.equal(frames[0].streamId, id);
});

test('keeps a trailing partial frame buffered until completed', () => {
  const p = new FrameParser();
  const a = encodeFrame(FrameType.DATA, 1, Buffer.from('one'));
  const b = encodeFrame(FrameType.DATA, 2, Buffer.from('two'));
  const combined = Buffer.concat([a, b]);
  const first = p.push(combined.subarray(0, a.length + 4)); // a + partial b
  assert.equal(first.length, 1);
  assert.equal(first[0].payload.toString(), 'one');
  const second = p.push(combined.subarray(a.length + 4));
  assert.equal(second.length, 1);
  assert.equal(second[0].payload.toString(), 'two');
});

test('throws on a frame length exceeding MAX_FRAME_LENGTH (DoS guard)', () => {
  const p = new FrameParser();
  // Forge a header that advertises a payload one byte over the cap.
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt8(FrameType.DATA, 0);
  header.writeUInt32BE(1, 1);
  header.writeUInt32BE(MAX_FRAME_LENGTH + 1, 5);
  assert.throws(() => p.push(header), /exceeds max/);
});

test('accepts a frame length exactly at MAX_FRAME_LENGTH', () => {
  const p = new FrameParser();
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt8(FrameType.DATA, 0);
  header.writeUInt32BE(1, 1);
  header.writeUInt32BE(MAX_FRAME_LENGTH, 5);
  // Only the header arrives; at-cap length must NOT throw, just buffer.
  assert.equal(p.push(header).length, 0);
});
