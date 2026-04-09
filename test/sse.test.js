import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { parseSseStream } from "../src/sse.js";

test("parseSseStream parses next and complete events", async () => {
  const chunks = [
    "event: next\ndata: {\"a\":1}\n\n",
    "event: next\ndata: {\"a\":2}\n\n",
    "event: complete\ndata:\n\n",
  ];
  const stream = Readable.from(chunks);
  const events = [];
  for await (const event of parseSseStream(stream)) {
    events.push(event);
  }

  assert.equal(events.length, 3);
  assert.equal(events[0].event, "next");
  assert.equal(events[0].data, "{\"a\":1}");
  assert.equal(events[2].event, "complete");
});

test("parseSseStream handles split event blocks", async () => {
  const stream = Readable.from([
    "event: next\ndata: he",
    "llo\n\n",
    "event: next\ndata: world\n\n",
  ]);

  const events = [];
  for await (const event of parseSseStream(stream)) {
    events.push(event);
  }

  assert.equal(events.length, 2);
  assert.equal(events[0].data, "hello");
  assert.equal(events[1].data, "world");
});

