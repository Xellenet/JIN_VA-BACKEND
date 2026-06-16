-- ============================================
-- Create ENUM type if it doesn't already exist
-- ============================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_type WHERE typname = 'token'
    ) THEN
        CREATE TYPE token AS ENUM (
            'ACCESS',
            'REFRESH',
            'RESET',
            'VERIFY'
        );
        -- NOTE: Additional values used by the app are added in a later migration
        -- to keep this migration backward-compatible with existing environments.
    END IF;
END $$;

-- ================================
-- Create user_tokens table (safe)
-- ================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'user_tokens'
    ) THEN
        CREATE TABLE user_tokens (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id INTEGER,
            type token NOT NULL,
            token TEXT NOT NULL,
            expires_at TIMESTAMP NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    END IF;
END $$;

-- ==========================================
-- Add foreign key only if users table exists
-- ==========================================

DO $$
BEGIN
    IF EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'users'
    ) THEN
        
        -- Check if FK does not already exist
        IF NOT EXISTS (
            SELECT 1
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
            WHERE tc.table_name = 'user_tokens'
              AND tc.constraint_type = 'FOREIGN KEY'
              AND kcu.column_name = 'user_id'
        ) THEN
            ALTER TABLE user_tokens
            ADD CONSTRAINT fk_user_tokens_user
            FOREIGN KEY (user_id)
                REFERENCES users(id)
                ON DELETE CASCADE;
        END IF;

    END IF;
END $$;