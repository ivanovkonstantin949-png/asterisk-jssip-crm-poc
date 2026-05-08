// ari-client.js
//
// Подключение к Asterisk REST Interface, обработка событий Stasis-приложения.
// Реконнект с экспоненциальным backoff — если Asterisk перезапустился,
// клиент сам восстановит подключение.

const ari = require("ari-client");

async function connectAri({
  url,
  user,
  pass,
  appName,
  onStasisStart,
  onStasisEnd,
}) {
  let backoff = 1000;
  const maxBackoff = 30000;

  const tryConnect = async () => {
    try {
      const client = await ari.connect(url, user, pass);
      console.log(`[ari] connected to ${url}, registering app "${appName}"`);

      client.on("StasisStart", async (event, channel) => {
        try {
          await onStasisStart(event, channel, client);
        } catch (err) {
          console.error("[ari] StasisStart handler error:", err);
        }
      });

      client.on("StasisEnd", async (event, channel) => {
        try {
          if (onStasisEnd) await onStasisEnd(event, channel, client);
        } catch (err) {
          console.error("[ari] StasisEnd handler error:", err);
        }
      });

      client.on("WebSocketReconnecting", () => {
        console.warn("[ari] websocket reconnecting...");
      });

      client.on("APILoadError", (err) => {
        console.error("[ari] API load error:", err);
      });

      await client.start(appName);
      backoff = 1000;
      return client;
    } catch (err) {
      console.error(
        `[ari] connect failed: ${err.message}, retry in ${backoff}ms`,
      );
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, maxBackoff);
      return tryConnect();
    }
  };

  return tryConnect();
}

module.exports = { connectAri };
