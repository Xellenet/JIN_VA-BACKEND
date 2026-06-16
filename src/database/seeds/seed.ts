import { DataSource } from 'typeorm';
import { config } from 'dotenv';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import * as bcrypt from 'bcrypt';
import { User } from '../../users/entities/user.entity';
import { ArtisanProfile } from '../../users/entities/artisan-profile.entity';
import { CustomerProfile } from '../../users/entities/customer-profile.entity';
import { Address } from '../../users/entities/address.entity';
import { UserToken } from '../../users/entities/user-token.entity';
import { ServiceEntity } from '../../services/entities/service.entity';
import { Gender, Role } from '../../common/types/enums';

config();

const SALT_ROUNDS = 12;
const SEED_PASSWORD = 'Seed@1234';

const dataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  username: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  entities: [User, ArtisanProfile, CustomerProfile, Address, UserToken, ServiceEntity],
  synchronize: false,
  namingStrategy: new SnakeNamingStrategy(),
});

async function seed() {
  await dataSource.initialize();
  console.log('✔  Connected to database');

  const userRepo = dataSource.getRepository(User);
  const artisanProfileRepo = dataSource.getRepository(ArtisanProfile);
  const customerProfileRepo = dataSource.getRepository(CustomerProfile);
  const serviceRepo = dataSource.getRepository(ServiceEntity);
  const addressRepo = dataSource.getRepository(Address);

  const existingCount = await userRepo.count();
  if (existingCount > 0) {
    console.log(`⚠  Database already has ${existingCount} user(s). Skipping seed. Use --force to re-seed.`);
    if (!process.argv.includes('--force')) {
      await dataSource.destroy();
      return;
    }
    console.log('⚡  --force flag detected. Clearing existing data...');
    await artisanProfileRepo.delete({});
    await customerProfileRepo.delete({});
    await addressRepo.delete({});
    await userRepo.delete({});
    await serviceRepo.delete({});
  }

  // ── Services ────────────────────────────────────────────────────────────────
  const serviceData = [
    { name: 'Plumbing',       description: 'Water supply, drainage, and piping services',             price: 150.00 },
    { name: 'Electrical',     description: 'Wiring, installations, and electrical repairs',           price: 200.00 },
    { name: 'Hair Braiding',  description: 'Professional hair braiding and natural hair styling',     price: 80.00  },
    { name: 'Carpentry',      description: 'Furniture making, repairs, and custom woodwork',          price: 120.00 },
    { name: 'Painting',       description: 'Interior and exterior painting for homes and offices',    price: 100.00 },
    { name: 'Tiling',         description: 'Floor and wall tiling installation and repairs',          price: 180.00 },
  ];

  const services = await serviceRepo.save(serviceData.map(s => serviceRepo.create(s)));
  console.log(`✔  Created ${services.length} services`);

  const hashedPassword = await bcrypt.hash(SEED_PASSWORD, SALT_ROUNDS);
  const verifiedAt = new Date();

  // ── Admin ───────────────────────────────────────────────────────────────────
  await userRepo.save(userRepo.create({
    firstname: 'System',
    lastname: 'Admin',
    email: 'admin@jinva.com',
    username: 'sysadmin',
    password: hashedPassword,
    gender: Gender.MALE,
    role: Role.ADMIN,
    phoneNumber: '020-000-0001',
    accountVerified: true,
    verifiedAt,
  }));
  console.log('✔  Created 1 admin');

  // ── Customers ───────────────────────────────────────────────────────────────
  const customerSeeds = [
    { firstname: 'Ama',    lastname: 'Mensah',   email: 'ama.mensah@gmail.com',    gender: Gender.FEMALE, phone: '020-111-0001', street: '12 Independence Ave',  budgetMin: 50,  budgetMax: 300, preferred: [services[0], services[1]] },
    { firstname: 'Kofi',   lastname: 'Asante',   email: 'kofi.asante@gmail.com',   gender: Gender.MALE,   phone: '020-111-0002', street: '7 Castle Road',         budgetMin: 100, budgetMax: 500, preferred: [services[2], services[3]] },
    { firstname: 'Abena',  lastname: 'Boateng',  email: 'abena.boateng@gmail.com', gender: Gender.FEMALE, phone: '020-111-0003', street: '3 High Street',         budgetMin: 80,  budgetMax: 400, preferred: [services[4], services[5]] },
    { firstname: 'Kwame',  lastname: 'Darko',    email: 'kwame.darko@gmail.com',   gender: Gender.MALE,   phone: '020-111-0004', street: '21 Liberation Road',    budgetMin: 60,  budgetMax: 350, preferred: [services[0], services[3]] },
  ];

  for (const c of customerSeeds) {
    const user = await userRepo.save(userRepo.create({
      firstname: c.firstname,
      lastname: c.lastname,
      email: c.email,
      username: `${c.firstname.toLowerCase()}.${c.lastname.toLowerCase()}`,
      password: hashedPassword,
      gender: c.gender,
      role: Role.CUSTOMER,
      phoneNumber: c.phone,
      accountVerified: true,
      verifiedAt,
    }));

    await customerProfileRepo.save(customerProfileRepo.create({
      user,
      bio: `Hi, I'm ${c.firstname} ${c.lastname}. I use JinVa to find trusted skilled professionals.`,
      budgetMin: c.budgetMin,
      budgetMax: c.budgetMax,
      preferredServices: c.preferred,
    }));

    await addressRepo.save(addressRepo.create({
      user,
      street: c.street,
      city: 'Accra',
      country: 'Ghana',
      zipCode: 'GA-001',
    }));
  }
  console.log(`✔  Created ${customerSeeds.length} customers`);

  // ── Artisans ────────────────────────────────────────────────────────────────
  const artisanSeeds = [
    {
      firstname: 'Yaw',    lastname: 'Osei',     email: 'yaw.osei@jinva.com',     gender: Gender.MALE,   phone: '020-222-0001',
      bio: 'Certified plumber with 8 years of experience in residential and commercial pipe installations.',
      experience: 8, rate: 150, businessName: 'Osei Plumbing Services', street: '5 Ring Road East',   services: [services[0]],
    },
    {
      firstname: 'Akua',   lastname: 'Frimpong', email: 'akua.frimpong@jinva.com', gender: Gender.FEMALE, phone: '020-222-0002',
      bio: 'Licensed electrician specialising in solar panel installations and smart home wiring systems.',
      experience: 6, rate: 200, businessName: 'Frimpong Electrical', street: '18 Cantonments Road', services: [services[1]],
    },
    {
      firstname: 'Efua',   lastname: 'Agyeman',  email: 'efua.agyeman@jinva.com',  gender: Gender.FEMALE, phone: '020-222-0003',
      bio: 'Professional hair braider with expertise in knotless braids, locs, and protective natural styles.',
      experience: 5, rate: 80,  businessName: "Efua's Beauty Studio",  street: '9 Oxford Street',    services: [services[2]],
    },
    {
      firstname: 'Kweku',  lastname: 'Amoah',    email: 'kweku.amoah@jinva.com',   gender: Gender.MALE,   phone: '020-222-0004',
      bio: 'Master carpenter crafting custom furniture, fitted wardrobes, and cabinetry since 2012.',
      experience: 12, rate: 120, businessName: 'Amoah Woodcraft',      street: '33 Teshie Link',     services: [services[3]],
    },
    {
      firstname: 'Adwoa',  lastname: 'Ansah',    email: 'adwoa.ansah@jinva.com',   gender: Gender.FEMALE, phone: '020-222-0005',
      bio: 'Experienced painter delivering quality interior and exterior finishes for homes and commercial spaces.',
      experience: 7, rate: 100, businessName: 'Ansah Paints & Finishes', street: '2 Labone Crescent', services: [services[4], services[5]],
    },
  ];

  for (const a of artisanSeeds) {
    const user = await userRepo.save(userRepo.create({
      firstname: a.firstname,
      lastname: a.lastname,
      email: a.email,
      username: `${a.firstname.toLowerCase()}.${a.lastname.toLowerCase()}`,
      password: hashedPassword,
      gender: a.gender,
      role: Role.ARTISAN,
      phoneNumber: a.phone,
      accountVerified: true,
      verifiedAt,
    }));

    await artisanProfileRepo.save(artisanProfileRepo.create({
      user,
      bio: a.bio,
      experienceYears: a.experience,
      hourlyRate: a.rate,
      businessName: a.businessName,
      availabilityStatus: 'AVAILABLE',
      services: a.services,
    }));

    await addressRepo.save(addressRepo.create({
      user,
      street: a.street,
      city: 'Accra',
      country: 'Ghana',
      zipCode: 'GA-002',
    }));
  }
  console.log(`✔  Created ${artisanSeeds.length} artisans`);

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('\n──────────────────────────────────────────────');
  console.log('  Seed complete');
  console.log('──────────────────────────────────────────────');
  console.log('  Password for all accounts : Seed@1234');
  console.log('  Admin    : admin@jinva.com');
  console.log('  Customers:');
  customerSeeds.forEach(c => console.log(`             ${c.email}`));
  console.log('  Artisans :');
  artisanSeeds.forEach(a => console.log(`             ${a.email}`));
  console.log('──────────────────────────────────────────────\n');

  await dataSource.destroy();
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
