import { DataSource } from 'typeorm';
import { config } from 'dotenv';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';

config();

const ds = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  username: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  synchronize: false,
  namingStrategy: new SnakeNamingStrategy(),
});

async function fix() {
  await ds.initialize();
  console.log('✔  Connected');

  // Remove stale migration record so TypeORM will re-run it
  await ds.query(`DELETE FROM migrations WHERE name = 'CreateMessages1782100000000'`);
  console.log('✔  Removed stale migration record');

  // Re-create conversations table
  await ds.query(`
    CREATE TABLE IF NOT EXISTS "conversations" (
      "id"               SERIAL    NOT NULL,
      "participant_a_id" integer   NOT NULL,
      "participant_b_id" integer   NOT NULL,
      "last_message_at"  TIMESTAMP,
      "created_at"       TIMESTAMP NOT NULL DEFAULT now(),
      CONSTRAINT "PK_conversations" PRIMARY KEY ("id"),
      CONSTRAINT "UQ_conversations_participants" UNIQUE ("participant_a_id","participant_b_id")
    )
  `);
  await ds.query(`
    ALTER TABLE "conversations"
      DROP CONSTRAINT IF EXISTS "FK_conversations_participant_a"
  `);
  await ds.query(`
    ALTER TABLE "conversations"
      ADD CONSTRAINT "FK_conversations_participant_a"
      FOREIGN KEY ("participant_a_id") REFERENCES "users"("id") ON DELETE CASCADE
  `);
  await ds.query(`
    ALTER TABLE "conversations"
      DROP CONSTRAINT IF EXISTS "FK_conversations_participant_b"
  `);
  await ds.query(`
    ALTER TABLE "conversations"
      ADD CONSTRAINT "FK_conversations_participant_b"
      FOREIGN KEY ("participant_b_id") REFERENCES "users"("id") ON DELETE CASCADE
  `);
  await ds.query(`CREATE INDEX IF NOT EXISTS "IDX_conversations_participant_a" ON "conversations" ("participant_a_id")`);
  await ds.query(`CREATE INDEX IF NOT EXISTS "IDX_conversations_participant_b" ON "conversations" ("participant_b_id")`);
  console.log('✔  Created conversations table');

  // Drop and recreate messages table (may exist with wrong schema from old sync)
  await ds.query(`DROP TABLE IF EXISTS "messages" CASCADE`);
  await ds.query(`
    CREATE TABLE "messages" (
      "id"              SERIAL    NOT NULL,
      "conversation_id" integer   NOT NULL,
      "sender_id"       integer   NOT NULL,
      "content"         text      NOT NULL,
      "is_read"         boolean   NOT NULL DEFAULT false,
      "created_at"      TIMESTAMP NOT NULL DEFAULT now(),
      CONSTRAINT "PK_messages" PRIMARY KEY ("id")
    )
  `);
  await ds.query(`
    ALTER TABLE "messages"
      ADD CONSTRAINT "FK_messages_conversation_id"
      FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE
  `);
  await ds.query(`
    ALTER TABLE "messages"
      ADD CONSTRAINT "FK_messages_sender_id"
      FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE
  `);
  await ds.query(`CREATE INDEX "IDX_messages_conversation_id" ON "messages" ("conversation_id")`);
  await ds.query(`CREATE INDEX "IDX_messages_sender_id" ON "messages" ("sender_id")`);
  console.log('✔  Recreated messages table with correct schema');

  // Record migration as applied
  await ds.query(`
    INSERT INTO migrations (timestamp, name)
    VALUES (1782100000000, 'CreateMessages1782100000000')
    ON CONFLICT DO NOTHING
  `);
  console.log('✔  Migration recorded');

  await ds.destroy();
  console.log('\nDone. Now run: npx ts-node -r tsconfig-paths/register src/database/seeds/seed.ts --force');
}

fix().catch(err => { console.error('Fix failed:', err.message); process.exit(1); });
