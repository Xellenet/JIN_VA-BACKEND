-- ========================================
-- Create artisans table and related tables
-- ========================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'artisans'
    ) THEN
        CREATE TABLE artisans (
            id SERIAL PRIMARY KEY,
            user_id INTEGER UNIQUE NOT NULL,
            what_they_do VARCHAR(255) NOT NULL,
            contact_phone VARCHAR(255),
            contact_email VARCHAR(255),
            location_address_id INTEGER,
            average_rating NUMERIC(3,2) DEFAULT 0,
            total_ratings INTEGER DEFAULT 0,
            bio TEXT,
            years_of_experience INTEGER,
            certifications TEXT,
            license_number VARCHAR(255),
            specializations TEXT,
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
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = 'artisans'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'user_id'
    ) THEN
        ALTER TABLE artisans
        ADD CONSTRAINT fk_artisans_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'addresses'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = 'artisans'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'location_address_id'
    ) THEN
        ALTER TABLE artisans
        ADD CONSTRAINT fk_artisans_location_address
        FOREIGN KEY (location_address_id) REFERENCES addresses(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'artisan_reviews'
    ) THEN
        CREATE TABLE artisan_reviews (
            id SERIAL PRIMARY KEY,
            artisan_id INTEGER NOT NULL,
            reviewer_user_id INTEGER,
            reviewer_name VARCHAR(255),
            rating NUMERIC(3,2) NOT NULL,
            review TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'artisans'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = 'artisan_reviews'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'artisan_id'
    ) THEN
        ALTER TABLE artisan_reviews
        ADD CONSTRAINT fk_artisan_reviews_artisan
        FOREIGN KEY (artisan_id) REFERENCES artisans(id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'users'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = 'artisan_reviews'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'reviewer_user_id'
    ) THEN
        ALTER TABLE artisan_reviews
        ADD CONSTRAINT fk_artisan_reviews_reviewer_user
        FOREIGN KEY (reviewer_user_id) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'artisan_portfolio_images'
    ) THEN
        CREATE TABLE artisan_portfolio_images (
            id SERIAL PRIMARY KEY,
            artisan_id INTEGER NOT NULL,
            image_url TEXT NOT NULL,
            caption VARCHAR(255),
            display_order INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'artisans'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = 'artisan_portfolio_images'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'artisan_id'
    ) THEN
        ALTER TABLE artisan_portfolio_images
        ADD CONSTRAINT fk_artisan_portfolio_images_artisan
        FOREIGN KEY (artisan_id) REFERENCES artisans(id) ON DELETE CASCADE;
    END IF;
END $$;
