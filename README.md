JinVa Backend

Table of Contents

Description
Features
Technologies Used
Installation
Configuration
Running the Server
API Endpoints
Database Schema
Authentication
Payments Integration
Chat Functionality
Testing
Contributing
License

Description
The JinVa Backend is the server-side component of the JinVa application, designed to connect users with local barbers, salons, and nail technicians. It provides APIs for user management, location-based searches, secure payments, and real-time chat between users and professionals. The backend is built to be scalable, secure, and efficient, handling data persistence, business logic, and integrations with third-party services.
This repository focuses exclusively on the backend. The frontend (client-side) is assumed to be in a separate repository and consumes these APIs.
Features

User Authentication: Secure registration, login, and profile management for both users and professionals.
Location-Based Search: Search for professionals by proximity using geospatial queries.
Professional Management: CRUD operations for professional profiles, including services offered, availability, and reviews.
Payments: Integrated payment processing for booking services.
Real-Time Chat: In-app messaging between users and professionals.
Error Handling and Logging: Robust logging and error responses for debugging and security.
Rate Limiting and Security: Protection against common web vulnerabilities (e.g., CORS, helmet for headers).

Technologies Used

Runtime: Node.js (v20.x)
Framework: Express.js
Database: MongoDB (with Mongoose ODM for schema management)
Authentication: JSON Web Tokens (JWT)
Payments: Stripe API
Real-Time Chat: Socket.io
Geolocation: MongoDB Geospatial Indexing (or integrate with Google Maps API for advanced features)
Environment Management: dotenv
Testing: Jest and Supertest
Other Libraries: bcryptjs (password hashing), multer (file uploads for profiles), winston (logging)

Installation

Clone the repository:
git clone https://github.com/yourusername/jinva-backend.git
cd jinva-backend


Install dependencies:
npm install



Configuration
Create a .env file in the root directory with the following variables:
PORT=5000
MONGO_URI=mongodb://localhost:27017/jinva
JWT_SECRET=your_jwt_secret_key
STRIPE_SECRET_KEY=your_stripe_secret_key
GOOGLE_MAPS_API_KEY=your_google_maps_api_key


MONGO_URI: Your MongoDB connection string.
JWT_SECRET: A strong secret for signing JWTs.
STRIPE_SECRET_KEY: Obtained from your Stripe dashboard.
GOOGLE_MAPS_API_KEY: Optional for enhanced geolocation.
Ensure sensitive keys are not committed to version control.

Running the Server

Development mode (with auto-reload using nodemon):
npm run dev


Production mode:
npm start



The server will run on http://localhost:5000 (or the port specified in .env).
API Endpoints
The API follows RESTful principles. Base URL: /api.
Users

POST /api/users/register: Register a new user or professional (body: { email, password, name, role: 'user' | 'professional', location: { lat, lng } }).
POST /api/users/login: Login and receive JWT (body: { email, password }).
GET /api/users/profile: Get authenticated user's profile (requires JWT).
PUT /api/users/profile: Update profile (requires JWT).

Professionals

GET /api/professionals: Search professionals (query params: ?location=lat,lng&radius=10&service=barber).
POST /api/professionals: Create professional profile (requires JWT, professional role).
GET /api/professionals/:id: Get details of a specific professional.
PUT /api/professionals/:id: Update professional profile (requires JWT).
DELETE /api/professionals/:id: Delete profile (requires JWT).

Bookings

POST /api/bookings: Create a booking (body: { professionalId, service, date, time }).
GET /api/bookings: Get user's bookings (requires JWT).
PUT /api/bookings/:id: Update booking status (e.g., confirm/cancel).

Payments

POST /api/payments/create-session: Create a Stripe checkout session (body: { bookingId, amount }).
POST /api/payments/webhook: Stripe webhook for payment confirmation (unprotected, verify signature).

Chat

Real-time via Socket.io (connect to /chat namespace).
Events: joinRoom, sendMessage, receiveMessage.

For full API documentation, refer to Postman collection (not included) or use tools like Swagger (to be integrated).
Database Schema
Using Mongoose schemas:

User: { email, password (hashed), name, role, location: { type: 'Point', coordinates: [lng, lat] }, profilePic }
Professional: Extends User with { services: [], availability: [], reviews: [{ rating, comment }] }
Booking: { userId, professionalId, service, date, time, status: 'pending' | 'confirmed' | 'completed' }
Message: { senderId, receiverId, content, timestamp }

Geospatial index on location for efficient searches.
Authentication

JWT-based: Tokens are issued on login and must be sent in Authorization: Bearer <token> header.
Role-based access: Middleware checks for 'user' or 'professional' roles.

Payments Integration

Uses Stripe for secure payments.
Create sessions for bookings and handle webhooks for fulfillment.
Test with Stripe's test keys in development.

Chat Functionality

Socket.io for real-time bidirectional communication.
Rooms based on user-professional pairs (e.g., room ID: ${userId}_${professionalId}).
Messages stored in DB for persistence.

Testing

Run unit and integration tests:
npm test


Coverage: Aim for >80% with Jest.

Example tests: Authentication flows, search queries, payment mocks.


Contributing

Fork the repository.
Create a feature branch (git checkout -b feature/YourFeature).
Commit changes (git commit -m 'Add YourFeature').
Push to the branch (git push origin feature/YourFeature).
Open a Pull Request.

Please follow code style (ESLint configured) and add tests for new features.
License
This project is licensed under the MIT License - see the LICENSE file for details.