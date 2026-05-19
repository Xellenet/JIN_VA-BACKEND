-- =========================================================
-- Expand token enum values to align with application enums
-- =========================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_type WHERE typname = 'token'
    ) THEN
        ALTER TYPE token ADD VALUE IF NOT EXISTS 'VERIFICATION';
        ALTER TYPE token ADD VALUE IF NOT EXISTS 'EMAIL_VERIFICATION';
        ALTER TYPE token ADD VALUE IF NOT EXISTS 'PASSWORD_RESET';
    END IF;
END $$;
