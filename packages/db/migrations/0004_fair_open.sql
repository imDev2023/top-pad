CREATE TABLE "admissions" (
	"launch" text NOT NULL,
	"wallet" text NOT NULL,
	"cluster" text NOT NULL,
	"pseudonym" text NOT NULL,
	"tier" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admissions_launch_wallet_pk" PRIMARY KEY("launch","wallet")
);
--> statement-breakpoint
CREATE TABLE "fair_open_seat_events" (
	"signature" text NOT NULL,
	"event_index" integer NOT NULL,
	"slot" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"launch" text NOT NULL,
	"wallet" text NOT NULL,
	"person" text NOT NULL,
	"kind" text NOT NULL,
	"tier" text,
	"amount" bigint NOT NULL,
	"deposit" bigint NOT NULL,
	"rent" bigint,
	CONSTRAINT "fair_open_seat_events_signature_event_index_pk" PRIMARY KEY("signature","event_index")
);
--> statement-breakpoint
CREATE TABLE "fair_opens" (
	"launch" text PRIMARY KEY NOT NULL,
	"creator" text NOT NULL,
	"nonce" text NOT NULL,
	"dbc_config" text NOT NULL,
	"quote_mint" text NOT NULL,
	"identity_hash" text NOT NULL,
	"deposits_open_at" timestamp with time zone NOT NULL,
	"opens_at" timestamp with time zone NOT NULL,
	"min_raise" bigint NOT NULL,
	"pot_cap" bigint NOT NULL,
	"lowest_rung" bigint NOT NULL,
	"step" bigint NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"failure" text,
	"failed_at" timestamp with time zone,
	"teaser" text,
	"created_signature" text NOT NULL,
	"created_slot" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fair_opens_nonce_unique" UNIQUE("nonce")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_launch_cluster" ON "admissions" USING btree ("launch","cluster");--> statement-breakpoint
CREATE INDEX "fair_open_seat_events_launch_idx" ON "fair_open_seat_events" USING btree ("launch","slot");--> statement-breakpoint
CREATE INDEX "fair_open_seat_events_wallet_idx" ON "fair_open_seat_events" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "fair_opens_opens_at_idx" ON "fair_opens" USING btree ("opens_at");--> statement-breakpoint
CREATE INDEX "fair_opens_creator_idx" ON "fair_opens" USING btree ("creator");