import { Router, type IRouter } from "express";
import { db, usersTable, messagesTable, messageSeenTable, conversationParticipantsTable, conversationsTable } from "@workspace/db";
import { eq, and, lt, desc, inArray, sql } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";
import { publicUser } from "./conversations";

const router: IRouter = Router();

async function buildMessage(msg: typeof messagesTable.$inferSelect, requesterId?: number) {
  const [sender] = await db.select().from(usersTable).where(eq(usersTable.id, msg.senderId));

  const seenRecords = await db.select().from(messageSeenTable).where(eq(messageSeenTable.messageId, msg.id));
  const seenBy = seenRecords.map((s) => s.userId);

  let replyTo = null;
  if (msg.replyToId) {
    const [replyMsg] = await db.select().from(messagesTable).where(eq(messagesTable.id, msg.replyToId));
    if (replyMsg) {
      const [replySender] = await db.select().from(usersTable).where(eq(usersTable.id, replyMsg.senderId));
      replyTo = {
        id: replyMsg.id,
        type: replyMsg.type,
        content: replyMsg.isDeleted ? "Message deleted" : replyMsg.content,
        sender: replySender ? publicUser(replySender) : null,
      };
    }
  }

  return {
    id: msg.id,
    conversationId: msg.conversationId,
    senderId: msg.senderId,
    type: msg.type,
    content: msg.isDeleted ? null : msg.content,
    fileUrl: msg.isDeleted ? null : msg.fileUrl,
    fileName: msg.isDeleted ? null : msg.fileName,
    fileSize: msg.isDeleted ? null : msg.fileSize,
    replyToId: msg.replyToId,
    isEdited: msg.isEdited,
    isDeleted: msg.isDeleted,
    seenBy,
    sender: sender ? publicUser(sender) : null,
    replyTo,
    createdAt: msg.createdAt,
    updatedAt: msg.updatedAt,
  };
}

router.get("/conversations/:conversationId/messages", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const convId = parseInt(Array.isArray(req.params.conversationId) ? req.params.conversationId[0] : req.params.conversationId, 10);

  const [participant] = await db
    .select()
    .from(conversationParticipantsTable)
    .where(and(eq(conversationParticipantsTable.conversationId, convId), eq(conversationParticipantsTable.userId, req.userId!)));

  if (!participant) {
    res.status(403).json({ error: "Not a participant" });
    return;
  }

  const before = req.query.before ? parseInt(req.query.before as string, 10) : null;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

  let query = db
    .select()
    .from(messagesTable)
    .where(
      before
        ? and(eq(messagesTable.conversationId, convId), lt(messagesTable.id, before))
        : eq(messagesTable.conversationId, convId)
    )
    .orderBy(desc(messagesTable.createdAt))
    .limit(Math.min(limit, 100));

  const msgs = await query;
  const built = await Promise.all(msgs.reverse().map((m) => buildMessage(m, req.userId)));
  res.json(built);
});

router.post("/conversations/:conversationId/messages", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const convId = parseInt(Array.isArray(req.params.conversationId) ? req.params.conversationId[0] : req.params.conversationId, 10);

  const [participant] = await db
    .select()
    .from(conversationParticipantsTable)
    .where(and(eq(conversationParticipantsTable.conversationId, convId), eq(conversationParticipantsTable.userId, req.userId!)));

  if (!participant) {
    res.status(403).json({ error: "Not a participant" });
    return;
  }

  const { type, content, fileUrl, fileName, fileSize, replyToId } = req.body as {
    type: string;
    content?: string;
    fileUrl?: string;
    fileName?: string;
    fileSize?: number;
    replyToId?: number;
  };

  if (!type) {
    res.status(400).json({ error: "type is required" });
    return;
  }

  const [msg] = await db
    .insert(messagesTable)
    .values({
      conversationId: convId,
      senderId: req.userId!,
      type,
      content: content ?? null,
      fileUrl: fileUrl ?? null,
      fileName: fileName ?? null,
      fileSize: fileSize ?? null,
      replyToId: replyToId ?? null,
    })
    .returning();

  await db
    .update(conversationsTable)
    .set({ lastMessageAt: new Date() })
    .where(eq(conversationsTable.id, convId));

  const built = await buildMessage(msg, req.userId);
  res.status(201).json(built);
});

router.patch("/conversations/:conversationId/messages/:messageId", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const convId = parseInt(Array.isArray(req.params.conversationId) ? req.params.conversationId[0] : req.params.conversationId, 10);
  const msgId = parseInt(Array.isArray(req.params.messageId) ? req.params.messageId[0] : req.params.messageId, 10);
  const { content } = req.body as { content: string };

  if (!content) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  const [msg] = await db.select().from(messagesTable).where(and(eq(messagesTable.id, msgId), eq(messagesTable.conversationId, convId)));
  if (!msg) {
    res.status(404).json({ error: "Message not found" });
    return;
  }
  if (msg.senderId !== req.userId) {
    res.status(403).json({ error: "Cannot edit others' messages" });
    return;
  }

  const [updated] = await db
    .update(messagesTable)
    .set({ content, isEdited: true })
    .where(eq(messagesTable.id, msgId))
    .returning();

  const built = await buildMessage(updated, req.userId);
  res.json(built);
});

router.delete("/conversations/:conversationId/messages/:messageId", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const convId = parseInt(Array.isArray(req.params.conversationId) ? req.params.conversationId[0] : req.params.conversationId, 10);
  const msgId = parseInt(Array.isArray(req.params.messageId) ? req.params.messageId[0] : req.params.messageId, 10);

  const [msg] = await db.select().from(messagesTable).where(and(eq(messagesTable.id, msgId), eq(messagesTable.conversationId, convId)));
  if (!msg) {
    res.status(404).json({ error: "Message not found" });
    return;
  }
  if (msg.senderId !== req.userId) {
    res.status(403).json({ error: "Cannot delete others' messages" });
    return;
  }

  await db.update(messagesTable).set({ isDeleted: true, content: null }).where(eq(messagesTable.id, msgId));
  res.sendStatus(204);
});

router.post("/conversations/:conversationId/read", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const convId = parseInt(Array.isArray(req.params.conversationId) ? req.params.conversationId[0] : req.params.conversationId, 10);

  await db
    .update(conversationParticipantsTable)
    .set({ lastReadAt: new Date() })
    .where(
      and(
        eq(conversationParticipantsTable.conversationId, convId),
        eq(conversationParticipantsTable.userId, req.userId!)
      )
    );

  res.json({ success: true });
});

export { buildMessage };
export default router;
