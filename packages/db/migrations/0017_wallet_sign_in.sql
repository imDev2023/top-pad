CREATE TABLE "wallet_sign_ins" (
	"nonce" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"message" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creators" ALTER COLUMN "x_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "creators" ALTER COLUMN "x_handle" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "creators" ALTER COLUMN "x_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "creator_wallets" ADD COLUMN "proof_message" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "wallet" text;--> statement-breakpoint
CREATE INDEX "wallet_sign_ins_expires_idx" ON "wallet_sign_ins" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "creators" ADD CONSTRAINT "creators_x_all_or_none" CHECK (("creators"."x_user_id" is null) = ("creators"."x_handle" is null) and ("creators"."x_user_id" is null) = ("creators"."x_name" is null));