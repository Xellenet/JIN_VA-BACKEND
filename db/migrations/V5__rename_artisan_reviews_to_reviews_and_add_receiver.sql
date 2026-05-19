-- ======================================================
-- Rename artisan_reviews table to reviews and add receiver
-- ======================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'artisan_reviews'
    ) AND NOT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'reviews'
    ) THEN
        ALTER TABLE artisan_reviews RENAME TO reviews;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'reviews'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'reviews'
          AND column_name = 'reviewed_user_id'
    ) THEN
        ALTER TABLE reviews
        ADD COLUMN reviewed_user_id INTEGER;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'reviews'
    ) THEN
        UPDATE reviews r
        SET reviewed_user_id = a.user_id
        FROM artisans a
        WHERE r.artisan_id = a.id
          AND r.reviewed_user_id IS NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'reviews'
    ) THEN
        ALTER TABLE reviews
        ALTER COLUMN reviewed_user_id SET NOT NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'users'
    ) AND EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'reviews'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = 'reviews'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'reviewed_user_id'
    ) THEN
        ALTER TABLE reviews
        ADD CONSTRAINT fk_reviews_reviewed_user
        FOREIGN KEY (reviewed_user_id) REFERENCES users(id) ON DELETE CASCADE;
    END IF;
END $$;
