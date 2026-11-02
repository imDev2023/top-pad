ALTER TABLE "protected_images" ADD COLUMN "tried_at" timestamp with time zone;--> statement-breakpoint
-- Pictures that failed three times before a second IPFS gateway and the daily retry existed, for passing reasons (most
-- of them ipfs.io's denylist with Pinata's gateway rate-limiting the batch): back in the queue.
UPDATE "protected_images" SET "status" = 'pending', "attempts" = 0 WHERE "status" = 'failed' AND "error" !~ '(SVG|not a PNG|larger than|malformed|not supported|control characters)';
