-- CreateEnum
CREATE TYPE "CustomerAccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'FROZEN');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('SUCCESS', 'FAILED_AT_BANK', 'PENDING_CLEARING', 'REVERSED');

-- CreateEnum
CREATE TYPE "ActionStepPolicyStatus" AS ENUM ('ALLOWED', 'BLOCKED', 'REQUIRES_HUMAN');

-- CreateEnum
CREATE TYPE "ActionExecutionStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "SessionOutcomeStatus" AS ENUM ('IN_PROGRESS', 'VERIFIED_SUCCESS', 'VERIFIED_FAILURE', 'ESCALATED');

-- CreateEnum
CREATE TYPE "HumanReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'MODIFIED');

-- CreateEnum
CREATE TYPE "AuditStage" AS ENUM ('INTAKE', 'CONTEXT_GATHERED', 'PLAN_PROPOSED', 'POLICY_EVALUATED', 'TOOL_EXECUTED', 'HUMAN_DECIDED', 'OUTCOME_VERIFIED', 'STATE_TRANSITION');

-- CreateTable
CREATE TABLE "synthetic_customers" (
    "customer_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "account_status" "CustomerAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "synthetic_balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "synthetic_customers_pkey" PRIMARY KEY ("customer_id")
);

-- CreateTable
CREATE TABLE "synthetic_transactions" (
    "transaction_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "biller_or_merchant" TEXT NOT NULL,
    "status" "TransactionStatus" NOT NULL,
    "failure_reason" TEXT,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "synthetic_transactions_pkey" PRIMARY KEY ("transaction_id")
);

-- CreateTable
CREATE TABLE "resolution_sessions" (
    "session_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "target_transaction_id" TEXT,
    "stated_objective" TEXT NOT NULL,
    "current_state" TEXT NOT NULL,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "max_retries" INTEGER NOT NULL DEFAULT 2,
    "outcome_status" "SessionOutcomeStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resolution_sessions_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "action_steps" (
    "step_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "tool_params" JSONB NOT NULL,
    "policy_verdict" "ActionStepPolicyStatus" NOT NULL,
    "policy_rule_triggered" TEXT,
    "execution_status" "ActionExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "execution_result" JSONB,
    "error_message" TEXT,
    "executed_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_steps_pkey" PRIMARY KEY ("step_id")
);

-- CreateTable
CREATE TABLE "audit_log_entries" (
    "id" BIGSERIAL NOT NULL,
    "session_id" TEXT NOT NULL,
    "stage" "AuditStage" NOT NULL,
    "decision_summary" TEXT,
    "context_references" JSONB,
    "details" JSONB NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "human_reviews" (
    "review_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "step_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "proposed_tool" TEXT NOT NULL,
    "proposed_params" JSONB NOT NULL,
    "status" "HumanReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewer_notes" TEXT,
    "resolved_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "human_reviews_pkey" PRIMARY KEY ("review_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "synthetic_transactions_idempotency_key_key" ON "synthetic_transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "synthetic_transactions_customer_id_idx" ON "synthetic_transactions"("customer_id");

-- CreateIndex
CREATE INDEX "synthetic_transactions_status_idx" ON "synthetic_transactions"("status");

-- CreateIndex
CREATE INDEX "resolution_sessions_customer_id_idx" ON "resolution_sessions"("customer_id");

-- CreateIndex
CREATE INDEX "resolution_sessions_target_transaction_id_idx" ON "resolution_sessions"("target_transaction_id");

-- CreateIndex
CREATE INDEX "resolution_sessions_outcome_status_idx" ON "resolution_sessions"("outcome_status");

-- CreateIndex
CREATE INDEX "action_steps_session_id_idx" ON "action_steps"("session_id");

-- CreateIndex
CREATE INDEX "action_steps_tool_name_idx" ON "action_steps"("tool_name");

-- CreateIndex
CREATE INDEX "action_steps_execution_status_idx" ON "action_steps"("execution_status");

-- CreateIndex
CREATE INDEX "audit_log_entries_session_id_idx" ON "audit_log_entries"("session_id");

-- CreateIndex
CREATE INDEX "audit_log_entries_stage_idx" ON "audit_log_entries"("stage");

-- CreateIndex
CREATE INDEX "audit_log_entries_timestamp_idx" ON "audit_log_entries"("timestamp");

-- CreateIndex
CREATE INDEX "human_reviews_session_id_idx" ON "human_reviews"("session_id");

-- CreateIndex
CREATE INDEX "human_reviews_step_id_idx" ON "human_reviews"("step_id");

-- CreateIndex
CREATE INDEX "human_reviews_status_idx" ON "human_reviews"("status");

-- AddForeignKey
ALTER TABLE "synthetic_transactions" ADD CONSTRAINT "synthetic_transactions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "synthetic_customers"("customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resolution_sessions" ADD CONSTRAINT "resolution_sessions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "synthetic_customers"("customer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_steps" ADD CONSTRAINT "action_steps_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "resolution_sessions"("session_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log_entries" ADD CONSTRAINT "audit_log_entries_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "resolution_sessions"("session_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_reviews" ADD CONSTRAINT "human_reviews_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "resolution_sessions"("session_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_reviews" ADD CONSTRAINT "human_reviews_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "action_steps"("step_id") ON DELETE CASCADE ON UPDATE CASCADE;
