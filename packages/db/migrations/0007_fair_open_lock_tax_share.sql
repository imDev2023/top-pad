ALTER TABLE "fair_opens" ADD COLUMN "seats" integer;--> statement-breakpoint
ALTER TABLE "fair_opens" ADD COLUMN "lock_escrow" text;--> statement-breakpoint
ALTER TABLE "fair_opens" ADD COLUMN "lock_coins" bigint;--> statement-breakpoint
ALTER TABLE "fair_opens" ADD COLUMN "lock_cliff_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fair_opens" ADD COLUMN "lock_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fair_opens" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fair_opens" ADD COLUMN "lock_signature" text;--> statement-breakpoint
ALTER TABLE "fair_opens" ADD COLUMN "tax_share" bigint;--> statement-breakpoint
ALTER TABLE "fair_opens" ADD COLUMN "tax_share_fees" bigint;--> statement-breakpoint
ALTER TABLE "fair_opens" ADD COLUMN "tax_share_dust" bigint;--> statement-breakpoint
ALTER TABLE "fair_opens" ADD COLUMN "tax_share_basis" bigint;--> statement-breakpoint
ALTER TABLE "fair_opens" ADD COLUMN "tax_share_to_treasury" boolean;--> statement-breakpoint
ALTER TABLE "fair_opens" ADD COLUMN "tax_share_collected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fair_opens" ADD COLUMN "tax_share_signature" text;--> statement-breakpoint
ALTER TABLE "fair_opens" ADD COLUMN "closed_at" timestamp with time zone;