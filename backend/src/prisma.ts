import { PrismaClient } from "@prisma/client";

/**
 * Shared Prisma client singleton.
 * Reused across the whole backend so connections are pooled once.
 */
const prisma = new PrismaClient();

export { prisma };
export default prisma;
