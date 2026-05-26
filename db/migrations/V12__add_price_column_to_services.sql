-- ==========================================================
-- Add missing price column to services table
-- ==========================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_name = 'services'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'services'
          AND column_name = 'price'
    ) THEN
        ALTER TABLE services
        ADD COLUMN price DECIMAL(10,2);
    END IF;
END $$;
