CREATE TABLE "coins" (
	"mint" text PRIMARY KEY NOT NULL,
	"pool" text NOT NULL,
	"config" text NOT NULL,
	"launch_mode" text NOT NULL,
	"launch_id" uuid,
	"creator_id" uuid,
	"creator_wallet" text NOT NULL,
	"name" text NOT NULL,
	"ticker" text NOT NULL,
	"metadata_uri" text NOT NULL,
	"image_uri" text NOT NULL,
	"created_signature" text NOT NULL,
	"created_slot" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "coins_pool_unique" UNIQUE("pool"),
	CONSTRAINT "coins_created_signature_unique" UNIQUE("created_signature")
);
--> statement-breakpoint
CREATE TABLE "creator_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"wallet" text NOT NULL,
	"via" text NOT NULL,
	"proof" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "creators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"x_user_id" text NOT NULL,
	"x_handle" text NOT NULL,
	"x_name" text NOT NULL,
	"x_avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creators_x_user_id_unique" UNIQUE("x_user_id")
);
--> statement-breakpoint
CREATE TABLE "launches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"wallet" text NOT NULL,
	"mode" text NOT NULL,
	"name" text NOT NULL,
	"ticker" text NOT NULL,
	"mint" text NOT NULL,
	"pool" text NOT NULL,
	"config" text NOT NULL,
	"metadata_uri" text NOT NULL,
	"image_uri" text NOT NULL,
	"message" text NOT NULL,
	"mint_signature" text NOT NULL,
	"last_valid_block_height" bigint NOT NULL,
	"status" text DEFAULT 'prepared' NOT NULL,
	"signature" text,
	"slot" bigint,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"landed_at" timestamp with time zone,
	CONSTRAINT "launches_mint_unique" UNIQUE("mint"),
	CONSTRAINT "launches_pool_unique" UNIQUE("pool"),
	CONSTRAINT "launches_signature_unique" UNIQUE("signature")
);
--> statement-breakpoint
CREATE TABLE "metadata_items" (
	"launch_id" uuid NOT NULL,
	"item" text NOT NULL,
	"arweave_id" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_at" timestamp with time zone,
	"receipt" jsonb,
	CONSTRAINT "metadata_items_launch_id_item_pk" PRIMARY KEY("launch_id","item"),
	CONSTRAINT "metadata_items_arweave_id_unique" UNIQUE("arweave_id")
);
--> statement-breakpoint
CREATE TABLE "protected_coins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mint" text NOT NULL,
	"ticker" text NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"ticker_strict" text NOT NULL,
	"ticker_loose" text NOT NULL,
	"ticker_core" text NOT NULL,
	"name_strict" text NOT NULL,
	"name_loose" text NOT NULL,
	"name_core" text NOT NULL,
	"fold_version" text NOT NULL,
	"protected_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"creator_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "x_authorizations" (
	"state" text PRIMARY KEY NOT NULL,
	"code_verifier" text NOT NULL,
	"return_to" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coins" ADD CONSTRAINT "coins_launch_id_launches_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."launches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coins" ADD CONSTRAINT "coins_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_wallets" ADD CONSTRAINT "creator_wallets_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metadata_items" ADD CONSTRAINT "metadata_items_launch_id_launches_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."launches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coins_creator_idx" ON "coins" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "coins_created_idx" ON "coins" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "creator_wallets_current_per_creator" ON "creator_wallets" USING btree ("creator_id") WHERE "creator_wallets"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "creator_wallets_current_per_wallet" ON "creator_wallets" USING btree ("wallet") WHERE "creator_wallets"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "launches_creator_created_idx" ON "launches" USING btree ("creator_id","created_at");--> statement-breakpoint
CREATE INDEX "launches_status_idx" ON "launches" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "protected_coins_mint_source" ON "protected_coins" USING btree ("mint","source");--> statement-breakpoint
CREATE INDEX "protected_coins_ticker_strict" ON "protected_coins" USING btree ("ticker_strict");--> statement-breakpoint
CREATE INDEX "protected_coins_ticker_loose" ON "protected_coins" USING btree ("ticker_loose");--> statement-breakpoint
CREATE INDEX "protected_coins_ticker_core" ON "protected_coins" USING btree ("ticker_core");--> statement-breakpoint
CREATE INDEX "protected_coins_name_strict" ON "protected_coins" USING btree ("name_strict");--> statement-breakpoint
CREATE INDEX "protected_coins_name_loose" ON "protected_coins" USING btree ("name_loose");--> statement-breakpoint
CREATE INDEX "protected_coins_name_core" ON "protected_coins" USING btree ("name_core");--> statement-breakpoint
CREATE INDEX "sessions_creator_idx" ON "sessions" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");