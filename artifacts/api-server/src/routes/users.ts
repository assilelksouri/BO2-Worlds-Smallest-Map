import { Router, type IRouter } from "express";
import { db, usersTable } from "@workspace/db";
import { eq, ilike, or, ne } from "drizzle-orm";
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

router.get("/users/search", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) {
    res.json([]);
    return;
  }
  const users = await db
    .select()
    .from(usersTable)
    .where(
      or(
        ilike(usersTable.username, `%${q}%`),
        ilike(usersTable.email, `%${q}%`)
      )
    )
    .limit(20);

  const filtered = users.filter((u) => u.id !== req.userId);
  res.json(filtered.map(publicUser));
});

router.patch("/users/me", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const { username, bio, avatar } = req.body as { username?: string; bio?: string; avatar?: string };
  const updates: Partial<typeof usersTable.$inferInsert> = {};
  if (username != null) updates.username = username;
  if (bio != null) updates.bio = bio;
  if (avatar != null) updates.avatar = avatar;

  const [user] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, req.userId!))
    .returning();

  res.json(publicUser(user));
});

router.get("/users/:userId", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const raw = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const userId = parseInt(raw, 10);
  if (isNaN(userId)) {
    res.status(400).json({ error: "Invalid user ID" });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json(publicUser(user));
});

export default router;
