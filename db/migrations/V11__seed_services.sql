-- ==========================================================
-- Seed services table with predefined services
-- ==========================================================

INSERT INTO services (name, description, created_at, updated_at)
VALUES
    ('Plumbing', 'Professional plumbing services including repairs, installations, and maintenance', NOW(), NOW()),
    ('Electrical Repairs', 'Electrical repair and troubleshooting services for residential and commercial properties', NOW(), NOW()),
    ('Carpentry', 'Custom carpentry work including furniture building, repairs, and installations', NOW(), NOW()),
    ('Painting', 'Interior and exterior painting services with quality finishes', NOW(), NOW()),
    ('Electrical Installation', 'Professional electrical installation services for new constructions and renovations', NOW(), NOW()),
    ('Tiling', 'Professional tiling services for walls, floors, and bathrooms', NOW(), NOW()),
    ('Welding', 'Welding services for metal fabrication, repairs, and installations', NOW(), NOW()),
    ('Barbering', 'Professional barbering services including haircuts and grooming', NOW(), NOW()),
    ('Hair Styling', 'Hair styling services including cuts, coloring, and treatments', NOW(), NOW()),
    ('Makeup', 'Professional makeup services for events, occasions, and daily applications', NOW(), NOW()),
    ('Nails', 'Nail care services including manicures, pedicures, and nail art', NOW(), NOW()),
    ('Auto Mechanics', 'Comprehensive auto repair and maintenance services', NOW(), NOW()),
    ('Car Wash', 'Professional car washing and detailing services', NOW(), NOW()),
    ('Tire Repairs', 'Tire repair, replacement, and maintenance services', NOW(), NOW()),
    ('Laundry', 'Professional laundry services for clothes and household items', NOW(), NOW()),
    ('Home Cleaning', 'Residential cleaning services including deep cleaning and regular maintenance', NOW(), NOW()),
    ('Fumigation', 'Pest control and fumigation services for residential and commercial spaces', NOW(), NOW()),
    ('Photography', 'Professional photography services for events, portraits, and commercial needs', NOW(), NOW()),
    ('Catering', 'Professional catering services for events and occasions', NOW(), NOW()),
    ('Decoration', 'Event decoration and interior design services', NOW(), NOW()),
    ('Masonry', 'Masonry work including brickwork, stonework, and concrete services', NOW(), NOW()),
    ('Building Contractors', 'General construction and building services for residential and commercial projects', NOW(), NOW())
ON CONFLICT (name) DO NOTHING;
