import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HOSTED_INBOUND_BODY_BYTES,
  readBoundedRequestJson,
} from "../agent/lib/bounded_request_json.core.mjs";

test("reads an object body below the hosted-inbound byte limit", async () => {
  const request = new Request("http://localhost", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hello" }),
  });
  assert.deepEqual(await readBoundedRequestJson(request, HOSTED_INBOUND_BODY_BYTES), {
    message: "hello",
  });
});

test("rejects a declared oversized body without reading it", async () => {
  let readerRequested = false;
  const request = {
    headers: { get: () => String(HOSTED_INBOUND_BODY_BYTES + 1) },
    body: { getReader: () => { readerRequested = true; throw new Error("must not read"); } },
  };
  assert.equal(await readBoundedRequestJson(request, HOSTED_INBOUND_BODY_BYTES), null);
  assert.equal(readerRequested, false);
});

test("rejects an oversized streamed body without a content-length", async () => {
  const chunk = new Uint8Array(HOSTED_INBOUND_BODY_BYTES + 1);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
  const request = new Request("http://localhost", {
    method: "POST",
    body,
    duplex: "half",
  });
  assert.equal(await readBoundedRequestJson(request, HOSTED_INBOUND_BODY_BYTES), null);
});

test("rejects malformed JSON and non-object JSON", async () => {
  for (const body of ["{", "[]", "null"]) {
    const request = new Request("http://localhost", { method: "POST", body });
    assert.equal(await readBoundedRequestJson(request, HOSTED_INBOUND_BODY_BYTES), null);
  }
});
