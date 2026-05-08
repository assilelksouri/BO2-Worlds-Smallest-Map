import http from "http";
import { Server as SocketIOServer } from "socket.io";
import jwt from "jsonwebtoken";
import app from "./app";
import { logger } from "./lib/logger";
import { db, usersTable, conversationParticipantsTable, messagesTable, messageSeenTable, conversationsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required but was not provided.");
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${rawPort}"`);

const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET || "chatapp-secret-key";

const server = http.createServer(app);

const io = new SocketIOServer(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  path: "/api/socket.io",
});

const userSocketMap = new Map<number, Set<string>>();

io.use((socket, next) => {
  const token = socket.handshake.auth.token as string;
  if (!token) return next(new Error("Authentication error"));
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: number; email: string };
    (socket as any).userId = payload.userId;
    next();
  } catch {
    next(new Error("Invalid token"));
  }
});

io.on("connection", async (socket) => {
  const userId = (socket as any).userId as number;
  logger.info({ userId, socketId: socket.id }, "Socket connected");

  if (!userSocketMap.has(userId)) userSocketMap.set(userId, new Set());
  userSocketMap.get(userId)!.add(socket.id);

  await db.update(usersTable).set({ isOnline: true }).where(eq(usersTable.id, userId));

  const participations = await db
    .select()
    .from(conversationParticipantsTable)
    .where(eq(conversationParticipantsTable.userId, userId));

  for (const p of participations) {
    socket.join(`conv:${p.conversationId}`);
  }

  io.emit("user:online", { userId, isOnline: true });

  socket.on("chat:send", async (data: {
    conversationId: number;
    type: string;
    content?: string;
    fileUrl?: string;
    fileName?: string;
    fileSize?: number;
    replyToId?: number;
    tempId?: string;
  }) => {
    try {
      const { conversationId, type, content, fileUrl, fileName, fileSize, replyToId, tempId } = data;

      const [participant] = await db
        .select()
        .from(conversationParticipantsTable)
        .where(and(
          eq(conversationParticipantsTable.conversationId, conversationId),
          eq(conversationParticipantsTable.userId, userId)
        ));

      if (!participant) return;

      const [sender] = await db.select().from(usersTable).where(eq(usersTable.id, userId));

      const [msg] = await db.insert(messagesTable).values({
        conversationId,
        senderId: userId,
        type,
        content: content ?? null,
        fileUrl: fileUrl ?? null,
        fileName: fileName ?? null,
        fileSize: fileSize ?? null,
        replyToId: replyToId ?? null,
      }).returning();

      await db.update(conversationsTable).set({ lastMessageAt: new Date() }).where(eq(conversationsTable.id, conversationId));

      let replyTo = null;
      if (msg.replyToId) {
        const [replyMsg] = await db.select().from(messagesTable).where(eq(messagesTable.id, msg.replyToId));
        if (replyMsg) {
          const [replySender] = await db.select().from(usersTable).where(eq(usersTable.id, replyMsg.senderId));
          replyTo = {
            id: replyMsg.id,
            type: replyMsg.type,
            content: replyMsg.isDeleted ? null : replyMsg.content,
            sender: replySender ? { id: replySender.id, username: replySender.username, avatar: replySender.avatar } : null,
          };
        }
      }

      const payload = {
        id: msg.id,
        tempId,
        conversationId: msg.conversationId,
        senderId: msg.senderId,
        type: msg.type,
        content: msg.content,
        fileUrl: msg.fileUrl,
        fileName: msg.fileName,
        fileSize: msg.fileSize,
        replyToId: msg.replyToId,
        isEdited: false,
        isDeleted: false,
        seenBy: [],
        sender: sender ? { id: sender.id, username: sender.username, avatar: sender.avatar, isOnline: sender.isOnline } : null,
        replyTo,
        createdAt: msg.createdAt,
        updatedAt: msg.updatedAt,
      };

      io.to(`conv:${conversationId}`).emit("chat:message", payload);
    } catch (err) {
      logger.error({ err }, "Error sending message via socket");
    }
  });

  socket.on("chat:typing", (data: { conversationId: number; isTyping: boolean }) => {
    socket.to(`conv:${data.conversationId}`).emit("chat:typing", {
      userId,
      conversationId: data.conversationId,
      isTyping: data.isTyping,
    });
  });

  socket.on("chat:seen", async (data: { messageId: number; conversationId: number }) => {
    try {
      const { messageId, conversationId } = data;
      const existing = await db
        .select()
        .from(messageSeenTable)
        .where(and(eq(messageSeenTable.messageId, messageId), eq(messageSeenTable.userId, userId)));

      if (existing.length === 0) {
        await db.insert(messageSeenTable).values({ messageId, userId });
      }

      await db.update(conversationParticipantsTable)
        .set({ lastReadAt: new Date() })
        .where(and(
          eq(conversationParticipantsTable.conversationId, conversationId),
          eq(conversationParticipantsTable.userId, userId)
        ));

      io.to(`conv:${conversationId}`).emit("chat:seen", { messageId, userId, conversationId });
    } catch (err) {
      logger.error({ err }, "Error marking message seen");
    }
  });

  socket.on("chat:delete", async (data: { messageId: number; conversationId: number }) => {
    try {
      const { messageId, conversationId } = data;
      const [msg] = await db.select().from(messagesTable).where(eq(messagesTable.id, messageId));
      if (!msg || msg.senderId !== userId) return;
      await db.update(messagesTable).set({ isDeleted: true, content: null }).where(eq(messagesTable.id, messageId));
      io.to(`conv:${conversationId}`).emit("chat:deleted", { messageId, conversationId });
    } catch (err) {
      logger.error({ err }, "Error deleting message");
    }
  });

  socket.on("chat:edit", async (data: { messageId: number; conversationId: number; content: string }) => {
    try {
      const { messageId, conversationId, content } = data;
      const [msg] = await db.select().from(messagesTable).where(eq(messagesTable.id, messageId));
      if (!msg || msg.senderId !== userId) return;
      const [updated] = await db.update(messagesTable).set({ content, isEdited: true }).where(eq(messagesTable.id, messageId)).returning();
      io.to(`conv:${conversationId}`).emit("chat:edited", { messageId, conversationId, content, updatedAt: updated.updatedAt });
    } catch (err) {
      logger.error({ err }, "Error editing message");
    }
  });

  socket.on("call:offer", (data: { conversationId: number; offer: RTCSessionDescriptionInit; targetUserId: number }) => {
    const targetSockets = userSocketMap.get(data.targetUserId);
    if (targetSockets) {
      for (const sid of targetSockets) {
        io.to(sid).emit("call:offer", { ...data, callerId: userId });
      }
    }
  });

  socket.on("call:answer", (data: { conversationId: number; answer: RTCSessionDescriptionInit; targetUserId: number }) => {
    const targetSockets = userSocketMap.get(data.targetUserId);
    if (targetSockets) {
      for (const sid of targetSockets) {
        io.to(sid).emit("call:answer", { ...data, callerId: userId });
      }
    }
  });

  socket.on("call:ice-candidate", (data: { candidate: RTCIceCandidateInit; targetUserId: number }) => {
    const targetSockets = userSocketMap.get(data.targetUserId);
    if (targetSockets) {
      for (const sid of targetSockets) {
        io.to(sid).emit("call:ice-candidate", { candidate: data.candidate, senderId: userId });
      }
    }
  });

  socket.on("call:reject", (data: { targetUserId: number; conversationId: number }) => {
    const targetSockets = userSocketMap.get(data.targetUserId);
    if (targetSockets) {
      for (const sid of targetSockets) {
        io.to(sid).emit("call:rejected", { userId });
      }
    }
  });

  socket.on("call:end", (data: { targetUserId: number }) => {
    const targetSockets = userSocketMap.get(data.targetUserId);
    if (targetSockets) {
      for (const sid of targetSockets) {
        io.to(sid).emit("call:ended", { userId });
      }
    }
  });

  socket.on("join:conversation", (conversationId: number) => {
    socket.join(`conv:${conversationId}`);
  });

  socket.on("disconnect", async () => {
    const sockets = userSocketMap.get(userId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        userSocketMap.delete(userId);
        await db.update(usersTable).set({ isOnline: false, lastSeen: new Date() }).where(eq(usersTable.id, userId));
        io.emit("user:online", { userId, isOnline: false, lastSeen: new Date() });
        logger.info({ userId }, "User went offline");
      }
    }
  });
});

server.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
});
