-- ==========================================================
-- Create artisan_profiles and customer_profiles tables
-- ==========================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'artisan_profiles'
    ) THEN
        CREATE TABLE artisan_profiles (
            id SERIAL PRIMARY KEY,
            user_id INTEGER UNIQUE NOT NULL,
            bio TEXT,
            experience_years INTEGER DEFAULT 0,
            hourly_rate NUMERIC(10,2),
            business_name VARCHAR(255),
            average_rating NUMERIC(3,2) DEFAULT 0,
            total_reviews INTEGER DEFAULT 0,
            availability_status VARCHAR(50) DEFAULT 'AVAILABLE',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'users'
    ) AND EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'artisan_profiles'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = 'artisan_profiles'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'user_id'
    ) THEN
        ALTER TABLE artisan_profiles
        ADD CONSTRAINT fk_artisan_profiles_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'customer_profiles'
    ) THEN
        CREATE TABLE customer_profiles (
            id SERIAL PRIMARY KEY,
            user_id INTEGER UNIQUE NOT NULL,
            bio TEXT,
            preferred_services TEXT,
            budget_min NUMERIC(10,2),
            budget_max NUMERIC(10,2),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'users'
    ) AND EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'customer_profiles'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = 'customer_profiles'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'user_id'
    ) THEN
        ALTER TABLE customer_profiles
        ADD CONSTRAINT fk_customer_profiles_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
    END IF;
END $$;
