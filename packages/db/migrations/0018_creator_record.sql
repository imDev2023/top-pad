CREATE TABLE "pool_creator_transfers" (
	"signature" text NOT NULL,
	"event_index" integer NOT NULL,
	"slot" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"pool" text NOT NULL,
	"from_wallet" text NOT NULL,
	"to_wallet" text NOT NULL,
	CONSTRAINT "pool_creator_transfers_signature_event_index_pk" PRIMARY KEY("signature","event_index")
);
--> statement-breakpoint
CREATE TABLE "wallet_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"from_wallet" text NOT NULL,
	"to_wallet" text NOT NULL,
	"message" text NOT NULL,
	"from_signature" text,
	"to_signature" text,
	"x_user_id" text,
	"x_handle" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"effective_at" timestamp with time zone,
	"cancel_message" text,
	"cancel_signature" text,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "creator_wallets" ADD COLUMN "change_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "x_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wallet_sign_ins" ADD COLUMN "purpose" text DEFAULT 'sign_in' NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_changes" ADD CONSTRAINT "wallet_changes_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pool_creator_transfers_pool_idx" ON "pool_creator_transfers" USING btree ("pool","slot");--> statement-breakpoint
CREATE INDEX "pool_creator_transfers_to_idx" ON "pool_creator_transfers" USING btree ("to_wallet");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_changes_pending_per_creator" ON "wallet_changes" USING btree ("creator_id") WHERE "wallet_changes"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "wallet_changes_creator_idx" ON "wallet_changes" USING btree ("creator_id","requested_at");--> statement-breakpoint
CREATE INDEX "wallet_changes_to_idx" ON "wallet_changes" USING btree ("to_wallet","status");--> statement-breakpoint
ALTER TABLE "creator_wallets" ADD CONSTRAINT "creator_wallets_change_id_wallet_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."wallet_changes"("id") ON DELETE no action ON UPDATE no action;