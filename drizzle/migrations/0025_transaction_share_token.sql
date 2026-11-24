ALTER TABLE "transactions" ADD COLUMN "share_token" text;
--> statement-breakpoint
CREATE INDEX ASYNC "transactions_share_token_idx" ON "transactions"("share_token");
