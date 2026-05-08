import { Router, type IRouter } from "express";
import { db, usersTable, conversationsTable, conversationParticipantsTable, messagesTable, messageSeenTable } from "@workspace/db";
import { eq, and, inArray, desc, sql, count } from "drizzle-orm";
import { requireAuth, type AuthRequest } from "../middlewares/auth";

const router: IRouter = Router();

function publicUser(user: typeof usersTable.$inferSelect) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    avatar: user.avatar,
    bio: user.bio,
    isOnline: user.isOnline,
    lastSeen: user.lastSeen,
    createdAt: user.createdAt,
  };
}

async function buildConversationSummary(convId: number, userId: number) {
  const conv = await db.select().from(conversationsTable).where(eq(conversationsTable.id, convId));
  if (!conv[0]) return null;

  const participants = await db
    .select()
    .from(conversationParticipantsTable)
    .where(eq(conversationParticipantsTable.conversationId, convId));

  const userIds = participants.map((p) => p.userId);
  const users = userIds.length > 0
    ? await db.select().from(usersTable).where(inArray(usersTable.id, userIds))
    : [];

  const [lastMsg] = await db
    .select()
    .from(messagesTable)
    .where(and(eq(messagesTable.conversationId, convId), eq(messagesTable.isDeleted, false)))
    .orderBy(desc(messagesTable.createdAt))
    .limit(1);

  const myParticipant = participants.find((p) => p.userId === userId);
  const lastReadAt = myParticipant?.lastReadAt;

  let unreadCount = 0;
  if (lastReadAt) {
    const [result] = await db
      .select({ count: count() })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.conversationId, convId),
          eq(messagesTable.isDeleted, false),
          sql`${messagesTable.createdAt} > ${lastReadAt}`,
          sql`${messagesTable.senderId} != ${userId}`
        )
      );
    unreadCount = Number(result?.count ?? 0);
  } else {
    const [result] = await db
      .select({ count: count() })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.conversationId, convId),
          eq(messagesTable.isDeleted, false),
          sql`${messagesTable.senderId} != ${userId}`
        )
      );
    unreadCount = Number(result?.count ?? 0);
  }

  let lastMessageText: string | null = null;
  if (lastMsg) {
    if (lastMsg.isDeleted) {
      lastMessageText = "Message deleted";
    } else if (lastMsg.type === "text") {
      lastMessageText = lastMsg.content;
    } else {
      lastMessageText = `[${lastMsg.type}]`;
    }
  }

  return {
    id: conv[0].id,
    type: conv[0].type,
    name: conv[0].name,
    avatar: conv[0].avatar,
    lastMessage: lastMessageText,
    lastMessageAt: conv[0].lastMessageAt,
    unreadCount,
    participants: users.map(publicUser),
    createdAt: conv[0].createdAt,
  };
}

router.get("/conversations", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const myParticipations = await db
    .select()
    .from(conversationParticipantsTable)
    .where(eq(conversationParticipantsTable.userId, req.userId!));

  const convIds = myParticipations.map((p) => p.conversationId);
  if (convIds.length === 0) {
    res.json([]);
    return;
  }

  const convs = await db
    .select()
    .from(conversationsTable)
    .where(inArray(conversationsTable.id, convIds))
    .orderBy(desc(conversationsTable.lastMessageAt));

  const summaries = await Promise.all(convs.map((c) => buildConversationSummary(c.id, req.userId!)));
  res.json(summaries.filter(Boolean));
});

router.post("/conversations", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const { type, participantIds, name, avatar } = req.body as {
    type: string;
    participantIds: number[];
    name?: string;
    avatar?: string;
  };

  if (!type || !participantIds || !Array.isArray(participantIds)) {
    res.status(400).json({ error: "type and participantIds required" });
    return;
  }

  const allParticipantIds = Array.from(new Set([req.userId!, ...participantIds]));

  if (type === "direct") {
    const other = participantIds.find((id) => id !== req.userId);
    if (!other) {
      res.status(400).json({ error: "Direct conversation needs another user" });
      return;
    }

    const existing = await db
      .select()
      .from(conversationParticipantsTable)
      .where(eq(conversationParticipantsTable.userId, req.userId!));

    for (const participation of existing) {
      const conv = await db
        .select()
        .from(conversationsTable)
        .where(and(eq(conversationsTable.id, participation.conversationId), eq(conversationsTable.type, "direct")));
      if (!conv[0]) continue;

      const otherParticipant = await db
        .select()
        .from(conversationParticipantsTable)
        .where(
          and(
            eq(conversationParticipantsTable.conversationId, conv[0].id),
            eq(conversationParticipantsTable.userId, other)
          )
        );

      if (otherParticipant.length > 0) {
        const summary = await buildConversationSummary(conv[0].id, req.userId!);
        res.status(200).json(summary);
        return;
      }
    }
  }

  const [conv] = await db
    .insert(conversationsTable)
    .values({ type, name: name ?? null, avatar: avatar ?? null, createdById: req.userId! })
    .returning();

  await db.insert(conversationParticipantsTable).values(
    allParticipantIds.map((uid) => ({ conversationId: conv.id, userId: uid }))
  );

  const summary = await buildConversationSummary(conv.id, req.userId!);
  res.status(201).json(summary);
});

router.get("/conversations/:conversationId", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const convId = parseInt(Array.isArray(req.params.conversationId) ? req.params.conversationId[0] : req.params.conversationId, 10);

  const [participant] = await db
    .select()
    .from(conversationParticipantsTable)
    .where(
      and(
        eq(conversationParticipantsTable.conversationId, convId),
        eq(conversationParticipantsTable.userId, req.userId!)
      )
    );

  if (!participant) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  const summary = await buildConversationSummary(convId, req.userId!);
  if (!summary) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  res.json(summary);
});

router.patch("/conversations/:conversationId", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const convId = parseInt(Array.isArray(req.params.conversationId) ? req.params.conversationId[0] : req.params.conversationId, 10);
  const { name, avatar } = req.body as { name?: string; avatar?: string };

  const [participant] = await db
    .select()
    .from(conversationParticipantsTable)
    .where(
      and(
        eq(conversationParticipantsTable.conversationId, convId),
        eq(conversationParticipantsTable.userId, req.userId!)
      )
    );

  if (!participant) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  const updates: Partial<typeof conversationsTable.$inferInsert> = {};
  if (name != null) updates.name = name;
  if (avatar != null) updates.avatar = avatar;

  await db.update(conversationsTable).set(updates).where(eq(conversationsTable.id, convId));
  const summary = await buildConversationSummary(convId, req.userId!);
  res.json(summary);
});

export { buildConversationSummary, publicUser };
export default router;
