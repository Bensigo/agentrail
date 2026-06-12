ALTER TABLE "memory_items" ADD COLUMN "repository_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;
