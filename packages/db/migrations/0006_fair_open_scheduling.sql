CREATE TABLE "fair_open_rungs" (
	"launch_id" uuid NOT NULL,
	"rung" bigint NOT NULL,
	"message" text NOT NULL,
	"mint_signature" text NOT NULL,
	"creator_signature" text,
	"keeper_signature" text,
	CONSTRAINT "fair_open_rungs_launch_id_rung_pk" PRIMARY KEY("launch_id","rung")
);
--> statement-breakpoint
ALTER TABLE "launches" ALTER COLUMN "mint_signature" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "ticker_key" text;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "fair_open" text;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "nonce" text;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "deposits_open_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "opens_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "min_raise" bigint;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "teaser" text;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "ladder" text;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "open_signature" text;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "open_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "open_slot" bigint;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "open_landed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "launches" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fair_open_rungs" ADD CONSTRAINT "fair_open_rungs_launch_id_launches_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."launches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "launches_ticker_reserved" ON "launches" USING btree ("ticker_key") WHERE "launches"."ticker_key" is not null;--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_fair_open_unique" UNIQUE("fair_open");--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_nonce_unique" UNIQUE("nonce");