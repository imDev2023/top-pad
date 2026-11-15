CREATE TABLE "cohort_members" (
	"creator_id" uuid PRIMARY KEY NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cohort_taps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"x_user_id" text NOT NULL,
	"x_handle" text NOT NULL,
	"wallet" text NOT NULL,
	"lamports" bigint NOT NULL,
	"signature" text NOT NULL,
	"last_valid_block_height" bigint NOT NULL,
	"status" text DEFAULT 'sending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "cohort_taps_signature_unique" UNIQUE("signature")
);
--> statement-breakpoint
ALTER TABLE "cohort_members" ADD CONSTRAINT "cohort_members_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cohort_taps" ADD CONSTRAINT "cohort_taps_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cohort_taps_once_per_creator" ON "cohort_taps" USING btree ("creator_id") WHERE "cohort_taps"."status" <> 'failed';--> statement-breakpoint
CREATE UNIQUE INDEX "cohort_taps_once_per_x" ON "cohort_taps" USING btree ("x_user_id") WHERE "cohort_taps"."status" <> 'failed';--> statement-breakpoint
CREATE UNIQUE INDEX "cohort_taps_once_per_wallet" ON "cohort_taps" USING btree ("wallet") WHERE "cohort_taps"."status" <> 'failed';--> statement-breakpoint
-- The operator app's Cohort page (spec 11.3, #63) reads the members, the tap's claims, and the Fair Opens members
-- scheduled with their seats and admissions, to work out the cohort's measures; it writes none of them.
GRANT SELECT ON "cohort_members", "cohort_taps", "fair_opens", "fair_open_seat_events", "admissions" TO "heat_operator";
