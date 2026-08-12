import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const channels = ["console", "slack", "discord", "telegram"];

test("every hosted reply channel records the canonical outbound reply only after its delivery await", () => {
  for (const name of channels) {
    const source = readFileSync(fileURLToPath(new URL(`../agent/channels/${name}.ts`, import.meta.url)), "utf8");
    assert.match(source, /recordDeliveredChannelReply/, `${name} must import the intake reply recorder`);
    const deliveryIndex = name === "console" ? source.indexOf("await postConsoleChatReply") :
      name === "slack" ? source.indexOf("await postSlackReply") :
      name === "discord" ? source.indexOf("await deliverDiscordReply") : source.indexOf("await channel.telegram.post");
    const recordIndex = source.indexOf("await recordDeliveredChannelReply");
    assert.ok(deliveryIndex >= 0 && recordIndex > deliveryIndex, `${name} must record only after a delivery await`);
    assert.match(source, new RegExp(`channel: "${name}"`), `${name} must retain its source-channel provenance`);
  }
});
