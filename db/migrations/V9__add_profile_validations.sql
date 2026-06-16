-- ==========================================================
-- Add profile schema validations/check constraints
-- ==========================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'artisan_profiles' AND column_name = 'experience_years'
    ) THEN
        UPDATE artisan_profiles
        SET experience_years = NULL
        WHERE experience_years IS NOT NULL AND experience_years <= 0;

        ALTER TABLE artisan_profiles
        ALTER COLUMN experience_years DROP DEFAULT,
        ALTER COLUMN experience_years DROP NOT NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'artisan_profiles' AND column_name = 'hourly_rate'
    ) THEN
        UPDATE artisan_profiles
        SET hourly_rate = NULL
        WHERE hourly_rate IS NOT NULL AND hourly_rate <= 0;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'customer_profiles' AND column_name = 'budget_min'
    ) THEN
        UPDATE customer_profiles
        SET budget_min = NULL
        WHERE budget_min IS NOT NULL AND budget_min <= 0;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'customer_profiles' AND column_name = 'budget_max'
    ) THEN
        UPDATE customer_profiles
        SET budget_max = NULL
        WHERE budget_max IS NOT NULL AND budget_max <= 0;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'artisan_profiles'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'artisan_profiles'
          AND constraint_name = 'ck_artisan_profiles_experience_years_positive'
    ) THEN
        ALTER TABLE artisan_profiles
        ADD CONSTRAINT ck_artisan_profiles_experience_years_positive
        CHECK (experience_years IS NULL OR experience_years > 0);
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'artisan_profiles'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'artisan_profiles'
          AND constraint_name = 'ck_artisan_profiles_hourly_rate_positive'
    ) THEN
        ALTER TABLE artisan_profiles
        ADD CONSTRAINT ck_artisan_profiles_hourly_rate_positive
        CHECK (hourly_rate IS NULL OR hourly_rate > 0);
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'artisan_profiles'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'artisan_profiles'
          AND constraint_name = 'ck_artisan_profiles_bio_length'
    ) THEN
        ALTER TABLE artisan_profiles
        ADD CONSTRAINT ck_artisan_profiles_bio_length
        CHECK (bio IS NULL OR char_length(bio) <= 1000);
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'customer_profiles'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'customer_profiles'
          AND constraint_name = 'ck_customer_profiles_budget_min_positive'
    ) THEN
        ALTER TABLE customer_profiles
        ADD CONSTRAINT ck_customer_profiles_budget_min_positive
        CHECK (budget_min IS NULL OR budget_min > 0);
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'customer_profiles'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'customer_profiles'
          AND constraint_name = 'ck_customer_profiles_budget_max_positive'
    ) THEN
        ALTER TABLE customer_profiles
        ADD CONSTRAINT ck_customer_profiles_budget_max_positive
        CHECK (budget_max IS NULL OR budget_max > 0);
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'customer_profiles'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'customer_profiles'
          AND constraint_name = 'ck_customer_profiles_budget_range'
    ) THEN
        ALTER TABLE customer_profiles
        ADD CONSTRAINT ck_customer_profiles_budget_range
        CHECK (budget_min IS NULL OR budget_max IS NULL OR budget_max >= budget_min);
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'customer_profiles'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'customer_profiles'
          AND constraint_name = 'ck_customer_profiles_bio_length'
    ) THEN
        ALTER TABLE customer_profiles
        ADD CONSTRAINT ck_customer_profiles_bio_length
        CHECK (bio IS NULL OR char_length(bio) <= 1000);
    END IF;
END $$;
