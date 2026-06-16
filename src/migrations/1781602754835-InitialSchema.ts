import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1781602754835 implements MigrationInterface {
    name = 'InitialSchema1781602754835'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "addresses" ("id" SERIAL NOT NULL, "street" character varying NOT NULL, "city" character varying NOT NULL, "country" character varying NOT NULL, "zip_code" character varying NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "user_id" integer, CONSTRAINT "PK_745d8f43d3af10ab8247465e450" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."user_tokens_type_enum" AS ENUM('VERIFICATION', 'EMAIL_VERIFICATION', 'PASSWORD_RESET', 'REFRESH')`);
        await queryRunner.query(`CREATE TABLE "user_tokens" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "type" "public"."user_tokens_type_enum" NOT NULL, "token" text NOT NULL, "expires_at" TIMESTAMP NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "user_id" integer, CONSTRAINT "PK_63764db9d9aaa4af33e07b2f4bf" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "services" ("id" SERIAL NOT NULL, "name" character varying NOT NULL, "description" text, "price" numeric(10,2), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_019d74f7abcdcb5a0113010cb03" UNIQUE ("name"), CONSTRAINT "PK_ba2d347a3168a296416c6c5ccb2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "artisan_profiles" ("id" SERIAL NOT NULL, "bio" text, "experience_years" integer, "hourly_rate" numeric(10,2), "business_name" character varying, "average_rating" numeric(3,2) NOT NULL DEFAULT '0', "total_reviews" integer NOT NULL DEFAULT '0', "availability_status" character varying NOT NULL DEFAULT 'AVAILABLE', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "user_id" integer, CONSTRAINT "REL_d4d2377166f887da2fdc311172" UNIQUE ("user_id"), CONSTRAINT "CHK_8cf2816fdb1fcb5ca1e64b4849" CHECK ("bio" IS NULL OR char_length("bio") <= 1000), CONSTRAINT "CHK_6a0d4f80eb7c96f6edae69ede8" CHECK ("hourly_rate" IS NULL OR "hourly_rate" > 0), CONSTRAINT "CHK_7f9274f3541ddf9a2e2a2ed360" CHECK ("experience_years" IS NULL OR "experience_years" > 0), CONSTRAINT "PK_d5c6ed3f0791f7c4c3c8f954638" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "customer_profiles" ("id" SERIAL NOT NULL, "bio" text, "budget_min" numeric(10,2), "budget_max" numeric(10,2), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "user_id" integer, CONSTRAINT "REL_99617dd6d452ad43dd992a7993" UNIQUE ("user_id"), CONSTRAINT "CHK_3e6ad7f62cc6d4725128c6780d" CHECK ("budget_min" IS NULL OR "budget_max" IS NULL OR "budget_max" >= "budget_min"), CONSTRAINT "CHK_89cb8d7777f7ff409ed2b504d5" CHECK ("budget_max" IS NULL OR "budget_max" > 0), CONSTRAINT "CHK_4821e7c75cec6b6cf688dc1222" CHECK ("budget_min" IS NULL OR "budget_min" > 0), CONSTRAINT "CHK_c1606aadb1555b637f709cfbe0" CHECK ("bio" IS NULL OR char_length("bio") <= 1000), CONSTRAINT "PK_ece08ee55cbe707d9f870907727" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."users_gender_enum" AS ENUM('MALE', 'FEMALE', 'OTHER')`);
        await queryRunner.query(`CREATE TYPE "public"."users_role_enum" AS ENUM('CUSTOMER', 'ADMIN', 'ARTISAN')`);
        await queryRunner.query(`CREATE TABLE "users" ("id" SERIAL NOT NULL, "email" character varying NOT NULL, "password" character varying NOT NULL, "username" character varying, "date_of_birth" date, "firstname" character varying NOT NULL, "lastname" character varying NOT NULL, "phone_number" character varying, "verified_at" TIMESTAMP, "account_verified" boolean, "gender" "public"."users_gender_enum" NOT NULL, "role" "public"."users_role_enum" NOT NULL DEFAULT 'CUSTOMER', "profile_picture" character varying, "social_provider" character varying, "social_provider_id" character varying, "is_social_login" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP, CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "UQ_17d1817f241f10a3dbafb169fd2" UNIQUE ("phone_number"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_97672ac88f789774dd47f7c8be" ON "users" ("email") `);
        await queryRunner.query(`CREATE TABLE "reviews" ("id" SERIAL NOT NULL, "reviewer_name" character varying, "rating" numeric(3,2) NOT NULL, "review" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "artisan_profile_id" integer, "reviewer_user_id" integer, "reviewed_user_id" integer, CONSTRAINT "PK_231ae565c273ee700b283f15c1d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."jobs_status_enum" AS ENUM('OPEN', 'PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXPIRED')`);
        await queryRunner.query(`CREATE TABLE "jobs" ("id" SERIAL NOT NULL, "description" text, "title" text, "budget_min" numeric(10,2), "budget_max" numeric(10,2), "location" character varying NOT NULL, "latitude" numeric(10,2), "longitude" numeric(10,2), "status" "public"."jobs_status_enum" NOT NULL DEFAULT 'OPEN', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP, "customer_id" integer NOT NULL, "service_id" integer NOT NULL, CONSTRAINT "PK_cf0a6c42b72fcc7f7c237def345" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "artisan_profile_services" ("artisan_profile_id" integer NOT NULL, "service_id" integer NOT NULL, CONSTRAINT "PK_0e0e76e22fc551c4d2a454c549f" PRIMARY KEY ("artisan_profile_id", "service_id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_32de3a0b87ac6fa92348b9b236" ON "artisan_profile_services" ("artisan_profile_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_75c3b884cefc98727f4aa027b9" ON "artisan_profile_services" ("service_id") `);
        await queryRunner.query(`CREATE TABLE "customer_profile_services" ("customer_profile_id" integer NOT NULL, "service_id" integer NOT NULL, CONSTRAINT "PK_30885015e40e99c6383c1ba5275" PRIMARY KEY ("customer_profile_id", "service_id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_f750231fb7d29e06cc3541a1fd" ON "customer_profile_services" ("customer_profile_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_053ddede9b1bf641ec82890f6b" ON "customer_profile_services" ("service_id") `);
        await queryRunner.query(`ALTER TABLE "addresses" ADD CONSTRAINT "FK_16aac8a9f6f9c1dd6bcb75ec023" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "user_tokens" ADD CONSTRAINT "FK_9e144a67be49e5bba91195ef5de" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "artisan_profiles" ADD CONSTRAINT "FK_d4d2377166f887da2fdc311172f" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "customer_profiles" ADD CONSTRAINT "FK_99617dd6d452ad43dd992a79933" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "reviews" ADD CONSTRAINT "FK_2d7320a4a1ad754b64c5f68ceae" FOREIGN KEY ("artisan_profile_id") REFERENCES "artisan_profiles"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "reviews" ADD CONSTRAINT "FK_a012538eb1c025bb46222968b90" FOREIGN KEY ("reviewer_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "reviews" ADD CONSTRAINT "FK_f46ea67dc2809872299d3a6f807" FOREIGN KEY ("reviewed_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD CONSTRAINT "FK_61855f3e378cc40ce4144d045b5" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD CONSTRAINT "FK_215cf9407123d1196319160205f" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "artisan_profile_services" ADD CONSTRAINT "FK_32de3a0b87ac6fa92348b9b2369" FOREIGN KEY ("artisan_profile_id") REFERENCES "artisan_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE "artisan_profile_services" ADD CONSTRAINT "FK_75c3b884cefc98727f4aa027b9b" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE "customer_profile_services" ADD CONSTRAINT "FK_f750231fb7d29e06cc3541a1fdb" FOREIGN KEY ("customer_profile_id") REFERENCES "customer_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
        await queryRunner.query(`ALTER TABLE "customer_profile_services" ADD CONSTRAINT "FK_053ddede9b1bf641ec82890f6ba" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "customer_profile_services" DROP CONSTRAINT "FK_053ddede9b1bf641ec82890f6ba"`);
        await queryRunner.query(`ALTER TABLE "customer_profile_services" DROP CONSTRAINT "FK_f750231fb7d29e06cc3541a1fdb"`);
        await queryRunner.query(`ALTER TABLE "artisan_profile_services" DROP CONSTRAINT "FK_75c3b884cefc98727f4aa027b9b"`);
        await queryRunner.query(`ALTER TABLE "artisan_profile_services" DROP CONSTRAINT "FK_32de3a0b87ac6fa92348b9b2369"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP CONSTRAINT "FK_215cf9407123d1196319160205f"`);
        await queryRunner.query(`ALTER TABLE "jobs" DROP CONSTRAINT "FK_61855f3e378cc40ce4144d045b5"`);
        await queryRunner.query(`ALTER TABLE "reviews" DROP CONSTRAINT "FK_f46ea67dc2809872299d3a6f807"`);
        await queryRunner.query(`ALTER TABLE "reviews" DROP CONSTRAINT "FK_a012538eb1c025bb46222968b90"`);
        await queryRunner.query(`ALTER TABLE "reviews" DROP CONSTRAINT "FK_2d7320a4a1ad754b64c5f68ceae"`);
        await queryRunner.query(`ALTER TABLE "customer_profiles" DROP CONSTRAINT "FK_99617dd6d452ad43dd992a79933"`);
        await queryRunner.query(`ALTER TABLE "artisan_profiles" DROP CONSTRAINT "FK_d4d2377166f887da2fdc311172f"`);
        await queryRunner.query(`ALTER TABLE "user_tokens" DROP CONSTRAINT "FK_9e144a67be49e5bba91195ef5de"`);
        await queryRunner.query(`ALTER TABLE "addresses" DROP CONSTRAINT "FK_16aac8a9f6f9c1dd6bcb75ec023"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_053ddede9b1bf641ec82890f6b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f750231fb7d29e06cc3541a1fd"`);
        await queryRunner.query(`DROP TABLE "customer_profile_services"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_75c3b884cefc98727f4aa027b9"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_32de3a0b87ac6fa92348b9b236"`);
        await queryRunner.query(`DROP TABLE "artisan_profile_services"`);
        await queryRunner.query(`DROP TABLE "jobs"`);
        await queryRunner.query(`DROP TYPE "public"."jobs_status_enum"`);
        await queryRunner.query(`DROP TABLE "reviews"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_97672ac88f789774dd47f7c8be"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP TYPE "public"."users_role_enum"`);
        await queryRunner.query(`DROP TYPE "public"."users_gender_enum"`);
        await queryRunner.query(`DROP TABLE "customer_profiles"`);
        await queryRunner.query(`DROP TABLE "artisan_profiles"`);
        await queryRunner.query(`DROP TABLE "services"`);
        await queryRunner.query(`DROP TABLE "user_tokens"`);
        await queryRunner.query(`DROP TYPE "public"."user_tokens_type_enum"`);
        await queryRunner.query(`DROP TABLE "addresses"`);
    }

}
