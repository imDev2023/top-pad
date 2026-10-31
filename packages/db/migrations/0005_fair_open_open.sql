ALTER TABLE "fair_open_seat_events" ADD COLUMN "spent" bigint;--> statement-breakpoint
ALTER TABLE "fair_open_seat_events" ADD COLUMN "coins" bigint;--> statement-breakpoint
ALTER TABLE "fair_opens" ADD COLUMN "mint" text;--> statement-breakpoint
ALTER TABLE "fair_opens" ADD COLUMN "pool" text;--> statement-breakpoint
ALTER TABLE "fair_opens" ADD COLUMN "spent" bigint;--> statement-breakpoint
ALTER TABLE "fair_opens" ADD COLUMN "coins" bigint;--> statement-breakpoint
ALTER TABLE "fair_opens" ADD COLUMN "opened_signature" text;--> statement-breakpoint
ALTER TABLE "fair_opens" ADD COLUMN "opened_at" timestamp with time zone;