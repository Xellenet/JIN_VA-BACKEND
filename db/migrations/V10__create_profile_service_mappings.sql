-- ==========================================================
-- Create join tables for artisan and customer profile services
-- ==========================================================

-- Drop the old preferred_services column from customer_profiles if it exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'customer_profiles' AND column_name = 'preferred_services'
    ) THEN
        ALTER TABLE customer_profiles DROP COLUMN preferred_services;
    END IF;
END $$;

-- Create artisan_profile_services join table
CREATE TABLE IF NOT EXISTS artisan_profile_services (
    artisan_profile_id INTEGER NOT NULL,
    service_id INTEGER NOT NULL,
    PRIMARY KEY (artisan_profile_id, service_id),
    CONSTRAINT fk_artisan_profile_services_profile
        FOREIGN KEY (artisan_profile_id) REFERENCES artisan_profiles(id) ON DELETE CASCADE,
    CONSTRAINT fk_artisan_profile_services_service
        FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
);

-- Create customer_profile_services join table
CREATE TABLE IF NOT EXISTS customer_profile_services (
    customer_profile_id INTEGER NOT NULL,
    service_id INTEGER NOT NULL,
    PRIMARY KEY (customer_profile_id, service_id),
    CONSTRAINT fk_customer_profile_services_profile
        FOREIGN KEY (customer_profile_id) REFERENCES customer_profiles(id) ON DELETE CASCADE,
    CONSTRAINT fk_customer_profile_services_service
        FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
);
