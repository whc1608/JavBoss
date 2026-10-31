const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "bridge.js"), "utf8");

test("the bridge forwards clean JavDB assistance to the service worker", async () => {
  const listeners = {};
  const runtimeMessages = [];
  const parent = { postMessage() {} };
  const window = {
    parent,
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
  };
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      async sendMessage(message) {
        runtimeMessages.push(message);
        return { ok: true };
      },
    },
  };

  vm.runInNewContext(source, { chrome, URL, window });
  const sessionId = "test-session-1234";
  listeners.message({
    source: parent,
    origin: "http://localhost:17654",
    data: { type: "JAVBOSS_EXTENSION_CONNECT", sessionId },
  });
  listeners.message({
    source: parent,
    origin: "http://localhost:17654",
    data: {
      type: "JAVBOSS_JAVDB_OPEN",
      sessionId,
      url: "https://javdb.com/search?q=ADN-429&f=all",
      fallbackUrl:
        "https://javdb.com/search?f=actor&q=%E5%B2%AC%E3%81%AA%E3%81%AA%E3%81%BF",
      request: { target: "idol", code: "ADN-429", name: "岬ななみ" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(runtimeMessages)), [
    {
      type: "JAVBOSS_JAVDB_OPEN_ASSIST",
      sessionId,
      url: "https://javdb.com/search?q=ADN-429&f=all",
      fallbackUrl:
        "https://javdb.com/search?f=actor&q=%E5%B2%AC%E3%81%AA%E3%81%AA%E3%81%BF",
      request: { target: "idol", code: "ADN-429", name: "岬ななみ" },
    },
  ]);
});

function createOnlineHarness(html, options = {}) {
  const listeners = {};
  const messages = [];
  const parent = {
    postMessage(message) {
      messages.push(message);
    },
  };
  const window = {
    parent,
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
  };
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      async sendMessage() {
        return { ok: true };
      },
    },
  };
  const fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "" },
    text: async () => html,
    arrayBuffer: async () => (options.arrayBuffer ? options.arrayBuffer() : new ArrayBuffer(0)),
  });

  vm.runInNewContext(source, { chrome, URL, window, fetch });
  const sessionId = "test-session-1234";
  listeners.message({
    source: parent,
    origin: "http://localhost:17654",
    data: { type: "JAVBOSS_EXTENSION_CONNECT", sessionId },
  });
  return { listeners, messages, parent, sessionId };
}

const MISSav_HTML = `<!doctype html><html><body>
<video class="player" controls></video>
<script>
var player = videojs(document.querySelector('video.player'), { dvd_id: 'ABC-123' });
var source = 'https://surrit.com/abc/playlist.m3u8';
var source1280 = 'https://surrit.com/abc/1920x1080/video.m3u8';
</script>
</body></html>`;

test("the bridge resolves an online stream for a movie code", async () => {
  const harness = createOnlineHarness(MISSav_HTML);
  harness.listeners.message({
    source: harness.parent,
    origin: "http://localhost:17654",
    data: {
      type: "JAVBOSS_ONLINE_RESOLVE",
      sessionId: harness.sessionId,
      requestId: "request-1",
      code: "ABC-123",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const result = harness.messages.find(
    (message) => message.type === "JAVBOSS_ONLINE_RESOLVE_RESULT",
  );
  assert.ok(result);
  assert.equal(result.ok, true);
  assert.equal(result.requestId, "request-1");
  assert.equal(result.source.provider, "MissAV");
  assert.equal(result.source.stream_url, "https://surrit.com/abc/1920x1080/video.m3u8");
  assert.equal(result.source.stream_type, "hls");
});

test("the bridge relays playlist and segment fetches", async () => {
  const harness = createOnlineHarness("", {
    arrayBuffer: () => new ArrayBuffer(8),
  });
  harness.listeners.message({
    source: harness.parent,
    origin: "http://localhost:17654",
    data: {
      type: "JAVBOSS_ONLINE_FETCH",
      sessionId: harness.sessionId,
      requestId: "request-2",
      url: "https://surrit.com/abc/1920x1080/video.m3u8",
      responseType: "arrayBuffer",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const result = harness.messages.find(
    (message) => message.type === "JAVBOSS_ONLINE_FETCH_RESULT",
  );
  assert.ok(result);
  assert.equal(result.ok, true);
  assert.equal(result.requestId, "request-2");
  assert.equal(result.data.byteLength, 8);
});
