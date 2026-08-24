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
import { Job } from '../../jobs/entities/job.entity';
import { JobApplication } from '../../jobs/entities/job-application.entity';
import { Review } from '../../reviews/entities/review.entity';
import { Favourite } from '../../favourites/entities/favourite.entity';
import { Conversation } from '../../messages/entities/conversation.entity';
import { Message } from '../../messages/entities/message.entity';
import { Notification } from '../../notifications/entities/notification.entity';
import { NotificationPreferences } from '../../notifications/entities/notification-preferences.entity';
import { ArtisanAvailability } from '../../availability/entities/artisan-availability.entity';
import { ArtisanVerification } from '../../verification/entities/artisan-verification.entity';
import { Booking } from '../../bookings/entities/booking.entity';
import { DeviceToken } from '../../push-notifications/entities/device-token.entity';
import { JobStatusHistory } from '../../jobs/entities/job-status-history.entity';
import { Payment } from '../../payments/entities/payment.entity';
import { Dispute } from '../../disputes/entities/dispute.entity';
import {
  Gender,
  Role,
  Status,
  ApplicationStatus,
  BookingStatus,
  DocumentType,
  VerificationStatus,
  DevicePlatform,
  NotificationType,
  PaymentStatus,
  DisputeStatus,
  DisputeCategory,
} from '../../common/types/enums';

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
  entities: [
    User,
    ArtisanProfile,
    CustomerProfile,
    Address,
    UserToken,
    ServiceEntity,
    Job,
    JobApplication,
    Review,
    Favourite,
    Conversation,
    Message,
    Notification,
    NotificationPreferences,
    ArtisanAvailability,
    ArtisanVerification,
    Booking,
    DeviceToken,
    // DR3: the seed now produces the booking → job → payment → dispute chain
    // the admin Linked Payment panel walks, so it has something real to show.
    JobStatusHistory,
    Payment,
    Dispute,
  ],
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
  const jobRepo = dataSource.getRepository(Job);
  const jobApplicationRepo = dataSource.getRepository(JobApplication);
  const reviewRepo = dataSource.getRepository(Review);
  const favouriteRepo = dataSource.getRepository(Favourite);
  const conversationRepo = dataSource.getRepository(Conversation);
  const messageRepo = dataSource.getRepository(Message);
  const notificationRepo = dataSource.getRepository(Notification);
  const notifPrefsRepo = dataSource.getRepository(NotificationPreferences);
  const availabilityRepo = dataSource.getRepository(ArtisanAvailability);
  const verificationRepo = dataSource.getRepository(ArtisanVerification);
  const bookingRepo = dataSource.getRepository(Booking);
  const deviceTokenRepo = dataSource.getRepository(DeviceToken);
  const jobHistoryRepo = dataSource.getRepository(JobStatusHistory);
  const paymentRepo = dataSource.getRepository(Payment);
  const disputeRepo = dataSource.getRepository(Dispute);

  const existingCount = await userRepo.count();
  if (existingCount > 0) {
    console.log(
      `⚠  Database already has ${existingCount} user(s). Use --force to re-seed.`,
    );
    if (!process.argv.includes('--force')) {
      await dataSource.destroy();
      return;
    }
    console.log('⚡  --force flag detected. Clearing existing data…');
    // Skip tables that don't exist yet (42P01 = undefined_table)
    const del = async (table: string) => {
      try {
        await dataSource.query(`DELETE FROM "${table}"`);
      } catch (e) {
        const code =
          e && typeof e === 'object' && 'code' in e
            ? (e as { code?: string }).code
            : undefined;
        if (code !== '42P01') throw e;
      }
    };
    // Delete in FK-safe order: most-dependent tables first
    await del('notifications');
    await del('device_tokens');
    await del('bookings');
    await del('artisan_verifications');
    await del('messages');
    await del('conversations');
    // MB1: `direct_messages` is dropped by migration
    // 1783130000000-DropDirectMessagesTable, so it is deliberately absent
    // here. `del()` already tolerates a missing table (Postgres 42P01), so a
    // database that hasn't run that migration yet is still handled — it just
    // isn't listed as an expected table any more.
    await del('favourites');
    await del('reviews');
    await del('job_applications');
    await del('jobs');
    await del('artisan_availability');
    await del('notification_preferences');
    await del('artisan_profiles'); // cascades artisan_profile_services join table
    await del('customer_profiles'); // cascades preferred_services join table
    await del('addresses');
    await del('user_tokens');
    await del('users');
    await del('services');
    console.log('✔  Cleared existing data');
  }

  // ── Services ──────────────────────────────────────────────────────────────────
  const serviceData = [
    {
      name: 'Plumbing',
      description: 'Water supply, drainage, and piping services',
      price: 150.0,
    },
    {
      name: 'Electrical',
      description: 'Wiring, installations, and electrical repairs',
      price: 200.0,
    },
    {
      name: 'Hair Braiding',
      description: 'Professional hair braiding and natural hair styling',
      price: 80.0,
    },
    {
      name: 'Carpentry',
      description: 'Furniture making, repairs, and custom woodwork',
      price: 120.0,
    },
    {
      name: 'Painting',
      description: 'Interior and exterior painting for homes and offices',
      price: 100.0,
    },
    {
      name: 'Tiling',
      description: 'Floor and wall tiling installation and repairs',
      price: 180.0,
    },
    {
      name: 'Cleaning',
      description: 'Professional residential and commercial cleaning services',
      price: 60.0,
    },
    {
      name: 'Landscaping',
      description: 'Garden design, lawn care, and outdoor space maintenance',
      price: 90.0,
    },
  ];

  const services = await serviceRepo.save(
    serviceData.map((s) => serviceRepo.create(s)),
  );
  const [
    plumbing,
    electrical,
    hairBraiding,
    carpentry,
    painting,
    tiling,
    cleaning,
  ] = services;
  console.log(`✔  Created ${services.length} services`);

  const hashedPassword = await bcrypt.hash(SEED_PASSWORD, SALT_ROUNDS);
  const verifiedAt = new Date();

  // ── Admin ──────────────────────────────────────────────────────────────────────
  const admin = await userRepo.save(
    userRepo.create({
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
      dateOfBirth: new Date('1980-01-15'),
    }),
  );
  console.log('✔  Created 1 admin');

  // ── Customers ──────────────────────────────────────────────────────────────────
  const customerSeeds = [
    {
      firstname: 'Ama',
      lastname: 'Mensah',
      email: 'ama.mensah@gmail.com',
      gender: Gender.FEMALE,
      phone: '020-111-0001',
      dateOfBirth: new Date('1992-03-20'),
      profilePicture: '/uploads/profiles/ama-mensah.jpg',
      street: '12 Independence Ave',
      budgetMin: 50,
      budgetMax: 300,
      preferred: [plumbing, electrical],
    },
    {
      firstname: 'Kofi',
      lastname: 'Asante',
      email: 'kofi.asante@gmail.com',
      gender: Gender.MALE,
      phone: '020-111-0002',
      dateOfBirth: new Date('1988-07-14'),
      profilePicture: '/uploads/profiles/kofi-asante.jpg',
      street: '7 Castle Road',
      budgetMin: 100,
      budgetMax: 500,
      preferred: [hairBraiding, carpentry],
    },
    {
      firstname: 'Abena',
      lastname: 'Boateng',
      email: 'abena.boateng@gmail.com',
      gender: Gender.FEMALE,
      phone: '020-111-0003',
      dateOfBirth: new Date('1995-11-08'),
      profilePicture: '/uploads/profiles/abena-boateng.jpg',
      street: '3 High Street',
      budgetMin: 80,
      budgetMax: 400,
      preferred: [painting, tiling],
    },
    {
      firstname: 'Kwame',
      lastname: 'Darko',
      email: 'kwame.darko@gmail.com',
      gender: Gender.MALE,
      phone: '020-111-0004',
      dateOfBirth: new Date('1990-05-22'),
      profilePicture: '/uploads/profiles/kwame-darko.jpg',
      street: '21 Liberation Road',
      budgetMin: 60,
      budgetMax: 350,
      preferred: [plumbing, carpentry],
    },
  ];

  const customers: User[] = [];
  for (const c of customerSeeds) {
    const user = await userRepo.save(
      userRepo.create({
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
        dateOfBirth: c.dateOfBirth,
        profilePicture: c.profilePicture,
      }),
    );

    await customerProfileRepo.save(
      customerProfileRepo.create({
        user,
        bio: `Hi, I'm ${c.firstname} ${c.lastname}. I use JinVa to find trusted skilled professionals.`,
        budgetMin: c.budgetMin,
        budgetMax: c.budgetMax,
        preferredServices: c.preferred,
      }),
    );

    await addressRepo.save(
      addressRepo.create({
        user,
        street: c.street,
        city: 'Accra',
        country: 'Ghana',
        zipCode: 'GA-001',
      }),
    );

    customers.push(user);
  }
  const [ama, kofi, abena, kwame] = customers;
  console.log(`✔  Created ${customers.length} customers`);

  // ── Artisans ───────────────────────────────────────────────────────────────────
  const artisanSeeds = [
    {
      firstname: 'Yaw',
      lastname: 'Osei',
      email: 'yaw.osei@jinva.com',
      gender: Gender.MALE,
      phone: '020-222-0001',
      dateOfBirth: new Date('1986-09-03'),
      profilePicture: '/uploads/profiles/yaw-osei.jpg',
      bio: 'Certified plumber with 8 years of experience in residential and commercial pipe installations.',
      experience: 8,
      rate: 150,
      businessName: 'Osei Plumbing Services',
      location: 'East Legon, Accra',
      street: '5 Ring Road East',
      services: [plumbing],
    },
    {
      firstname: 'Akua',
      lastname: 'Frimpong',
      email: 'akua.frimpong@jinva.com',
      gender: Gender.FEMALE,
      phone: '020-222-0002',
      dateOfBirth: new Date('1993-01-27'),
      profilePicture: '/uploads/profiles/akua-frimpong.jpg',
      bio: 'Licensed electrician specialising in solar panel installations and smart home wiring systems.',
      experience: 6,
      rate: 200,
      businessName: 'Frimpong Electrical',
      location: 'Cantonments, Accra',
      street: '18 Cantonments Road',
      services: [electrical],
    },
    {
      firstname: 'Efua',
      lastname: 'Agyeman',
      email: 'efua.agyeman@jinva.com',
      gender: Gender.FEMALE,
      phone: '020-222-0003',
      dateOfBirth: new Date('1997-06-15'),
      profilePicture: '/uploads/profiles/efua-agyeman.jpg',
      bio: 'Professional hair braider with expertise in knotless braids, locs, and protective natural styles.',
      experience: 5,
      rate: 80,
      businessName: "Efua's Beauty Studio",
      location: 'Osu, Accra',
      street: '9 Oxford Street',
      services: [hairBraiding],
    },
    {
      firstname: 'Kweku',
      lastname: 'Amoah',
      email: 'kweku.amoah@jinva.com',
      gender: Gender.MALE,
      phone: '020-222-0004',
      dateOfBirth: new Date('1984-12-10'),
      profilePicture: '/uploads/profiles/kweku-amoah.jpg',
      bio: 'Master carpenter crafting custom furniture, fitted wardrobes, and cabinetry since 2012.',
      experience: 12,
      rate: 120,
      businessName: 'Amoah Woodcraft',
      location: 'Teshie, Accra',
      street: '33 Teshie Link',
      services: [carpentry],
    },
    {
      firstname: 'Adwoa',
      lastname: 'Ansah',
      email: 'adwoa.ansah@jinva.com',
      gender: Gender.FEMALE,
      phone: '020-222-0005',
      dateOfBirth: new Date('1991-04-05'),
      profilePicture: '/uploads/profiles/adwoa-ansah.jpg',
      bio: 'Experienced painter delivering quality interior and exterior finishes for homes and commercial spaces.',
      experience: 7,
      rate: 100,
      businessName: 'Ansah Paints & Finishes',
      location: 'Labone, Accra',
      street: '2 Labone Crescent',
      services: [painting, tiling],
    },
  ];

  const artisans: User[] = [];
  const artisanProfiles: ArtisanProfile[] = [];

  for (const a of artisanSeeds) {
    const user = await userRepo.save(
      userRepo.create({
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
        dateOfBirth: a.dateOfBirth,
        profilePicture: a.profilePicture,
      }),
    );

    const profile = await artisanProfileRepo.save(
      artisanProfileRepo.create({
        user,
        bio: a.bio,
        experienceYears: a.experience,
        hourlyRate: a.rate,
        businessName: a.businessName,
        availabilityStatus: 'AVAILABLE',
        location: a.location,
        services: a.services,
      }),
    );

    await addressRepo.save(
      addressRepo.create({
        user,
        street: a.street,
        city: 'Accra',
        country: 'Ghana',
        zipCode: 'GA-002',
      }),
    );

    artisans.push(user);
    artisanProfiles.push(profile);
  }
  const [yaw, akua, efua, kweku, adwoa] = artisans;
  const [yawProfile, akuaProfile, efuaProfile, kwekuProfile, adwoaProfile] =
    artisanProfiles;
  console.log(`✔  Created ${artisans.length} artisans`);

  // ── NotificationPreferences ────────────────────────────────────────────────────
  const allUsers = [admin, ...customers, ...artisans];
  for (const user of allUsers) {
    await notifPrefsRepo.save(notifPrefsRepo.create({ user }));
  }
  console.log(`✔  Created ${allUsers.length} notification preferences`);

  // ── ArtisanAvailability ────────────────────────────────────────────────────────
  const profileSlots = new Map<number, ArtisanAvailability[]>();
  const weekdays = [1, 2, 3, 4, 5]; // Mon–Fri
  const timeBlocks = [
    { startTime: '08:00', endTime: '12:00' },
    { startTime: '13:00', endTime: '17:00' },
  ];
  let totalSlots = 0;

  for (const profile of artisanProfiles) {
    profileSlots.set(profile.id, []);
    for (const day of weekdays) {
      for (const tb of timeBlocks) {
        const slot = await availabilityRepo.save(
          availabilityRepo.create({
            artisanProfile: profile,
            dayOfWeek: day,
            startTime: tb.startTime,
            endTime: tb.endTime,
            isActive: true,
          }),
        );
        profileSlots.get(profile.id)!.push(slot);
        totalSlots++;
      }
    }
  }
  // First slot for each artisan = Mon 08:00–12:00
  const yawSlot0 = profileSlots.get(yawProfile.id)![0];
  const akuaSlot0 = profileSlots.get(akuaProfile.id)![0];
  console.log(`✔  Created ${totalSlots} availability slots`);

  // ── Jobs ───────────────────────────────────────────────────────────────────────
  const jobsData = [
    {
      customer: ama,
      service: plumbing,
      status: Status.COMPLETED,
      acceptedArtisan: yaw,
      title: 'Fix leaking kitchen pipe',
      location: '12 Independence Ave, Accra',
      budgetMin: 100,
      budgetMax: 200,
      deadline: new Date('2026-06-01'),
      description:
        'Kitchen sink pipe has been leaking for 2 weeks. Need urgent repair and pipe replacement.',
    },
    {
      customer: kofi,
      service: electrical,
      status: Status.COMPLETED,
      acceptedArtisan: akua,
      title: 'Install 5KVA solar inverter system',
      location: '7 Castle Road, Accra',
      budgetMin: 300,
      budgetMax: 500,
      deadline: new Date('2026-06-05'),
      description:
        'Need a 5KVA solar inverter installed with battery backup for the entire house.',
    },
    {
      customer: abena,
      service: hairBraiding,
      status: Status.IN_PROGRESS,
      acceptedArtisan: efua,
      title: 'Knotless box braids – full head',
      location: '3 High Street, Accra',
      budgetMin: 60,
      budgetMax: 120,
      deadline: new Date('2026-06-30'),
      description:
        'Looking for a skilled braider for waist-length knotless box braids. Medium size, light extensions.',
    },
    {
      customer: kwame,
      service: carpentry,
      status: Status.IN_PROGRESS,
      acceptedArtisan: kweku,
      title: 'Custom wall-to-wall bookshelf',
      location: '21 Liberation Road, Accra',
      budgetMin: 200,
      budgetMax: 400,
      deadline: new Date('2026-07-10'),
      description:
        'Need a floor-to-ceiling bookshelf built along a 4-metre wall in the study room.',
    },
    {
      customer: ama,
      service: painting,
      status: Status.OPEN,
      acceptedArtisan: null,
      title: 'Repaint 3-bedroom apartment',
      location: '12 Independence Ave, Accra',
      budgetMin: 200,
      budgetMax: 400,
      deadline: new Date('2026-07-15'),
      description:
        'Full repaint of a 3-bedroom apartment. Neutral tones preferred. Include ceilings.',
    },
    {
      customer: kofi,
      service: tiling,
      status: Status.OPEN,
      acceptedArtisan: null,
      title: 'Tile new bathroom floor and walls',
      location: '7 Castle Road, Accra',
      budgetMin: 300,
      budgetMax: 600,
      deadline: new Date('2026-07-20'),
      description:
        'New bathroom construction needs floor and wall tiling. Total area approximately 20 sqm.',
    },
    {
      customer: abena,
      service: cleaning,
      status: Status.OPEN,
      acceptedArtisan: null,
      title: 'Deep clean 4-bedroom house before move-in',
      location: '3 High Street, Accra',
      budgetMin: 80,
      budgetMax: 150,
      deadline: new Date('2026-06-28'),
      description:
        'Full deep clean before moving in. Includes kitchen appliances, bathrooms, and all windows.',
    },
    {
      customer: kwame,
      service: plumbing,
      status: Status.CANCELLED,
      acceptedArtisan: null,
      title: 'Install 500L overhead water tank',
      location: '21 Liberation Road, Accra',
      budgetMin: 150,
      budgetMax: 300,
      deadline: new Date('2026-06-20'),
      description:
        'Need a 500L overhead water tank installed with proper plumbing connections to the house.',
    },
  ];

  const jobs: Job[] = [];
  for (const j of jobsData) {
    const job = await jobRepo.save(
      jobRepo.create({
        customer: j.customer,
        service: j.service,
        status: j.status,
        acceptedArtisan: j.acceptedArtisan ?? undefined,
        title: j.title,
        location: j.location,
        budgetMin: j.budgetMin,
        budgetMax: j.budgetMax,
        deadline: j.deadline,
        description: j.description,
      }),
    );
    jobs.push(job);
  }
  console.log(`✔  Created ${jobs.length} jobs`);

  // ── JobApplications ────────────────────────────────────────────────────────────
  const applicationData = [
    {
      job: jobs[0],
      artisan: yaw,
      status: ApplicationStatus.ACCEPTED,
      quotePrice: 160,
      message:
        'I can fix this efficiently. Available this week with all required materials.',
    },
    {
      job: jobs[1],
      artisan: akua,
      status: ApplicationStatus.ACCEPTED,
      quotePrice: 450,
      message:
        'Experienced in residential solar installations. Can start Monday with full equipment.',
    },
    {
      job: jobs[2],
      artisan: efua,
      status: ApplicationStatus.ACCEPTED,
      quotePrice: 90,
      message:
        'Knotless braids are my speciality. Happy to take this booking at a convenient time.',
    },
    {
      job: jobs[3],
      artisan: kweku,
      status: ApplicationStatus.ACCEPTED,
      quotePrice: 300,
      message:
        'Custom shelving is my core work. I can deliver excellent quality on this project.',
    },
    {
      job: jobs[4],
      artisan: yaw,
      status: ApplicationStatus.PENDING,
      quotePrice: 250,
      message:
        'I also handle painting work. I can complete the full apartment in 3 days.',
    },
    {
      job: jobs[4],
      artisan: adwoa,
      status: ApplicationStatus.PENDING,
      quotePrice: 320,
      message:
        'Specialise in interior painting. References from past clients available on request.',
    },
    {
      job: jobs[5],
      artisan: adwoa,
      status: ApplicationStatus.PENDING,
      quotePrice: 500,
      message:
        'Experienced tiler. I can complete the 20sqm tiling within 4 working days.',
    },
    {
      job: jobs[7],
      artisan: kweku,
      status: ApplicationStatus.REJECTED,
      quotePrice: 200,
      message:
        'I can handle overhead tank installation. Have done similar projects before.',
    },
  ];

  for (const app of applicationData) {
    await jobApplicationRepo.save(
      jobApplicationRepo.create({
        job: app.job,
        artisan: app.artisan,
        status: app.status,
        quotePrice: app.quotePrice,
        message: app.message,
      }),
    );
  }
  console.log(`✔  Created ${applicationData.length} job applications`);

  // ── ArtisanVerifications ───────────────────────────────────────────────────────
  await verificationRepo.save(
    verificationRepo.create({
      artisanProfile: yawProfile,
      documentType: DocumentType.GHANA_CARD,
      idNumber: 'GHA-12345678-9',
      fullLegalName: 'Yaw Kofi Osei',
      dateOfBirth: '1986-09-03',
      documentFrontUrl: '/uploads/documents/yaw-ghana-card-front.jpg',
      documentBackUrl: '/uploads/documents/yaw-ghana-card-back.jpg',
      selfieUrl: '/uploads/documents/yaw-selfie.jpg',
      status: VerificationStatus.APPROVED,
      provider: 'manual',
      adminNotes: 'All documents verified. Identity confirmed.',
      reviewedAt: new Date('2026-05-10'),
    }),
  );

  await verificationRepo.save(
    verificationRepo.create({
      artisanProfile: akuaProfile,
      documentType: DocumentType.PASSPORT,
      idNumber: 'GH123456789',
      fullLegalName: 'Akua Adwoa Frimpong',
      dateOfBirth: '1993-01-27',
      documentFrontUrl: '/uploads/documents/akua-passport-main.jpg',
      selfieUrl: '/uploads/documents/akua-selfie.jpg',
      status: VerificationStatus.APPROVED,
      provider: 'manual',
      adminNotes:
        'Passport verified. Electrician licence confirmed separately.',
      reviewedAt: new Date('2026-05-12'),
    }),
  );

  await verificationRepo.save(
    verificationRepo.create({
      artisanProfile: efuaProfile,
      documentType: DocumentType.GHANA_CARD,
      idNumber: 'GHA-98765432-1',
      fullLegalName: 'Efua Abena Agyeman',
      dateOfBirth: '1997-06-15',
      documentFrontUrl: '/uploads/documents/efua-ghana-card-front.jpg',
      documentBackUrl: '/uploads/documents/efua-ghana-card-back.jpg',
      selfieUrl: '/uploads/documents/efua-selfie.jpg',
      status: VerificationStatus.UNDER_REVIEW,
      provider: 'manual',
    }),
  );

  await verificationRepo.save(
    verificationRepo.create({
      artisanProfile: kwekuProfile,
      documentType: DocumentType.DRIVERS_LICENSE,
      documentFrontUrl: '/uploads/documents/kweku-license-front.jpg',
      selfieUrl: '/uploads/documents/kweku-selfie.jpg',
      status: VerificationStatus.PENDING,
      provider: 'manual',
    }),
  );

  await verificationRepo.save(
    verificationRepo.create({
      artisanProfile: adwoaProfile,
      documentType: DocumentType.GHANA_CARD,
      idNumber: 'GHA-11223344-5',
      fullLegalName: 'Adwoa Akos Ansah',
      dateOfBirth: '1991-04-05',
      documentFrontUrl: '/uploads/documents/adwoa-ghana-card-front.jpg',
      documentBackUrl: '/uploads/documents/adwoa-ghana-card-back.jpg',
      selfieUrl: '/uploads/documents/adwoa-selfie.jpg',
      status: VerificationStatus.REJECTED,
      provider: 'manual',
      adminNotes: 'Document appears expired. Please resubmit with valid ID.',
      rejectionReason:
        'Submitted Ghana Card has expired. Please provide a current, valid identification document.',
      reviewedAt: new Date('2026-05-15'),
    }),
  );

  // Mark approved artisans as verified
  await artisanProfileRepo.update(yawProfile.id, { isVerified: true });
  await artisanProfileRepo.update(akuaProfile.id, { isVerified: true });
  console.log('✔  Created 5 artisan verifications');

  // ── Reviews ────────────────────────────────────────────────────────────────────
  await reviewRepo.save(
    reviewRepo.create({
      job: jobs[0],
      artisanProfile: yawProfile,
      reviewerUser: ama,
      reviewedUser: yaw,
      reviewerName: 'Ama Mensah',
      rating: 4.5,
      review:
        'Yaw did an excellent job fixing the pipe. He was professional, punctual, and cleaned up after himself. Highly recommended!',
    }),
  );

  await reviewRepo.save(
    reviewRepo.create({
      job: jobs[1],
      artisanProfile: akuaProfile,
      reviewerUser: kofi,
      reviewedUser: akua,
      reviewerName: 'Kofi Asante',
      rating: 5.0,
      review:
        'Akua is absolutely brilliant! The solar system installation was flawless and my electricity bills have dropped significantly.',
    }),
  );

  await artisanProfileRepo.update(yawProfile.id, {
    averageRating: 4.5,
    totalReviews: 1,
  });
  await artisanProfileRepo.update(akuaProfile.id, {
    averageRating: 5.0,
    totalReviews: 1,
  });
  console.log('✔  Created 2 reviews');

  // ── Favourites ─────────────────────────────────────────────────────────────────
  const favouriteData = [
    { customer: ama, artisan: yawProfile },
    { customer: ama, artisan: efuaProfile },
    { customer: kofi, artisan: akuaProfile },
    { customer: abena, artisan: kwekuProfile },
    { customer: kwame, artisan: adwoaProfile },
  ];

  for (const f of favouriteData) {
    await favouriteRepo.save(
      favouriteRepo.create({ customer: f.customer, artisan: f.artisan }),
    );
  }
  console.log(`✔  Created ${favouriteData.length} favourites`);

  // ── Conversations & Messages ───────────────────────────────────────────────────
  // MB1: the retired `direct_messages` seed block used to live here and seeded
  // the same four pairs a second time, in the module that emitted no events.
  // Its two pairs that weren't already covered below (abena↔efua and
  // kwame↔kweku) are seeded as canonical conversations instead, so fixture
  // coverage is unchanged.
  const conv1 = await conversationRepo.save(
    conversationRepo.create({
      participantA: ama,
      participantB: yaw,
    }),
  );

  for (const m of [
    {
      sender: ama,
      content:
        'Hi Yaw, just wanted to follow up on the plumbing work you completed.',
    },
    {
      sender: yaw,
      content:
        'Hi Ama! The installation is fully tested. You should have no more leaks.',
    },
    {
      sender: ama,
      content:
        'Wonderful! Everything is working perfectly. Very satisfied with the work!',
    },
  ]) {
    await messageRepo.save(
      messageRepo.create({
        conversation: conv1,
        sender: m.sender,
        content: m.content,
        isRead: true,
      }),
    );
  }

  const conv2 = await conversationRepo.save(
    conversationRepo.create({
      participantA: kofi,
      participantB: akua,
    }),
  );

  for (const m of [
    {
      sender: kofi,
      content:
        'Good morning Akua, when can you start the electrical work for the guest wing?',
    },
    {
      sender: akua,
      content:
        'Good morning Kofi! I can start this Thursday morning. Does that work?',
    },
    {
      sender: kofi,
      content: 'Thursday works perfectly. I will arrange access for you.',
    },
    {
      sender: akua,
      content: 'Great! I will bring all the necessary equipment and materials.',
    },
  ]) {
    await messageRepo.save(
      messageRepo.create({
        conversation: conv2,
        sender: m.sender,
        content: m.content,
        isRead: false,
      }),
    );
  }

  const conv3 = await conversationRepo.save(
    conversationRepo.create({ participantA: abena, participantB: efua }),
  );
  for (const m of [
    {
      sender: abena,
      content:
        'Hi Efua! I love your work. I would like to book a knotless braiding session.',
    },
    {
      sender: efua,
      content:
        'Thank you Abena! I have slots this Saturday from 9am. Does that work for you?',
    },
  ]) {
    await messageRepo.save(
      messageRepo.create({
        conversation: conv3,
        sender: m.sender,
        content: m.content,
        isRead: false,
      }),
    );
  }

  const conv4 = await conversationRepo.save(
    conversationRepo.create({ participantA: kwame, participantB: kweku }),
  );
  await messageRepo.save(
    messageRepo.create({
      conversation: conv4,
      sender: kwame,
      content:
        'Kweku, I need a custom floor-to-ceiling bookshelf built. Can you come for a consultation?',
      isRead: false,
    }),
  );
  // MC4: one image-only message so the attachment rendering path (and the
  // nullable `content` case) has fixture coverage.
  await messageRepo.save(
    messageRepo.create({
      conversation: conv4,
      sender: kwame,
      content: null,
      attachmentUrl: '/uploads/messages/seed-bookshelf-reference.jpg',
      attachmentType: 'image/jpeg',
      isRead: false,
    }),
  );

  console.log('✔  Created 4 conversations with 11 messages');

  // ── Bookings ───────────────────────────────────────────────────────────────────
  const bookingData = [
    {
      customer: ama,
      artisanProfile: yawProfile,
      availabilitySlot: yawSlot0,
      scheduledDate: '2026-07-07',
      startTime: '08:00',
      endTime: '12:00',
      status: BookingStatus.CONFIRMED,
      agreedPrice: 150,
      notes: 'Please bring pipe sealant. The leak is under the kitchen sink.',
      artisanNotes: 'Will inspect the full pipe system and fix the leak.',
    },
    {
      customer: kofi,
      artisanProfile: akuaProfile,
      availabilitySlot: akuaSlot0,
      scheduledDate: '2026-07-10',
      startTime: '13:00',
      endTime: '17:00',
      status: BookingStatus.PENDING,
      agreedPrice: undefined,
      notes: 'Interested in solar installation for the entire house.',
      artisanNotes: undefined,
    },
    {
      customer: abena,
      artisanProfile: efuaProfile,
      availabilitySlot: undefined,
      scheduledDate: '2026-06-10',
      startTime: '09:00',
      endTime: '13:00',
      status: BookingStatus.COMPLETED,
      agreedPrice: 80,
      notes: 'Waist-length knotless box braids. Please bring light extensions.',
      artisanNotes:
        'Session completed successfully. Client was delighted with the style.',
    },
    {
      customer: kwame,
      artisanProfile: kwekuProfile,
      availabilitySlot: undefined,
      scheduledDate: '2026-07-15',
      startTime: '08:00',
      endTime: '12:00',
      status: BookingStatus.DECLINED,
      agreedPrice: undefined,
      notes: 'Need an initial consultation before committing to the full job.',
      artisanNotes: 'Unable to take this booking due to a prior commitment.',
    },
    {
      customer: ama,
      artisanProfile: adwoaProfile,
      availabilitySlot: undefined,
      scheduledDate: '2026-06-25',
      startTime: '08:00',
      endTime: '12:00',
      status: BookingStatus.CANCELLED,
      agreedPrice: undefined,
      notes: 'Full interior repaint. 3 bedrooms and living room.',
      artisanNotes: undefined,
    },
    {
      customer: kofi,
      artisanProfile: yawProfile,
      availabilitySlot: undefined,
      scheduledDate: '2026-07-21',
      startTime: '13:00',
      endTime: '17:00',
      status: BookingStatus.PENDING,
      agreedPrice: undefined,
      notes:
        'Install a new outdoor tap and connect it to the main water supply.',
      artisanNotes: undefined,
    },
  ];

  const bookings: Booking[] = [];
  for (const b of bookingData) {
    bookings.push(
      await bookingRepo.save(
        bookingRepo.create({
          customer: b.customer,
          artisanProfile: b.artisanProfile,
          availabilitySlot: b.availabilitySlot,
          scheduledDate: b.scheduledDate,
          startTime: b.startTime,
          endTime: b.endTime,
          status: b.status,
          agreedPrice: b.agreedPrice,
          notes: b.notes,
          artisanNotes: b.artisanNotes,
        }),
      ),
    );
  }
  console.log(`✔  Created ${bookingData.length} bookings`);

  // ── DR3: a booking → job → payment → dispute chain that actually resolves ────
  //
  // The admin dispute screen's Linked Payment panel walks
  // `Dispute → Booking → Job → Payment` (`DisputesService.findLinkedWork`).
  // `BookingsService.confirm()` does write `Job.booking` (guarded by
  // `bookings.job-link.spec.ts`), but the seed previously created bookings and
  // jobs as two disconnected sets and no payments at all — so there was no row
  // anywhere in a seeded database where that chain could resolve, and the panel
  // could only ever render its empty state no matter what QA did.
  //
  // This gives QA the reproducible end-to-end case DR3 asks for: a completed
  // booking whose job holds a real payment, with a dispute on it that an admin
  // can rule on and watch the money move.
  //
  // NOTE for the payments follow-up: production `confirm()` deliberately does
  // *not* call `PaymentsService.holdPayment`, so a real booking-derived job
  // holds no money yet. This seeded payment represents the state that wiring
  // will produce. Until it lands, a genuinely booking-derived dispute in
  // production will legitimately show "no payment on file" — see
  // `api-contract.md` under DR3.
  const disputedBooking = bookings[2]; // abena ↔ efua, COMPLETED, GH₵ 80
  const bookingDerivedJob = await jobRepo.save(
    jobRepo.create({
      customer: abena,
      service: hairBraiding,
      title: `Hair Braiding — booking #${disputedBooking.id}`,
      description:
        'Waist-length knotless box braids, booked directly with the artisan.',
      location: 'East Legon, Accra',
      currency: 'GHS',
      budgetMin: 80,
      budgetMax: 80,
      status: Status.COMPLETED,
      acceptedArtisan: efua,
      booking: disputedBooking,
    }),
  );
  await jobHistoryRepo.save([
    jobHistoryRepo.create({
      jobId: bookingDerivedJob.id,
      fromStatus: null,
      toStatus: Status.PENDING,
      changedBy: String(efua.id),
      reason: `Created from confirmed booking #${disputedBooking.id}`,
    }),
    jobHistoryRepo.create({
      jobId: bookingDerivedJob.id,
      fromStatus: Status.PENDING,
      toStatus: Status.IN_PROGRESS,
      changedBy: String(efua.id),
      reason: 'Artisan started the work',
    }),
    jobHistoryRepo.create({
      jobId: bookingDerivedJob.id,
      fromStatus: Status.IN_PROGRESS,
      toStatus: Status.COMPLETED,
      changedBy: String(abena.id),
      reason: 'Customer confirmed completion',
    }),
  ]);

  // HELD ("Withheld"), so both money verdicts are genuinely available on the
  // dispute below: REFUND_CLIENT can refund it, RELEASE_ARTISAN can release it.
  // Platform fee is 5% of 80, matching `PLATFORM_FEE_PERCENT`'s default.
  const disputedPayment = await paymentRepo.save(
    paymentRepo.create({
      jobId: bookingDerivedJob.id,
      customerId: abena.id,
      artisanProfileId: efuaProfile.id,
      amount: 80,
      platformFee: 4,
      artisanAmount: 76,
      currency: 'GHS',
      status: PaymentStatus.HELD,
      reference: `jinva-${bookingDerivedJob.id}-${abena.id}-seed`,
      channel: 'mobile_money',
      paidAt: new Date('2026-06-10T13:30:00Z'),
    }),
  );

  // Two disputes on one booking, one per raiser — the uniqueness rule is one
  // dispute per booking *per raiser* (Open Question 14, kept as-is). This is
  // the exact shape QA needs to verify the double-refund hard guard: rule on
  // one, then try to move money again from the other.
  const disputeData = [
    {
      booking: disputedBooking,
      raisedBy: abena,
      category: DisputeCategory.WORK_QUALITY,
      status: DisputeStatus.OPEN,
      reason:
        'The braids started unravelling within three days and two sections were left uneven. I would like a refund of what I paid.',
    },
    {
      booking: disputedBooking,
      raisedBy: efua,
      category: DisputeCategory.PAYMENT_AMOUNT,
      status: DisputeStatus.UNDER_REVIEW,
      reason:
        'I completed the full session as agreed and supplied the extensions myself. The payment is still being withheld and I would like it released.',
    },
  ];
  for (const d of disputeData) {
    await disputeRepo.save(
      disputeRepo.create({
        booking: d.booking,
        bookingId: d.booking.id,
        raisedBy: d.raisedBy,
        raisedById: d.raisedBy.id,
        category: d.category,
        status: d.status,
        reason: d.reason,
      }),
    );
  }
  console.log(
    `✔  Created the DR3 chain: job #${bookingDerivedJob.id} → payment #${disputedPayment.id} (HELD) → ${disputeData.length} disputes on booking #${disputedBooking.id}`,
  );

  // ── DeviceTokens ───────────────────────────────────────────────────────────────
  const deviceTokenData = [
    {
      user: ama,
      userId: ama.id,
      token: 'fcm:ama_mensah_android_01',
      platform: DevicePlatform.ANDROID,
    },
    {
      user: kofi,
      userId: kofi.id,
      token: 'apns:kofi_asante_ios_01',
      platform: DevicePlatform.IOS,
    },
    {
      user: abena,
      userId: abena.id,
      token: 'fcm:abena_boateng_android_01',
      platform: DevicePlatform.ANDROID,
    },
    {
      user: kwame,
      userId: kwame.id,
      token: 'web:kwame_darko_chrome_01',
      platform: DevicePlatform.WEB,
    },
    {
      user: yaw,
      userId: yaw.id,
      token: 'fcm:yaw_osei_android_01',
      platform: DevicePlatform.ANDROID,
    },
    {
      user: akua,
      userId: akua.id,
      token: 'apns:akua_frimpong_ios_01',
      platform: DevicePlatform.IOS,
    },
    {
      user: efua,
      userId: efua.id,
      token: 'fcm:efua_agyeman_android_01',
      platform: DevicePlatform.ANDROID,
    },
    {
      user: kweku,
      userId: kweku.id,
      token: 'fcm:kweku_amoah_android_01',
      platform: DevicePlatform.ANDROID,
    },
    {
      user: adwoa,
      userId: adwoa.id,
      token: 'web:adwoa_ansah_firefox_01',
      platform: DevicePlatform.WEB,
    },
  ];

  for (const dt of deviceTokenData) {
    await deviceTokenRepo.save(
      deviceTokenRepo.create({
        user: dt.user,
        userId: dt.userId,
        token: dt.token,
        platform: dt.platform,
      }),
    );
  }
  console.log(`✔  Created ${deviceTokenData.length} device tokens`);

  // ── Notifications ──────────────────────────────────────────────────────────────
  const notificationData = [
    {
      user: yaw,
      type: NotificationType.ARTISAN_PROFILE_VERIFIED,
      title: 'Profile Verified',
      body: 'Congratulations! Your identity and profile have been successfully verified on JinVa.',
    },
    {
      user: akua,
      type: NotificationType.ARTISAN_PROFILE_VERIFIED,
      title: 'Profile Verified',
      body: 'Congratulations! Your identity and profile have been successfully verified on JinVa.',
    },
    {
      user: adwoa,
      type: NotificationType.ARTISAN_VERIFICATION_REJECTED,
      title: 'Verification Unsuccessful',
      body: 'Your verification was rejected. Please resubmit with a valid, unexpired identification document.',
    },
    {
      user: yaw,
      type: NotificationType.BOOKING_RECEIVED,
      title: 'New Booking Request',
      body: 'Ama Mensah has requested a booking with you on Monday 7 July 2026 at 08:00.',
    },
    {
      user: akua,
      type: NotificationType.BOOKING_RECEIVED,
      title: 'New Booking Request',
      body: 'Kofi Asante has requested a booking with you on Thursday 10 July 2026 at 13:00.',
    },
    {
      user: ama,
      type: NotificationType.BOOKING_CONFIRMED,
      title: 'Booking Confirmed',
      body: 'Your booking with Yaw Osei on Monday 7 July 2026 at 08:00 has been confirmed.',
    },
    {
      user: kofi,
      type: NotificationType.BOOKING_CONFIRMED,
      title: 'Booking Confirmed',
      body: 'Your booking with Akua Frimpong on Thursday 10 July 2026 at 13:00 has been confirmed.',
    },
    {
      user: kwame,
      type: NotificationType.BOOKING_DECLINED,
      title: 'Booking Declined',
      body: 'Kweku Amoah has declined your booking request for 15 July 2026. You may book another artisan.',
    },
    {
      user: ama,
      type: NotificationType.BOOKING_CANCELLED,
      title: 'Booking Cancelled',
      body: 'Your booking with Adwoa Ansah scheduled for 25 June 2026 has been cancelled.',
    },
    {
      user: yaw,
      type: NotificationType.REVIEW_RECEIVED,
      title: 'New Review',
      body: 'Ama Mensah gave you a 4.5-star review: "Yaw did an excellent job fixing the pipe."',
    },
    {
      user: akua,
      type: NotificationType.REVIEW_RECEIVED,
      title: 'New Review',
      body: 'Kofi Asante gave you a 5.0-star review: "Akua is absolutely brilliant!"',
    },
    {
      user: efua,
      type: NotificationType.JOB_APPLICATION_ACCEPTED,
      title: 'Application Accepted',
      body: 'Your application for "Knotless box braids – full head" has been accepted. Confirm the booking.',
    },
    {
      user: kweku,
      type: NotificationType.JOB_APPLICATION_ACCEPTED,
      title: 'Application Accepted',
      body: 'Your application for "Custom wall-to-wall bookshelf" has been accepted. Confirm the booking.',
    },
    {
      user: ama,
      type: NotificationType.JOB_APPLICATION_RECEIVED,
      title: 'New Application',
      body: 'Yaw Osei has applied to your painting job "Repaint 3-bedroom apartment". Review the quote.',
    },
    {
      user: kofi,
      type: NotificationType.MESSAGE_RECEIVED,
      title: 'New Message',
      body: 'You have a new message from Akua Frimpong.',
    },
  ];

  for (const n of notificationData) {
    await notificationRepo.save(
      notificationRepo.create({
        user: n.user,
        type: n.type,
        title: n.title,
        body: n.body,
        isRead: false,
      }),
    );
  }
  console.log(`✔  Created ${notificationData.length} notifications`);

  // ── Summary ────────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  JinVa — Comprehensive Seed Complete');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  Password for all accounts : ${SEED_PASSWORD}`);
  console.log('  Admin    : admin@jinva.com');
  console.log('  Customers: ama.mensah@gmail.com  |  kofi.asante@gmail.com');
  console.log('             abena.boateng@gmail.com  |  kwame.darko@gmail.com');
  console.log('  Artisans : yaw.osei@jinva.com  |  akua.frimpong@jinva.com');
  console.log('             efua.agyeman@jinva.com  |  kweku.amoah@jinva.com');
  console.log('             adwoa.ansah@jinva.com');
  console.log('──────────────────────────────────────────────────────────');
  console.log(`  Services              : ${services.length}`);
  console.log(`  Users                 : ${allUsers.length}`);
  console.log(`  Notification Prefs    : ${allUsers.length}`);
  console.log(`  Availability Slots    : ${totalSlots}`);
  console.log(`  Jobs                  : ${jobs.length}`);
  console.log(`  Job Applications      : ${applicationData.length}`);
  console.log(`  Artisan Verifications : 5`);
  console.log(`  Reviews               : 2`);
  console.log(`  Favourites            : ${favouriteData.length}`);
  console.log(`  Conversations         : 4  |  Messages : 11`);
  console.log(`  Bookings              : ${bookingData.length}`);
  console.log(`  Payments              : 1 (HELD, on the DR3 dispute chain)`);
  console.log(`  Disputes              : ${disputeData.length}`);
  console.log(`  Device Tokens         : ${deviceTokenData.length}`);
  console.log(`  Notifications         : ${notificationData.length}`);
  console.log('══════════════════════════════════════════════════════════\n');

  await dataSource.destroy();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
