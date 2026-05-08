// client.js
//
// Браузерный SIP-клиент на jsSIP с авто-реконнектом WSS-сокета и
// автоматическим re-register при восстановлении соединения.
//
// Скрипт намеренно компактный — это демо-клиент для оператора, не полноценный
// софтфон. В проде поверх этого добавляется UI входящих, hold/transfer
// (если бы они были разрешены), DTMF-панель, статусы Available/Not Ready и т.д.

(function () {
  const $ = (id) => document.getElementById(id);
  const logEl = $("log");
  const statusEl = $("status");
  const remoteAudio = $("remoteAudio");

  function log(msg) {
    const ts = new Date().toLocaleTimeString();
    logEl.innerHTML += `[${ts}] ${msg}<br/>`;
    logEl.scrollTop = logEl.scrollHeight;
    console.log(msg);
  }

  function setStatus(s) {
    statusEl.textContent = `Status: ${s}`;
  }

  let ua = null;
  let currentSession = null;

  function buildUA() {
    const wsUri = $("wsUri").value.trim();
    const ext = $("ext").value.trim();
    const password = $("password").value;

    const socket = new JsSIP.WebSocketInterface(wsUri);

    const config = {
      sockets: [socket],
      uri: `sip:${ext}@${location.hostname || "localhost"}`,
      password,
      register: true,
      register_expires: 300,
      // Реконнект встроен в jsSIP: при разрыве сокета UA сам пробует переподключиться.
      connection_recovery_min_interval: 2,
      connection_recovery_max_interval: 30,
      session_timers: false,
    };

    const newUa = new JsSIP.UA(config);

    newUa.on("connected", () => {
      log("UA connected");
      setStatus("connected");
    });
    newUa.on("disconnected", (e) => {
      log(`UA disconnected (code=${e && e.code})`);
      setStatus("disconnected — reconnecting");
    });
    newUa.on("registered", () => {
      log("UA registered");
      setStatus(`registered as ${ext}`);
    });
    newUa.on("unregistered", () => {
      log("UA unregistered");
      setStatus("unregistered");
    });
    newUa.on("registrationFailed", (e) => {
      log(`Registration failed: ${e.cause}`);
      setStatus(`registration failed: ${e.cause}`);
    });
    newUa.on("newRTCSession", (data) => {
      const session = data.session;
      currentSession = session;

      session.on("peerconnection", (ev) => {
        ev.peerconnection.addEventListener("track", (te) => {
          if (te.streams && te.streams[0]) {
            remoteAudio.srcObject = te.streams[0];
          }
        });
      });

      session.on("confirmed", () => {
        log("Call confirmed (media flowing)");
        setStatus("in call");
      });

      session.on("ended", (e) => {
        log(`Call ended: ${e.cause}`);
        setStatus("idle");
        currentSession = null;
      });

      session.on("failed", (e) => {
        log(`Call failed: ${e.cause}`);
        setStatus("idle");
        currentSession = null;
      });

      if (session.direction === "incoming") {
        log(`Incoming call from ${session.remote_identity.uri.user}`);
        setStatus("incoming — auto-answer in demo");
        // В демо отвечаем автоматически; в проде — UI кнопка Accept/Decline
        session.answer({
          mediaConstraints: { audio: true, video: false },
        });
      }
    });

    return newUa;
  }

  $("register").addEventListener("click", () => {
    if (ua) ua.stop();
    ua = buildUA();
    ua.start();
    log("UA starting...");
  });

  $("unregister").addEventListener("click", () => {
    if (ua) {
      ua.stop();
      log("UA stopped");
      setStatus("idle");
    }
  });

  $("call").addEventListener("click", () => {
    if (!ua) {
      log("UA not started");
      return;
    }
    const callee = $("callee").value.trim();
    const target = `sip:${callee}@${location.hostname || "localhost"}`;
    log(`Calling ${target}`);
    ua.call(target, {
      mediaConstraints: { audio: true, video: false },
      pcConfig: { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] },
    });
  });

  $("hangup").addEventListener("click", () => {
    if (currentSession) {
      currentSession.terminate();
      log("Hangup");
    }
  });
})();
