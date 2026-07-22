ALTER TABLE "chat_identities" ADD COLUMN "signup_token" text;
ALTER TABLE "chat_identities" ADD COLUMN "signup_token_expires_at" timestamp with time zone;
ALTER TABLE "chat_identities" ADD CONSTRAINT "chat_identities_signup_token_unique" UNIQUE("signup_token");
