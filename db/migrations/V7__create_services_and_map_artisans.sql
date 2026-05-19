-- ==========================================================
-- Create services table and artisan-services mapping
-- ==========================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'artisans'
          AND column_name = 'what_they_do'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'artisans'
                    AND column_name = 'services_overview'
    ) THEN
                ALTER TABLE artisans RENAME COLUMN what_they_do TO services_overview;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'services'
    ) THEN
        CREATE TABLE services (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) UNIQUE NOT NULL,
            description TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'artisan_services'
    ) THEN
        CREATE TABLE artisan_services (
            artisan_id INTEGER NOT NULL,
            service_id INTEGER NOT NULL,
            PRIMARY KEY (artisan_id, service_id)
        );
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'artisans'
    ) AND EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'artisan_services'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = 'artisan_services'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'artisan_id'
    ) THEN
        ALTER TABLE artisan_services
        ADD CONSTRAINT fk_artisan_services_artisan
        FOREIGN KEY (artisan_id) REFERENCES artisans(id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'services'
    ) AND EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'artisan_services'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = 'artisan_services'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'service_id'
    ) THEN
        ALTER TABLE artisan_services
        ADD CONSTRAINT fk_artisan_services_service
        FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE;
    END IF;
END $$;
