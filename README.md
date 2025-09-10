# JinVa Backend

## Table of Contents
- [Description](#description)
- [Features](#features)
- [Technologies Used](#technologies-used)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the Server](#running-the-server)
- [API Endpoints](#api-endpoints)
- [Database Schema](#database-schema)
- [Authentication](#authentication)
- [Payments Integration](#payments-integration)
- [Chat Functionality](#chat-functionality)
- [Testing](#testing)
- [Contributing](#contributing)
- [License](#license)

## Description
The JinVa Backend is the server-side component of the JinVa application, designed to connect users with local barbers, salons, and nail technicians. It provides APIs for user management, location-based searches, secure payments, and real-time chat between users and professionals. The backend is built to be scalable, secure, and efficient, handling data persistence, business logic, and integrations with third-party services.

This repository focuses exclusively on the backend. The frontend (client-side) is assumed to be in a separate repository and consumes these APIs.

## Features
- **User Authentication**: Secure registration, login, and profile management for both users and professionals.
- **Location-Based Search**: Search for professionals by proximity using geospatial queries.
- **Professional Management**: CRUD operations for professional profiles, including services offered, availability, and reviews.
- **Payments**: Integrated payment processing for booking services.
- **Real-Time Chat**: In-app messaging between users and professionals.
- **Error Handling and Logging**: Robust logging and error responses for debugging and security.
- **Rate Limiting and Security**: Protection against common web vulnerabilities (e.g., CORS, helmet for headers).

## Technologies Used
- **Runtime**: Node.js (v20.x)
- **Framework**: Express.js
- **Database**: MongoDB (with Mongoose ODM for schema management)
- **Authentication**: JSON Web Tokens (JWT)
- **Payments**: Stripe API
- **Real-Time Chat**: Socket.io
- **Geolocation**: MongoDB Geospatial Indexing (or integrate with Google Maps API for advanced features)
- **Environment Management**: dotenv
- **Testing**: Jest and Supertest
- **Other Libraries**: bcryptjs, multer, winston

## Installation
```bash
git clone https://github.com/yourusername/jinva-backend.git
cd jinva-backend
npm install
```

## Configuration
Create a `.env` file in the root directory with the following variables:
```env
PORT=5000
MONGO_URI=mongodb://localhost:27017/jinva
JWT_SECRET=your_jwt_secret_key
STRIPE_SECRET_KEY=your_stripe_secret_key
GOOGLE_MAPS_API_KEY=your_google_maps_api_key
```

- `MONGO_URI`: Your MongoDB connection string.
- `JWT_SECRET`: A strong secret for signing JWTs.
- `STRIPE_SECRET_KEY`: Obtained from your Stripe dashboard.
- `GOOGLE_MAPS_API_KEY`: Optional for enhanced geolocation.

Ensure sensitive keys are not committed to version control.

## Running the Server
Development mode (with auto-reload using nodemon):
```bash
npm run dev
```

Production mode:
```bash
npm start
```

The server will run on `http://localhost:5000` (or the port specified in `.env`).

## API Endpoints
Base URL: `/api`.

### Users
- `POST /api/users/register`: Register a new user or professional.
- `POST /api/users/login`: Login and receive JWT.
- `GET /api/users/profile`: Get authenticated user's profile.
- `PUT /api/users/profile`: Update profile.

### Professionals
- `GET /api/professionals`: Search professionals.
- `POST /api/professionals`: Create professional profile (JWT required).
- `GET /api/professionals/:id`: Get details of a specific professional.
- `PUT /api/professionals/:id`: Update professional profile (JWT required).
- `DELETE /api/professionals/:id`: Delete profile (JWT required).

### Bookings
- `POST /api/bookings`: Create a booking.
- `GET /api/bookings`: Get user's bookings (JWT required).
- `PUT /api/bookings/:id`: Update booking status.

### Payments
- `POST /api/payments/create-session`: Create a Stripe checkout session.
- `POST /api/payments/webhook`: Stripe webhook for payment confirmation.

### Chat
Real-time via Socket.io (`/chat` namespace).  
Events: `joinRoom`, `sendMessage`, `receiveMessage`.

## Database Schema
Using Mongoose schemas:
- **User**: `{ email, password, name, role, location, profilePic }`
- **Professional**: Extends User with `{ services, availability, reviews }`
- **Booking**: `{ userId, professionalId, service, date, time, status }`
- **Message**: `{ senderId, receiverId, content, timestamp }`

## Authentication
- JWT-based with `Authorization: Bearer <token>` header.
- Role-based access control.

## Payments Integration
- Stripe integration for secure payments.
- Create sessions for bookings and handle webhooks for confirmation.

## Chat Functionality
- Socket.io for real-time communication.
- Rooms based on user-professional pairs (`${userId}_${professionalId}`).
- Messages stored in DB.

## Testing
Run tests:
```bash
npm test
```

Coverage: Aim for **>80%** with Jest.  
Example tests: Authentication, search queries, payment mocks.

## Contributing
1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/YourFeature`.
3. Commit changes: `git commit -m 'Add YourFeature'`.
4. Push to branch: `git push origin feature/YourFeature`.
5. Open a Pull Request.

## License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
