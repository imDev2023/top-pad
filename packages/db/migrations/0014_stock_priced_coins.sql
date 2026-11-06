-- Stock-priced coins (ADR 0007, #90): each launch and pool names the quote it is priced in, and each pool its config's
-- Graduation Target and starting price. Every row before this was on Heat's SOL configs, the only ones the launch service
-- used or the indexer watched, and only devnet has any (mainnet has no configs yet), so the rows are filled with SOL and
-- devnet's SOL pair's target and curve A start (`CLUSTERS.devnet`); a pool on any other config stops the migration.
ALTER TABLE "launches" ADD COLUMN "quote_mint" text;--> statement-breakpoint
UPDATE "launches" SET "quote_mint" = 'So11111111111111111111111111111111111111112';--> statement-breakpoint
ALTER TABLE "launches" ALTER COLUMN "quote_mint" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "quote_mint" text;--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "graduation_target" bigint;--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "start_sqrt_price" numeric(40, 0);--> statement-breakpoint
UPDATE "pools" SET "quote_mint" = 'So11111111111111111111111111111111111111112', "graduation_target" = 8500000000, "start_sqrt_price" = 35525023424642174
  WHERE "config" IN ('rPqMj6mwJp9qnZBMeawF8s2iC74EkhpbUSvhWd9XTnC', 'CMSi1oRQsZJbogjxajFCuGYze3NW9oieuKNrxGPjg8Mi');--> statement-breakpoint
ALTER TABLE "pools" ALTER COLUMN "quote_mint" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pools" ALTER COLUMN "graduation_target" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pools" ALTER COLUMN "start_sqrt_price" SET NOT NULL;
