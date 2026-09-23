const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");

const WARNINGS = new Map();

// Put your group ID here later.
// Leave empty for now.
const ALLOWED_GROUPS = [];

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState("auth_info");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log("✅ WhatsApp bot connected!");
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
          : true;

      if (shouldReconnect) {
        console.log("🔄 Reconnecting...");
        startBot();
      } else {
        console.log("❌ Logged out.");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue;

        const groupId = msg.key.remoteJid;

        // Only work inside WhatsApp groups
        if (!groupId || !groupId.endsWith("@g.us")) continue;

        // Ignore groups that are not authorized
        if (
          ALLOWED_GROUPS.length > 0 &&
          !ALLOWED_GROUPS.includes(groupId)
        ) {
          continue;
        }

        const sender = msg.key.participant;

        if (!sender) continue;

        const messageText =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          "";

        // Detect normal links
        const hasLink =
          /https?:\/\/|www\./i.test(messageText);

        // Detect forwarded messages
        const isForwarded =
          msg.message.extendedTextMessage?.contextInfo?.isForwarded ||
          msg.message.imageMessage?.contextInfo?.isForwarded ||
          msg.message.videoMessage?.contextInfo?.isForwarded ||
          msg.message.documentMessage?.contextInfo?.isForwarded ||
          false;

        if (!hasLink && !isForwarded) continue;

        // Check whether sender is an admin
        const metadata = await sock.groupMetadata(groupId);

        const participant = metadata.participants.find(
          p => p.id === sender
        );

        const isAdmin =
          participant?.admin === "admin" ||
          participant?.admin === "superadmin";

        // Don't punish admins
        if (isAdmin) continue;

        // Delete the offending message
        await sock.sendMessage(groupId, {
          delete: msg.key
        });

        const warningKey = `${groupId}:${sender}`;
        const previousWarnings =
          WARNINGS.get(warningKey) || 0;

        // First violation
        if (previousWarnings === 0) {

          WARNINGS.set(warningKey, 1);

          await sock.sendMessage(groupId, {
            text:
              "⚠️ Warning!\n\n" +
              "Links and shared/forwarded channel messages are not allowed.\n" +
              "Your next violation will result in removal."
          });

        }

        // Second violation
        else {

          WARNINGS.delete(warningKey);

          await sock.sendMessage(groupId, {
            text:
              "🚫 You have been removed for sending a prohibited message."
          });

          await sock.groupParticipantsUpdate(
            groupId,
            [sender],
            "remove"
          );
        }

      } catch (error) {
        console.log("⚠️ Moderation error:", error);
      }
    }
  });
}

startBot();
