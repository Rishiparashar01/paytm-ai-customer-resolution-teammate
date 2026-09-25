import { prisma } from "../prisma";

/**
 * Synthetic customer service — in-memory helpers + DB reads.
 */
export async function getCustomer(customerId: string) {
  return prisma.syntheticCustomer.findUnique({ where: { customerId } });
}

export async function createCustomer(data: {
  customerId: string;
  name: string;
  phone: string;
  accountStatus: "ACTIVE" | "SUSPENDED" | "FROZEN";
  syntheticBalance: number;
}) {
  return prisma.syntheticCustomer.create({ data });
}

const customerService = { getCustomer, createCustomer };
export default customerService;
